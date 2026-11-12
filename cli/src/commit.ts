import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import type { LinterName } from './api.ts'
import { checkFile, lintProject, type FileReport, type Reported } from './check.ts'
import { isInside, loadSettings } from './config.ts'
import { filesBySettings, loadImportedFiles } from './files.ts'
import { isLinterInput, LINTERS, projectLinters } from './linters.ts'
import { loadRules } from './rules.ts'

export type CommitReport = { readonly reports: readonly FileReport[]; readonly failures: readonly string[] }

const DEPENDENCIES = new Set(Object.values(LINTERS).flatMap(({ copies }) => copies.map((copy) => copy.split('/')[0] ?? copy)))
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

export async function checkCommit(root: string): Promise<CommitReport> {
  const unloaded = new Set<string>()
  const staged = await gitPaths(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
  const deleted = await gitPaths(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=D'])
  const renamed = await renamedFrom(root)
  const checked = await Promise.all(staged.map(async (path) => {
    const text = await git(root, ['show', `:${path}`])
    if (text.slice(0, 8000).includes('\0')) return undefined
    const file = join(root, path)
    const settings = await loadSettings(dirname(file), root)
    const { rules, failures } = await loadRules(settings)
    for (const failure of failures) unloaded.add(failure)
    return checkFile(settings, rules, file, text, { scope: 'commit', previous: await committed(root, renamed.get(path) ?? path), imported: () => loadImportedFiles(root) })
  }))
  const reports = checked.filter((report) => report !== undefined)
  const linters = new Set((await Promise.all([...staged, ...deleted].map((path) => lintersCovering(root, path)))).flat())
  return { reports: linters.size === 0 ? reports : withAddedErrors(reports, await addedErrors(root, linters, renamed)), failures: [...unloaded] }
}

async function renamedFrom(root: string): Promise<ReadonlyMap<string, string>> {
  const fields = await gitPaths(root, ['diff', '--cached', '-z', '--name-status', '--diff-filter=R'])
  return new Map(fields.flatMap((field, index) => (index % 3 === 2 ? [[field, fields[index - 1] ?? field] as const] : [])))
}

async function lintersCovering(root: string, path: string): Promise<readonly LinterName[]> {
  const file = join(root, path)
  const { linters, programs } = await loadSettings(dirname(file), root)
  return [...projectLinters(linters, programs, [file], root).map(({ name }) => name), ...linters.filter((name) => isLinterInput(name, file, root))]
}

async function addedErrors(root: string, linters: ReadonlySet<LinterName>, renamed: ReadonlyMap<string, string>): Promise<readonly FileReport[]> {
  const copies = realpathSync(mkdtempSync(join(tmpdir(), 'rulebook-commit-')))
  const stop = (signal: (typeof SIGNALS)[number]): void => {
    rmSync(copies, { recursive: true, force: true })
    process.exit(128 + constants.signals[signal])
  }
  for (const signal of SIGNALS) process.once(signal, stop)
  try {
    const ignored = (await gitPaths(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])).map((path) => path.replace(/\/$/, ''))
    const tree = (await git(root, ['write-tree'])).trim()
    const after = await lintTree(root, tree, join(copies, 'commit'), linters, ignored)
    const hasErrors = after.some(({ findings }) => findings.some(({ level }) => level === 'error'))
    const before = hasErrors && (await hasHead(root)) ? await lintTree(root, 'HEAD', join(copies, 'head'), linters, ignored) : []
    const failed = new Set(before.flatMap(({ failures }) => failures.map(({ rule }) => rule)))
    const renamedTo = new Map([...renamed].map(([path, old]) => [old, path]))
    const known = new Map<string, number>()
    const keyOf = (path: string, { rule, message }: Reported): string => `${path}\0${rule}\0${message}`
    for (const { path, findings } of before) {
      for (const finding of findings.filter(({ level }) => level === 'error')) {
        const key = keyOf(renamedTo.get(path) ?? path, finding)
        known.set(key, (known.get(key) ?? 0) + 1)
      }
    }
    const added = after.map(({ path, findings, failures }) => ({
      path,
      failures,
      findings: findings.flatMap((finding) => {
        if (finding.level !== 'error') return []
        if (failed.has(finding.rule.split('/')[0] ?? '')) return [{ ...finding, level: 'warning' as const }]
        const remaining = known.get(keyOf(path, finding)) ?? 0
        known.set(keyOf(path, finding), remaining - 1)
        return remaining <= 0 ? [finding] : []
      }),
    }))
    return [...added.filter(({ findings, failures }) => findings.length > 0 || failures.length > 0), ...before.flatMap(({ path, failures }) => (failures.length === 0 ? [] : [{ path: path === '.' ? 'HEAD' : `HEAD:${path}`, findings: [], failures }]))]
  } finally {
    rmSync(copies, { recursive: true, force: true })
    for (const signal of SIGNALS) process.off(signal, stop)
  }
}

async function lintTree(root: string, tree: string, copy: string, linters: ReadonlySet<LinterName>, ignored: readonly string[]): Promise<readonly FileReport[]> {
  mkdirSync(copy)
  const archive = Bun.spawn(['git', 'archive', tree], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  const extract = Bun.spawn(['tar', '-x', '-C', copy], { env: process.env, stdin: archive.stdout, stdout: 'ignore', stderr: 'pipe' })
  const [archived, extracted, archiveError, extractError] = await Promise.all([archive.exited, extract.exited, new Response(archive.stderr).text(), new Response(extract.stderr).text()])
  if (archived !== 0 || extracted !== 0) throw new Error(`git archive ${tree} | tar -x failed: ${`${archiveError}${extractError}`.trim()}`)
  const paths = await gitPaths(root, ['ls-tree', '-r', '-z', '--name-only', tree])
  const included = paths.flatMap((path) => [...linters].flatMap((name) => {
    const { configs, includes } = LINTERS[name]
    return includes !== undefined && configs.includes(basename(path)) ? includes(readFileSync(join(copy, path), 'utf8')).map((include) => join(dirname(path), include)) : []
  }))
  const isInclude = (path: string): boolean => included.some((include) => isInside(include, path) || isInside(path, include))
  for (const path of ignored.filter((path) => DEPENDENCIES.has(basename(path)) || isInclude(path))) {
    const link = join(copy, path)
    if (existsSync(link)) continue
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(root, path), link)
  }
  const groups = await filesBySettings(root, paths.map((path) => join(root, path)))
  const reports = await lintProject(new Map([...groups].map(([settings, files]) => [{ ...settings, root: copy, linters: settings.linters.filter((name) => linters.has(name)) }, files.map((file) => join(copy, relative(root, file)))])), [])
  const bare = (text: string): string => text.replaceAll(`${copy}/`, '')
  return reports.map(({ path, findings, failures }) => ({ path, findings: findings.map((finding) => ({ ...finding, message: bare(finding.message) })), failures: failures.map((failure) => ({ ...failure, reason: bare(failure.reason) })) }))
}

function withAddedErrors(reports: readonly FileReport[], added: readonly FileReport[]): readonly FileReport[] {
  const merged = new Map(reports.map((report) => [report.path, report]))
  for (const { path, findings, failures } of added) {
    const report = merged.get(path) ?? { path, findings: [], failures: [] }
    merged.set(path, { path, failures: [...report.failures, ...failures], findings: [...report.findings, ...findings].sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule)) })
  }
  return [...merged.values()]
}

async function committed(root: string, path: string): Promise<string> {
  const show = Bun.spawn(['git', 'show', `HEAD:${path}`], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'ignore' })
  const [text, code] = await Promise.all([new Response(show.stdout).text(), show.exited])
  return code === 0 ? text : ''
}

async function hasHead(root: string): Promise<boolean> {
  const head = Bun.spawn(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, env: process.env, stdout: 'ignore', stderr: 'ignore' })
  return (await head.exited) === 0
}

async function gitPaths(root: string, args: readonly string[]): Promise<readonly string[]> {
  return (await git(root, args)).split('\0').filter((path) => path !== '')
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const run = Bun.spawn(['git', ...args], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' })
  const [text, error, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${error.trim()}`)
  return text
}
