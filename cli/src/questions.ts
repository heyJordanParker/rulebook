import { basename, dirname, join } from 'node:path'
import { checkFile, globRegExp } from './check.ts'
import { CONFIG_FILE, globalConfigFile, isRecord, loadSettings, projectRoot } from './config.ts'
import { checkEdit, editRoot, type ToolCall } from './edit.ts'
import { listedFiles } from './files.ts'
import { editAnswer, type EditAnswer } from './report.ts'
import { loadRules } from './rules.ts'

export type Question = 'edit' | 'text' | 'rules'

type Text = { readonly name: string; readonly text: string; readonly cwd: string; readonly input?: Readonly<Record<string, unknown>> }

const EDIT_TOOLS = /^(Edit|Write|MultiEdit)$/

type Answerer = {
  root(input: unknown): string
  answer(input: unknown, root: string): Promise<unknown>
}

const QUESTIONS: Readonly<Record<Question, Answerer>> = {
  edit: {
    root: (input) => editRoot(toolCall(input)),
    answer: (input, root) => checkEdit(toolCall(input), root),
  },
  text: {
    root: (input) => {
      const { cwd } = textOf(input)
      return projectRoot(cwd, cwd)
    },
    answer: (input, root) => checkText(textOf(input), root),
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

async function checkText({ name, text, cwd, input }: Text, root: string): Promise<EditAnswer> {
  const settings = await loadSettings(cwd, root)
  if (!name.startsWith('@')) throw new Error('rulebook text checks a message by its @-name, such as @reply or @inbox/<id>.md.')
  const { rules } = await loadRules(settings)
  const report = await checkFile(settings, rules, name, text, { scope: 'edit', imported: async () => new Set(), ...(input === undefined ? {} : { input }) })
  return editAnswer(report)
}

export async function checkToolCall(input: unknown): Promise<EditAnswer | undefined> {
  const call = toolCall(input)
  if (EDIT_TOOLS.test(call.tool_name)) return checkEdit(call, editRoot(call))
  const root = projectRoot(call.cwd, call.cwd)
  const messages = Object.entries((await loadSettings(call.cwd, root)).messages)
  const name = messages.find(([, { tools }]) => tools.some((glob) => globRegExp(glob).test(call.tool_name)))?.[0]
  return name === undefined ? undefined : checkText({ name: `@${name}`, text: textsOf(call.tool_input).join('\n\n'), cwd: call.cwd, input: call.tool_input }, root)
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
      rules: folder.rules.filter(({ level }) => level !== 'off').map(({ id, description, paths = folder.settings.paths }) => ({
        id,
        description,
        isEverywhere: paths.some((glob) => glob === (folder.path === '' ? '**' : `${folder.path}/**`) || glob.startsWith('@')),
        paths: regExpsOf(paths),
      })),
    })),
    messages: Object.entries(settings.messages).map(([name, { tools }]) => ({ name: `@${name}`, tools: regExpsOf(tools) })),
    failures: [...new Set(folders.flatMap((folder) => folder.failures))],
  }
}

function toolCall(input: unknown): ToolCall {
  if (!isRecord(input) || typeof input.tool_name !== 'string' || !isRecord(input.tool_input) || typeof input.cwd !== 'string') throw new Error('rulebook edit reads {"tool_name", "tool_input", "cwd"}.')
  return { tool_name: input.tool_name, tool_input: input.tool_input, cwd: input.cwd }
}

function textOf(input: unknown): Text {
  if (!isRecord(input) || typeof input.name !== 'string' || typeof input.cwd !== 'string') throw new Error('rulebook text reads {"name", "text" or "input", "cwd"}.')
  if (isRecord(input.input)) return { name: input.name, text: textsOf(input.input).join('\n\n'), cwd: input.cwd, input: input.input }
  if (typeof input.text !== 'string') throw new Error('rulebook text reads {"name", "text" or "input", "cwd"}.')
  return { name: input.name, text: input.text, cwd: input.cwd }
}

function textsOf(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textsOf)
  if (isRecord(value)) return Object.values(value).flatMap(textsOf)
  return []
}

function cwdOf(input: unknown): string {
  if (!isRecord(input) || typeof input.cwd !== 'string') throw new Error('rulebook rules reads {"cwd"}.')
  return input.cwd
}
