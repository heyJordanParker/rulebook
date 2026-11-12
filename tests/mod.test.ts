import { expect, test } from 'bun:test'
import { Prompt, Reply, ToolCall } from '../node_modules/@cmodjs/core/mod.js'
import { testMod } from '../node_modules/@cmodjs/core/testing.js'
import { rulebook } from '../src/mod.js'

type Tested = ReturnType<typeof testMod>
type Spawn = NonNullable<Tested['fakes']['process']['spawn']>
type Answers = Readonly<Record<string, unknown>>

const EM_DASH = String.fromCharCode(0x2014)
const SOCKET = '/tmp/rulebook-7.sock'
const LISTED = {
  '**': { source: String.raw`(?!@)^(?:(?!(?:^|\/)\.{1,2}(?:\/|$))(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?))$`, flags: '' },
  '@reply': { source: String.raw`(?=@)^(?:^(?:\@reply)$)$`, flags: '' },
  '**/Claude.md': { source: String.raw`(?!@)^(?:(?:^|\/|(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?)\/)Claude\.md)$`, flags: '' },
  'mcp__inbox__*': { source: String.raw`(?!@)^(?:^(?:mcp__inbox__[^/]*?)$)$`, flags: '' },
  '**/*.md': { source: String.raw`(?!@)^(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$))(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?)\/)?(?!\.{1,2}(?:\/|$))(?=.)[^/]*?\.md)$`, flags: '' },
}
const EM_DASHES = { id: 'global/block-em-dashes', description: "Don't write em dashes.", isEverywhere: true, paths: [LISTED['**'], LISTED['@reply']] }
const TRUE_FACTS = { id: 'global/require-true-facts', description: "Don't state a Fact the code contradicts.", isEverywhere: false, paths: [LISTED['**/Claude.md']] }
const MESSAGES = [{ name: '@reply', tools: [] }, { name: '@inbox', tools: [LISTED['mcp__inbox__*']] }]
const LISTING = { root: '/work', sources: ['/home/.config/rulebook/rulebook.config.ts', '/work/rulebook.config.ts', '/home/.config/rulebook/rules'], folders: [{ path: '', rules: [EM_DASHES, TRUE_FACTS] }], messages: MESSAGES, failures: [] as string[] }
const FILES = { '/work/Claude.md': 'A fact.\n', '/work/packages/claude/Claude.md': 'A fact.\n', '/work/notes.md': 'A note.\n' }
const SPLIT = { rule: 'global/block-em-dashes', line: 1, level: 'error', message: 'Split the sentence at the em dash.' }
const ENVIRONMENT = { CLAUDE_CONFIG_DIR: '/home/.claude/profiles/copywriter', PATH: '/usr/bin:/bin' }

function printed(stdout: string, exitCode = 0) {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

function addressed(first: string): Spawn {
  return () => {
    async function* read() {
      yield { stream: 'stdout' as const, text: `${first}\n` }
      await new Promise(() => undefined)
      return { code: 0, signal: null }
    }
    return Object.assign(read(), { result: new Promise(() => undefined) }) as unknown as ReturnType<Spawn>
  }
}

function served(tested: Tested, answers: () => Answers): void {
  tested.fakes.process.spawn = addressed(`unix:${SOCKET}`)
  tested.fakes.process.run = async (command) => printed(Object.entries(ENVIRONMENT).map(([name, value]) => `${name}=${value}\0`).join(''), command.join(' ') === 'env -0' ? 0 : 1)
  tested.fakes.http.fetch = async (url, init) => {
    const answer = answers()[url.slice('http://localhost/'.length)]
    const { input } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { input: Readonly<Record<string, string>> }
    return { status: 200, ok: true, headers: {}, text: JSON.stringify(typeof answer === 'function' ? answer(input) : answer) }
  }
}

function serving(answers: Answers, options: Parameters<typeof testMod>[1] = {}): Tested {
  const tested = testMod(rulebook, options)
  served(tested, () => answers)
  return tested
}

function refusing(refusal: string) {
  return ({ text }: Readonly<Record<string, string>>) => (text?.includes(EM_DASH) ? { refuse: `${refusal}\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > ${text.split('\n')[0]}`, failures: [], findings: [SPLIT] } : { failures: [], findings: [] })
}

function asked(tested: Tested, question?: string) {
  return tested.calls
    .filter(({ call, args }) => call === 'http.fetch' && (question === undefined ? !String(args[0]).endsWith('/rules') : String(args[0]).endsWith(`/${question}`)))
    .map(({ args }) => {
      const { body, socketPath } = args[1] as { readonly body: string; readonly socketPath?: string }
      const { input, environment } = JSON.parse(body) as { readonly input: Readonly<Record<string, unknown>>; readonly environment: Readonly<Record<string, string>> }
      return { url: args[0], input, environment, socketPath }
    })
}

async function read(tested: Tested, file: string, task?: string) {
  const callId = `read-${Math.random()}`
  await tested.add({ type: ToolCall, name: 'Read', input: { file_path: file }, callId }, { task })
  return tested.raise.beforeToolResult({ callId, output: 'A fact.\n' }, { task })
}

test('the rules for every file and for messages reach the agent as its session starts, and again after each compaction, from one rules question to rulebook serve', async () => {
  const tested = serving({ rules: LISTING }, { projectRoot: '/work' })
  expect(await tested.raise.beforeSessionStart({ source: 'startup' })).toEqual({ note: "- Don't write em dashes." })
  expect(await tested.raise.beforeSessionStart({ source: 'compact' })).toEqual({ note: "- Don't write em dashes." })
  expect(asked(tested, 'rules')).toEqual([{ url: 'http://localhost/rules', input: { cwd: '/work' }, environment: ENVIRONMENT, socketPath: SOCKET }])
})

test('the mod runs one rulebook serve for the whole computer, and starts no rulebook process for a check', async () => {
  const spawned: (readonly string[])[] = []
  const tested = serving({ rules: LISTING, edit: { failures: [], findings: [] } }, { projectRoot: '/work' })
  const spawn = addressed(`unix:${SOCKET}`)
  tested.fakes.process.spawn = (request) => (spawned.push(request.argv), spawn(request))
  await tested.raise.beforeSessionStart({ source: 'startup' })
  await tested.raise.beforeToolCall({ name: 'Write', input: { file_path: '/work/Claude.md', content: 'x' } })
  expect(spawned).toEqual([['/test/home/.local/share/cmod/programs/cmod', 'program', 'rulebook', '--no-wait', '--', 'rulebook', 'serve']])
  expect(tested.calls.filter(({ call }) => call === 'process.run').map(({ args }) => args[0])).toEqual([['env', '-0']])
})

test('a rule for some files reaches the agent with its first read of a file it covers, once per context', async () => {
  const tested = serving({ rules: LISTING }, { projectRoot: '/work', files: FILES })
  await tested.raise.beforeSessionStart({ source: 'startup' })
  await tested.add({ type: Prompt, text: 'Read the docs' })
  expect(await read(tested, '/work/notes.md')).toBeUndefined()
  expect(await read(tested, '/work/Claude.md')).toEqual({ note: "Rules for Claude.md:\n- Don't state a Fact the code contradicts." })
  expect(await read(tested, '/work/packages/claude/Claude.md')).toBeUndefined()
  await tested.raise.beforeSessionStart({ source: 'compact' })
  expect(await read(tested, '/work/packages/claude/Claude.md')).toEqual({ note: "Rules for packages/claude/Claude.md:\n- Don't state a Fact the code contradicts." })
})

test("a rule that packages/a/rulebook.config.ts turns on reaches the agent with its read of packages/a/x.md, and never with packages/b/x.md, which the root folder's rules cover", async () => {
  const hedging = { id: 'global/block-hedging', description: 'State a claim only once you checked it.', isEverywhere: false, paths: [LISTED['**/*.md']] }
  const listing = { ...LISTING, folders: [{ path: '', rules: [EM_DASHES, TRUE_FACTS] }, { path: 'packages/a', rules: [EM_DASHES, TRUE_FACTS, hedging] }] }
  const tested = serving({ rules: listing }, { projectRoot: '/work', files: { '/work/packages/a/x.md': 'A note.\n', '/work/packages/b/x.md': 'A note.\n' } })
  await tested.raise.beforeSessionStart({ source: 'startup' })
  await tested.add({ type: Prompt, text: 'Read the notes' })
  expect(await read(tested, '/work/packages/b/x.md')).toBeUndefined()
  expect(await read(tested, '/work/packages/a/x.md')).toEqual({ note: 'Rules for packages/a/x.md:\n- State a claim only once you checked it.' })
})

test('a subagent gets the session-start rules as it starts, and the file rules on its own first read', async () => {
  const tested = serving({ rules: LISTING }, { projectRoot: '/work', files: FILES })
  await tested.raise.beforeSessionStart({ source: 'startup' })
  await tested.add({ type: Prompt, text: 'Map the docs' })
  expect(await read(tested, '/work/Claude.md')).toEqual({ note: "Rules for Claude.md:\n- Don't state a Fact the code contradicts." })
  const task = await tested.startTask({ title: 'Map the docs', agentType: 'Explore' })
  expect(await tested.raise.beforePrompt({ text: 'Map the docs' }, { task })).toEqual({ note: "- Don't write em dashes." })
  expect(await read(tested, '/work/Claude.md', task)).toEqual({ note: "Rules for Claude.md:\n- Don't state a Fact the code contradicts." })
  expect(await read(tested, '/work/Claude.md', task)).toBeUndefined()
})

test('the rules load again at the next check after a rulebook config or rule file changes, never at the change itself, so the sessions that sit idle ask nothing', async () => {
  const ticks: (() => void)[] = []
  let modifiedAt = 1
  let listing: typeof LISTING = LISTING
  const tested = testMod(rulebook, { projectRoot: '/work' })
  served(tested, () => ({ rules: listing }))
  tested.fakes.clock.every = (_ms: number, tick: () => void) => (ticks.push(tick), { cancel: () => undefined })
  tested.fakes.fs.stat = async () => ({ kind: 'file', isLink: false, mtimeMs: modifiedAt, size: 1 })
  expect(await tested.raise.beforeSessionStart({ source: 'startup' })).toEqual({ note: "- Don't write em dashes." })
  await Bun.sleep(10)
  listing = { ...LISTING, folders: [{ path: '', rules: [EM_DASHES, TRUE_FACTS, { id: 'global/block-hedging', description: 'State a claim only once you checked it.', isEverywhere: true, paths: [LISTED['**']] }] }] }
  modifiedAt = 2
  for (const tick of ticks) tick()
  await Bun.sleep(10)
  expect(asked(tested, 'rules')).toHaveLength(1)
  expect(await tested.raise.beforeSessionStart({ source: 'compact' })).toEqual({ note: "- Don't write em dashes.\n- State a claim only once you checked it." })
  expect(asked(tested, 'rules')).toHaveLength(2)
})

test('an error from rulebook refuses the edit with its text', async () => {
  const refusal = `Edit to Claude.md refused. Fix every error, then edit again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${EM_DASH} now.`
  const tested = serving({ rules: LISTING, edit: { refuse: refusal, failures: [], findings: [SPLIT] } }, { projectRoot: '/work' })
  const input = { file_path: '/work/Claude.md', old_string: 'a', new_string: `Run it ${EM_DASH} now.` }
  expect(await tested.raise.beforeToolCall({ name: 'Edit', input })).toEqual({ refuse: refusal })
  expect(asked(tested)).toEqual([{ url: 'http://localhost/edit', input: { tool_name: 'Edit', tool_input: input, cwd: '/work' }, environment: ENVIRONMENT, socketPath: SOCKET }])
})

test('warnings from rulebook reach the agent beside the edit', async () => {
  const tested = serving({ rules: LISTING, edit: { note: 'Edit to Claude.md allowed with warnings:', failures: [] } })
  expect(await tested.raise.beforeToolCall({ name: 'Write', input: { file_path: '/work/Claude.md', content: 'x' } })).toEqual({ note: 'Edit to Claude.md allowed with warnings:' })
})

test('a rule that did not run goes to the Log as a warning with no toast, and the edit goes on with its note', async () => {
  const skipped = 'global/block-domain-words-for-code did not run on Claude.md: it ran past 30 s'
  const note = `Edit to Claude.md allowed, but not every rule checked it:\n\n${skipped}`
  const tested = serving({ rules: LISTING, edit: { note, failures: [skipped], findings: [] } })
  expect(await tested.raise.beforeToolCall({ name: 'Write', input: { file_path: '/work/Claude.md', content: 'x' } })).toEqual({ note })
  await tested.settle()
  expect(tested.shown.debug).toContainEqual(expect.stringContaining(skipped))
  expect(tested.shown.toasts.filter(({ type }) => type !== 'success')).toEqual([])
})

test('a rulebook serve that cannot start fails each check with an error toast, and checks the edit no other way', async () => {
  const tested = serving({ rules: LISTING, edit: { failures: [], findings: [] } })
  tested.fakes.process.spawn = addressed('listening')
  expect(await tested.raise.beforeToolCall({ name: 'Write', input: { file_path: '/work/Claude.md', content: `Run it ${EM_DASH} now.` } })).toBeUndefined()
  await tested.settle()
  expect(tested.shown.toasts.filter(({ type }) => type === 'error').map(({ message }) => message)).toContain('The rulebook program stopped')
  expect(tested.shown.toasts.filter(({ type }) => type === 'error').length).toBeGreaterThan(1)
  expect(asked(tested)).toEqual([])
})

test('an answer rulebook serve fails is an error, never a pass', async () => {
  const tested = serving({ rules: LISTING })
  const answer = tested.fakes.http.fetch
  tested.fakes.http.fetch = async (url, init) => (url.endsWith('/edit') ? { status: 500, ok: false, headers: {}, text: '/work/rulebook.config.ts: "lint" is not a rulebook config key.' } : answer!(url, init))
  expect(await tested.raise.beforeToolCall({ name: 'Write', input: { file_path: '/work/Claude.md', content: 'x' } })).toBeUndefined()
  await tested.settle()
  expect(tested.shown.toasts.filter(({ type }) => type === 'error')).toEqual([expect.objectContaining({ description: expect.stringContaining('rulebook edit failed: /work/rulebook.config.ts: "lint" is not a rulebook config key.') })])
})

test("a call to a tool a message's tools match is refused before it runs when its text breaks a rule, and no other tool is checked", async () => {
  const tested = serving({ rules: LISTING, text: refusing('Inbox refused. Fix every error, then send it again.') }, { projectRoot: '/work' })
  const proposal = { title: `Ship it ${EM_DASH} today.`, problems: [{ title: 'Slow checks', solutions: [{ ideas: ['Cache the rules.'] }] }], urgent: true }
  expect(await tested.raise.beforeToolCall({ name: 'mcp__inbox__propose', input: proposal })).toEqual({ refuse: `Inbox refused. Fix every error, then send it again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Ship it ${EM_DASH} today.` })
  expect(await tested.raise.beforeToolCall({ name: 'mcp__notes__add', input: { text: `Ship it ${EM_DASH} today.` } })).toBeUndefined()
  expect(await tested.raise.beforeToolCall({ name: 'Read', input: { file_path: '/work/Claude.md' } })).toBeUndefined()
  expect(asked(tested).map(({ url, input }) => ({ url, input }))).toEqual([{ url: 'http://localhost/text', input: { name: '@inbox', text: `Ship it ${EM_DASH} today.\n\nSlow checks\n\nCache the rules.`, cwd: '/work' } }])
})

test('a reply that breaks a rule is refused once with the refusal, and the turn ends after its rewrite', async () => {
  const tested = serving({ rules: LISTING, text: refusing('Reply refused. Fix every error, then write the whole reply again.') }, { projectRoot: '/work' })
  await tested.add({ type: Prompt, text: 'Ship it' })
  await tested.add({ type: Reply, text: `Shipped ${EM_DASH} it works.` })
  expect(await tested.raise.beforeTurnEnd()).toEqual({ refuse: `Reply refused. Fix every error, then write the whole reply again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Shipped ${EM_DASH} it works.` })
  await tested.add({ type: Reply, text: 'Shipped. It works.' })
  expect(await tested.raise.beforeTurnEnd()).toBeUndefined()
  expect(asked(tested).map(({ input }) => input)).toEqual([{ name: '@reply', text: `Shipped ${EM_DASH} it works.`, cwd: '/work' }, { name: '@reply', text: 'Shipped. It works.', cwd: '/work' }])
  expect(tested.shown.toasts.filter(({ type }) => type === 'warning')).toEqual([])
})

test('a rewrite that still breaks a rule ends the turn with a warning toast, and the next turn can be refused again', async () => {
  const tested = serving({ rules: LISTING, text: refusing('Reply refused. Fix every error, then write the whole reply again.') })
  await tested.add({ type: Prompt, text: 'Ship it' })
  await tested.add({ type: Reply, text: `Shipped ${EM_DASH} it works.` })
  expect(await tested.raise.beforeTurnEnd()).toHaveProperty('refuse')
  await tested.add({ type: Reply, text: `Shipped ${EM_DASH} as asked.` })
  expect(await tested.raise.beforeTurnEnd()).toBeUndefined()
  expect(tested.shown.toasts.filter(({ type }) => type === 'warning').map(({ message }) => message)).toEqual(['Reply line 1: Split the sentence at the em dash. (global/block-em-dashes)'])
  await tested.endTurn()
  await tested.add({ type: Prompt, text: 'Ship the next one' })
  await tested.add({ type: Reply, text: `Shipped ${EM_DASH} again.` })
  expect(await tested.raise.beforeTurnEnd()).toHaveProperty('refuse')
})

test('/rulebook lists every finding in the Sidebar', async () => {
  const tested = testMod(rulebook)
  served(tested, () => ({}))
  const reports = [{ path: 'Claude.md', findings: [{ rule: 'global/block-em-dashes', line: 3, level: 'error', message: 'Split the sentence at the em dash.', isExisting: false }], failures: [] }]
  const failure = '/work/rules/block-x.ts: a rule needs a description.'
  tested.fakes.process.run = async () => printed(JSON.stringify({ reports, failures: [failure] }), 1)
  await tested.type('/rulebook')
  await Bun.sleep(10)
  expect(await tested.shown.page.lines()).toEqual(['1 error, 0 warnings in 1 file', '', failure, '', 'Claude.md', '  3  error  global/block-em-dashes  Split the sentence at the em dash.'])
})

test('a rule that failed to load shows a warning toast when a rules listing names it, and a listing that rulebook serve already gave it to names it no more', async () => {
  const failure = '/work/rules/block-x.ts: a rule needs a description. The rule app/block-x checks nothing until it loads.'
  const ticks: (() => void)[] = []
  let modifiedAt = 1
  let failures = [failure]
  const tested = testMod(rulebook, { projectRoot: '/work', files: FILES })
  served(tested, () => ({ rules: { ...LISTING, failures } }))
  tested.fakes.clock.every = (_ms: number, tick: () => void) => (ticks.push(tick), { cancel: () => undefined })
  tested.fakes.fs.stat = async () => ({ kind: 'file', isLink: false, mtimeMs: modifiedAt, size: 1 })
  expect(await tested.raise.beforeSessionStart({ source: 'startup' })).toEqual({ note: "- Don't write em dashes." })
  await Bun.sleep(10)
  failures = []
  modifiedAt = 2
  for (const tick of ticks) tick()
  await Bun.sleep(10)
  expect(await read(tested, '/work/notes.md')).toBeUndefined()
  await tested.settle()
  expect(asked(tested, 'rules')).toHaveLength(2)
  expect(tested.shown.toasts.filter(({ type }) => type !== 'success').map(({ type, message }) => ({ type, message }))).toEqual([{ type: 'warning', message: failure }])
})

test('a rules listing that failed loads again on the next check, so the message checks go on once rulebook serve answers', async () => {
  const tested = serving({ rules: LISTING, text: { refuse: 'Inbox refused.', failures: [], findings: [] } }, { projectRoot: '/work' })
  const answer = tested.fakes.http.fetch!
  let isBroken = true
  tested.fakes.http.fetch = async (url, init) => (isBroken && url.endsWith('/rules') ? { status: 500, ok: false, headers: {}, text: '/home/.config/rulebook/rulebook.config.ts: "lint" is not a rulebook config key.' } : answer(url, init))
  await tested.raise.beforeSessionStart({ source: 'startup' })
  await tested.settle()
  isBroken = false
  expect(await tested.raise.beforeToolCall({ name: 'mcp__inbox__propose', input: { title: 'Ship it.' } })).toEqual({ refuse: 'Inbox refused.' })
  expect(asked(tested, 'rules')).toHaveLength(2)
})

test('an env -0 that failed runs again on the next check, and the check sends the environment it printed', async () => {
  const tested = serving({ rules: LISTING, edit: { failures: [], findings: [] } }, { projectRoot: '/work' })
  const run = tested.fakes.process.run!
  let isBroken = true
  tested.fakes.process.run = async (command, ...rest) => (isBroken ? printed('', 1) : run(command, ...rest))
  const write = { name: 'Write', input: { file_path: '/work/Claude.md', content: 'x' } }
  await tested.raise.beforeToolCall(write)
  await tested.settle()
  isBroken = false
  await tested.raise.beforeToolCall(write)
  expect(asked(tested, 'edit').map(({ environment }) => environment)).toEqual([ENVIRONMENT])
})
