import { basename, dirname, join } from 'node:path'
import type { Call, Severity } from './api.ts'
import { checkFile, COMMAND, globRegExp } from './check.ts'
import { CONFIG_FILE, globalConfigFile, isRecord, isSeverity, loadSettings, projectRoot } from './config.ts'
import { checkEdit, EDIT_TOOLS, editRoot } from './edit.ts'
import { listedFiles } from './files.ts'
import { editAnswer, type EditAnswer } from './report.ts'
import { loadRules, severityOf, withSeverities } from './rules.ts'

export type Question = 'edit' | 'text' | 'rules'

type Severities = Readonly<Record<string, Severity | 'off'>>

type Text = { readonly name: string; readonly text: string; readonly cwd: string; readonly call?: Call }

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

type Answerer = {
  root(input: unknown): string
  answer(input: unknown, root: string): Promise<unknown>
}

const QUESTIONS: Readonly<Record<Question, Answerer>> = {
  edit: {
    root: (input) => editRoot(callOf(input)),
    answer: (input, root) => checkEdit(callOf(input), root, severitiesOf(input)),
  },
  text: {
    root: (input) => {
      const { cwd } = textOf(input)
      return projectRoot(cwd, cwd)
    },
    answer: (input, root) => checkText(textOf(input), root, severitiesOf(input)),
  },
  rules: {
    root: (input) => {
      const cwd = cwdOf(input)
      return projectRoot(cwd, cwd)
    },
    answer: (input, root) => listRules(cwdOf(input), root),
  },
}

export function isQuestion(name: string): name is Question {
  return Object.hasOwn(QUESTIONS, name)
}

export function projectOf(question: Question, input: unknown): string {
  return QUESTIONS[question].root(input)
}

export function answer(question: Question, input: unknown, root: string): Promise<unknown> {
  return QUESTIONS[question].answer(input, root)
}

async function checkText({ name, text, cwd, call }: Text, root: string, severities: Severities): Promise<EditAnswer> {
  const settings = await loadSettings(cwd, root)
  if (!name.startsWith('@')) throw new Error('The text question checks a message by its @-name, such as @reply or @inbox/<id>.md.')
  const { rules } = await loadRules(settings)
  const report = await checkFile(settings, withSeverities(rules, severities), name, text, { scope: 'edit', imported: async () => new Set(), ...(call === undefined ? {} : { call }) })
  return editAnswer(report)
}

export async function checkToolCall(input: unknown): Promise<EditAnswer | undefined> {
  const call = callOf(input)
  if (EDIT_TOOLS.has(call.tool)) return checkEdit(call, editRoot(call), {})
  const root = projectRoot(call.cwd, call.cwd)
  const messages = Object.entries((await loadSettings(call.cwd, root)).messages)
  const name = messages.find(([, { tools }]) => tools.some((glob) => globRegExp(glob).test(call.tool)))?.[0]
  return name === undefined ? undefined : checkText({ name: `@${name}`, text: messageText(`@${name}`, call.input), cwd: call.cwd, call }, root, {})
}

function severitiesOf(input: unknown): Severities {
  const rules = isRecord(input) ? input.rules : undefined
  if (rules === undefined) return {}
  if (!isRecord(rules) || !Object.values(rules).every((severity) => severity === 'off' || isSeverity(severity))) throw new Error('"rules" maps each rule name to "error", "warn", "ask", or "off", as a config\'s rules do.')
  return rules as Severities
}

async function listRules(cwd: string, root: string): Promise<unknown> {
  const settings = await loadSettings(cwd, root)
  await loadRules(await loadSettings(root, root))
  const configured = ((await listedFiles(cwd)) ?? []).filter((path) => basename(path) === CONFIG_FILE && path !== CONFIG_FILE).map(dirname)
  const folders = await Promise.all(['', ...configured].map(async (path) => {
    const own = await loadSettings(join(root, path), root)
    return { path, settings: own, ...(await loadRules(own)) }
  }))
  const regExpsOf = (globs: readonly string[]) => globs.map(globRegExp).map(({ source, flags }) => ({ source, flags }))
  return {
    root,
    sources: [...new Set([globalConfigFile(), join(root, CONFIG_FILE), ...folders.flatMap((folder) => folder.settings.configs.flatMap((config) => [config.file, ...Object.values(config.plugins)]))])],
    folders: folders.map((folder) => ({
      path: folder.path,
      rules: folder.rules.flatMap(({ id, description, level, metadata, files = folder.settings.files }) => (level === 'off' ? [] : [{
        id,
        description,
        severity: severityOf(level),
        metadata,
        isEverywhere: files.some((glob) => glob === (folder.path === '' ? '**' : `${folder.path}/**`) || glob.startsWith('@')),
        files: regExpsOf(files),
      }])),
    })),
    messages: Object.entries(settings.messages).map(([name, { tools }]) => ({ name: `@${name}`, tools: regExpsOf(tools) })),
    failures: [...new Set(folders.flatMap((folder) => folder.failures))],
  }
}

function callOf(input: unknown): Call {
  if (!isRecord(input) || typeof input.tool_name !== 'string' || !isRecord(input.tool_input) || typeof input.cwd !== 'string') throw new Error('A tool call is {"tool_name", "tool_input", "cwd"}, with "session_id", "agent_type", "agent_id", and "transcript_path" when Claude Code sends them.')
  return { tool: input.tool_name, input: input.tool_input, cwd: input.cwd, ...whoCalls(input) }
}

function whoCalls(input: Readonly<Record<string, unknown>>): Omit<Call, 'tool' | 'input' | 'cwd'> {
  const fields = { session: input.session_id, agentType: input.agent_type, agentId: input.agent_id, transcriptPath: input.transcript_path }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === 'string' && value !== ''))
}

function textOf(input: unknown): Text {
  if (!isRecord(input) || typeof input.name !== 'string' || typeof input.cwd !== 'string') throw new Error('The text question reads {"name", "text" or "input", "cwd"}.')
  if (isRecord(input.input)) {
    const call = typeof input.tool_name === 'string' ? { call: { tool: input.tool_name, input: input.input, cwd: input.cwd, ...whoCalls(input) } } : {}
    return { name: input.name, text: messageText(input.name, input.input), cwd: input.cwd, ...call }
  }
  if (typeof input.text !== 'string') throw new Error('The text question reads {"name", "text" or "input", "cwd"}.')
  return { name: input.name, text: input.text, cwd: input.cwd }
}

function messageText(name: string, input: Readonly<Record<string, unknown>>): string {
  return name === COMMAND ? commandText(input.command ?? input.cmd) : textsOf(input).join('\n\n')
}

function commandText(command: unknown): string {
  if (typeof command === 'string') return command
  if (!Array.isArray(command) || !command.every((word) => typeof word === 'string')) return ''
  const [shell = '', flag = '', script] = command
  return command.length === 3 && SHELLS.has(basename(shell)) && /^-[a-z]*c$/.test(flag) && script !== undefined ? script : command.join(' ')
}

function textsOf(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textsOf)
  if (isRecord(value)) return Object.values(value).flatMap(textsOf)
  return []
}

function cwdOf(input: unknown): string {
  if (!isRecord(input) || typeof input.cwd !== 'string') throw new Error('The rules question reads {"cwd"}.')
  return input.cwd
}
