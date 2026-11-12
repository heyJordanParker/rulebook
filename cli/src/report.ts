import type { FileReport, Reported } from './check.ts'

export type EditAnswer = {
  readonly refuse?: string
  readonly note?: string
  readonly failures: readonly string[]
  readonly findings: readonly Reported[]
}

function findingLines(findings: readonly Reported[]): string {
  const lineWidth = Math.max(...findings.map(({ line }) => String(line).length))
  const levelWidth = Math.max(...findings.map(({ level }) => level.length))
  const ruleWidth = Math.max(...findings.map(({ rule }) => rule.length))
  return findings
    .map(({ line, level, rule, message, quote }) => `  ${String(line).padStart(lineWidth)}  ${level.padEnd(levelWidth)}  ${rule.padEnd(ruleWidth)}  ${message}\n  ${' '.repeat(lineWidth)}  > ${quote.trim()}`.trimEnd())
    .join('\n')
}

function failureLines(report: FileReport): readonly string[] {
  return report.failures.map(({ rule, reason }) => `${rule} did not run${report.path === '.' ? '' : ` on ${report.path}`}: ${reason}`)
}

export function editAnswer(report: FileReport | undefined): EditAnswer {
  if (report === undefined) return { failures: [], findings: [] }
  const { findings } = report
  const written = findings.filter(({ isExisting }) => !isExisting)
  const errors = written.filter(({ level }) => level === 'error')
  const warnings = written.filter(({ level }) => level === 'warning')
  const failures = failureLines(report)
  const isRefused = findings.some(({ level }) => level === 'error')
  const blocks = [
    ...(errors.length === 0 ? [] : [findingLines(errors)]),
    ...(warnings.length === 0 ? [] : [isRefused ? `Warnings:\n${findingLines(warnings)}` : findingLines(warnings)]),
    ...existingLine(report, written.length > 0),
    ...(failures.length === 0 ? [] : [failures.join('\n')]),
  ]
  if (isRefused) return { refuse: [refusal(report.path), ...blocks].join('\n\n'), failures, findings }
  if (findings.length > 0) return { note: [`${subject(report.path)} allowed with warnings:`, ...blocks].join('\n\n'), failures, findings }
  if (failures.length > 0) return { note: [`${subject(report.path)} allowed, but not every rule checked it:`, ...blocks].join('\n\n'), failures, findings }
  return { failures, findings }
}

function existingLine(report: FileReport, isMore: boolean): readonly string[] {
  const existing = report.findings.filter(({ isExisting }) => isExisting)
  if (existing.length === 0) return []
  const errors = existing.filter(({ level }) => level === 'error').length
  const noun = errors === existing.length ? 'error' : errors === 0 ? 'warning' : 'finding'
  const isOne = existing.length === 1
  return [`${existing.length}${isMore ? ' more' : ''} ${noun}${isOne ? '' : 's'} in this file ${isOne ? 'was' : 'were'} there before this edit. \`rulebook ${report.path}\` lists ${isOne ? 'it' : 'them'}.`]
}

function refusal(path: string): string {
  const again = path === '@reply' ? 'write the whole reply again' : path.startsWith('@') ? 'send it again' : 'edit again'
  return `${subject(path)} refused. Fix every error, then ${again}.`
}

function subject(path: string): string {
  if (!path.startsWith('@')) return `Edit to ${path}`
  const [name = ''] = path.slice(1).split('/')
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

export function commitReport(reports: readonly FileReport[], unloaded: readonly string[]): { readonly text: string; readonly isRefused: boolean } {
  const isHidden = ({ isExisting, level }: Reported): boolean => isExisting && level !== 'error'
  const written = reports.map((report) => ({ ...report, findings: report.findings.filter((finding) => !isHidden(finding)) }))
  const isRefused = written.some(({ findings }) => findings.some(({ level }) => level === 'error'))
  const existing = reports.flatMap(({ path, findings }) => (findings.some(isHidden) ? [path] : []))
  const count = reports.flatMap(({ findings }) => findings.filter(isHidden)).length
  const before = count === 0 ? [] : [`${count} ${count === 1 ? 'finding' : 'findings'} in these files ${count === 1 ? 'was' : 'were'} there before this commit. \`rulebook ${existing.join(' ')}\` lists ${count === 1 ? 'it' : 'them'}.`]
  const body = textReport(written, unloaded)
  return { isRefused, text: [...(isRefused ? ['Commit refused. Fix every error, stage the fix, then commit again.'] : []), body, ...before].join('\n\n') }
}

export function textReport(reports: readonly FileReport[], unloaded: readonly string[]): string {
  const flagged = reports.filter(({ findings }) => findings.length > 0)
  const all = reports.flatMap(({ findings }) => findings)
  const errors = all.filter(({ level }) => level === 'error').length
  const failures = [...unloaded, ...reports.flatMap(failureLines)]
  const blocks = flagged.map((report) => `${report.path}\n${findingLines(report.findings)}`)
  const counts = `${errors} ${errors === 1 ? 'error' : 'errors'}, ${all.length - errors} ${all.length - errors === 1 ? 'warning' : 'warnings'} in ${reports.length} ${reports.length === 1 ? 'file' : 'files'}`
  return [...blocks, ...(failures.length === 0 ? [] : [failures.join('\n')]), counts].join('\n\n')
}
