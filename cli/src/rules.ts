import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { NapiConfig } from '@ast-grep/napi'
import type { Finding, Level, CheckedFile, Rule, RuleSettings, Runs } from './api.ts'
import { importsRule, noSuppressionsRule } from './check.ts'
import type { Import } from './claude-md.ts'
import { isLevel, isRecord, isRuns, isStrings, isThreshold, isTimeout, rootRelative, type Settings } from './config.ts'
import { isJev } from './jev.ts'
import { cacheFolder } from './linters.ts'
import { importDefault } from './modules.ts'

type Common = {
  readonly id: string
  readonly source: string
  readonly description: string
  readonly level: Level | 'off'
  readonly runs: Runs
  readonly paths: readonly string[] | undefined
}

type Doc = { readonly file: string; readonly imports: readonly Import[] }

export type StaticRule = Common & {
  readonly kind: 'static'
  check(file: CheckedFile, doc: Doc | undefined): readonly Finding[] | Promise<readonly Finding[]>
}

export type AgenticRule = Common & {
  readonly kind: 'agentic'
  readonly timeout: number
  readonly body: string
  readonly agent: string | undefined
  readonly model: string | undefined
  readonly effort: string | undefined
  readonly threshold: number | undefined
  readonly allowedTools: string | readonly string[] | undefined
  readonly disallowedTools: string | readonly string[] | undefined
}

export type LoadedRule = StaticRule | AgenticRule

export type Rules = { readonly rules: readonly LoadedRule[]; readonly failures: readonly string[] }

const RULE_FILES = new Bun.Glob('**/*.{ts,md,yml}')
const SCRIPT_KEYS = new Set(['description', 'level', 'runs', 'paths', 'check'])
const FRONTMATTER_KEYS = new Set(['description', 'agent', 'model', 'effort', 'paths', 'allowed-tools', 'disallowed-tools', 'metadata'])
const METADATA_KEYS = new Set(['level', 'runs', 'timeout', 'threshold'])
const CLAUDE_KEYS = ['agent', 'effort', 'allowed-tools', 'disallowed-tools'] as const
const PATTERN_KEYS = new Set(['description', 'language', 'paths', 'level', 'runs', 'rule'])
const LANGUAGES = ['typescript', 'tsx', 'javascript', 'html', 'css', 'php', 'python', 'bash', 'lua', 'json', 'yaml', 'toml', 'markdown']

let astGrep: Promise<typeof import('@ast-grep/napi')> | undefined

const loadedRules = new WeakMap<Settings, Promise<Rules>>()

export function loadRules(settings: Settings): Promise<Rules> {
  const known = loadedRules.get(settings)
  if (known !== undefined) return known
  const rules = rulesOf(settings)
  loadedRules.set(settings, rules)
  return rules
}

async function rulesOf(settings: Settings): Promise<Rules> {
  const rules: LoadedRule[] = [importsRule(settings), noSuppressionsRule]
  const failures: string[] = []
  const ids = new Set(rules.map(({ id }) => id))
  for (const config of settings.configs) {
    for (const [plugin, folder] of Object.entries(config.plugins)) {
      for (const path of [...RULE_FILES.scanSync({ cwd: folder })].filter((path) => !path.endsWith('.d.ts') && !path.endsWith('.test.ts')).sort()) {
        const id = `${plugin}/${path.slice(0, path.lastIndexOf('.'))}`
        const source = join(folder, path)
        if (ids.has(id)) throw new Error(`${source}: another file is already the rule ${id}. Give each rule its own name.`)
        ids.add(id)
        try {
          const rule = await loadedRule(id, source, settings.timeout)
          rules.push({ ...rule, paths: rule.paths && rootRelative(config.basePath, rule.paths) })
        } catch (error) {
          failures.push(`${error instanceof Error ? error.message : String(error)} The rule ${id} checks nothing until it loads.`)
        }
      }
    }
  }
  for (const id of Object.keys(settings.rules)) if (!ids.has(id)) throw new Error(`A rulebook config sets the rule "${id}", which no plugin holds. The rules are ${[...ids].join(', ')}.`)
  const loaded = rules.map((rule) => overridden(rule, settings.rules[rule.id]))
  for (const { id, paths, level } of loaded) {
    if (paths === undefined && level !== 'off' && settings.paths.length === 0) failures.push(`The rule ${id} has no paths, and no config lists paths, so it checks no file. Give the rule paths, such as paths: ['**/*.ts'].`)
  }
  return { rules: loaded, failures }
}

function loadedRule(id: string, source: string, timeout: number): Promise<LoadedRule> {
  if (source.endsWith('.ts')) return scriptRule(id, source)
  if (source.endsWith('.md')) return agenticRule(id, source, timeout)
  return patternRule(id, source)
}

async function scriptRule(id: string, source: string): Promise<StaticRule> {
  const rule = await importDefault(source)
  if (!isRecord(rule) || typeof rule.check !== 'function') throw new Error(`${source}: the default export is not a rule. Export defineRule({ description, check }).`)
  for (const key of Object.keys(rule)) if (!SCRIPT_KEYS.has(key)) throw new Error(`${source}: rulebook does not read the key "${key}". It reads ${[...SCRIPT_KEYS].join(', ')}.`)
  const check = rule.check as Rule['check']
  return { ...commonOf(id, source, rule), kind: 'static', check: (file) => check(file) }
}

async function agenticRule(id: string, source: string, timeout: number): Promise<AgenticRule> {
  const fail = (problem: string): never => {
    throw new Error(`${source}: ${problem}`)
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(await Bun.file(source).text())
  if (match === null) return fail('the rule has no frontmatter between --- lines.')
  const frontmatter = yamlOf(source, match[1] ?? '')
  const body = (match[2] ?? '').trim()
  if (!isRecord(frontmatter)) return fail('the frontmatter is not a map of keys.')
  for (const key of Object.keys(frontmatter)) if (!FRONTMATTER_KEYS.has(key)) fail(`rulebook does not read the key "${key}". It reads ${[...FRONTMATTER_KEYS].join(', ')}.`)
  for (const key of ['agent', 'model', 'effort'] as const) if (frontmatter[key] !== undefined && typeof frontmatter[key] !== 'string') fail(`${key} is a string.`)
  for (const key of ['allowed-tools', 'disallowed-tools'] as const) if (frontmatter[key] !== undefined && typeof frontmatter[key] !== 'string' && !isStrings(frontmatter[key])) fail(`${key} is a string or a list.`)
  const metadata = frontmatter.metadata ?? {}
  if (!isRecord(metadata)) return fail('metadata is a map.')
  for (const key of Object.keys(metadata)) if (!METADATA_KEYS.has(key)) fail(`metadata.${key} is not a rulebook key. rulebook reads metadata.level, metadata.runs, metadata.timeout, and metadata.threshold.`)
  if (metadata.timeout !== undefined && !isTimeout(metadata.timeout)) fail('metadata.timeout is a whole number of milliseconds above 0.')
  if (metadata.threshold !== undefined && !isThreshold(metadata.threshold)) fail('metadata.threshold is a probability above 0 and at most 1.')
  if (body === '') fail('the rule has no body. The body is the check.')
  if (isJev(frontmatter.model)) for (const key of CLAUDE_KEYS) if (frontmatter[key] !== undefined) fail(`model jev runs the rule on Jev, which runs no agent, so rulebook does not read ${key}.`)
  if (metadata.threshold !== undefined && !isJev(frontmatter.model)) fail('metadata.threshold is the probability Jev must give a line to pass, so it needs model: jev.')
  return {
    ...commonOf(id, source, { ...metadata, description: frontmatter.description, paths: frontmatter.paths }),
    kind: 'agentic',
    timeout: (metadata.timeout as number | undefined) ?? timeout,
    body,
    agent: frontmatter.agent as string | undefined,
    model: frontmatter.model as string | undefined,
    effort: frontmatter.effort as string | undefined,
    threshold: metadata.threshold as number | undefined,
    allowedTools: frontmatter['allowed-tools'] as string | readonly string[] | undefined,
    disallowedTools: frontmatter['disallowed-tools'] as string | readonly string[] | undefined,
  }
}

async function patternRule(id: string, source: string): Promise<StaticRule> {
  const fail = (problem: string): never => {
    throw new Error(`${source}: ${problem}`)
  }
  const rule = yamlOf(source, await Bun.file(source).text())
  if (!isRecord(rule)) return fail('the rule is not a map of keys.')
  for (const key of Object.keys(rule)) if (!PATTERN_KEYS.has(key)) fail(`rulebook does not read the key "${key}". It reads ${[...PATTERN_KEYS].join(', ')}.`)
  const { language } = rule
  if (typeof language !== 'string' || !LANGUAGES.includes(language)) return fail(`language is one of ${LANGUAGES.join(', ')}.`)
  if (!isRecord(rule.rule)) fail('rule is an ast-grep rule, such as { pattern: "console.log($$$ARGS)" }.')
  const common = commonOf(id, source, rule)
  const matcher = { rule: rule.rule } as NapiConfig
  const { parse } = await (astGrep ??= loadAstGrep())
  try {
    parse(language, '').root().findAll(matcher)
  } catch (error) {
    fail(`ast-grep refuses the rule: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { ...common, kind: 'static', check: ({ text }) => parse(language, text).root().findAll(matcher).map((node) => ({ line: node.range().start.line + 1 })) }
}

async function loadAstGrep(): Promise<typeof import('@ast-grep/napi')> {
  const [napi, php, python, bash, lua, json, yaml, toml, markdown] = await Promise.all([
    import('@ast-grep/napi'),
    import('@ast-grep/lang-php'),
    import('@ast-grep/lang-python'),
    import('@ast-grep/lang-bash'),
    import('@ast-grep/lang-lua'),
    import('@ast-grep/lang-json'),
    import('@ast-grep/lang-yaml'),
    import('@ast-grep/lang-toml'),
    import('@ast-grep/lang-markdown'),
  ])
  const packages = { php, python, bash, lua, json, yaml, toml, markdown }
  napi.registerDynamicLanguage(Object.fromEntries(await Promise.all(Object.entries(packages).map(async ([language, { default: registration }]) => {
    const { extensions, languageSymbol = `tree_sitter_${language}`, expandoChar = '$' } = registration
    return [language, { libraryPath: Bun.isStandaloneExecutable ? await embeddedParser(language) : registration.libraryPath, extensions, languageSymbol, expandoChar }] as const
  }))))
  return napi
}

async function embeddedParser(language: string): Promise<string> {
  const embedded = (Bun.embeddedFiles as readonly Bun.BunFile[]).find((file) => file.name?.includes(`/lang-${language}/`))
  if (embedded?.name === undefined) throw new Error(`This rulebook build holds no ${language} parser. Build it with the build script in cli/package.json, which embeds each parser.`)
  const folder = cacheFolder()
  const file = join(folder, `${language}-${basename(embedded.name)}`)
  if (existsSync(file)) return file
  mkdirSync(folder, { recursive: true })
  const partial = `${file}.${crypto.randomUUID()}`
  await Bun.write(partial, embedded)
  renameSync(partial, file)
  return file
}

function commonOf(id: string, source: string, keys: Readonly<Record<string, unknown>>): Common {
  const fail = (problem: string): never => {
    throw new Error(`${source}: ${problem}`)
  }
  const { description, level, runs } = keys
  if (typeof description !== 'string' || description.trim() === '' || description.trim().includes('\n')) return fail('a rule needs a description: the Rule in one line of plain words, such as "Don\'t write em dashes."')
  if (level !== undefined && !isLevel(level)) fail('level is "error" or "warning".')
  if (runs !== undefined && !isRuns(runs)) fail('runs is "always", "commit", or "manual".')
  return {
    id,
    source,
    description: description.trim(),
    level: (level as Level | undefined) ?? 'error',
    runs: (runs as Runs | undefined) ?? 'always',
    paths: pathsOf(source, keys.paths),
  }
}

function pathsOf(source: string, paths: unknown): readonly string[] | undefined {
  if (paths === undefined) return undefined
  if (typeof paths === 'string') return paths.split(',').map((path) => path.trim()).filter((path) => path !== '')
  if (isStrings(paths)) return paths
  throw new Error(`${source}: paths is a list of globs or a comma-separated string.`)
}

function yamlOf(source: string, text: string): unknown {
  try {
    return Bun.YAML.parse(text)
  } catch (error) {
    throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function overridden(rule: LoadedRule, override: RuleSettings | undefined): LoadedRule {
  if (override === undefined) return rule
  const { level, runs, paths } = override
  const common = { ...rule, ...(level === undefined ? {} : { level }), ...(runs === undefined ? {} : { runs }), ...(paths === undefined ? {} : { paths }) }
  if (common.kind === 'static') {
    for (const key of ['agent', 'model', 'effort', 'timeout', 'threshold'] as const) if (override[key] !== undefined) throw new Error(`A rulebook config sets ${key} on ${rule.id}, a static rule, which runs no agent.`)
    return common
  }
  const agentic = { ...common, ...(override.timeout === undefined ? {} : { timeout: override.timeout }), ...(override.agent === undefined ? {} : { agent: override.agent }), ...(override.model === undefined ? {} : { model: override.model }), ...(override.effort === undefined ? {} : { effort: override.effort }), ...(override.threshold === undefined ? {} : { threshold: override.threshold }) }
  if (isJev(agentic.model)) for (const key of ['agent', 'effort'] as const) if (override[key] !== undefined) throw new Error(`A rulebook config sets ${key} on ${rule.id}, which runs on Jev, and Jev runs no agent.`)
  if (!isJev(agentic.model) && override.threshold !== undefined) throw new Error(`A rulebook config sets threshold on ${rule.id}, which runs on Claude Code. threshold is the probability Jev must give a line to pass, so it needs model: 'jev'.`)
  return agentic
}
