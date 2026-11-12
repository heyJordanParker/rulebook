#!/usr/bin/env bun
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import packageJson from '../package.json' with { type: 'json' }
import { checkFile, displayPath, isCovered, isPrompt, lintProject } from './check.ts'
import { loadSettings, projectRoot, type Settings } from './config.ts'
import { filesBySettings, importedFiles, listedFiles, probeFiles, projectFiles } from './files.ts'
import { answer, checkToolCall, projectOf, type Question } from './questions.ts'
import { checkCommit } from './commit.ts'
import { commitReport, textReport } from './report.ts'
import { loadRules, type LoadedRule } from './rules.ts'
import { serve } from './serve.ts'

const HELP = `rulebook ${packageJson.version}: checks any file, agent reply, and tool call against your rules and your project's linters.

Usage:
  rulebook [files...]           Check every file a rule covers, every Prompt, and every probe of this project, or only the files named, with every rule.
  rulebook --static [files...]  Check with the static rules only.
  rulebook --json [files...]    Print the results as JSON.
  rulebook commit               Check every staged file as the commit will record it, with every rule that runs always or on commit. Run it as the git pre-commit hook.
  rulebook hook                 Check the tool call a Claude Code PreToolUse hook sends on stdin: an Edit, Write, or MultiEdit, or a call a message's tools match. An error refuses it.
  rulebook edit                 Check the Edit, Write, or MultiEdit call Claude Code sends on stdin, before it runs.
  rulebook text <@name>         Check the message on stdin, such as @reply, with every rule whose paths cover its @-name.
  rulebook rules                Print, for each folder that holds a rulebook.config.ts, each rule that is on there, with its description and the paths it covers, and each message with the tools that send it, as JSON.
  rulebook serve                Answer edit, text, and rules as POST /edit, /text, and /rules on a Unix socket, keeping each project's configs and rules loaded, and print unix:<socket path> first.
  rulebook --version            Print the version.

A file's rules and settings come from ~/.config/rulebook/rulebook.config.ts and the nearest rulebook.config.ts in the file's folder or a folder above it, with every config they extend.`

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { static: { type: 'boolean' }, json: { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  })
  if (values.version) return print(packageJson.version)
  if (values.help) return print(HELP)
  if (positionals[0] === 'serve') return serve()
  if (positionals[0] === 'edit') return asked('edit', JSON.parse(await Bun.stdin.text()))
  if (positionals[0] === 'text') return asked('text', { name: positionals[1] ?? '', text: await Bun.stdin.text(), cwd: process.cwd() })
  if (positionals[0] === 'rules') return asked('rules', { cwd: process.cwd() })
  if (positionals[0] === 'commit') return commit(values.json === true)
  if (positionals[0] === 'hook') return hook(JSON.parse(await Bun.stdin.text()))
  return check(positionals, values.static === true, values.json === true)
}

async function hook(input: unknown): Promise<number> {
  const answer = await checkToolCall(input)
  if (answer?.refuse !== undefined) {
    await Bun.write(Bun.stderr, `${answer.refuse}\n`)
    return 2
  }
  return answer?.note === undefined ? 0 : print(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: answer.note } }))
}

async function commit(isJson: boolean): Promise<number> {
  const { reports, failures } = await checkCommit(projectRoot(process.cwd(), process.cwd()))
  const { text, isRefused } = commitReport(reports, failures)
  await print(isJson ? JSON.stringify({ reports, failures }) : text)
  return isRefused ? 1 : 0
}

async function asked(question: Question, input: unknown): Promise<number> {
  return print(JSON.stringify(await answer(question, input, projectOf(question, input))))
}

async function check(named: readonly string[], isStatic: boolean, isJson: boolean): Promise<number> {
  const listing = listedFiles(process.cwd())
  const root = projectRoot(process.cwd(), process.cwd())
  const settings = await loadSettings(process.cwd(), root)
  const groups = new Map<Settings, readonly string[]>([[settings, []], ...(await filesBySettings(root, projectFiles(settings, await listing)))])
  const imported = importedFiles(root, groups)
  const unloaded = new Set<string>()
  const rulesOf = async (own: Settings): Promise<readonly LoadedRule[]> => {
    const { rules, failures } = await loadRules(own)
    for (const failure of failures) unloaded.add(failure)
    return rules
  }
  const files = named.length > 0 ? named.map((file) => realFile(file)) : await textFiles([...new Set([...(await coveredFiles(groups, rulesOf)), ...imported, ...messageFiles(settings)])])
  const checked = await Promise.all(files.map(async (file) => {
    const own = displayPath(settings, file).startsWith('@') ? settings : await loadSettings(dirname(file), root)
    const report = await checkFile(own, await rulesOf(own), file, await Bun.file(file).text(), { scope: isStatic ? 'static' : 'all', imported: async () => imported })
    if (report === undefined && named.length > 0) throw new Error(`${file} is not a Prompt, a probe, or a file a rule's paths cover.`)
    return report
  }))
  const reports = await lintProject(groups, checked.filter((report) => report !== undefined), named.length > 0 ? files : undefined)
  const failures = [...unloaded]
  await print(isJson ? JSON.stringify({ reports, failures }) : textReport(reports, failures))
  return failures.length > 0 || reports.some((report) => report.failures.length > 0 || report.findings.some(({ level }) => level === 'error')) ? 1 : 0
}

async function coveredFiles(groups: ReadonlyMap<Settings, readonly string[]>, rulesOf: (settings: Settings) => Promise<readonly LoadedRule[]>): Promise<readonly string[]> {
  const covered = await Promise.all([...groups].map(async ([settings, files]) => {
    const rules = await rulesOf(settings)
    return [...files.filter((file) => isPrompt(settings, file) || isCovered(settings, rules, file)), ...probeFiles(settings)]
  }))
  return covered.flat()
}

function messageFiles(settings: Settings): readonly string[] {
  return Object.values(settings.messages).flatMap(({ folder }) => (folder === undefined || !existsSync(folder) ? [] : [...new Bun.Glob('**').scanSync({ cwd: folder, absolute: true, dot: true })]))
}

async function textFiles(files: readonly string[]): Promise<readonly string[]> {
  const texts = await Promise.all(files.map(async (file) => statSync(file, { throwIfNoEntry: false })?.isFile() === true && !(await Bun.file(file).slice(0, 8000).bytes()).includes(0)))
  return files.filter((_, index) => texts[index])
}

function realFile(file: string): string {
  const path = resolve(file)
  if (!existsSync(path)) throw new Error(`${file} does not exist.`)
  return realpathSync(path)
}

async function print(text: string): Promise<number> {
  await Bun.write(Bun.stdout, `${text}\n`)
  return 0
}

main(Bun.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`rulebook: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  },
)
