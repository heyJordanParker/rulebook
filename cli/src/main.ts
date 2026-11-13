#!/usr/bin/env bun
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import packageJson from '../package.json' with { type: 'json' }
import { checkFile, displayPath, isCovered, isPrompt, isSkipped, lintProject } from './check.ts'
import { checkStaged } from './commit.ts'
import { loadSettings, projectRoot, type Settings } from './config.ts'
import { fileRoot, realFile } from './edit.ts'
import { filesBySettings, importedFiles, listedFiles, loadImportedFiles, probeFiles, projectFiles } from './files.ts'
import { answer, checkToolCall, projectOf } from './questions.ts'
import { commitReport, editAnswer, textReport } from './report.ts'
import { loadRules, type LoadedRule } from './rules.ts'
import { serve } from './serve.ts'

const HELP = `rulebook ${packageJson.version}: checks any file, agent reply, and tool call against your rules and your project's linters.

Usage:
  rulebook check [files...]                Check every file a rule covers, every Prompt, and every probe of this project, or only the files named, with every rule and linter.
  rulebook check --staged                  Check what the next commit records, with every rule that runs always or on commit. Run it as the git pre-commit hook.
  rulebook check --stdin-file-path=<path>  Check stdin as the text of the file or message at <path>, such as @reply, with every rule that runs always.
  rulebook check --reporter=json           Print the results as JSON.
  rulebook check --skip=<name>             Skip a rule, every rule of a plugin or folder, a linter, or every agentic rule, such as --skip=agentic. Repeat it to skip more.
  rulebook inspect rules                   Print, for each folder that holds a rulebook.config.ts, each rule that is on there, with its description and the paths it covers, and each message with the tools that send it, as JSON.
  rulebook claude-hook                     Check the tool call a Claude Code PreToolUse hook sends on stdin: an Edit, Write, or MultiEdit, or a call a message's tools match. An error refuses it.
  rulebook --version                       Print the version.

A file's rules and settings come from ~/.config/rulebook/rulebook.config.ts and the nearest rulebook.config.ts in the file's folder or a folder above it, with every config they extend.`

const REPORTERS = ['default', 'json']

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      staged: { type: 'boolean' },
      'stdin-file-path': { type: 'string' },
      reporter: { type: 'string', default: 'default' },
      skip: { type: 'string', multiple: true, default: [] },
      version: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...named] = positionals
  if (values.version) return print(packageJson.version)
  if (values.help || command === undefined) return print(HELP)
  if (command === '__run_server') return serve()
  if (command === 'claude-hook') return claudeHook(JSON.parse(await Bun.stdin.text()))
  if (command === 'inspect') return inspect(named)
  if (command !== 'check') throw new Error(`${command} is not a rulebook command. \`rulebook --help\` lists them.`)
  if (!REPORTERS.includes(values.reporter)) throw new Error(`--reporter is default or json, not ${values.reporter}.`)
  const isJson = values.reporter === 'json'
  const stdinPath = values['stdin-file-path']
  if ([values.staged === true, stdinPath !== undefined, named.length > 0].filter(Boolean).length > 1) throw new Error('rulebook check takes files, --staged, or --stdin-file-path, one at a time.')
  if (values.staged === true) return staged(values.skip, isJson)
  if (stdinPath !== undefined) return checkStdin(stdinPath, values.skip, isJson)
  return check(named, values.skip, isJson)
}

async function inspect([target, ...rest]: readonly string[]): Promise<number> {
  if (target !== 'rules' || rest.length > 0) throw new Error('rulebook inspect takes rules.')
  const input = { cwd: process.cwd() }
  return print(JSON.stringify(await answer('rules', input, projectOf('rules', input))))
}

async function claudeHook(input: unknown): Promise<number> {
  const answer = await checkToolCall(input)
  if (answer?.refuse !== undefined) {
    await Bun.write(Bun.stderr, `${answer.refuse}\n`)
    return 2
  }
  return answer?.note === undefined ? 0 : print(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: answer.note } }))
}

async function staged(skip: readonly string[], isJson: boolean): Promise<number> {
  const { reports, failures } = await checkStaged(projectRoot(process.cwd(), process.cwd()), skip)
  const { text, isRefused } = commitReport(reports, failures)
  await print(isJson ? JSON.stringify({ reports, failures }) : text)
  return isRefused ? 1 : 0
}

async function checkStdin(path: string, skip: readonly string[], isJson: boolean): Promise<number> {
  const cwd = process.cwd()
  const isMessage = path.startsWith('@')
  const file = isMessage ? path : realFile(path, cwd)
  const root = isMessage ? projectRoot(cwd, cwd) : fileRoot(file, cwd)
  const settings = await loadSettings(isMessage ? cwd : dirname(file), root)
  const { rules, failures } = await loadRules(settings)
  const report = await checkFile(settings, rules, file, await Bun.stdin.text(), { scope: 'edit', imported: () => loadImportedFiles(root), skip })
  const { refuse, note } = editAnswer(report)
  const text = refuse ?? note
  if (isJson) await print(JSON.stringify({ reports: report === undefined ? [] : [report], failures }))
  else if (text !== undefined) await print(text)
  return refuse === undefined ? 0 : 1
}

async function check(named: readonly string[], skip: readonly string[], isJson: boolean): Promise<number> {
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
  const files = named.length > 0 ? named.map((file) => namedFile(file)) : await textFiles([...new Set([...(await coveredFiles(groups, rulesOf)), ...imported, ...messageFiles(settings)])])
  const checked = await Promise.all(files.map(async (file) => {
    const own = displayPath(settings, file).startsWith('@') ? settings : await loadSettings(dirname(file), root)
    const report = await checkFile(own, await rulesOf(own), file, await Bun.file(file).text(), { scope: 'all', imported: async () => imported, skip })
    if (report === undefined && named.length > 0) throw new Error(`${file} is not a Prompt, a probe, or a file a rule's paths cover.`)
    return report
  }))
  const linted = new Map([...groups].map(([own, owned]) => [{ ...own, linters: own.linters.filter((name) => !isSkipped(skip, name)) }, owned]))
  const reports = await lintProject(linted, checked.filter((report) => report !== undefined), named.length > 0 ? files : undefined)
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

function namedFile(file: string): string {
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
