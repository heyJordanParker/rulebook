import { defineMod, fs, http, longestMs, messageOf, process, Reply, sessions, type Mod, type Subscription } from '../node_modules/@cmodjs/core/mod.js'
import { program } from '../node_modules/@cmodjs/core/jobs/program.js'
import { slashCommand } from '../node_modules/@cmodjs/core/jobs/slash-command.js'
import { isAbsolute, relative } from '../node_modules/@cmodjs/core/path.js'
import { resultsPage } from './pages/results.js'
import { initialState, type Finding, type RulebookState, type Report } from './state.js'

type EditAnswer = {
  readonly refuse?: string
  readonly note?: string
  readonly failures: readonly string[]
  readonly findings: readonly Finding[]
}

type ListedRegExp = { readonly source: string; readonly flags: string }

type Listing = {
  readonly root: string
  readonly sources: readonly string[]
  readonly folders: readonly {
    readonly path: string
    readonly rules: readonly { readonly id: string; readonly description: string; readonly isEverywhere: boolean; readonly paths: readonly ListedRegExp[] }[]
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
    const page = mod.sidebar.add(resultsPage)
    const everyAgent = sessions.current.goal
    const server = mod.use(program({ command: ['rulebook', 'serve'], singleInstance: true }))

    let environment: Promise<string> | undefined
    const asked = async <Answer,>(question: string, input: object, signal?: AbortSignal): Promise<Answer> => {
      environment ??= environmentOf().catch((error: unknown) => {
        environment = undefined
        throw error
      })
      const { url, socketPath } = await server.ready()
      const body = `{"input":${JSON.stringify(input)},"environment":${await environment}}`
      const response = await http.fetch(`${url}/${question}`, { method: 'POST', body, ...(socketPath === undefined ? {} : { socketPath }), ...(signal === undefined ? {} : { signal }) })
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

    const relayed = (answer: EditAnswer): { readonly refuse: string } | { readonly note: string } | undefined => {
      for (const failure of answer.failures) mod.log(failure, { level: 'warning' })
      if (answer.refuse !== undefined) return { refuse: answer.refuse }
      if (answer.note !== undefined) return { note: answer.note }
      return undefined
    }

    const show = async (agent: string, files: readonly string[], isNewContext: boolean): Promise<{ readonly note: string } | undefined> => {
      const { root, folders } = await listed()
      const shown = new Set(isNewContext ? [] : mod.state.memory.shown[agent])
      const told = (path: string, covers: (rule: ListedRule) => boolean): string => {
        const folder = folders.find((each) => each.path === '' || path === each.path || path.startsWith(`${each.path}/`))
        const unshown = (folder?.rules ?? []).filter((rule) => !shown.has(rule.id) && covers(rule))
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
    everyAgent.beforeToolResult((result) => show(result.task ?? result.session, [...result.files.read, ...result.files.changed], false))

    everyAgent.beforeToolCall(
      { name: /^(Edit|Write|MultiEdit)$/ },
      async (call, { signal }) => relayed(await asked<EditAnswer>('edit', { tool_name: call.name, tool_input: call.input, cwd: call.cwd }, signal)),
      { timeoutMs: longestMs },
    )

    everyAgent.beforeToolCall(
      async (call, { signal }) => {
        const message = (await listed()).messages.find(({ isSentBy }) => isSentBy(call.name))
        return message === undefined ? undefined : relayed(await asked<EditAnswer>('text', { name: message.name, input: call.input, cwd: call.cwd }, signal))
      },
      { timeoutMs: longestMs },
    )

    sessions.current.beforeTurnEnd(
      async (turn, { signal }) => {
        const reply = (await turn.messages()).findLast((message) => message.type === Reply)
        if (reply === undefined) return undefined
        const answer = await asked<EditAnswer>('text', { name: '@reply', text: reply.text, cwd: sessions.current.cwd }, signal)
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
          await page.open()
          return undefined
        },
      }),
    )
  },
})

async function checkProject(mod: Mod<RulebookState>, files: readonly string[]): Promise<void> {
  try {
    const checked = await process.run(['rulebook', '--json', ...files], { cwd: sessions.current.cwd, timeoutMs: longestMs })
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
    folders: [...folders].sort((a, b) => b.path.length - a.path.length).map(({ path, rules }) => ({ path, rules: rules.map((rule) => ({ ...rule, covers: anyOf(rule.paths) })) })),
    messages: messages.map((message) => ({ ...message, isSentBy: anyOf(message.tools) })),
  }
}

function anyOf(listed: readonly ListedRegExp[]): (text: string) => boolean {
  const regExps = listed.map(({ source, flags }) => new RegExp(source, flags))
  return (text) => regExps.some((regExp) => regExp.test(text))
}

function displayPath(root: string, file: string): string {
  const path = relative(root, file)
  return path.startsWith('..') || isAbsolute(path) ? file : path
}
