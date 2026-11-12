import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }
import type { Level, LinterName } from './api.ts'
import { existingFolder, isStrings } from './config.ts'
import { oneLine, openedDiagnostics, seconds, type Diagnostic, type Server } from './lsp.ts'

type LinterFinding = { readonly file: string; readonly line: number; readonly level: Level; readonly rule: string; readonly message: string }

export type Covering = { readonly name: LinterName; readonly folder: string; readonly config: string | undefined; readonly command?: readonly string[] | undefined }

export type ProjectLinter = Covering & { readonly files: readonly string[] }

type Program = { readonly path: string; readonly command: readonly string[]; readonly env: Readonly<Record<string, string>> }

type StylelintResult = { readonly source?: string; readonly warnings: readonly { readonly line: number; readonly rule: string; readonly severity: string; readonly text: string }[] }

type Linter = {
  readonly extensions: readonly string[]
  readonly configExtensions?: (config: string) => readonly string[] | undefined
  readonly shebang?: RegExp
  readonly configs: readonly string[]
  readonly copies: readonly string[]
  readonly includes?: (config: string) => readonly string[]
  readonly inputs?: (config: string) => readonly string[]
  readonly isBuiltIn?: boolean
  readonly runsOnBun?: boolean
  readonly program: string
  readonly lintText?: (program: Program, folder: string, file: string, text: string, timeout: number) => Promise<readonly LinterFinding[]>
  lintFolder(program: Program, folder: string, files: readonly string[], timeout: number): Promise<readonly LinterFinding[]>
}

const SCRIPTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']
const MAGO_REPORT = ['--reporting-format', 'json']
const MAGO_LEVELS = ['note', 'help', 'warning', 'error']
const SHELLCHECK_REPORT = ['--format', 'json1']
const SELENE_REPORT = ['--display-style', 'json2', '--no-summary']
const STYLELINT_CONFIGS = ['.stylelintrc', ...['json', 'yaml', 'yml', 'js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map((extension) => `.stylelintrc.${extension}`), ...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map((extension) => `stylelint.config.${extension}`)]
const BIOME = `node_modules/@biomejs/cli-${process.platform}-${process.arch}`

export const LINTERS: Readonly<Record<LinterName, Linter>> = {
  mago: {
    extensions: ['.php'],
    configs: ['mago.toml'],
    copies: ['vendor/bin/mago'],
    configExtensions: (config) => {
      const extensions = magoConfig(config)?.source?.extensions
      return isStrings(extensions) ? extensions.map((extension) => `.${extension}`) : undefined
    },
    includes: (config) => {
      const includes = magoConfig(config)?.source?.includes
      return isStrings(includes) ? includes : []
    },
    inputs: (config) => [magoConfig(config)?.linter?.baseline, magoConfig(config)?.analyzer?.baseline].filter((baseline) => typeof baseline === 'string'),
    program: 'mago',
    lintText: async (program, folder, file, text, timeout) => magoFindings(folder, 'lint', await run(program, ['lint', '--stdin-input', ...MAGO_REPORT, file], folder, text, timeout, [0, 1])),
    lintFolder: async (program, folder, _files, timeout) => (await Promise.all((['lint', 'analyze'] as const).map(async (command) => magoFindings(folder, command, await run(program, [command, ...MAGO_REPORT], folder, undefined, timeout, [0, 1]))))).flat(),
  },
  oxlint: {
    extensions: SCRIPTS,
    configs: ['.oxlintrc.json', '.oxlintrc.jsonc', 'oxlint.config.ts', 'oxlint.config.mts'],
    copies: ['node_modules/oxlint/bin/oxlint'],
    isBuiltIn: true,
    runsOnBun: true,
    program: 'oxlint',
    lintText: async (program, folder, file, text, timeout) => diagnosticFindings(file, await openedDiagnostics([...program.command, '--lsp'], program.env, folder, file, text, timeout), oxlintRule),
    lintFolder: async (program, folder, _files, timeout) => {
      const { stdout } = await run(program, ['--format', 'json'], folder, undefined, timeout, [0, 1])
      const { diagnostics } = JSON.parse(stdout) as { diagnostics: readonly { code?: string; severity: string; message: string; help?: string; filename: string; labels: readonly { span: { line: number } }[] }[] }
      return diagnostics.map(({ code, severity, message, help, filename, labels }) => ({ file: resolve(folder, filename), line: labels[0]?.span.line ?? 1, level: levelOf(severity), rule: oxlintRule(code), message: oneLine(help === undefined ? message : `${message} help: ${help}`) }))
    },
  },
  biome: {
    extensions: [...SCRIPTS, '.css', '.json', '.jsonc'],
    configs: ['biome.json', 'biome.jsonc'],
    copies: [`${BIOME}/biome`, `${BIOME}-musl/biome`],
    isBuiltIn: true,
    program: 'biome',
    lintText: async (program, folder, file, text, timeout) => {
      let isIgnored = false
      const isIgnoredByServer = async (server: Server): Promise<boolean> => (isIgnored = await isIgnoredByBiome(server, folder, file))
      const [diagnostics, unformatted] = await Promise.all([openedDiagnostics([...program.command, 'lsp-proxy'], program.env, folder, file, text, timeout, isIgnoredByServer), biomeFormatFindings(program, folder, file, text, timeout)])
      if (isIgnored) return []
      return [...diagnosticFindings(file, diagnostics, biomeRule).map((finding) => (finding.rule.startsWith('biome/assist/') ? { ...finding, level: 'error' as const } : finding)), ...unformatted]
    },
    lintFolder: async (program, folder, _files, timeout) => {
      const { stdout } = await run(program, ['check', '--reporter', 'github', '--max-diagnostics', 'none'], folder, undefined, timeout, [0, 1])
      const found = stdout.split('\n').flatMap((line): readonly LinterFinding[] => {
        const match = /^::(error|warning|notice) title=([^,]*),file=([^,]*),line=(\d+),[^:]*::(.*)$/.exec(line)
        return match === null ? [] : [{ file: resolve(folder, unescaped(match[3] ?? '')), line: Number(match[4]), level: levelOf(match[1] ?? ''), rule: biomeRule(unescaped(match[2] ?? '')), message: oneLine(unescaped(match[5] ?? '')) }]
      })
      const unformatted = [...new Set(found.filter(({ rule }) => rule === 'biome/format').map(({ file }) => file))]
      const formats = await Promise.all(unformatted.map((file) => biomeFormatFindings(program, folder, file, readFileSync(file, 'utf8'), timeout)))
      return [...found.filter(({ rule }) => rule !== 'biome/format'), ...formats.flat()]
    },
  },
  stylelint: {
    extensions: ['.css'],
    configs: STYLELINT_CONFIGS,
    copies: ['node_modules/stylelint/bin/stylelint.mjs'],
    isBuiltIn: true,
    runsOnBun: true,
    program: 'stylelint',
    lintText: async (program, folder, file, text, timeout) => {
      const { default: stylelint } = (await import(Bun.resolveSync('stylelint', dirname(program.path)))) as typeof import('stylelint')
      return stylelintWarnings((await within(stylelint.lint({ code: text, codeFilename: file, cwd: folder }), timeout)).results)
    },
    lintFolder: async (program, folder, _files, timeout) => stylelintFindings(await run(program, ['**/*.css', '--formatter', 'json', '--allow-empty-input'], folder, undefined, timeout, [0, 2])),
  },
  ruff: {
    extensions: ['.py', '.pyi'],
    configs: ['ruff.toml', '.ruff.toml', 'pyproject.toml'],
    copies: ['.venv/bin/ruff'],
    program: 'ruff',
    lintText: async (program, folder, file, text, timeout) => ruffFindings(await run(program, ['check', '--output-format', 'json', '--force-exclude', '--stdin-filename', file, '-'], folder, text, timeout, [0, 1])),
    lintFolder: async (program, folder, _files, timeout) => ruffFindings(await run(program, ['check', '--output-format', 'json'], folder, undefined, timeout, [0, 1])),
  },
  selene: {
    extensions: ['.lua'],
    configs: ['selene.toml'],
    copies: [],
    program: 'selene',
    lintText: async (program, folder, file, text, timeout) => (isExcludedBySelene(folder, file) ? [] : seleneFindings(folder, file, await run(program, [...SELENE_REPORT, '-'], folder, text, timeout, [0, 1]))),
    lintFolder: async (program, folder, _files, timeout) => seleneFindings(folder, undefined, await run(program, [...SELENE_REPORT, '.'], folder, undefined, timeout, [0, 1])),
  },
  shellcheck: {
    extensions: ['.sh', '.bash', '.ksh', '.dash'],
    shebang: /^#!.*\b(sh|bash|dash|ksh)\b/,
    configs: [],
    copies: [],
    program: 'shellcheck',
    lintText: async (program, folder, file, text, timeout) => shellcheckFindings(folder, file, await run(program, [...SHELLCHECK_REPORT, ...shellOf(file, text), '-'], folder, text, timeout, [0, 1])),
    lintFolder: async (program, folder, files, timeout) => shellcheckFindings(folder, undefined, await run(program, [...SHELLCHECK_REPORT, ...files.map((file) => relative(folder, file))], folder, undefined, timeout, [0, 1])),
  },
  pint: {
    extensions: ['.php'],
    configs: ['pint.json'],
    copies: ['vendor/bin/pint'],
    program: 'pint',
    lintText: (program, folder, file, text, timeout) => pintFindings(program, folder, { file, text }, timeout),
    lintFolder: (program, folder, _files, timeout) => pintFindings(program, folder, undefined, timeout),
  },
  tsc: {
    extensions: SCRIPTS,
    configs: ['tsconfig.json'],
    copies: ['node_modules/typescript/bin/tsc'],
    runsOnBun: true,
    program: 'tsc',
    lintFolder: async (program, folder, _files, timeout) => tscFindings(folder, await run(program, ['-b', '--noEmit', '--pretty', 'false'], folder, undefined, timeout, [0, 1, 2])),
  },
}

export function coveringLinters(names: readonly LinterName[], programs: Partial<Record<LinterName, readonly string[]>>, file: string, text: string, root: string): readonly Covering[] {
  return names.flatMap((name): readonly Covering[] => {
    const linter = LINTERS[name]
    if (linter.configExtensions === undefined && !covers(linter, linter.extensions, file, () => text)) return []
    const covering = nearestCovering(name, file, root)
    return covers(linter, extensionsOf(linter, covering.config), file, () => text) ? [{ ...covering, command: programs[name] }] : []
  })
}

export function isLinterInput(name: LinterName, file: string, root: string): boolean {
  const linter = LINTERS[name]
  if (linter.configs.includes(basename(file))) return true
  const { config } = nearestCovering(name, file, root)
  return config !== undefined && (linter.inputs?.(readFileSync(config, 'utf8')) ?? []).some((input) => resolve(dirname(config), input) === file)
}

function nearestCovering(name: LinterName, file: string, root: string): Covering {
  for (let folder = dirname(file); ; folder = dirname(folder)) {
    const config = LINTERS[name].configs.map((config) => join(folder, config)).find(isConfig)
    if (config !== undefined) return { name, folder, config }
    if (folder === root || dirname(folder) === folder) return { name, folder: existingFolder(dirname(file)), config: undefined }
  }
}

export function projectLinters(names: readonly LinterName[], programs: Partial<Record<LinterName, readonly string[]>>, files: readonly string[], root: string): readonly ProjectLinter[] {
  return names.flatMap((name): readonly ProjectLinter[] => {
    const linter = LINTERS[name]
    const outermost = new Map<string, string | undefined>()
    const configOf = (folder: string): string | undefined => {
      if (outermost.has(folder)) return outermost.get(folder)
      const above = folder === root || dirname(folder) === folder ? undefined : configOf(dirname(folder))
      const config = above ?? linter.configs.map((config) => join(folder, config)).find(isConfig)
      outermost.set(folder, config)
      return config
    }
    const runs = new Map<string, { name: LinterName; folder: string; config: string | undefined; command: readonly string[] | undefined; files: string[] }>()
    const extensions = new Map<string | undefined, readonly string[]>()
    for (const file of files) {
      const config = configOf(dirname(file))
      if (!extensions.has(config)) extensions.set(config, extensionsOf(linter, config))
      if (!covers(linter, extensions.get(config) ?? linter.extensions, file, () => firstLine(file))) continue
      const run = runs.get(config ?? '') ?? { name, folder: config === undefined ? root : dirname(config), config, command: programs[name], files: [] }
      run.files.push(file)
      runs.set(config ?? '', run)
    }
    return [...runs.values()]
  })
}

export async function lintText(linter: Covering, file: string, text: string, timeout: number): Promise<readonly LinterFinding[]> {
  const check = LINTERS[linter.name].lintText
  return check === undefined ? [] : check(await programOf(linter), linter.folder, file, text, timeout)
}

export async function lintFolder(linter: ProjectLinter, timeout: number): Promise<readonly LinterFinding[]> {
  return LINTERS[linter.name].lintFolder(await programOf(linter), linter.folder, linter.files, timeout)
}

function extensionsOf(linter: Linter, config: string | undefined): readonly string[] {
  return (config === undefined ? undefined : linter.configExtensions?.(readFileSync(config, 'utf8'))) ?? linter.extensions
}

function covers(linter: Linter, extensions: readonly string[], file: string, firstLineOf: () => string): boolean {
  const extension = extname(file)
  return extensions.includes(extension) || (extension === '' && linter.shebang?.test(firstLineOf()) === true)
}

function isConfig(file: string): boolean {
  if (!existsSync(file)) return false
  if (basename(file) !== 'pyproject.toml') return true
  return /^\s*\[tool\.ruff[.\]]/m.test(readFileSync(file, 'utf8'))
}

function firstLine(file: string): string {
  if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return ''
  const handle = openSync(file, 'r')
  try {
    const start = Buffer.alloc(256)
    return start.subarray(0, readSync(handle, start)).toString().split('\n', 1)[0] ?? ''
  } finally {
    closeSync(handle)
  }
}

async function programOf({ name, folder, command }: Covering): Promise<Program> {
  const linter = LINTERS[name]
  if (command !== undefined) return { path: resolve(folder, command[0] ?? ''), command, env: {} }
  const copy = copyAbove(linter, folder) ?? (linter.isBuiltIn === true ? copyAbove(linter, await builtInFolder()) : undefined)
  if (copy !== undefined) return linter.runsOnBun === true ? { path: copy, command: [process.execPath, copy], env: { BUN_BE_BUN: '1' } } : { path: copy, command: [copy], env: {} }
  if (linter.isBuiltIn === true) throw new Error(`this rulebook build holds no ${name}. Build it with the build script in cli/package.json, which builds oxlint, Biome, and Stylelint in.`)
  const onPath = Bun.which(linter.program, { PATH: process.env.PATH ?? '' })
  if (onPath !== null) return { path: onPath, command: [onPath], env: {} }
  const places = [...linter.copies.map((copy) => `${copy} in ${folder} or a folder above it`), `${linter.program} on PATH`]
  throw new Error(`linters names ${name}, but no ${name} program is installed: there is no ${places.join(' and no ')}. Install ${name}, or take ${name} out of linters in rulebook.config.ts.`)
}

function copyAbove(linter: Linter, folder: string): string | undefined {
  for (let dir = folder; ; dir = dirname(dir)) {
    const copy = linter.copies.map((path) => join(dir, path)).find((path) => existsSync(path))
    if (copy !== undefined || dirname(dir) === dir) return copy
  }
}

export function cacheFolder(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'rulebook', packageJson.version)
}

let builtIn: Promise<string> | undefined

function builtInFolder(): Promise<string> {
  builtIn ??= Bun.isStandaloneExecutable ? extractedLinters() : Promise.resolve(import.meta.dir)
  return builtIn
}

async function extractedLinters(): Promise<string> {
  const embedded = (Bun.embeddedFiles as readonly Bun.BunFile[]).find((file) => /(^|\/)linters-[^/]*\.tgz$/.test(file.name ?? ''))
  if (embedded?.name === undefined) throw new Error('this rulebook build holds no oxlint, Biome, or Stylelint. Build it with the build script in cli/package.json, which builds them in.')
  const folder = join(cacheFolder(), basename(embedded.name, '.tgz'))
  if (existsSync(folder)) return folder
  const partial = `${folder}.${crypto.randomUUID()}`
  await new Bun.Archive(await embedded.bytes()).extract(partial)
  try {
    renameSync(partial, folder)
  } catch (error) {
    rmSync(partial, { recursive: true, force: true })
    if (!existsSync(folder)) throw error
  }
  return folder
}

async function run(program: Program, args: readonly string[], cwd: string, stdin: string | undefined, timeout: number, passing: readonly number[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const output = mkdtempSync(join(tmpdir(), 'rulebook-linter-'))
  try {
    const [stdoutFile, stderrFile] = [join(output, 'stdout'), join(output, 'stderr')]
    const started = performance.now()
    const child = Bun.spawn([...program.command, ...args], { cwd, env: { ...process.env, ...program.env }, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: Bun.file(stdoutFile), stderr: Bun.file(stderrFile), timeout })
    const code = await child.exited
    const [stdout, stderr] = [stdoutFile, stderrFile].map((file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')) as [string, string]
    if (child.signalCode !== null) throw new Error(performance.now() - started >= timeout ? `it ran past ${seconds(timeout)}` : `it stopped on ${child.signalCode}`)
    if (!passing.includes(code)) throw new Error(`it exited ${code}: ${oneLine(stderr) || oneLine(stdout)}`)
    return { stdout, stderr }
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
}

function diagnosticFindings(file: string, diagnostics: readonly Diagnostic[], ruleOf: (code: string | undefined) => string | undefined): readonly LinterFinding[] {
  return diagnostics.flatMap(({ range, severity = 1, code, message }) => {
    const rule = ruleOf(code === undefined ? undefined : String(code))
    return rule === undefined ? [] : [{ file, line: range.start.line + 1, level: severity === 1 ? 'error' : 'warning', rule, message: oneLine(message) }]
  })
}

function oxlintRule(code: string | undefined): string {
  const match = /^([^(]+)\((.+)\)$/.exec(code ?? '')
  if (match === null) return `oxlint/${code ?? 'syntax'}`
  return match[1] === 'eslint' ? `oxlint/${match[2]}` : `oxlint/${match[1]}/${match[2]}`
}

function biomeRule(code: string | undefined): string {
  return `biome/${code?.replace(/^lint\//, '') ?? 'syntax'}`
}

async function biomeFormatFindings(program: Program, folder: string, file: string, text: string, timeout: number): Promise<readonly LinterFinding[]> {
  const { stdout } = await run(program, ['format', '--stdin-file-path', relative(folder, file)], folder, text, timeout, [0, 1])
  if (stdout === '' || stdout === text) return []
  const written = text.split('\n')
  const formatted = stdout.split('\n')
  const changed = written.findIndex((line, index) => line !== formatted[index])
  return [{ file, line: changed === -1 ? written.length : changed + 1, level: 'error', rule: 'biome/format', message: "The file breaks Biome's formatting, and Biome's first change is on this line. Run biome format on the file to fix it." }]
}

async function isIgnoredByBiome(server: Server, folder: string, file: string): Promise<boolean> {
  await server.asked('client/registerCapability')
  const { projectKey } = (await server.request('biome/open_project', { path: folder, openUninitialized: true })) as { projectKey: number }
  return (await server.request('biome/is_path_ignored', { projectKey, path: file, features: ['lint'], ignoreKind: 'ancestors' })) === true
}

type MagoSection = { readonly [key: string]: unknown }

function magoConfig(text: string): { readonly source?: MagoSection; readonly linter?: MagoSection; readonly analyzer?: MagoSection } | undefined {
  try {
    return Bun.TOML.parse(text) as { source?: MagoSection; linter?: MagoSection; analyzer?: MagoSection }
  } catch {
    return undefined
  }
}

function magoFindings(folder: string, command: 'lint' | 'analyze', { stdout }: { readonly stdout: string }): readonly LinterFinding[] {
  if (stdout.trim() === '') return []
  const config = join(folder, 'mago.toml')
  const settings = existsSync(config) ? magoConfig(readFileSync(config, 'utf8')) : undefined
  const level = settings?.[command === 'lint' ? 'linter' : 'analyzer']?.['minimum-fail-level']
  const failing = MAGO_LEVELS.indexOf(typeof level === 'string' ? level.toLowerCase() : 'error')
  const { issues } = JSON.parse(stdout) as { issues: readonly { level: string; code: string; message: string; annotations: readonly { kind: string; message?: string; span: { file_id: { name: string }; start: { line: number } } }[] }[] }
  return issues.flatMap(({ level, code, message, annotations }) => {
    const primary = annotations.find(({ kind }) => kind === 'Primary') ?? annotations[0]
    return primary === undefined ? [] : [{ file: resolve(folder, primary.span.file_id.name), line: primary.span.start.line + 1, level: MAGO_LEVELS.indexOf(level.toLowerCase()) >= failing ? 'error' : 'warning', rule: `mago/${code}`, message: oneLine(primary.message === undefined ? message : `${message} ${primary.message}`) }]
  })
}

function stylelintFindings({ stdout, stderr }: { readonly stdout: string; readonly stderr: string }): readonly LinterFinding[] {
  const output = [stdout, stderr].find((text) => text.trimStart().startsWith('['))
  if (output === undefined) throw new Error(`it printed no results: ${oneLine(stderr) || oneLine(stdout)}`)
  return stylelintWarnings(JSON.parse(output) as readonly StylelintResult[])
}

function stylelintWarnings(results: readonly StylelintResult[]): readonly LinterFinding[] {
  return results.flatMap(({ source = '', warnings }) => warnings.map(({ line, rule, severity, text }) => ({ file: source, line, level: levelOf(severity), rule: `stylelint/${rule}`, message: oneLine(text.replace(` (${rule})`, '')) })))
}

async function within<T>(work: Promise<T>, timeout: number): Promise<T> {
  let timer: Timer | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`it ran past ${seconds(timeout)}`)), timeout)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

function ruffFindings({ stdout }: { readonly stdout: string }): readonly LinterFinding[] {
  const diagnostics = JSON.parse(stdout) as readonly { code: string | null; message: string; filename: string; location: { row: number }; severity?: string }[]
  return diagnostics.map(({ code, message, filename, location, severity = 'error' }) => ({ file: filename, line: location.row, level: levelOf(severity), rule: `ruff/${code ?? 'syntax-error'}`, message: oneLine(message) }))
}

function isExcludedBySelene(folder: string, file: string): boolean {
  const config = join(folder, 'selene.toml')
  if (!existsSync(config)) return false
  const { exclude = [] } = Bun.TOML.parse(readFileSync(config, 'utf8')) as { exclude?: readonly string[] }
  const path = relative(folder, file)
  return exclude.some((glob) => new Bun.Glob(glob).match(path))
}

function seleneFindings(folder: string, file: string | undefined, { stdout, stderr }: { readonly stdout: string; readonly stderr: string }): readonly LinterFinding[] {
  if (stderr.includes('ERROR')) throw new Error(oneLine(stderr))
  return stdout.split('\n').filter((line) => line.startsWith('{')).flatMap((line) => {
    const output = JSON.parse(line) as { type: string; severity?: string; code?: string | null; message?: string; primary_label?: { filename: string; span: { start_line: number } } }
    if (output.type !== 'Diagnostic' || output.primary_label === undefined) return []
    return [{ file: file ?? resolve(folder, output.primary_label.filename), line: output.primary_label.span.start_line + 1, level: levelOf(output.severity ?? ''), rule: `selene/${output.code ?? 'parse_error'}`, message: oneLine(output.message ?? '') }]
  })
}

function shellOf(file: string, text: string): readonly string[] {
  const extension = extname(file).slice(1)
  return text.startsWith('#!') || !['bash', 'ksh', 'dash'].includes(extension) ? [] : ['--shell', extension]
}

function shellcheckFindings(folder: string, file: string | undefined, { stdout }: { readonly stdout: string }): readonly LinterFinding[] {
  const { comments } = JSON.parse(stdout) as { comments: readonly { file: string; line: number; level: string; code: number; message: string }[] }
  return comments.map((comment) => ({ file: file ?? resolve(folder, comment.file), line: comment.line, level: levelOf(comment.level), rule: `shellcheck/SC${comment.code}`, message: oneLine(comment.message) }))
}

async function pintFindings(program: Program, folder: string, pending: { readonly file: string; readonly text: string } | undefined, timeout: number): Promise<readonly LinterFinding[]> {
  const temporary = mkdtempSync(join(tmpdir(), 'rulebook-pint-'))
  try {
    const project = pending === undefined ? folder : join(temporary, 'project')
    if (pending !== undefined) {
      const copy = join(project, relative(folder, pending.file))
      mkdirSync(dirname(copy), { recursive: true })
      writeFileSync(copy, pending.text)
    }
    const config = join(folder, 'pint.json')
    const report = join(temporary, 'report.json')
    const args = ['--test', '-v', '--format', 'agent', '--output-to-file', report, '--output-format', 'json', ...(existsSync(config) ? ['--config', config] : []), ...(pending === undefined ? [] : ['--cache-file', join(temporary, 'cache')])]
    const { stdout, stderr } = await run(program, args, project, undefined, timeout, [0, 1])
    if (!existsSync(report)) throw new Error(`it wrote no report: ${oneLine(stderr) || oneLine(stdout)}`)
    const fileOf = (path: string): string => pending?.file ?? resolve(folder, path)
    const { errors = [] } = JSON.parse(stdout) as { errors?: readonly { path: string; message: string }[] }
    const { files } = JSON.parse(readFileSync(report, 'utf8')) as { files: readonly { name: string; appliedFixers: readonly string[]; diff: string }[] }
    return [
      ...files.flatMap(({ name, appliedFixers, diff }) => appliedFixers.map((fixer) => ({ file: fileOf(name), line: firstChangedLine(diff), level: 'error' as const, rule: `pint/${fixer}`, message: `The file breaks Pint's ${fixer}, and Pint's first change is on this line. Run pint on the file to fix it.` }))),
      ...errors.map(({ path, message }) => ({ file: fileOf(path), line: Number(/on line (\d+)/.exec(message)?.[1] ?? 1), level: 'error' as const, rule: 'pint/error', message: oneLine(message) })),
    ]
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function firstChangedLine(diff: string): number {
  const rows = diff.split('\n')
  const hunk = rows.findIndex((row) => row.startsWith('@@ '))
  let line = Number(/^@@ -(\d+)/.exec(rows[hunk] ?? '')?.[1] ?? 1)
  for (const row of rows.slice(hunk + 1)) {
    if (row.startsWith('-') || row.startsWith('+')) break
    line += 1
  }
  return Math.max(line, 1)
}

function tscFindings(folder: string, { stdout }: { readonly stdout: string }): readonly LinterFinding[] {
  const findings: { file: string; line: number; level: Level; rule: string; message: string }[] = []
  for (const line of stdout.split('\n').filter((line) => line.trim() !== '')) {
    const match = /^(.+)\((\d+),\d+\): (error|warning) TS(\d+): (.*)$/.exec(line)
    const last = findings.at(-1)
    if (match !== null && SCRIPTS.includes(extname(match[1] ?? ''))) findings.push({ file: resolve(folder, match[1] ?? ''), line: Number(match[2]), level: levelOf(match[3] ?? ''), rule: `tsc/TS${match[4]}`, message: match[5] ?? '' })
    else if (match === null && line.startsWith(' ') && last !== undefined) last.message = `${last.message} ${line.trim()}`
    else throw new Error(`it reported an error outside every JavaScript and TypeScript file: ${line}`)
  }
  return findings
}

function unescaped(text: string): string {
  return text.replace(/%(25|0D|0A|3A|2C)/gi, (escape) => decodeURIComponent(escape))
}

function levelOf(severity: string): Level {
  return severity.toLowerCase() === 'error' ? 'error' : 'warning'
}
