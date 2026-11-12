import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import type { Config, Level, LinterName, RuleSettings, Runs } from './api.ts'
import { LINTERS } from './linters.ts'
import { importDefault } from './modules.ts'

export const CONFIG_FILE = 'rulebook.config.ts'

type LoadedConfig = {
  readonly file: string
  readonly dir: string
  readonly basePath: string
  readonly plugins: Readonly<Record<string, string>>
  readonly probes: readonly string[]
  readonly messages: Readonly<Record<string, MessageSource>>
}

type MessageSource = { readonly tools: readonly string[]; readonly folder: string | undefined }

type Place = Pick<LoadedConfig, 'file' | 'dir' | 'basePath'>

type Layer = { readonly loaded: LoadedConfig; readonly config: Config }

export type Settings = {
  readonly root: string
  readonly configs: readonly LoadedConfig[]
  readonly paths: readonly string[]
  readonly timeout: number
  readonly existingErrors: Level
  readonly rules: Readonly<Record<string, RuleSettings>>
  readonly linters: readonly LinterName[]
  readonly messages: Readonly<Record<string, MessageSource>>
}

const KEYS = new Set(['extends', 'plugins', 'paths', 'probes', 'timeout', 'existingErrors', 'rules', 'linters', 'messages'])
const RULE_KEYS = new Set(['level', 'runs', 'paths', 'timeout', 'agent', 'model', 'effort', 'threshold'])
const MESSAGE_KEYS = new Set(['tools', 'folder'])
const BUILT_IN: Pick<LoadedConfig, 'file' | 'plugins' | 'messages'> = { file: 'rulebook', plugins: {}, messages: { reply: { tools: [], folder: undefined } } }

export function globalConfigFile(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'rulebook', CONFIG_FILE)
}

export function projectRoot(folder: string, outsideGit: string): string {
  const real = realpathSync(folder)
  if (real.split(sep).includes('.git')) return realpathSync(outsideGit)
  for (let dir = real; ; dir = dirname(dir)) {
    if (isWorkTree(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return realpathSync(outsideGit)
  }
}

function isWorkTree(git: string): boolean {
  const stats = statSync(git, { throwIfNoEntry: false })
  if (stats?.isDirectory() === true) return existsSync(join(git, 'HEAD'))
  return stats?.isFile() === true && readFileSync(git, 'utf8').startsWith('gitdir: ')
}

const nearest = new Map<string, string | undefined>()
const loadedSettings = new Map<string, Promise<Settings>>()
const readPaths = new Set<string>()

export function settingsSources(): readonly string[] {
  return [globalConfigFile(), ...[...nearest.keys()].map((folder) => join(folder, CONFIG_FILE)), ...readPaths]
}

export function loadSettings(folder: string, root: string): Promise<Settings> {
  const file = nearestConfig(folder)
  const key = `${root}\0${file ?? ''}`
  const known = loadedSettings.get(key)
  if (known !== undefined) return known
  const settings = settingsOf(root, file)
  loadedSettings.set(key, settings)
  return settings
}

function nearestConfig(folder: string): string | undefined {
  if (nearest.has(folder)) return nearest.get(folder)
  const file = join(folder, CONFIG_FILE)
  const above = dirname(folder)
  const found = existsSync(file) ? realpathSync(file) : above === folder ? undefined : nearestConfig(above)
  nearest.set(folder, found)
  return found
}

async function settingsOf(root: string, file: string | undefined): Promise<Settings> {
  const global = globalConfigFile()
  const found = [...(existsSync(global) ? await fileLayers(realpathSync(global), root, true, []) : []), ...(file === undefined ? [] : await fileLayers(file, root, false, []))]
  const seen = new Set<Config>()
  const configs = found.filter(({ config }) => !seen.has(config) && seen.add(config))

  const sources = [BUILT_IN, ...configs.map(({ loaded }) => loaded)]
  for (const [key, noun] of [['plugins', 'plugin'], ['messages', 'message']] as const) {
    const owners = new Map<string, string>()
    for (const source of sources) {
      for (const name of Object.keys(source[key])) {
        if (owners.has(name)) throw new Error(`${source.file}: the ${noun} "${name}" is already named by ${owners.get(name)}. Give each ${noun} its own name.`)
        owners.set(name, source.file)
      }
    }
  }

  const latest = configs.map(({ config }) => config).toReversed()

  return {
    root,
    configs: configs.map(({ loaded }) => loaded),
    paths: [...new Set(configs.flatMap(({ loaded, config }) => rootRelative(loaded.basePath, config.paths ?? [])))],
    timeout: latest.find(({ timeout }) => timeout !== undefined)?.timeout ?? 30_000,
    existingErrors: latest.find(({ existingErrors }) => existingErrors !== undefined)?.existingErrors ?? 'warning',
    rules: overrides(configs.map(({ loaded, config }) => rootRelativeRules(loaded.basePath, config.rules ?? {}))),
    linters: [...new Set(configs.flatMap(({ config }) => config.linters ?? []))],
    messages: Object.assign({}, ...sources.map(({ messages }) => messages)),
  }
}

function overrides(layers: readonly Readonly<Record<string, RuleSettings>>[]): Record<string, RuleSettings> {
  const merged: Record<string, RuleSettings> = {}
  for (const layer of layers) for (const [id, settings] of Object.entries(layer)) merged[id] = { ...merged[id], ...settings }
  return merged
}

export function rootRelative(basePath: string, globs: readonly string[]): readonly string[] {
  return basePath === '' ? globs : globs.map((glob) => (glob.startsWith('@') ? glob : posix.join(basePath, glob)))
}

function rootRelativeRules(basePath: string, rules: NonNullable<Config['rules']>): Readonly<Record<string, RuleSettings>> {
  return Object.fromEntries(Object.entries(rules).map(([id, override]) => {
    const settings = typeof override === 'string' ? { level: override } : override
    return [id, settings.paths === undefined ? settings : { ...settings, paths: rootRelative(basePath, settings.paths) }]
  }))
}

async function fileLayers(file: string, root: string, isGlobal: boolean, chain: readonly string[]): Promise<readonly Layer[]> {
  if (chain.includes(file)) throw new Error(`${chain.at(-1)}: extends ${file}, which extends it back through ${[...chain.slice(chain.indexOf(file)), file].join(' -> ')}. Remove one of these extends.`)
  const dir = dirname(file)
  const basePath = isGlobal || !isInside(root, dir) ? '' : relative(root, dir)
  return configLayers(validConfig(file, await importDefault(file)), { file, dir, basePath }, root, [...chain, file])
}

async function configLayers(config: Config, place: Place, root: string, chain: readonly string[]): Promise<readonly Layer[]> {
  const layers: Layer[] = []
  for (const entry of config.extends ?? []) layers.push(...(typeof entry === 'string' ? await fileLayers(extendedFile(place, entry), root, false, chain) : await configLayers(validConfig(place.file, entry), place, root, chain)))
  return [...layers, { loaded: loadedConfig(config, place), config }]
}

function extendedFile({ file, dir }: Place, path: string): string {
  const target = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : resolve(dir, path)
  readPaths.add(target)
  if (statSync(target, { throwIfNoEntry: false })?.isFile() !== true) throw new Error(`${file}: extends "${path}", but ${target} is not a file.`)
  return realpathSync(target)
}

function loadedConfig(config: Config, { file, dir, basePath }: Place): LoadedConfig {
  const plugins = Object.fromEntries(Object.entries(config.plugins ?? {}).map(([name, folder]) => [name, realFolder(file, resolve(dir, folder))]))
  const messages = Object.fromEntries(Object.entries(config.messages ?? {}).map(([name, { tools = [], folder }]) => {
    const path = folder === undefined ? undefined : resolve(dir, folder)
    return [name, { tools, folder: path !== undefined && existsSync(path) ? realpathSync(path) : path }]
  }))
  return { file, dir, basePath, plugins, probes: config.probes ?? [], messages }
}

function realFolder(file: string, folder: string): string {
  readPaths.add(folder)
  if (!existsSync(folder)) throw new Error(`${file}: the plugin folder ${folder} does not exist.`)
  return realpathSync(folder)
}

function validConfig(file: string, value: unknown): Config {
  const fail = (problem: string): never => {
    throw new Error(`${file}: ${problem}`)
  }
  if (!isRecord(value)) return fail('the default export is not a config object. Export defineConfig({ … }).')
  for (const key of Object.keys(value)) if (!KEYS.has(key)) fail(`"${key}" is not a rulebook config key. The keys are ${[...KEYS].join(', ')}.`)
  if (value.extends !== undefined && !(Array.isArray(value.extends) && value.extends.every((entry) => typeof entry === 'string' || isRecord(entry)))) fail('extends is a list of config paths, relative to the config, and config objects, such as [recommended].')
  if (value.plugins !== undefined && !(isRecord(value.plugins) && Object.values(value.plugins).every((folder) => typeof folder === 'string'))) fail('plugins maps each plugin name to a folder.')
  for (const name of Object.keys(value.plugins ?? {})) if (!/^[a-z][a-z0-9-]*$/.test(name)) fail(`"${name}" is not a plugin name: use lowercase letters, digits, and "-".`)
  for (const key of ['paths', 'probes'] as const) if (value[key] !== undefined && !isStrings(value[key])) fail(`${key} is a list of globs.`)
  if (value.timeout !== undefined && !isTimeout(value.timeout)) fail('timeout is a whole number of milliseconds above 0.')
  if (value.existingErrors !== undefined && !isLevel(value.existingErrors)) fail('existingErrors is "error" or "warning".')
  if (value.rules !== undefined && !isRecord(value.rules)) fail('rules maps each rule name, such as "global/block-em-dashes", to a level or to settings.')
  for (const [id, override] of Object.entries(isRecord(value.rules) ? value.rules : {})) validOverride(file, id, override)
  if (value.linters !== undefined && !isStrings(value.linters)) fail(`linters is a list of the linters to run, such as ['oxlint', 'biome']. The linters are ${Object.keys(LINTERS).join(', ')}.`)
  for (const name of isStrings(value.linters) ? value.linters : []) if (!Object.hasOwn(LINTERS, name)) fail(`linters names "${name}", which is not a linter rulebook runs. The linters are ${Object.keys(LINTERS).join(', ')}.`)
  if (value.messages !== undefined && !isRecord(value.messages)) fail('messages maps each message name, such as "inbox", to the tools and the folder its text comes from.')
  for (const [name, message] of Object.entries(isRecord(value.messages) ? value.messages : {})) validMessage(file, name, message)
  return value as Config
}

function validMessage(file: string, name: string, message: unknown): void {
  const fail = (problem: string): never => {
    throw new Error(`${file}: messages["${name}"] ${problem}`)
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) fail('is not a message name: use lowercase letters, digits, and "-".')
  if (!isRecord(message)) return fail('is an object of tools and a folder.')
  for (const key of Object.keys(message)) if (!MESSAGE_KEYS.has(key)) fail(`sets "${key}". A message sets ${[...MESSAGE_KEYS].join(' and ')}.`)
  if (message.tools !== undefined && !isStrings(message.tools)) fail('tools is a list of tool name globs, such as "mcp__inbox__*".')
  if (message.folder !== undefined && typeof message.folder !== 'string') fail('folder is the path of a folder.')
}

function validOverride(file: string, id: string, override: unknown): void {
  const fail = (problem: string): never => {
    throw new Error(`${file}: rules["${id}"] ${problem}`)
  }
  if (override === 'off' || isLevel(override)) return
  if (!isRecord(override)) return fail('is "error", "warning", "off", or an object of rule settings.')
  for (const key of Object.keys(override)) if (!RULE_KEYS.has(key)) fail(`sets "${key}", which no rule has. A rule's settings are ${[...RULE_KEYS].join(', ')}.`)
  if (override.level !== undefined && override.level !== 'off' && !isLevel(override.level)) fail('level is "error", "warning", or "off".')
  if (override.runs !== undefined && !isRuns(override.runs)) fail('runs is "always" or "manual".')
  if (override.paths !== undefined && !isStrings(override.paths)) fail('paths is a list of globs.')
  if (override.timeout !== undefined && !isTimeout(override.timeout)) fail('timeout is a whole number of milliseconds above 0.')
  if (override.threshold !== undefined && !isThreshold(override.threshold)) fail('threshold is a probability above 0 and at most 1.')
  for (const key of ['agent', 'model', 'effort'] as const) if (override[key] !== undefined && typeof override[key] !== 'string') fail(`${key} is a string.`)
}

export function isInside(folder: string, file: string): boolean {
  const path = relative(folder, file)
  return !path.startsWith('..') && !isAbsolute(path)
}

export function existingFolder(folder: string): string {
  return existsSync(folder) ? folder : existingFolder(dirname(folder))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function isLevel(value: unknown): value is Level {
  return value === 'error' || value === 'warning'
}

export function isRuns(value: unknown): value is Runs {
  return value === 'always' || value === 'manual'
}

export function isTimeout(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

export function isThreshold(value: unknown): value is number {
  return typeof value === 'number' && value > 0 && value <= 1
}
