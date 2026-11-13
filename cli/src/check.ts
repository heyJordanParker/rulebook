import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import { diffArrays } from 'diff'
import picomatch from 'picomatch/posix'
import type { Finding, Level, LinterName, CheckedFile } from './api.ts'
import { runAgentic } from './agent.ts'
import { importedFile, isClaudeMd, readClaudeMd } from './claude-md.ts'
import { isInside, type Settings } from './config.ts'
import { isJev, runJev } from './jev.ts'
import { coveringLinters, LINTERS, lintFolder, lintText, projectLinters, type Covering, type ProjectLinter } from './linters.ts'
import { seconds } from './lsp.ts'
import type { LoadedRule, StaticRule } from './rules.ts'

type Scope = 'edit' | 'commit' | 'all'

export type Reported = {
  readonly rule: string
  readonly line: number
  readonly level: Level
  readonly message: string
  readonly quote: string
  readonly isExisting: boolean
}

type Failure = { readonly rule: string; readonly reason: string }

export type FileReport = {
  readonly path: string
  readonly findings: readonly Reported[]
  readonly failures: readonly Failure[]
}

type CheckOptions = {
  readonly scope: Scope
  readonly previous?: string | undefined
  readonly imported: () => Promise<ReadonlySet<string>>
  readonly input?: Readonly<Record<string, unknown>>
  readonly skip?: readonly string[]
}

const PIN = /^\s*<!--\s*rulebook-expect\s+(\S+)\s*-->\s*$/
const MAX_EDIT_LENGTH = 1_000

function matches(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => globRegExp(glob).test(path))
}

const regExps = new Map<string, RegExp>()

export function globRegExp(glob: string): RegExp {
  const known = regExps.get(glob)
  if (known !== undefined) return known
  const { source, flags } = picomatch.makeRe(glob, { dot: true, posix: true, strictSlashes: true })
  const regExp = new RegExp(`${glob.startsWith('@') ? '(?=@)' : '(?!@)'}${source}`, flags)
  regExps.set(glob, regExp)
  return regExp
}

export function displayPath(settings: Settings, file: string): string {
  if (file.startsWith('@')) return file
  for (const [name, { folder }] of Object.entries(settings.messages)) {
    if (folder !== undefined && isInside(folder, file)) return `@${name}/${relative(folder, file)}`
  }
  return isInside(settings.root, file) ? relative(settings.root, file) : file
}

export function isCovered(settings: Settings, rules: readonly LoadedRule[], file: string): boolean {
  const path = displayPath(settings, file)
  return rules.some((rule) => covers(rule, path, false))
}

function isProbe(settings: Settings, file: string): boolean {
  return settings.configs.some((config) => isInside(config.dir, file) && matches(config.probes, relative(config.dir, file)))
}

export function isPrompt(settings: Settings, file: string): boolean {
  return isInside(settings.root, file) && matches(settings.paths, relative(settings.root, file))
}

export async function checkFile(settings: Settings, rules: readonly LoadedRule[], file: string, text: string, options: CheckOptions): Promise<FileReport | undefined> {
  const path = displayPath(settings, file)
  const isMessage = path.startsWith('@')
  const probe = !isMessage && isProbe(settings, file)
  const configured = probe || (!isMessage && isPrompt(settings, file))
  const isMemory = !isMessage && isClaudeMd(file)
  const imported = !isMessage && !(configured && isMemory) && existsSync(file) && (await options.imported()).has(realpathSync(file))
  const covered = rules.filter((rule) => inScope(rule, options) && covers(rule, path, configured || imported))
  const linted = !isMessage && !probe ? coveringLinters(settings.linters.filter((name) => !isSkipped(options.skip, name)), settings.programs, file, text, settings.root) : []
  if (!configured && !imported && covered.length === 0 && linted.length === 0) return undefined
  const written = text.split('\n')
  const isDoc = imported || isMemory
  const mayPin = text.includes('rulebook-expect')
  const claudeMd = isDoc || probe || (mayPin && written.some((line) => PIN.test(line))) ? readClaudeMd(text) : undefined
  const memory = isDoc ? claudeMd : undefined
  const prompt: CheckedFile = { root: settings.root, path, ...(memory === undefined ? { text, lines: written } : { text: memory.lines.join('\n'), lines: memory.lines }), ...(options.input === undefined ? {} : { input: options.input }) }
  const doc = memory === undefined ? undefined : { file, imports: memory.imports }
  const pins = mayPin ? pinsOf(written, claudeMd?.lines ?? []) : []
  const pinned = new Set(pins.map(({ rule }) => rule))
  const chosen = probe ? rules.filter((rule) => inScope(rule, options) && pinned.has(rule.id)) : covered
  const wrote = options.previous === undefined ? undefined : linesWritten(options.previous, written)
  const changed = wrote === undefined ? undefined : [...wrote].filter((line) => written[line - 1]?.trim() !== '')

  const linting = Promise.all((options.scope === 'edit' ? linted : []).map((linter) => linterFlags(linter, file, text, settings.timeout)))
  const longest = Math.max(0, ...chosen.flatMap((rule) => (rule.kind === 'agentic' ? [rule.timeout] : [])))
  const deadline = new AbortController()
  const timer = longest === 0 ? undefined : setTimeout(() => deadline.abort(new Error(`it ran past ${seconds(longest)}`)), longest)
  const runs = await Promise.all(chosen.map(async (rule) => {
    try {
      const found = rule.kind === 'static' ? await rule.check(prompt, doc) : isJev(rule.model) ? await runJev(rule, prompt, deadline.signal) : await runAgentic(rule, prompt, settings.root, changed, deadline.signal)
      return { rule, found: validFindings(rule.id, prompt, found) }
    } catch (error) {
      return { rule, failure: error instanceof Error ? error.message : String(error) }
    }
  })).finally(() => clearTimeout(timer))

  const lints = await linting
  const failures = [...runs.flatMap((run) => ('failure' in run ? [{ rule: run.rule.id, reason: run.failure }] : [])), ...lints.flatMap((lint) => lint.failures)]
  const found = [...runs.flatMap((run) => ('found' in run ? run.found.map(({ line, message }) => ({ line, message: message ?? run.rule.description, rule: run.rule.id, level: run.rule.level === 'off' ? 'error' as const : run.rule.level })) : [])), ...lints.flatMap((lint) => lint.flags)]
  const unscoped = new Set(rules.filter((rule) => !inScope(rule, options)).map(({ id }) => id))
  const flagged = probe ? probeFindings(found, pins.filter(({ rule }) => !unscoped.has(rule))) : [...found, ...pins.map((pin) => ({ rule: 'rulebook/pins', line: pin.line, level: 'error' as const, message: 'A rulebook-expect pin works only in a probe file. Remove it.' }))]

  return {
    path,
    failures,
    findings: flagged
      .map((finding) => {
        const quote = written[finding.line - 1] ?? ''
        const isExisting = wrote !== undefined && !wrote.has(finding.line)
        return { ...finding, quote, isExisting, level: isExisting && finding.level === 'error' ? settings.existingErrors : finding.level }
      })
      .sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule)),
  }
}

export async function lintProject(groups: ReadonlyMap<Settings, readonly string[]>, reports: readonly FileReport[], only?: readonly string[]): Promise<readonly FileReport[]> {
  const linters = new Map<string, { readonly linter: ProjectLinter; readonly settings: Settings; readonly timeout: number }>()
  for (const [settings, files] of groups) {
    for (const linter of projectLinters(settings.linters, settings.programs, files, settings.root)) {
      const key = `${linter.name}\0${linter.config ?? ''}`
      const known = linters.get(key)
      linters.set(key, known === undefined ? { linter, settings, timeout: settings.timeout } : { ...known, linter: { ...known.linter, files: [...known.linter.files, ...linter.files] }, timeout: Math.max(known.timeout, settings.timeout) })
    }
  }
  const runs = await Promise.all([...linters.values()].map(async ({ linter, settings, timeout }) => {
    try {
      return { linter, settings, found: await lintFolder(linter, timeout) }
    } catch (error) {
      return { linter, settings, failure: error instanceof Error ? error.message : String(error) }
    }
  }))
  const merged = new Map(reports.map(({ path, findings, failures }) => [path, { path, findings: [...findings], failures: [...failures] }]))
  const reportOf = (path: string): { path: string; findings: Reported[]; failures: Failure[] } => {
    const report = merged.get(path) ?? { path, findings: [], failures: [] }
    merged.set(path, report)
    return report
  }
  const lines = new Map<string, readonly string[]>()
  for (const run of runs) {
    if ('failure' in run) {
      reportOf(displayPath(run.settings, run.linter.config ?? run.linter.folder) || '.').failures.push({ rule: run.linter.name, reason: run.failure })
      continue
    }
    const linted = new Set(run.linter.files)
    for (const { file, line, level, rule, message } of run.found) {
      if (!linted.has(file) || (only !== undefined && !only.includes(file))) continue
      const path = displayPath(run.settings, file)
      if (!lines.has(file)) lines.set(file, existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [])
      reportOf(path).findings.push({ rule, line, message, level, quote: lines.get(file)?.[line - 1] ?? '', isExisting: false })
    }
  }
  return [...merged.values()].map((report) => ({ ...report, findings: report.findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule)) }))
}

async function linterFlags(linter: Covering, file: string, text: string, timeout: number): Promise<{ readonly flags: readonly Flag[]; readonly failures: readonly Failure[] }> {
  try {
    const found = await lintText(linter, file, text, timeout)
    return { flags: found.map(({ line, level, rule, message }) => ({ line, rule, message, level })), failures: [] }
  } catch (error) {
    return { flags: [], failures: [{ rule: linter.name, reason: error instanceof Error ? error.message : String(error) }] }
  }
}

function covers(rule: LoadedRule, path: string, isPrompt: boolean): boolean {
  return rule.level !== 'off' && (rule.paths === undefined ? isPrompt : matches(rule.paths, path))
}

function inScope(rule: LoadedRule, { scope, skip }: CheckOptions): boolean {
  if (isSkipped(skip, rule.id) || (rule.kind === 'agentic' && isSkipped(skip, 'agentic'))) return false
  if (scope === 'all') return true
  if (scope === 'commit') return rule.runs !== 'manual'
  return rule.runs === 'always'
}

export function isSkipped(skip: readonly string[] | undefined, name: string): boolean {
  return skip?.some((skipped) => name === skipped || name.startsWith(`${skipped}/`)) ?? false
}

type Pin = { readonly rule: string; readonly line: number; readonly target: number }

function pinsOf(written: readonly string[], shown: readonly string[]): readonly Pin[] {
  const pins: Pin[] = []
  const waiting: { rule: string; line: number }[] = []
  written.forEach((text, index) => {
    const rule = PIN.test(shown[index] ?? '') ? undefined : PIN.exec(text)?.[1]
    if (rule !== undefined) waiting.push({ rule, line: index + 1 })
    else for (const pin of waiting.splice(0)) pins.push({ ...pin, target: index + 1 })
  })
  return [...pins, ...waiting.map((pin) => ({ ...pin, target: written.length + 1 }))]
}

function linesWritten(previous: string, written: readonly string[]): ReadonlySet<number> {
  const before = withoutFinalBlank(previous.split('\n'))
  const after = withoutFinalBlank(written)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let end = 0
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1
  const oldMiddle = before.slice(start, before.length - end)
  const newMiddle = after.slice(start, after.length - end)
  const parts = unmatchedLines(oldMiddle, newMiddle) > MAX_EDIT_LENGTH ? undefined : diffArrays(oldMiddle, newMiddle, { maxEditLength: MAX_EDIT_LENGTH })
  if (parts === undefined) return new Set(written.map((_, index) => index + 1))
  const lines = new Set<number>()
  let line = start + 1
  for (const { added, removed, count } of parts) {
    if (removed) continue
    if (added) for (let each = line; each < line + count; each += 1) lines.add(each)
    line += count
  }
  return lines
}

function withoutFinalBlank(lines: readonly string[]): readonly string[] {
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

function unmatchedLines(before: readonly string[], after: readonly string[]): number {
  const unpaired = new Map<string, number>()
  for (const line of before) unpaired.set(line, (unpaired.get(line) ?? 0) + 1)
  let paired = 0
  for (const line of after) {
    const count = unpaired.get(line) ?? 0
    if (count === 0) continue
    unpaired.set(line, count - 1)
    paired += 1
  }
  return before.length + after.length - 2 * paired
}

export function importsRule(settings: Settings): StaticRule {
  return {
    id: 'rulebook/imports',
    source: 'rulebook',
    kind: 'static',
    description: 'Import only files that exist.',
    level: 'off',
    runs: 'always',
    paths: undefined,
    check: (_, doc) => (doc === undefined ? [] : doc.imports.flatMap(({ path, line }) => {
      const target = importedFile(doc.file, path)
      if (target === undefined || statSync(target, { throwIfNoEntry: false })?.isFile() === true) return []
      return [{ line, message: `The import names ${displayPath(settings, target)}, which is not a file. Fix the path or remove the import.` }]
    })),
  }
}

const SUPPRESSIONS: Readonly<Record<LinterName, RegExp>> = {
  mago: /(?:\/\/|#|\*)\s*@mago-(?:expect|ignore)\b/,
  oxlint: /(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable\b/,
  biome: /(?:\/\/|\/\*)\s*biome-ignore(?:-all|-start)?(?![\w-])/,
  stylelint: /(?:\/\/|\/\*)\s*stylelint-disable\b/,
  ruff: /#\s*(?:(?:ruff|flake8):\s*)?noqa\b|#\s*ruff:\s*(?:ignore|disable|file-ignore)\[/i,
  selene: /--#?\s*selene:\s*allow\(/,
  shellcheck: /#\s*shellcheck\s.*\bdisable=/,
  pint: /(?:\/\/|\*)\s*@php-cs-fixer-ignore\b/,
  tsc: /(?:\/\/|\/\*)\s*@ts-(?:expect-error|ignore|nocheck)\b/,
}

export const noSuppressionsRule: StaticRule = {
  id: 'rulebook/no-suppressions',
  source: 'rulebook',
  kind: 'static',
  description: 'Fix the code instead of suppressing the rule.',
  level: 'off',
  runs: 'always',
  paths: [`**/*.{${[...new Set(Object.values(LINTERS).flatMap(({ extensions }) => extensions.map((extension) => extension.slice(1))))].join(',')}}`, '**/!(*.*)'],
  check: ({ lines }) => lines.flatMap((text, index) => {
    const linter = Object.entries(SUPPRESSIONS).find(([, suppression]) => suppression.test(text))?.[0]
    return linter === undefined ? [] : [{ line: index + 1, message: `This comment suppresses ${linter}. Fix the code ${linter} flags, and remove the comment.` }]
  }),
}

type Flag = Omit<Reported, 'isExisting' | 'quote'>

function probeFindings(found: readonly Flag[], pins: readonly Pin[]): readonly Flag[] {
  const open = [...pins]
  const unexpected = found.filter((finding) => {
    const index = open.findIndex((pin) => pin.rule === finding.rule && pin.target === finding.line)
    if (index === -1) return true
    open.splice(index, 1)
    return false
  })
  return [
    ...unexpected.map((finding) => ({ ...finding, level: 'error' as const, message: `${finding.message} (no pin expects this flag)` })),
    ...open.map((pin) => ({ rule: pin.rule, line: pin.line, level: 'error' as const, message: `The pin expects ${pin.rule} to flag line ${pin.target}, and it does not.` })),
  ]
}

function validFindings(rule: string, file: CheckedFile, found: readonly Finding[]): readonly Finding[] {
  for (const finding of found) {
    if (!Number.isInteger(finding.line) || finding.line < 1 || finding.line > file.lines.length) throw new Error(`${rule} flagged line ${finding.line}, which ${file.path} does not have`)
    if (finding.message !== undefined && (typeof finding.message !== 'string' || finding.message.trim() === '')) throw new Error(`${rule} flagged line ${finding.line} with a blank message. Write the message, or leave it out to show the rule's description`)
  }
  return found
}
