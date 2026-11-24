import { defineMod, fs, http, longestMs, messageOf, process, provide, Reply, sessions, type Mod, type Subscription } from '../node_modules/@cmodjs/core/mod.js'
import { program } from '../node_modules/@cmodjs/core/jobs/program.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { isAbsolute, relative } from '../node_modules/@cmodjs/core/path.js'
import type { ListedRule as PublicRule, RulebookCheck, RuleSeverity } from '../types/index.js'
import { resultsView } from './views/results.js'
import { initialState, type Finding, type RulebookState, type Report } from './state.js'

type EditAnswer = {
  readonly refuse?: string
  readonly ask?: string
  readonly note?: string
  readonly failures: readonly string[]
  readonly findings: readonly Finding[]
}

type Severities = Readonly<Record<string, RuleSeverity | 'off'>>

type ListedRegExp = { readonly source: string; readonly flags: string }

type Listing = {
  readonly root: string
  readonly sources: readonly string[]
  readonly folders: readonly {
    readonly path: string
    readonly rules: readonly (PublicRule & { readonly isEverywhere: boolean; readonly files: readonly ListedRegExp[] })[]
  }[]
  readonly messages: readonly { readonly name: string; readonly tools: readonly ListedRegExp[] }[]
  readonly failures: readonly string[]
}

type ListedRule = Listing['folders'][number]['rules'][number] & { readonly covers: (path: string) => boolean }

type ListedFolder = { readonly path: string; readonly rules: readonly ListedRule[] }

type ListedMessage = Listing['messages'][number] & { readonly isSentBy: (tool: string) => boolean }

type Listed = Omit<Listing, 'folders' | 'messages'> & { readonly folders: readonly ListedFolder[]; readonly messages: readonly ListedMessage[] }

export const rulebook = defineMod({
  name: 'rulebook',
  state: initialState,

  setup(mod) {
    const results = mod.views.add(resultsView)
    const everyAgent = sessions.current.goal
    const server = mod.use(program({ command: ['rulebook', '__run_server'], singleInstance: true }))

    let environment: Promise<string> | undefined
    const asked = async <Answer,>(question: string, input: object, signal?: AbortSignal): Promise<Answer> => {
      environment ??= environmentOf().catch((error: unknown) => {
        environment = undefined
        throw error
      })
      const body = `{"input":${JSON.stringify(input)},"environment":${await environment}}`
      const sent = async () => {
        const { url, socketPath } = await server.ready()
        return http.fetch(`${url}/${question}`, { method: 'POST', body, ...(socketPath === undefined ? {} : { socketPath }), ...(signal === undefined ? {} : { signal }) })
      }
      const response = await sent().catch((error: unknown) => {
        if (signal?.aborted === true) throw error
        return sent()
      })
      if (!response.ok) throw new Error(`rulebook ${question} failed: ${response.text}`)
      return JSON.parse(response.text) as Answer
    }

    let project: string | undefined
    let listing: Promise<Listed> | undefined
    let sources: readonly string[] = []
    let watching: Subscription | undefined
    const watch = (): void => {
      watching?.remove()
      if (sources.length === 0) return
      const subscription = fs.onChange({ path: sources }, () => {
        if (watching !== subscription) return
        watching = undefined
        subscription.remove()
        listing = undefined
      })
      watching = subscription
    }
    const load = (): Promise<Listed> => {
      project = sessions.current.project
      const loading = asked<Listing>('rules', { cwd: project }).then(listedOf)
      listing = loading
      void loading.then((loaded) => {
        sources = loaded.sources
        for (const failure of loaded.failures) mod.toast.warning(failure)
      }, () => {
        if (listing === loading) listing = undefined
      }).then(watch)
      return loading
    }
    const listed = (): Promise<Listed> => (listing !== undefined && project === sessions.current.project ? listing : load())

    const rulesIn = async (path: string): Promise<readonly PublicRule[]> => {
      const { root, folders } = await listed()
      return (folderOf(folders, path.startsWith('@') ? path : displayPath(root, path))?.rules ?? []).map(({ id, description, severity, metadata }) => ({ id, description, severity, metadata }))
    }
    const rulebookRules = provide('rulebook/Rules', { rules: rulesIn })
    const severitiesFor = async (check: Omit<RulebookCheck, 'rules'>): Promise<Severities> => {
      const rules = await rulesIn(check.path)
      if (rules.length === 0) return {}
      const answers = await rulebookRules.ask('Check', { ...check, rules })
      return Object.assign({}, ...answers.flatMap((answer) => (isRecord(answer) && isRecord(answer.rules) ? [answer.rules] : [])))
    }

    const asks = new Map<string, string>()
    const relayed = (answer: EditAnswer, callId?: string): { readonly refuse: string } | { readonly note: string } | undefined => {
      for (const failure of answer.failures) mod.log(failure, { level: 'warning' })
      if (answer.refuse !== undefined) return { refuse: answer.refuse }
      if (answer.ask !== undefined && callId !== undefined) asks.set(callId, answer.ask)
      if (answer.note !== undefined) return { note: answer.note }
      return undefined
    }

    const show = async (agent: string, files: readonly string[], isNewContext: boolean): Promise<{ readonly note: string } | undefined> => {
      const { root, folders } = await listed()
      const shown = new Set(isNewContext ? [] : mod.state.memory.shown[agent])
      const told = (path: string, covers: (rule: ListedRule) => boolean): string => {
        const unshown = (folderOf(folders, path)?.rules ?? []).filter((rule) => !shown.has(rule.id) && covers(rule))
        for (const { id } of unshown) shown.add(id)
        return unshown.map(({ description }) => `- ${description}`).join('\n')
      }
      const everywhere = told(displayPath(root, sessions.current.project), ({ isEverywhere }) => isEverywhere)
      const perFile = [...new Set(files)].map((file) => {
        const path = displayPath(root, file)
        const covered = told(path, ({ covers }) => covers(path))
        return covered === '' ? '' : `Rules for ${path}:\n${covered}`
      })
      const note = [everywhere, ...perFile].filter((block) => block !== '').join('\n\n')
      if (note !== '' || isNewContext) mod.state.memory.shown = { ...mod.state.memory.shown, [agent]: [...shown] }
      return note === '' ? undefined : { note }
    }

    everyAgent.beforeSessionStart((start) => show(start.task ?? start.session, [], true))
    everyAgent.beforePrompt({ task: /./ }, (prompt) => show(prompt.task ?? prompt.session, [], false))
    everyAgent.beforeToolResult((result) => {
      asks.delete(result.callId)
      return show(result.task ?? result.session, [...result.files.read, ...result.files.changed], false)
    })

    everyAgent.beforeToolCall(
      { name: /^(Edit|Write|MultiEdit|NotebookEdit)$/ },
      async (call, { signal }) => {
        const rules = await severitiesFor(checkOf(call, editedPath(call.input) ?? sessions.current.project))
        return relayed(await asked<EditAnswer>('edit', { tool_name: call.name, tool_input: call.input, cwd: call.cwd, ...whoCalls(call), rules }, signal), call.callId)
      },
      { timeoutMs: longestMs },
    )

    everyAgent.beforeToolCall(
      async (call, { signal }) => {
        const message = (await listed()).messages.find(({ isSentBy }) => isSentBy(call.name))
        if (message === undefined) return undefined
        const rules = await severitiesFor(checkOf(call, message.name))
        return relayed(await asked<EditAnswer>('text', { name: message.name, input: call.input, cwd: call.cwd, tool_name: call.name, ...whoCalls(call), rules }, signal), call.callId)
      },
      { timeoutMs: longestMs },
    )

    sessions.current.beforePermissionCheck(({ callId }) => {
      const reason = callId === undefined ? undefined : asks.get(callId)
      if (callId === undefined || reason === undefined) return undefined
      asks.delete(callId)
      return { ask: reason }
    })

    sessions.current.beforeTurnEnd(
      async (turn, { signal }) => {
        const reply = (await turn.messages()).findLast((message) => message.type === Reply)
        if (reply === undefined) return undefined
        const rules = await severitiesFor({ path: '@reply', session: sessions.current.id })
        const answer = await asked<EditAnswer>('text', { name: '@reply', text: reply.text, cwd: sessions.current.cwd, rules }, signal)
        const relay = relayed(answer)
        if (answer.refuse !== undefined && mod.state.memory.refusedTurn !== turn.prompt.id) {
          mod.state.memory.refusedTurn = turn.prompt.id
          return relay
        }
        if (answer.findings.length > 0) mod.toast.warning(answer.findings.map(({ line, rule, message }) => `Reply line ${line}: ${message} (${rule})`).join('\n'))
        return undefined
      },
      { timeoutMs: longestMs },
    )

    mod.use(
      slashCommand({
        name: 'rulebook',
        description: 'Check every Prompt in this project, or the files named, with every rulebook rule',
        argumentHint: '[files]',
        reply: async ({ positionals }) => {
          mod.state.memory.run = { status: 'running', files: positionals }
          void checkProject(mod, positionals)
          await results.open()
          return undefined
        },
      }),
    )
  },
})

async function checkProject(mod: Mod<RulebookState>, files: readonly string[]): Promise<void> {
  try {
    const checked = await process.run(['rulebook', 'check', '--reporter=json', ...files], { cwd: sessions.current.cwd, timeoutMs: longestMs })
    if (checked.exitCode > 1) throw new Error(checked.stderr.trim())
    const { reports, failures } = JSON.parse(checked.stdout) as { readonly reports: readonly Report[]; readonly failures: readonly string[] }
    mod.state.memory.run = { status: 'done', reports, failures }
  } catch (error) {
    mod.state.memory.run = { status: 'failed', error: messageOf(error) }
  }
}

async function environmentOf(): Promise<string> {
  const printed = await process.run(['env', '-0'])
  if (printed.exitCode !== 0) throw new Error(`env -0 exited ${printed.exitCode}: ${printed.stderr.trim()}`)
  return JSON.stringify(Object.fromEntries(printed.stdout.split('\0').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])))
}

function listedOf({ root, sources, folders, messages, failures }: Listing): Listed {
  return {
    root,
    sources,
    failures,
    folders: [...folders].sort((a, b) => b.path.length - a.path.length).map(({ path, rules }) => ({ path, rules: rules.map((rule) => ({ ...rule, covers: anyOf(rule.files) })) })),
    messages: messages.map((message) => ({ ...message, isSentBy: anyOf(message.tools) })),
  }
}

function whoCalls(call: { readonly session: string; readonly agentType?: string; readonly task?: string }): Readonly<Record<string, string>> {
  return { session_id: call.session, ...(call.agentType === undefined ? {} : { agent_type: call.agentType }), ...(call.task === undefined ? {} : { agent_id: call.task }) }
}

function checkOf(call: { readonly name: string; readonly session: string; readonly agentType?: string; readonly task?: string }, path: string): Omit<RulebookCheck, 'rules'> {
  return { path, session: call.session, ...(call.task === undefined ? {} : { task: call.task }), ...(call.agentType === undefined ? {} : { agentType: call.agentType }), tool: call.name }
}

function editedPath(input: Readonly<Record<string, unknown>>): string | undefined {
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' ? path : undefined
}

function folderOf<Folder extends { readonly path: string }>(folders: readonly Folder[], path: string): Folder | undefined {
  return folders.find((each) => each.path === '' || path === each.path || path.startsWith(`${each.path}/`))
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function anyOf(listed: readonly ListedRegExp[]): (text: string) => boolean {
  const regExps = listed.map(({ source, flags }) => new RegExp(source, flags))
  return (text) => regExps.some((regExp) => regExp.test(text))
}

function displayPath(root: string, file: string): string {
  const path = relative(root, file)
  return path.startsWith('..') || isAbsolute(path) ? file : path
}
