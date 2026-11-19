import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type { NapiConfig, SgNode } from '@ast-grep/napi'
import type { ParsedShell } from '@cmodjs/core/shell.js'
import type { Call, Command, Context, Node, Rule, RuleSettings, Runs, Severity, Shell, SourceCode, Visitors } from './api.ts'
import { COMMAND, importsRule, noSuppressionsRule } from './check.ts'
import type { Import } from './claude-md.ts'
import { isRecord, isRuns, isSeverity, isStrings, isThreshold, isTimeout, rootRelative, type Settings } from './config.ts'
import { isJev } from './jev.ts'
import { cacheFolder } from './linters.ts'
import { importDefault } from './modules.ts'

export type Level = 'error' | 'warning'

export type Finding = { readonly line: number; readonly message?: string; readonly isWhole?: true }

export type CheckedFile = {
  readonly root: string
  readonly path: string
  readonly text: string
  readonly lines: readonly string[]
  readonly shell?: ParsedShell
  readonly call?: Call
}

type Common = {
  readonly id: string
  readonly source: string
  readonly description: string
  readonly message: string | undefined
  readonly level: Level | 'off'
  readonly runs: Runs
  readonly files: readonly string[] | undefined
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
const COMMON_KEYS = ['description', 'message', 'files', 'severity', 'runs']
const SCRIPT_KEYS = new Set([...COMMON_KEYS, 'create'])
const FRONTMATTER_KEYS = new Set([...COMMON_KEYS, 'timeout', 'threshold', 'agent', 'model', 'effort', 'allowed-tools', 'disallowed-tools'])
const CLAUDE_KEYS = ['agent', 'effort', 'allowed-tools', 'disallowed-tools'] as const
const PATTERN_KEYS = new Set([...COMMON_KEYS, 'language', 'rule'])
const LANGUAGES = ['typescript', 'tsx', 'javascript', 'html', 'css', 'php', 'python', 'bash', 'lua', 'json', 'yaml', 'toml', 'markdown', 'rust']
const EXTENSIONS: Readonly<Record<string, string>> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  html: 'html', htm: 'html', css: 'css', php: 'php', phpt: 'php', py: 'python', pyi: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', bats: 'bash',
  lua: 'lua', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown', mdx: 'markdown', markdown: 'markdown', rs: 'rust',
}

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
          rules.push({ ...rule, files: rule.files && rootRelative(config.basePath, rule.files) })
        } catch (error) {
          failures.push(`${error instanceof Error ? error.message : String(error)} The rule ${id} checks nothing until it loads.`)
        }
      }
    }
  }
  for (const id of Object.keys(settings.rules)) if (!ids.has(id)) throw new Error(`A rulebook config sets the rule "${id}", which no plugin holds. The rules are ${[...ids].join(', ')}.`)
  const loaded = rules.map((rule) => overridden(rule, settings.rules[rule.id]))
  for (const { id, files, level } of loaded) {
    if (files === undefined && level !== 'off' && settings.files.length === 0) failures.push(`The rule ${id} has no files, and no config lists files, so it checks no file. Give the rule files, such as files: ['**/*.ts'].`)
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
  if (!isRecord(rule) || typeof rule.create !== 'function') throw new Error(`${source}: the default export is not a rule. Export defineRule({ description, create }).`)
  for (const key of Object.keys(rule)) if (!SCRIPT_KEYS.has(key)) throw new Error(`${source}: rulebook does not read the key "${key}". It reads ${[...SCRIPT_KEYS].join(', ')}.`)
  const create = rule.create as Rule['create']
  return { ...commonOf(id, source, rule), kind: 'static', check: (file) => visited(source, create, file) }
}

async function visited(source: string, create: Rule['create'], file: CheckedFile): Promise<readonly Finding[]> {
  const found: Finding[] = []
  const language = languageOf(file.path)
  const sourceCode = await sourceCodeOf(file, language)
  const context: Context = {
    root: file.root,
    filename: file.path.startsWith('@') ? file.path : resolve(file.root, file.path),
    sourceCode,
    ...(file.call === undefined ? {} : { call: file.call }),
    report: (problem) => {
      found.push('loc' in problem ? { line: problem.loc.start.line } : findingOf(problem.node))
    },
  }
  const visitors: Visitors = await create(context)
  if (!isRecord(visitors)) throw new Error(`${source}: create returns an object of visitors, such as { call_expression(call) { … } }.`)
  const kinds = Object.keys(visitors).filter((key) => key !== 'Command')
  const unknown = await unknownKinds(kinds)
  if (unknown.length > 0) throw new Error(`${source}: create returns the visitor "${unknown[0]}", which names no node. A visitor names Command or a node kind of ${LANGUAGES.join(', ')}.`)
  const { ast } = sourceCode
  if (isShell(ast)) {
    if (visitors.Command !== undefined) for (const command of ast.commands) await visitors.Command(command)
  } else if (language !== undefined) {
    const own = await ownKinds(language, kinds)
    if (own.length > 0) for (const node of (ast as SgNode).findAll({ rule: { any: own.map((kind) => ({ kind })) } })) await (visitors[node.kind()] as (node: SgNode) => void | Promise<void>)(node)
  }
  return found
}

function findingOf(node: Node): Finding {
  if ('lineNumber' in node) return { line: node.lineNumber }
  if (!('kind' in node) || node.parent() === null) return { line: 1, isWhole: true }
  return { line: node.range().start.line + 1 }
}

function isShell(node: Node): node is Shell {
  return 'commands' in node
}

const sourceCodes = new WeakMap<CheckedFile, Promise<SourceCode>>()

function sourceCodeOf(file: CheckedFile, language: string | undefined): Promise<SourceCode> {
  const known = sourceCodes.get(file)
  if (known !== undefined) return known
  const sourceCode = parsed(file, language)
  sourceCodes.set(file, sourceCode)
  return sourceCode
}

async function parsed({ text, lines, shell }: CheckedFile, language: string | undefined): Promise<SourceCode> {
  if (shell !== undefined) return { text, lines, ast: { commands: commandsOf(shell, lines), reads: shell.reads, writes: shell.writes, fetches: shell.fetches, isFullyParsed: shell.isFullyParsed } }
  if (language === undefined) return { text, lines, ast: { text } }
  const { parse } = await (astGrep ??= loadAstGrep())
  let root: SgNode | undefined
  return {
    text,
    lines,
    get ast() {
      root ??= parse(language, text).root()
      return root
    },
  }
}

function languageOf(path: string): string | undefined {
  if (path === COMMAND) return undefined
  if (path.startsWith('@')) return 'markdown'
  return EXTENSIONS[extname(path).slice(1).toLowerCase()]
}

function commandsOf(shell: ParsedShell, lines: readonly string[]): readonly Command[] {
  return shell.commands.map(({ argv, folder, input, runner }) => {
    const index = lines.findIndex((line) => line.includes(argv[0]))
    return { lineNumber: index === -1 ? 1 : index + 1, program: basename(argv[0]), args: argv.slice(1), argv, folder, ...(input === undefined ? {} : { input }), ...(runner === undefined ? {} : { runner }) }
  })
}

const kindsOfLanguages = new Map<string, boolean>()

async function ownKinds(language: string, kinds: readonly string[]): Promise<readonly string[]> {
  const { parse } = await (astGrep ??= loadAstGrep())
  return kinds.filter((kind) => {
    const key = `${language}\0${kind}`
    let isOwn = kindsOfLanguages.get(key)
    if (isOwn === undefined) {
      try {
        parse(language, '').root().findAll({ rule: { kind } })
        isOwn = true
      } catch {
        isOwn = false
      }
      kindsOfLanguages.set(key, isOwn)
    }
    return isOwn
  })
}

async function unknownKinds(kinds: readonly string[]): Promise<readonly string[]> {
  if (kinds.length === 0) return []
  const known = new Set((await Promise.all(LANGUAGES.map((language) => ownKinds(language, kinds)))).flat())
  return kinds.filter((kind) => !known.has(kind))
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
  if (frontmatter.timeout !== undefined && !isTimeout(frontmatter.timeout)) fail('timeout is a whole number of milliseconds above 0.')
  if (frontmatter.threshold !== undefined && !isThreshold(frontmatter.threshold)) fail('threshold is a probability above 0 and at most 1.')
  if (body === '') fail('the rule has no body. The body is the check.')
  if (isJev(frontmatter.model)) for (const key of CLAUDE_KEYS) if (frontmatter[key] !== undefined) fail(`model jev runs the rule on Jev, which runs no agent, so rulebook does not read ${key}.`)
  if (frontmatter.threshold !== undefined && !isJev(frontmatter.model)) fail('threshold is the probability Jev must give a line to pass, so it needs model: jev.')
  return {
    ...commonOf(id, source, frontmatter),
    kind: 'agentic',
    timeout: (frontmatter.timeout as number | undefined) ?? timeout,
    body,
    agent: frontmatter.agent as string | undefined,
    model: frontmatter.model as string | undefined,
    effort: frontmatter.effort as string | undefined,
    threshold: frontmatter.threshold as number | undefined,
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
  const [napi, php, python, bash, lua, json, yaml, toml, markdown, rust] = await Promise.all([
    import('@ast-grep/napi'),
    import('@ast-grep/lang-php'),
    import('@ast-grep/lang-python'),
    import('@ast-grep/lang-bash'),
    import('@ast-grep/lang-lua'),
    import('@ast-grep/lang-json'),
    import('@ast-grep/lang-yaml'),
    import('@ast-grep/lang-toml'),
    import('@ast-grep/lang-markdown'),
    import('@ast-grep/lang-rust'),
  ])
  const packages = { php, python, bash, lua, json, yaml, toml, markdown, rust }
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
  const { description, message, severity, runs } = keys
  if (typeof description !== 'string' || description.trim() === '' || description.trim().includes('\n')) return fail('a rule needs a description: the Rule in one line of plain words, such as "Don\'t write em dashes."')
  if (message !== undefined && (typeof message !== 'string' || message.trim() === '')) fail('message is the text of each finding, a string. Leave it out to show the description.')
  if (severity !== undefined && !isSeverity(severity)) fail('severity is "error" or "warn".')
  if (runs !== undefined && !isRuns(runs)) fail('runs is "always" or "manual".')
  return {
    id,
    source,
    description: description.trim(),
    message: typeof message === 'string' ? message.trim() : undefined,
    level: levelOf((severity as Severity | undefined) ?? 'error'),
    runs: (runs as Runs | undefined) ?? 'always',
    files: filesOf(source, keys.files),
  }
}

export function levelOf(severity: Severity): Level {
  return severity === 'warn' ? 'warning' : 'error'
}

function filesOf(source: string, files: unknown): readonly string[] | undefined {
  if (files === undefined) return undefined
  if (typeof files === 'string') return files.split(',').map((file) => file.trim()).filter((file) => file !== '')
  if (isStrings(files)) return files
  throw new Error(`${source}: files is a list of globs or a comma-separated string.`)
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
  const { severity, runs, files } = override
  const common = { ...rule, ...(severity === undefined ? {} : { level: severity === 'off' ? 'off' as const : levelOf(severity) }), ...(runs === undefined ? {} : { runs }), ...(files === undefined ? {} : { files }) }
  if (common.kind === 'static') {
    for (const key of ['agent', 'model', 'effort', 'timeout', 'threshold'] as const) if (override[key] !== undefined) throw new Error(`A rulebook config sets ${key} on ${rule.id}, a static rule, which runs no agent.`)
    return common
  }
  const agentic = { ...common, ...(override.timeout === undefined ? {} : { timeout: override.timeout }), ...(override.agent === undefined ? {} : { agent: override.agent }), ...(override.model === undefined ? {} : { model: override.model }), ...(override.effort === undefined ? {} : { effort: override.effort }), ...(override.threshold === undefined ? {} : { threshold: override.threshold }) }
  if (isJev(agentic.model)) for (const key of ['agent', 'effort'] as const) if (override[key] !== undefined) throw new Error(`A rulebook config sets ${key} on ${rule.id}, which runs on Jev, and Jev runs no agent.`)
  if (!isJev(agentic.model) && override.threshold !== undefined) throw new Error(`A rulebook config sets threshold on ${rule.id}, which runs on Claude Code. threshold is the probability Jev must give a line to pass, so it needs model: 'jev'.`)
  return agentic
}
