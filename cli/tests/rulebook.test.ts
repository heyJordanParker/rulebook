import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts')
const ASK = join(import.meta.dir, 'ask.ts')

const EM_DASH_RULE = `import { defineRule } from '@cmodjs/rulebook'

export default defineRule({
  description: "Don't write em dashes.",
  check: ({ lines }) => lines.flatMap((text, index) => (text.includes('—') ? [{ line: index + 1, message: 'Split the sentence at the em dash.' }] : [])),
})
`

const HEDGING_RULE = `import { defineRule } from '@cmodjs/rulebook'

export default defineRule({
  description: 'State a claim only once you checked it.',
  level: 'warning',
  check: ({ lines }) => lines.flatMap((text, index) => (/\\bprobably\\b/.test(text) ? [{ line: index + 1, message: 'Check the claim, then state it.' }] : [])),
})
`

let home: string
let project: string
let calls: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'rulebook-home-')))
  project = join(home, 'project')
  calls = join(home, 'claude-calls')
  mkdirSync(project)
  Bun.spawnSync(['git', 'init', '-q'], { cwd: project })
  write(join(home, 'config', 'rulebook', 'rulebook.config.ts'), `import { defineConfig, recommended } from '@cmodjs/rulebook'
export default defineConfig({ extends: [recommended], plugins: { global: './rules' }, paths: ['**/Claude.md'], probes: ['probes/*.md'] })
`)
  write(join(home, 'config', 'rulebook', 'rules', 'block-em-dashes.ts'), EM_DASH_RULE)
  write(join(home, 'config', 'rulebook', 'rules', 'block-hedging.ts'), HEDGING_RULE)
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

function write(file: string, text: string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

function fakeClaude(answer: string, delaySeconds = 0): string {
  const program = write(join(home, 'bin', 'claude'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
while [ $# -gt 0 ]; do
  if [ "$1" = "--plugin-dir" ]; then cat "$2/skills/check/SKILL.md" >> '${calls}'; fi
  shift
done
cat > /dev/null
sleep ${delaySeconds}
cat <<'JSON'
${answer}
JSON
`)
  chmodSync(program, 0o755)
  return program
}

function agenticRule(name: string, frontmatter: string): void {
  write(join(home, 'config', 'rulebook', 'rules', `${name}.md`), `---\ndescription: Name code with code words, never Domain.md words.\n${frontmatter}\n---\n\nReport each Domain.md word that names code.\n`)
}

function linkedRule(): { dotfiles: string; rule: string } {
  const dotfiles = join(home, 'dotfiles')
  const rule = write(join(project, 'rules', 'style.md'), '<!-- a maintainer note — keep it short -->\n@gone.md\n')
  mkdirSync(join(dotfiles, 'rules'), { recursive: true })
  symlinkSync(join(project, 'rules'), join(dotfiles, 'rules', 'inbox'))
  mkdirSync(join(home, '.claude'))
  symlinkSync(join(dotfiles, 'rules'), join(home, '.claude', 'rules'))
  return { dotfiles, rule }
}

function rulebook(args: readonly string[], stdin?: string, claude = fakeClaude('{"type":"result","is_error":false,"structured_output":{"findings":[]}}'), cwd = project, env: Readonly<Record<string, string>> = {}, entry = MAIN) {
  const run = Bun.spawnSync([process.execPath, entry, ...args], {
    cwd,
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), PATH: `${dirname(claude)}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: undefined, ...env },
  })
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}

function edit(tool: string, input: Record<string, unknown>, claude?: string) {
  const run = rulebook(['edit'], JSON.stringify({ tool_name: tool, tool_input: input, cwd: project }), claude, project, {}, ASK)
  expect(run.stderr).toBe('')
  return JSON.parse(run.stdout) as { refuse?: string; note?: string; failures: string[]; findings: unknown[] }
}

const NOTHING = { failures: [], findings: [] }

test('an error refuses the edit and names the rule and the line', () => {
  const answer = edit('Write', { file_path: join(project, 'Claude.md'), content: '# Facts\n\nRun it — it restows.\n' })
  expect(answer.refuse).toBe('Edit to Claude.md refused. Fix every error, then edit again.\n\n  3  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it — it restows.')
})

test('a warning lets the edit land and tells the agent', () => {
  const answer = edit('Write', { file_path: join(project, 'Claude.md'), content: 'It probably works.\n' })
  expect(answer).toEqual({
    note: 'Edit to Claude.md allowed with warnings:\n\n  1  warning  global/block-hedging  Check the claim, then state it.\n     > It probably works.',
    failures: [],
    findings: [{ rule: 'global/block-hedging', line: 1, level: 'warning', message: 'Check the claim, then state it.', quote: 'It probably works.', isExisting: false }],
  })
})

test('a file outside every config paths is not checked', () => {
  expect(edit('Write', { file_path: join(project, 'notes.md'), content: 'Run it — now.\n' })).toEqual(NOTHING)
})

test('an error already in the file is a warning, unless existingErrors makes it an error, and the answer counts it in one line', () => {
  const file = write(join(project, 'Claude.md'), 'Old line — here.\nSecond line.\n')
  const answer = edit('Edit', { file_path: file, old_string: 'Second line.', new_string: 'Second line, now edited.' })
  expect(answer.refuse).toBeUndefined()
  expect(answer.note).toBe('Edit to Claude.md allowed with warnings:\n\n1 warning in this file was there before this edit. `rulebook check Claude.md` lists it.')

  write(join(project, 'rulebook.config.ts'), `export default { existingErrors: 'error' }\n`)
  expect(edit('Edit', { file_path: file, old_string: 'Second line.', new_string: 'Second line, now edited.' }).refuse).toBe('Edit to Claude.md refused. Fix every error, then edit again.\n\n1 error in this file was there before this edit. `rulebook check Claude.md` lists it.')
})

test('an edit that adds one em dash to a file holding 5 old ones refuses with the one new line quoted and the count line', () => {
  const file = write(join(project, 'Claude.md'), [1, 2, 3, 4, 5].map((step) => `Step ${step} \u2014 old.`).join('\n') + '\nRun it now.\n')
  const answer = edit('Edit', { file_path: file, old_string: 'Run it now.', new_string: 'Run it \u2014 now.' })
  expect(answer.refuse).toBe('Edit to Claude.md refused. Fix every error, then edit again.\n\n  6  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it \u2014 now.\n\n5 more warnings in this file were there before this edit. `rulebook check Claude.md` lists them.')
  expect(answer.findings).toHaveLength(6)
})

test('a MultiEdit is checked as the file reads after every replacement', () => {
  const file = write(join(project, 'Claude.md'), 'One.\nTwo.\n')
  const answer = edit('MultiEdit', { file_path: file, edits: [{ old_string: 'One.', new_string: 'One — more.' }, { old_string: 'Two.', new_string: 'Two.' }] })
  expect(answer.refuse).toContain('1  error  global/block-em-dashes')
})

test("a project config turns a global rule off or changes its level, and adds the project's own rules", () => {
  write(join(project, 'rulebook.config.ts'), `import { defineConfig } from '@cmodjs/rulebook'
export default defineConfig({ plugins: { app: './rules' }, rules: { 'global/block-em-dashes': 'warning', 'global/block-hedging': 'off' } })
`)
  const dash = String.fromCharCode(0x2014)
  write(join(project, 'rules','block-npm-run.ts'), `export default { description: 'Run just, never npm run.', check: ({ lines }) => lines.flatMap((text, index) => (text.includes('npm run') ? [{ line: index + 1, message: 'Run just.' }] : [])) }\n`)
  const answer = edit('Write', { file_path: join(project, 'Claude.md'), content: `Run it ${dash} probably.\nRun npm run migrate.\n` })
  expect(answer.refuse).toBe(`Edit to Claude.md refused. Fix every error, then edit again.\n\n  2  error  app/block-npm-run  Run just.\n     > Run npm run migrate.\n\nWarnings:\n  1  warning  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} probably.`)
})

test("a file in packages/a/ with its own rulebook.config.ts uses that config plus the global config, and not the root's, unless it extends the root's", () => {
  const dash = String.fromCharCode(0x2014)
  write(join(project, 'rulebook.config.ts'), `export default { rules: { 'global/block-em-dashes': 'off' } }\n`)
  write(join(project, 'packages', 'a', 'rulebook.config.ts'), `export default { paths: ['**/*.md'] }\n`)
  const nested = join(project, 'packages', 'a', 'docs', 'x.md')
  expect(edit('Write', { file_path: join(project, 'Claude.md'), content: `Run it ${dash} now.\n` })).toEqual(NOTHING)
  expect(edit('Write', { file_path: nested, content: `Run it ${dash} now.\n` }).refuse).toBe(`Edit to packages/a/docs/x.md refused. Fix every error, then edit again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} now.`)
  write(join(project, 'Claude.md'), `Run it ${dash} now.\n`)
  write(nested, `Run it ${dash} now.\n`)
  write(join(project, 'notes', 'y.md'), `Run it ${dash} now.\n`)
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe(`packages/a/docs/x.md\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} now.\n\n1 error, 0 warnings in 2 files\n`)

  write(join(project, 'packages', 'a', 'rulebook.config.ts'), `export default { extends: ['../../rulebook.config.ts'], paths: ['**/*.md'] }\n`)
  expect(edit('Write', { file_path: nested, content: `Run it ${dash} now.\n` })).toEqual(NOTHING)
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe('0 errors, 0 warnings in 2 files\n')
})

test("a project with no config of its own, under a folder that holds one, uses that folder's config plus the global config, until the project holds its own", () => {
  const dash = String.fromCharCode(0x2014)
  write(join(home, 'rulebook.config.ts'), `export default { rules: { 'global/block-em-dashes': 'warning' } }\n`)
  const answer = edit('Write', { file_path: join(project, 'Claude.md'), content: `Run it ${dash} probably.\n` })
  expect(answer.refuse).toBeUndefined()
  expect(answer.findings).toEqual([
    { rule: 'global/block-em-dashes', line: 1, level: 'warning', message: 'Split the sentence at the em dash.', quote: `Run it ${dash} probably.`, isExisting: false },
    { rule: 'global/block-hedging', line: 1, level: 'warning', message: 'Check the claim, then state it.', quote: `Run it ${dash} probably.`, isExisting: false },
  ])
  write(join(project, 'Claude.md'), `Run it ${dash} now.\n`)
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe(`Claude.md\n  1  warning  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} now.\n\n0 errors, 1 warning in 1 file\n`)

  write(join(project, 'rulebook.config.ts'), 'export default {}\n')
  expect(edit('Write', { file_path: join(project, 'Claude.md'), content: `Run it ${dash} again.\n` }).refuse).toBe(`Edit to Claude.md refused. Fix every error, then edit again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} again.`)
})

test("extends: ['../rulebook.config.ts'] merges the global config, then each extends entry, then the config's own keys, so a later rules setting turns an inherited rule to 'warning'", () => {
  const dash = String.fromCharCode(0x2014)
  write(join(project, 'rulebook.config.ts'), `export default { plugins: { app: './rules' }, rules: { 'global/block-em-dashes': 'off', 'global/block-hedging': 'error' } }\n`)
  write(join(project, 'rules','block-npm-run.ts'), `export default { description: 'Run just, never npm run.', check: ({ lines }) => lines.flatMap((text, index) => (text.includes('npm run') ? [{ line: index + 1, message: 'Run just.' }] : [])) }\n`)
  write(join(project, 'a', 'rulebook.config.ts'), `export default { extends: ['../rulebook.config.ts'], rules: { 'global/block-em-dashes': 'warning' } }\n`)
  const answer = edit('Write', { file_path: join(project, 'a', 'Claude.md'), content: `Run it ${dash} probably.\nRun npm run migrate.\n` })
  expect(answer.findings).toEqual([
    { rule: 'global/block-em-dashes', line: 1, level: 'warning', message: 'Split the sentence at the em dash.', quote: `Run it ${dash} probably.`, isExisting: false },
    { rule: 'global/block-hedging', line: 1, level: 'error', message: 'Check the claim, then state it.', quote: `Run it ${dash} probably.`, isExisting: false },
    { rule: 'app/block-npm-run', line: 2, level: 'error', message: 'Run just.', quote: 'Run npm run migrate.', isExisting: false },
  ])
})

test('a missing extends path fails and names it', () => {
  write(join(project, 'rulebook.config.ts'), `export default { extends: ['./shared/rulebook.config.ts'] }\n`)
  const run = rulebook(['check', '--skip=agentic'])
  expect(run.code).toBe(2)
  expect(run.stderr).toBe(`rulebook: ${join(project, 'rulebook.config.ts')}: extends "./shared/rulebook.config.ts", but ${join(project, 'shared', 'rulebook.config.ts')} is not a file.\n`)
})

test('a broken CLAUDE.md import is not flagged with no config, and is flagged once a config extends recommended, which needs no paths of its own', () => {
  rmSync(join(home, 'config'), { recursive: true })
  expect(edit('Write', { file_path: join(project, 'CLAUDE.md'), content: '@gone.md\n' })).toEqual(NOTHING)
  write(join(home, 'config', 'rulebook', 'rulebook.config.ts'), `import { defineConfig, recommended } from '@cmodjs/rulebook'\nexport default defineConfig({ extends: [recommended], plugins: { global: './rules' } })\n`)
  write(join(home, 'config', 'rulebook', 'rules', 'block-x.ts'), `export default { description: "Don't run x.", check: ({ lines }) => lines.flatMap((text, index) => (text.includes('Run x.') ? [{ line: index + 1 }] : [])) }\n`)
  expect(edit('Write', { file_path: join(project, 'CLAUDE.md'), content: '@gone.md\n' }).refuse).toBe('Edit to CLAUDE.md refused. Fix every error, then edit again.\n\n  1  error  rulebook/imports  The import names gone.md, which is not a file. Fix the path or remove the import.\n     > @gone.md')
  expect(edit('Write', { file_path: join(project, '.claude', 'skills', 'deploy', 'SKILL.md'), content: 'Run x.\n' }).refuse).toBe("Edit to .claude/skills/deploy/SKILL.md refused. Fix every error, then edit again.\n\n  1  error  global/block-x  Don't run x.\n     > Run x.")
  expect(edit('Write', { file_path: join(project, 'docs', 'notes.md'), content: 'Run x.\n' })).toEqual(NOTHING)
})

const NO_SUPPRESSIONS = `export default { rules: { 'rulebook/no-suppressions': 'error' } }\n`

test('a write that adds an oxlint-disable-next-line comment lands with no config, and is refused once a config turns rulebook/no-suppressions on', () => {
  const content = '// oxlint-disable-next-line no-debugger\ndebugger\n'
  expect(edit('Write', { file_path: join(project, 'src', 'app.ts'), content })).toEqual(NOTHING)
  write(join(project, 'rulebook.config.ts'), NO_SUPPRESSIONS)
  expect(edit('Write', { file_path: join(project, 'src', 'app.ts'), content }).refuse).toBe('Edit to src/app.ts refused. Fix every error, then edit again.\n\n  1  error  rulebook/no-suppressions  This comment suppresses oxlint. Fix the code oxlint flags, and remove the comment.\n     > // oxlint-disable-next-line no-debugger')
})

test('an edit elsewhere in a file that already held a suppression comment lands with the existing-findings count line, and rulebook lists the suppression', () => {
  write(join(project, 'rulebook.config.ts'), NO_SUPPRESSIONS)
  const file = write(join(project, 'src', 'app.ts'), '// oxlint-disable-next-line no-debugger\ndebugger\nconst a = 1\n')
  const answer = edit('Edit', { file_path: file, old_string: 'const a = 1', new_string: 'const a = 2' })
  expect(answer.refuse).toBeUndefined()
  expect(answer.note).toBe('Edit to src/app.ts allowed with warnings:\n\n1 warning in this file was there before this edit. `rulebook check src/app.ts` lists it.')
  expect(rulebook(['check', 'src/app.ts']).stdout).toBe('src/app.ts\n  1  error  rulebook/no-suppressions  This comment suppresses oxlint. Fix the code oxlint flags, and remove the comment.\n     > // oxlint-disable-next-line no-debugger\n\n1 error, 0 warnings in 1 file\n')
})

test.each([
  ['oxlint', 'app.ts', '// oxlint-disable-next-line no-debugger'],
  ['oxlint', 'app.ts', 'debugger // oxlint-disable-line no-debugger'],
  ['oxlint', 'app.ts', '/* oxlint-disable no-debugger */'],
  ['oxlint', 'app.js', '// eslint-disable-next-line no-debugger'],
  ['oxlint', 'app.js', 'debugger // eslint-disable-line no-debugger'],
  ['oxlint', 'app.js', '/* eslint-disable */'],
  ['biome', 'app.ts', '// biome-ignore lint/suspicious/noDebugger: reason'],
  ['biome', 'app.ts', '// biome-ignore-all lint/suspicious/noDebugger: reason'],
  ['biome', 'app.ts', '// biome-ignore-start lint/suspicious/noDebugger: reason'],
  ['biome', 'style.css', '/* biome-ignore lint/complexity/noImportantStyles: reason */'],
  ['mago', 'app.php', '// @mago-expect lint:no-shorthand-ternary'],
  ['mago', 'app.php', '// @mago-ignore all'],
  ['mago', 'app.php', ' * @mago-ignore analysis:missing-return-statement'],
  ['ruff', 'app.py', 'import os  # noqa: F401'],
  ['ruff', 'app.py', 'import os  # type: ignore # NOQA'],
  ['ruff', 'app.py', '# ruff: noqa'],
  ['ruff', 'app.py', '# flake8: noqa'],
  ['ruff', 'app.py', 'import os  # ruff: ignore[F401]'],
  ['ruff', 'app.py', '# ruff: disable[E501]'],
  ['ruff', 'app.py', '# ruff: file-ignore[F401]'],
  ['shellcheck', 'run.sh', '# shellcheck disable=SC2086'],
  ['shellcheck', 'run.sh', '# shellcheck source=/dev/null disable=SC1091'],
  ['shellcheck', 'deploy', '# shellcheck disable=SC2086'],
  ['stylelint', 'style.css', '/* stylelint-disable */'],
  ['stylelint', 'style.css', 'a { color: pink !important; } /* stylelint-disable-line declaration-no-important */'],
  ['stylelint', 'style.css', '/* stylelint-disable-next-line declaration-no-important */'],
  ['selene', 'init.lua', '-- selene: allow(unused_variable)'],
  ['selene', 'init.lua', '--# selene: allow(unused_variable)'],
])('rulebook/no-suppressions flags a %s suppression in %s: %s', (linter, name, comment) => {
  write(join(project, 'rulebook.config.ts'), NO_SUPPRESSIONS)
  expect(edit('Write', { file_path: join(project, 'src', name), content: `${comment}\n` }).findings).toEqual([
    { rule: 'rulebook/no-suppressions', line: 1, level: 'error', message: `This comment suppresses ${linter}. Fix the code ${linter} flags, and remove the comment.`, quote: comment, isExisting: false },
  ])
})

test('rulebook/no-suppressions flags neither a comment that ends a suppression nor a Prompt that names one', () => {
  write(join(project, 'rulebook.config.ts'), NO_SUPPRESSIONS)
  expect(edit('Write', { file_path: join(project, 'src', 'app.ts'), content: '/* oxlint-enable no-debugger */\n// biome-ignore-end lint/suspicious/noDebugger: reason\n' })).toEqual(NOTHING)
  expect(edit('Write', { file_path: join(project, 'Claude.md'), content: 'Never write `// oxlint-disable-next-line`.\n' })).toEqual(NOTHING)
})

test('a config that names a rule no plugin holds fails loudly', () => {
  write(join(project, 'rulebook.config.ts'), `export default { rules: { 'global/no-such-rule': 'off' } }\n`)
  const run = rulebook(['check', '--stdin-file-path=Claude.md'], 'x\n')
  expect(run.code).toBe(2)
  expect(run.stderr).toContain('sets the rule "global/no-such-rule", which no plugin holds')
})

test('an agentic rule runs as a forked Skill with its own frontmatter, and its findings refuse the edit', () => {
  agenticRule('block-domain-words-for-code', 'agent: explorer\nmodel: haiku\neffort: low\nallowed-tools: Read\npaths:\n  - "**/Claude.md"\nmetadata:\n  level: error')
  const claude = fakeClaude('{"type":"result","is_error":false,"result":"{\\"findings\\": [{\\"line\\": 1, \\"message\\": \\"Slice names a commit here.\\"}]}"}')
  const answer = edit('Write', { file_path: join(project, 'Claude.md'), content: 'Each Slice is a commit.\n' }, claude)
  expect(answer.refuse).toContain('1  error  global/block-domain-words-for-code  Slice names a commit here.')
  const recorded = readFileSync(calls, 'utf8')
  for (const part of ['-p', '--output-format stream-json', '--plugin-dir', '{"disableAllHooks":true}', '"context":"fork"', '"agent":"explorer"', '"model":"haiku"', '"effort":"low"', '"allowed-tools":["Read"]', '"disallowed-tools":["Edit","Write","MultiEdit","NotebookEdit"]', '1 | Each Slice is a commit.']) expect(recorded).toContain(part)
})

test("an agentic rule's findings count when its subagent answers through the StructuredOutput tool", () => {
  agenticRule('require-true-facts', 'model: sonnet')
  const stream = [
    '{"type":"assistant","parent_tool_use_id":"forked-command-rulebook-rule:check","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":{"findings":[{"line":1,"message":"The code says otherwise."}]}}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"Command completed"}',
  ].join('\n')
  expect(edit('Write', { file_path: join(project, 'Claude.md'), content: 'A fact.\n' }, fakeClaude(stream)).refuse).toContain('1  error  global/require-true-facts  The code says otherwise.')
})

test('a manual rule never runs on an edit, and runs when rulebook runs', () => {
  agenticRule('require-true-facts', 'metadata:\n  runs: manual')
  const claude = fakeClaude('{"type":"result","is_error":false,"structured_output":{"findings":[{"line":1,"message":"The code says otherwise."}]}}')
  expect(edit('Write', { file_path: join(project, 'Claude.md'), content: 'A fact.\n' }, claude)).toEqual(NOTHING)
  write(join(project, 'Claude.md'), 'A fact.\n')
  const run = rulebook(['check'], undefined, claude)
  expect(run.code).toBe(1)
  expect(run.stdout).toBe('Claude.md\n  1  error  global/require-true-facts  The code says otherwise.\n     > A fact.\n\n1 error, 0 warnings in 1 file\n')
})

test('a Jev rule that names an agent fails to load, and a config that sets model jev and an agent on one rule fails', () => {
  agenticRule('require-true-facts', 'model: jev\nagent: explorer')
  const { failures } = JSON.parse(rulebook(['inspect', 'rules']).stdout) as { failures: string[] }
  expect(failures).toEqual([`${join(home, 'config', 'rulebook', 'rules', 'require-true-facts.md')}: model jev runs the rule on Jev, which runs no agent, so rulebook does not read agent. The rule global/require-true-facts checks nothing until it loads.`])
  agenticRule('require-true-facts', 'agent: explorer')
  write(join(project, 'rulebook.config.ts'), `export default { rules: { 'global/require-true-facts': { model: 'jev', effort: 'low' } } }\n`)
  const run = rulebook(['check', '--skip=agentic'])
  expect(run.code).toBe(2)
  expect(run.stderr).toBe('rulebook: A rulebook config sets effort on global/require-true-facts, which runs on Jev, and Jev runs no agent.\n')
})

test('a threshold on a Claude rule or outside 0 to 1 fails to load, and a config that sets one on a Claude rule fails', () => {
  const source = join(home, 'config', 'rulebook', 'rules', 'require-true-facts.md')
  const failures = () => (JSON.parse(rulebook(['inspect', 'rules']).stdout) as { failures: string[] }).failures
  agenticRule('require-true-facts', 'model: sonnet\nmetadata:\n  threshold: 0.9')
  expect(failures()).toEqual([`${source}: metadata.threshold is the probability Jev must give a line to pass, so it needs model: jev. The rule global/require-true-facts checks nothing until it loads.`])
  agenticRule('require-true-facts', 'model: jev\nmetadata:\n  threshold: 90')
  expect(failures()).toEqual([`${source}: metadata.threshold is a probability above 0 and at most 1. The rule global/require-true-facts checks nothing until it loads.`])
  agenticRule('require-true-facts', 'model: sonnet')
  write(join(project, 'rulebook.config.ts'), `export default { rules: { 'global/require-true-facts': { threshold: 0.9 } } }\n`)
  const run = rulebook(['check', '--skip=agentic'])
  expect(run.code).toBe(2)
  expect(run.stderr).toBe("rulebook: A rulebook config sets threshold on global/require-true-facts, which runs on Claude Code. threshold is the probability Jev must give a line to pass, so it needs model: 'jev'.\n")
})

test('two agentic rules with timeouts of 300 and 600 ms end within one 600 ms deadline, and the edit lands', () => {
  write(join(project, 'rulebook.config.ts'), `export default { timeout: 300, rules: { 'global/require-true-facts': { timeout: 600 } } }\n`)
  agenticRule('block-domain-words-for-code', 'model: haiku')
  agenticRule('require-true-facts', 'metadata:\n  timeout: 450')
  const started = performance.now()
  const answer = edit('Write', { file_path: join(project, 'Claude.md'), content: 'Each Slice is a commit.\n' }, fakeClaude('{}', 5))
  expect(performance.now() - started).toBeLessThan(3_000)
  expect(answer.refuse).toBeUndefined()
  expect(answer.failures).toEqual([
    'global/block-domain-words-for-code did not run on Claude.md: it ran past 600 ms',
    'global/require-true-facts did not run on Claude.md: it ran past 600 ms',
  ])
})

test('a config that sets timeout on a static rule fails and names the rule', () => {
  write(join(project, 'rulebook.config.ts'), `export default { rules: { 'global/block-em-dashes': { timeout: 600 } } }\n`)
  const run = rulebook(['check', '--skip=agentic'])
  expect(run.code).toBe(2)
  expect(run.stderr).toBe('rulebook: A rulebook config sets timeout on global/block-em-dashes, a static rule, which runs no agent.\n')
})

test('a manual run over six files, each with one agentic rule, starts every session at once', () => {
  agenticRule('require-true-facts', 'metadata:\n  runs: manual')
  for (const folder of ['a', 'b', 'c', 'd', 'e', 'f']) write(join(project, folder, 'Claude.md'), 'A fact.\n')
  const starts = join(home, 'claude-starts')
  const claude = write(join(home, 'bin', 'claude'), `#!${process.execPath}
import { appendFileSync } from 'node:fs'
appendFileSync('${starts}', \`\${Date.now()}\\n\`)
await Bun.sleep(2_000)
console.log('{"type":"result","is_error":false,"structured_output":{"findings":[{"line":1,"message":"Checked."}]}}')
`)
  chmodSync(claude, 0o755)
  const run = rulebook(['check'], undefined, claude)
  expect(run.stdout).toEndWith('6 errors, 0 warnings in 6 files\n')
  const started = readFileSync(starts, 'utf8').trim().split('\n').map(Number)
  expect(started).toHaveLength(6)
  expect(Math.max(...started) - Math.min(...started)).toBeLessThan(1_000)
}, 30_000)

test('a pattern rule flags each match of its ast-grep rule at its first line, and never a comment or a string', () => {
  write(join(project, 'rulebook.config.ts'), `export default { paths: ['src/**/*.ts'] }\n`)
  write(join(home, 'config', 'rulebook', 'rules', 'block-console-log.yml'), "description: Don't log to the console.\nlanguage: typescript\npaths: ['**/*.ts']\nrule:\n  pattern: console.log($$$ARGS)\n")
  write(join(project, 'src', 'app.ts'), "// console.log('in a comment')\nconst text = \"console.log('in a string')\"\nconsole.log(\n  text,\n)\n")
  expect(rulebook(['check', '--skip=agentic', 'src/app.ts']).stdout).toBe("src/app.ts\n  3  error  global/block-console-log  Don't log to the console.\n     > console.log(\n\n1 error, 0 warnings in 1 file\n")
})

test('a pattern rule in PHP flags a PHP file', () => {
  write(join(project, 'rulebook.config.ts'), `export default { paths: ['**/*.php'] }\n`)
  write(join(home, 'config', 'rulebook', 'rules', 'block-var-dump.yml'), "description: Don't leave var_dump in the code.\nlanguage: php\nrule:\n  pattern:\n    context: '<?php var_dump($$$ARGS);'\n    selector: function_call_expression\n")
  write(join(project, 'debug.php'), '<?php\n$user = load();\nvar_dump($user);\n')
  expect(rulebook(['check', '--skip=agentic', 'debug.php']).stdout).toBe("debug.php\n  3  error  global/block-var-dump  Don't leave var_dump in the code.\n     > var_dump($user);\n\n1 error, 0 warnings in 1 file\n")
})

test('a rule in a subfolder carries the folder in its name, and a config or pin that names it without the folder fails and names it', () => {
  write(join(home, 'config', 'rulebook', 'rules', 'writing', 'block-x.ts'), `export default { description: "Don't write x.", check: ({ lines }) => lines.flatMap((text, index) => (text.includes('x') ? [{ line: index + 1, message: 'Remove the x.' }] : [])) }\n`)
  expect(edit('Write', { file_path: join(project, 'Claude.md'), content: 'Run x.\n' }).refuse).toContain('1  error  global/writing/block-x  Remove the x.')

  const probe = write(join(home, 'config', 'rulebook', 'probes', 'block-x.md'), '<!-- rulebook-expect global/block-x -->\nRun x.\n')
  expect(rulebook(['check', probe]).stdout).toContain('1  error  global/block-x  The pin expects global/block-x to flag line 2, and it does not.')

  write(join(project, 'rulebook.config.ts'), `export default { rules: { 'global/block-x': 'off' } }\n`)
  const run = rulebook(['check', '--stdin-file-path=Claude.md'], 'Run x.\n')
  expect(run.code).toBe(2)
  expect(run.stderr).toContain('A rulebook config sets the rule "global/block-x", which no plugin holds. The rules are rulebook/imports, rulebook/no-suppressions, global/block-em-dashes, global/block-hedging, global/writing/block-x.')
})

test('a rule of any kind without a description checks nothing, every other rule still checks, and the rules listing and a full run name it once', () => {
  const dash = String.fromCharCode(0x2014)
  const rules = join(home, 'config', 'rulebook', 'rules')
  const undescribed = {
    'block-x.ts': `export default { check: () => [] }\n`,
    'block-y.md': '---\nmodel: haiku\n---\n\nReport each y.\n',
    'block-z.yml': 'language: typescript\nrule:\n  pattern: z\n',
  }
  write(join(project, 'Claude.md'), `Run it ${dash} now.\n`)
  for (const [name, text] of Object.entries(undescribed)) {
    const rule = write(join(rules, name), text)
    const failure = `${rule}: a rule needs a description: the Rule in one line of plain words, such as "Don't write em dashes." The rule global/${name.slice(0, name.lastIndexOf('.'))} checks nothing until it loads.`
    expect(rulebook(['check', '--skip=agentic'])).toEqual({ code: 1, stdout: `Claude.md\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} now.\n\n${failure}\n\n1 error, 0 warnings in 1 file\n`, stderr: '' })
    expect((JSON.parse(rulebook(['inspect', 'rules']).stdout) as { failures: string[] }).failures).toEqual([failure])
    expect(edit('Write', { file_path: join(project, 'Claude.md'), content: `Run it ${dash} again.\n` })).toEqual({
      refuse: `Edit to Claude.md refused. Fix every error, then edit again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} again.`,
      failures: [],
      findings: [{ rule: 'global/block-em-dashes', line: 1, level: 'error', message: 'Split the sentence at the em dash.', quote: `Run it ${dash} again.`, isExisting: false }],
    })
    rmSync(rule)
  }
})

test("a project's rule that fails to load leaves the global rules checking that project, and a config setting for it is no error", () => {
  const dash = String.fromCharCode(0x2014)
  write(join(project, 'rulebook.config.ts'), `export default { plugins: { app: './rules' }, rules: { 'app/require-readme-sections': 'warning' } }\n`)
  const rule = write(join(project, 'rules','require-readme-sections.ts'), `export default { check: () => [] }\n`)
  const listing = rulebook(['inspect', 'rules'])
  expect(listing.stderr).toBe('')
  expect((JSON.parse(listing.stdout) as { failures: string[] }).failures).toEqual([`${rule}: a rule needs a description: the Rule in one line of plain words, such as "Don't write em dashes." The rule app/require-readme-sections checks nothing until it loads.`])
  expect(edit('Write', { file_path: join(project, 'Claude.md'), content: `Run it ${dash} now.\n` }).refuse).toBe(`Edit to Claude.md refused. Fix every error, then edit again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} now.`)
})

test('rulebook inspect rules lists, for the project folder, each rule that is on with its id, description, whether it covers every file or a message, and a regular expression for each path it covers, each registered message with a regular expression for each tool that sends it, and the files and folders the rules come from', () => {
  write(join(project, 'rulebook.config.ts'), `export default { plugins: { app: './rules' }, messages: { inbox: { tools: ['mcp__inbox__*'] } }, rules: { 'global/block-hedging': 'off' } }\n`)
  write(join(project, 'rules', 'block-npm-run.md'), '---\ndescription: Run just, never npm run.\npaths: ["**", "@reply"]\n---\n\nReport each npm run.\n')
  const run = rulebook(['inspect', 'rules'])
  const listed = { source: expect.any(String), flags: '' }
  expect(run.stderr).toBe('')
  expect(JSON.parse(run.stdout)).toEqual({
    root: project,
    sources: [join(home, 'config', 'rulebook', 'rulebook.config.ts'), join(project, 'rulebook.config.ts'), join(home, 'config', 'rulebook', 'rules'), join(project, 'rules')],
    folders: [{
      path: '',
      rules: [
        { id: 'rulebook/imports', description: 'Import only files that exist.', isEverywhere: false, paths: Array(5).fill(listed) },
        { id: 'global/block-em-dashes', description: "Don't write em dashes.", isEverywhere: false, paths: Array(5).fill(listed) },
        { id: 'app/block-npm-run', description: 'Run just, never npm run.', isEverywhere: true, paths: [listed, listed] },
      ],
    }],
    messages: [
      { name: '@reply', tools: [] },
      { name: '@inbox', tools: [listed] },
    ],
    failures: [],
  })
})

test('rulebook inspect rules lets the mod tell that a rule from packages/a/rulebook.config.ts applies to packages/a/x.md and not to packages/b/x.md', () => {
  write(join(project, 'packages', 'a', 'rulebook.config.ts'), `export default { plugins: { a: './rules' } }\n`)
  write(join(project, 'packages', 'a', 'rules', 'block-x.ts'), `export default { description: "Don't write x.", paths: ['**/*.md'], check: () => [] }\n`)
  write(join(project, 'packages', 'b', 'rulebook.config.ts'), 'export default {}\n')
  const { folders } = JSON.parse(rulebook(['inspect', 'rules']).stdout) as { folders: { path: string; rules: { id: string; paths: { source: string; flags: string }[] }[] }[] }
  const rulesFor = (path: string) => {
    const folder = folders.filter((each) => each.path === '' || path.startsWith(`${each.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]
    return (folder?.rules ?? []).filter((rule) => rule.paths.some(({ source, flags }) => new RegExp(source, flags).test(path))).map(({ id }) => id)
  }
  expect(folders.map(({ path }) => path)).toEqual(['', 'packages/a', 'packages/b'])
  expect(rulesFor('packages/a/x.md')).toEqual(['a/block-x'])
  expect(rulesFor('packages/b/x.md')).toEqual([])
  expect(rulesFor('notes/x.md')).toEqual([])
})

test('each regular expression rulebook inspect rules lists covers the paths and @-names its glob covers', () => {
  const paths = ['Claude.md', 'packages/claude/Claude.md', '.claude/rules/style.md', '.env', 'src', 'src/app.ts', 'src/lib/deep/util.ts', '@reply', '@inbox', '@inbox/proposal/x.md']
  const covered: [string, string[]][] = [
    ['**', ['Claude.md', 'packages/claude/Claude.md', '.claude/rules/style.md', '.env', 'src', 'src/app.ts', 'src/lib/deep/util.ts']],
    ['**/*.md', ['Claude.md', 'packages/claude/Claude.md', '.claude/rules/style.md']],
    ['**/Claude.md', ['Claude.md', 'packages/claude/Claude.md']],
    ['*.md', ['Claude.md']],
    ['.claude/rules/*.md', ['.claude/rules/style.md']],
    ['.*', ['.env']],
    ['src/**', ['src/app.ts', 'src/lib/deep/util.ts']],
    ['src/*.ts', ['src/app.ts']],
    ['{src,packages}/**/*.{ts,md}', ['packages/claude/Claude.md', 'src/app.ts', 'src/lib/deep/util.ts']],
    ['@reply', ['@reply']],
    ['@inbox', ['@inbox']],
    ['@inbox/**', ['@inbox/proposal/x.md']],
    ['@*', ['@reply', '@inbox']],
  ]
  const globs = covered.map(([glob]) => glob)
  write(join(project, 'rulebook.config.ts'), `export default { messages: { inbox: { folder: '../inbox-items' } }, rules: { 'global/block-em-dashes': { paths: ${JSON.stringify(globs)} } } }\n`)
  const { folders } = JSON.parse(rulebook(['inspect', 'rules']).stdout) as { folders: { rules: { id: string; paths: { source: string; flags: string }[] }[] }[] }
  const listed = folders[0]?.rules.find(({ id }) => id === 'global/block-em-dashes')?.paths ?? []
  expect(listed.map(({ source, flags }, index) => [globs[index], paths.filter((path) => new RegExp(source, flags).test(path))])).toEqual(covered)
})

test('a probe passes while each pin fires, and fails on a pin that stops firing or a flag with no pin', () => {
  const probe = write(join(home, 'config', 'rulebook', 'probes', 'block-em-dashes.md'), '<!-- rulebook-expect global/block-em-dashes -->\nRun it — now.\n\nRun it now.\n')
  expect(rulebook(['check', probe]).code).toBe(0)
  write(probe, '<!-- rulebook-expect global/block-em-dashes -->\nRun it now.\n\nRun it — now.\n')
  const run = rulebook(['check', probe])
  expect(run.code).toBe(1)
  expect(run.stdout).toContain('1  error  global/block-em-dashes  The pin expects global/block-em-dashes to flag line 2, and it does not.')
  expect(run.stdout).toContain('4  error  global/block-em-dashes  Split the sentence at the em dash. (no pin expects this flag)')
})

test("a probe skips each pin of a rule outside the run's scope, and still fails a pin that names no rule", () => {
  agenticRule('require-true-facts', 'metadata:\n  runs: manual')
  const probe = write(join(home, 'config', 'rulebook', 'probes', 'require-true-facts.md'), '<!-- rulebook-expect global/require-true-facts -->\nThe sky is green.\n')
  expect(rulebook(['check', '--skip=agentic', probe])).toEqual({ code: 0, stdout: '0 errors, 0 warnings in 1 file\n', stderr: '' })
  expect(edit('Write', { file_path: probe, content: '<!-- rulebook-expect global/require-true-facts -->\nThe grass is blue.\n' })).toEqual(NOTHING)
  write(probe, '<!-- rulebook-expect global/no-such-rule -->\nThe sky is green.\n')
  expect(rulebook(['check', '--skip=agentic', probe]).stdout).toContain('1  error  global/no-such-rule  The pin expects global/no-such-rule to flag line 2, and it does not.')
})

test('a pin outside a probe is an error, and a pin shown in a code block is text', () => {
  const answer = edit('Write', { file_path: join(project, 'Claude.md'), content: '<!-- rulebook-expect global/block-em-dashes -->\nRun it now.\n' })
  expect(answer.refuse).toContain('1  error  rulebook/pins')
  expect(edit('Write', { file_path: join(project, 'Claude.md'), content: '```md\n<!-- rulebook-expect global/block-em-dashes -->\n```\n' })).toEqual(NOTHING)
})

test("a Claude.md's imports are linted as Prompts, and an import that points at no file is an error that quotes its line", () => {
  write(join(project, 'Claude.md'), '@extra.md\n@include included.md\n`@literal.md`\n@gone.md\n')
  for (const name of ['extra.md', 'included.md', 'literal.md']) write(join(project, name), 'Run it — now.\n')
  const run = rulebook(['check', '--skip=agentic'])
  expect(run.code).toBe(1)
  expect(run.stdout).toBe([
    'Claude.md',
    '  2  error  rulebook/imports  The import names include, which is not a file. Fix the path or remove the import.',
    '     > @include included.md',
    '  4  error  rulebook/imports  The import names gone.md, which is not a file. Fix the path or remove the import.',
    '     > @gone.md',
    '',
    'extra.md',
    '  1  error  global/block-em-dashes  Split the sentence at the em dash.',
    '     > Run it — now.',
    '',
    '3 errors, 0 warnings in 2 files',
    '',
  ].join('\n'))
})

test('frontmatter and the comments Claude Code removes are never checked, and a comment Claude sees is', () => {
  const answer = edit('Write', { file_path: join(project, 'Claude.md'), content: '---\ntitle: Rules — for agents\n---\n# Rules\n\n<!-- a maintainer note — keep it short -->\n\n- Keep it short. <!-- a note — in a list item -->\n' })
  expect(answer.refuse).toBe('Edit to Claude.md refused. Fix every error, then edit again.\n\n  8  error  global/block-em-dashes  Split the sentence at the em dash.\n     > - Keep it short. <!-- a note — in a list item -->')
})

test('an edit to a file a Claude.md imports is checked as a Prompt', () => {
  write(join(project, 'Claude.md'), '@docs/style.md\n')
  const file = write(join(project, 'docs', 'style.md'), 'Keep it short.\n')
  const answer = edit('Edit', { file_path: file, old_string: 'Keep it short.', new_string: 'Keep it short — always.' })
  expect(answer.refuse).toBe('Edit to docs/style.md refused. Fix every error, then edit again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Keep it short — always.')
})

test('an edit to a file a Claude.md imports two hops deep is read as Claude Code reads it and checked', () => {
  write(join(project, 'Claude.md'), '@docs/guide.md\n')
  write(join(project, 'docs', 'guide.md'), '@style.md\n')
  const file = write(join(project, 'docs', 'style.md'), '<!-- a maintainer note -->\nKeep it short.\n')
  const answer = edit('Edit', { file_path: file, old_string: '<!-- a maintainer note -->\nKeep it short.', new_string: '<!-- a maintainer note — hidden -->\nKeep it short — always.' })
  expect(answer.refuse).toBe('Edit to docs/style.md refused. Fix every error, then edit again.\n\n  2  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Keep it short — always.')
})

test('imports load four hops deep, the way Claude Code loads them', () => {
  write(join(project, 'Claude.md'), '@docs/1.md\n')
  for (const hop of [1, 2, 3, 4, 5]) write(join(project, 'docs', `${hop}.md`), `@${hop + 1}.md\nRun it — now.\n`)
  const flagged = [1, 2, 3, 4].map((hop) => `docs/${hop}.md\n  2  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it — now.\n\n`).join('')
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe(`${flagged}4 errors, 0 warnings in 5 files\n`)
})

test('a project Claude.md imports from outside the project only when ~/.claude.json approves it', () => {
  write(join(project, 'Claude.md'), '@../outside.md\n')
  const outside = write(join(home, 'outside.md'), 'Run it — now.\n')
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe('0 errors, 0 warnings in 1 file\n')
  write(join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { hasClaudeMdExternalIncludesApproved: true } } }))
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe(`${outside}\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it \u2014 now.\n\n1 error, 0 warnings in 2 files\n`)
})

test('a Claude.md under ~/.claude imports from anywhere', () => {
  write(join(home, '.claude', 'Claude.md'), '@../outside.md\n')
  const outside = write(join(home, 'outside.md'), 'Run it — now.\n')
  expect(rulebook(['check', '--skip=agentic'], undefined, undefined, join(home, '.claude')).stdout).toBe(`${outside}\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it \u2014 now.\n\n1 error, 0 warnings in 2 files\n`)
})

test('a .claude/rules file reads as Claude Code reads it: its frontmatter and comments are never checked, and its imports are', () => {
  write(join(project, 'rulebook.config.ts'), `export default { paths: ['.claude/rules/style.md'] }\n`)
  write(join(project, '.claude', 'rules', 'style.md'), '---\npaths:\n  - "src/**"\ndescription: Style — for src\n---\n<!-- a maintainer note — keep it short -->\n@extra.md\n@gone.md\n')
  write(join(project, '.claude', 'rules', 'extra.md'), 'Run it — now.\n')
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe([
    '.claude/rules/extra.md',
    '  1  error  global/block-em-dashes  Split the sentence at the em dash.',
    '     > Run it — now.',
    '',
    '.claude/rules/style.md',
    '  8  error  rulebook/imports  The import names .claude/rules/gone.md, which is not a file. Fix the path or remove the import.',
    '     > @gone.md',
    '',
    '2 errors, 0 warnings in 2 files',
    '',
  ].join('\n'))
})

test('a rules file that ~/.claude/rules links to reads as a user rules file, which imports from anywhere', () => {
  write(join(project, 'rulebook.config.ts'), `export default { paths: ['**/rules/*.md'] }\n`)
  const rule = write(join(project, 'packages', 'claude', 'rules', 'style.md'), '<!-- a maintainer note — keep it short -->\n@../../../../outside.md\n')
  mkdirSync(join(home, '.claude'))
  symlinkSync(join(project, 'packages', 'claude', 'rules'), join(home, '.claude', 'rules'))
  const outside = write(join(home, 'outside.md'), 'Run it — now.\n')
  expect(edit('Write', { file_path: rule, content: '<!-- a note — edited -->\n@../../../../outside.md\n' })).toEqual(NOTHING)
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe(`${outside}\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it \u2014 now.\n\n1 error, 0 warnings in 2 files\n`)
})

test('a write through ~/.claude/rules, a link into the project, is checked as a write to the file the link reaches, for an existing file, a new one, and one in a new folder', () => {
  const dash = String.fromCharCode(0x2014)
  write(join(project, 'rulebook.config.ts'), `export default { paths: ['rules/**/*.md'] }\n`)
  write(join(project, 'rules', 'scope.md'), 'Keep it short.\n')
  mkdirSync(join(home, '.claude'))
  symlinkSync(join(project, 'rules'), join(home, '.claude', 'rules'))
  for (const name of ['scope.md', 'new.md']) {
    expect(edit('Write', { file_path: join(home, '.claude', 'rules', name), content: 'Keep it short.\n@gone.md\n' }).refuse).toBe(`Edit to rules/${name} refused. Fix every error, then edit again.\n\n  2  error  rulebook/imports  The import names rules/gone.md, which is not a file. Fix the path or remove the import.\n     > @gone.md`)
  }
  expect(edit('Write', { file_path: join(home, '.claude', 'rules', 'new-folder', 'x.md'), content: `Run it ${dash} now.\n` }).refuse).toBe(`Edit to rules/new-folder/x.md refused. Fix every error, then edit again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} now.`)
})

test('a rules file in a folder that a symlinked subfolder of ~/.claude/rules reaches reads as a user rules file in its own repository', () => {
  write(join(project, 'rulebook.config.ts'), `export default { paths: ['rules/*.md'] }\n`)
  linkedRule()
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe('rules/style.md\n  2  error  rulebook/imports  The import names rules/gone.md, which is not a file. Fix the path or remove the import.\n     > @gone.md\n\n1 error, 0 warnings in 1 file\n')
})

test('the repository that holds the symlinked subfolder lints each rules file behind it once, even through a link back to itself', () => {
  const { dotfiles, rule } = linkedRule()
  symlinkSync(join(project, 'rules'), join(project, 'rules', 'again'))
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dotfiles })
  write(join(dotfiles, 'rulebook.config.ts'), `export default { paths: ['rules/**/*.md'] }\n`)
  expect(rulebook(['check', '--skip=agentic'], undefined, undefined, dotfiles).stdout).toBe(`${rule}\n  2  error  rulebook/imports  The import names ${join(project, 'rules', 'gone.md')}, which is not a file. Fix the path or remove the import.\n     > @gone.md\n\n1 error, 0 warnings in 1 file\n`)
})

test("a project .claude/rules folder's symlinked subfolder that leaves the project is linted only when ~/.claude.json approves it", () => {
  write(join(project, 'rulebook.config.ts'), `export default { paths: ['.claude/rules/**/*.md'] }\n`)
  const shared = write(join(home, 'shared', 'style.md'), '<!-- a maintainer note — keep it short -->\nRun it — now.\n')
  mkdirSync(join(project, '.claude', 'rules'), { recursive: true })
  symlinkSync(join(home, 'shared'), join(project, '.claude', 'rules', 'shared'))
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe('0 errors, 0 warnings in 0 files\n')
  write(join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { hasClaudeMdExternalIncludesApproved: true } } }))
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe(`${shared}\n  2  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it \u2014 now.\n\n1 error, 0 warnings in 1 file\n`)
})

test("an edit refusal quotes the flagged line, and a finding without a message shows the rule's description", () => {
  write(join(home, 'config', 'rulebook', 'rules', 'block-x.ts'), `export default { description: "Don't write x.", check: ({ lines }) => lines.flatMap((text, index) => (text.includes('x') ? [{ line: index + 1 }] : [])) }\n`)
  const answer = edit('Write', { file_path: join(project, 'Claude.md'), content: 'Keep it short.\nRun x.\n' })
  expect(answer.refuse).toBe("Edit to Claude.md refused. Fix every error, then edit again.\n\n  2  error  global/block-x  Don't write x.\n     > Run x.")
})

test('rulebook check --stdin-file-path=@reply checks a reply with each rule whose paths cover @reply, and its refusal quotes the line', () => {
  write(join(project, 'rulebook.config.ts'), `export default { rules: { 'global/block-em-dashes': { paths: ['**', '@reply'] }, 'global/block-hedging': { paths: ['**'] } } }\n`)
  const refusal = 'Reply refused. Fix every error, then write the whole reply again.\n\n  2  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it — now.\n'
  expect(rulebook(['check', '--stdin-file-path=@reply'], 'It probably works.\nRun it — now.')).toEqual({ code: 1, stdout: refusal, stderr: '' })
  expect(JSON.parse(rulebook(['check', '--stdin-file-path=@reply', '--reporter=json'], 'It probably works.\nRun it — now.').stdout)).toEqual({
    reports: [{ path: '@reply', failures: [], findings: [{ rule: 'global/block-em-dashes', line: 2, level: 'error', message: 'Split the sentence at the em dash.', quote: 'Run it — now.', isExisting: false }] }],
    failures: [],
  })
})

test('rulebook check --stdin-file-path checks any @-name with the rules whose paths cover it, with no config naming the message, and a file as the text it will hold', () => {
  const dash = String.fromCharCode(0x2014)
  expect(rulebook(['check', '--stdin-file-path=@inbox/proposal/x.md'], `Run it ${dash} now.`)).toEqual({ code: 0, stdout: '', stderr: '' })

  write(join(project, 'rulebook.config.ts'), `export default { rules: { 'global/block-em-dashes': { paths: ['@inbox/**'] }, 'global/block-hedging': { paths: ['**'] } } }\n`)
  expect(rulebook(['check', '--stdin-file-path=@inbox/proposal/x.md'], `Run it ${dash} probably.`)).toEqual({ code: 1, stdout: `Inbox refused. Fix every error, then send it again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} probably.\n`, stderr: '' })
  expect(rulebook(['check', '--stdin-file-path=notes.md'], 'It probably works.\n')).toEqual({ code: 0, stdout: 'Edit to notes.md allowed with warnings:\n\n  1  warning  global/block-hedging  Check the claim, then state it.\n     > It probably works.\n', stderr: '' })
})

test('rulebook check --skip skips a rule, every rule of a plugin, and every agentic rule', () => {
  const dash = String.fromCharCode(0x2014)
  agenticRule('block-domain-words', 'model: haiku')
  write(join(project, 'Claude.md'), `It probably works ${dash} now.\n`)
  const claude = fakeClaude('{"type":"result","is_error":false,"structured_output":{"findings":[{"line":1,"message":"Slice names a commit here."}]}}')
  const rules = (args: readonly string[]) => (JSON.parse(rulebook(['check', '--reporter=json', ...args], undefined, claude).stdout) as { reports: { findings: { rule: string }[] }[] }).reports.flatMap(({ findings }) => findings.map(({ rule }) => rule))
  expect(rules([])).toEqual(['global/block-domain-words', 'global/block-em-dashes', 'global/block-hedging'])
  expect(rules(['--skip=agentic'])).toEqual(['global/block-em-dashes', 'global/block-hedging'])
  expect(rules(['--skip=global/block-hedging', '--skip=agentic'])).toEqual(['global/block-em-dashes'])
  expect(rules(['--skip=global'])).toEqual([])
})

test('rulebook names its commands and refuses one it does not have', () => {
  expect(rulebook([]).stdout).toContain('rulebook check --staged')
  expect(rulebook(['lint'])).toEqual({ code: 2, stdout: '', stderr: 'rulebook: lint is not a rulebook command. `rulebook --help` lists them.\n' })
  expect(rulebook(['check', '--staged', 'Claude.md'])).toEqual({ code: 2, stdout: '', stderr: 'rulebook: rulebook check takes files, --staged, or --stdin-file-path, one at a time.\n' })
})

test("a turned-on plugin's rulebook.config.ts registers no message until a config extends it", () => {
  write(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'inbox@market': true } }))
  write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'inbox@market': [{ scope: 'user', installPath: join(home, 'cache', 'inbox@market') }] } }))
  write(join(home, 'cache', 'inbox@market', 'rulebook.config.ts'), `export default { messages: { inbox: { tools: ['mcp__inbox__*'] } } }\n`)
  const messages = () => (JSON.parse(rulebook(['inspect', 'rules']).stdout) as { messages: { name: string }[] }).messages.map(({ name }) => name)
  expect(messages()).toEqual(['@reply'])

  write(join(project, 'rulebook.config.ts'), `export default { extends: ['~/cache/inbox@market/rulebook.config.ts'] }\n`)
  expect(messages()).toEqual(['@reply', '@inbox'])
})

test("CLAUDE_CONFIG_DIR moves Claude Code's config folder: a file in its rules/ reads as a user rules file", () => {
  const dash = String.fromCharCode(0x2014)
  const claude = join(home, 'moved-claude')
  write(join(claude, 'rulebook.config.ts'), `export default { paths: ['rules/*.md'], rules: { 'global/block-em-dashes': { paths: ['**'] } } }\n`)
  write(join(claude, 'rules', 'style.md'), `<!-- a maintainer note ${dash} keep it short -->\n@../../outside.md\n`)
  const outside = write(join(home, 'outside.md'), `Run it ${dash} now.\n`)

  expect(rulebook(['check', '--skip=agentic'], undefined, undefined, claude).stdout).toBe(`rules/style.md\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > <!-- a maintainer note ${dash} keep it short -->\n\n1 error, 0 warnings in 1 file\n`)
  expect(rulebook(['check', '--skip=agentic'], undefined, undefined, claude, { CLAUDE_CONFIG_DIR: claude }).stdout).toBe(`${outside}\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} now.\n\n1 error, 0 warnings in 2 files\n`)
})

test("a legacy .config.json in Claude Code's config folder replaces ~/.claude.json while it holds anything, as Claude Code reads it", () => {
  const dash = String.fromCharCode(0x2014)
  write(join(project, 'Claude.md'), '@../outside.md\n')
  const outside = write(join(home, 'outside.md'), `Run it ${dash} now.\n`)
  write(join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { hasClaudeMdExternalIncludesApproved: true } } }))
  write(join(home, '.claude', '.config.json'), JSON.stringify({ projects: {} }))
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe('0 errors, 0 warnings in 1 file\n')
  write(join(home, '.claude', '.config.json'), '')
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe(`${outside}\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} now.\n\n1 error, 0 warnings in 2 files\n`)
})

test('a full run lists each flagged file in a registered message folder by its @-name', () => {
  const items = join(home, 'inbox-items')
  write(join(project, 'rulebook.config.ts'), `export default { messages: { inbox: { folder: '${items}' } }, rules: { 'global/block-em-dashes': { paths: ['@inbox/**'] } } }\n`)
  write(join(items, 'proposal', 'a.md'), 'Run it — now.\n')
  write(join(items, 'report', 'b.md'), 'Run it now.\n')
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe('@inbox/proposal/a.md\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it \u2014 now.\n\n1 error, 0 warnings in 2 files\n')
})

test("a rule whose paths cover any file checks an edit to it, and a full run lists it, but never a binary file", () => {
  write(join(project, 'rulebook.config.ts'), `export default { rules: { 'global/block-em-dashes': { paths: ['**'] } } }\n`)
  const file = write(join(project, 'src', 'app.ts'), "const note = 'Run it now.'\n")
  expect(edit('Edit', { file_path: file, old_string: 'Run it now.', new_string: 'Run it — now.' }).refuse).toBe("Edit to src/app.ts refused. Fix every error, then edit again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > const note = 'Run it — now.'")
  write(file, "const note = 'Run it — now.'\n")
  writeFileSync(join(project, 'image.bin'), Buffer.from([0, 0xe2, 0x80, 0x94, 0]))
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe("src/app.ts\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > const note = 'Run it \u2014 now.'\n\n1 error, 0 warnings in 2 files\n")
})

test('a rule that reads text flags the line it reads in a Claude.md whose frontmatter and comments Claude Code removes', () => {
  write(join(home, 'config', 'rulebook', 'rules', 'block-x.ts'), `export default { description: "Don't write x.", check: ({ text }) => text.split('\\n').flatMap((line, index) => (line.includes('x') ? [{ line: index + 1 }] : [])) }\n`)
  const answer = edit('Write', { file_path: join(project, 'Claude.md'), content: '---\ntitle: Rules\n---\n<!-- a maintainer note -->\n\nRun x.\n' })
  expect(answer.refuse).toBe("Edit to Claude.md refused. Fix every error, then edit again.\n\n  6  error  global/block-x  Don't write x.\n     > Run x.")
})

test('an edit that writes a line whose text the file already holds elsewhere reports that line as written', () => {
  const dash = String.fromCharCode(0x2014)
  agenticRule('require-true-facts', 'model: haiku')
  const file = write(join(project, 'Claude.md'), `Run it ${dash} now.\nSecond line.\n`)
  const answer = edit('Edit', { file_path: file, old_string: 'Second line.', new_string: `Second line.\nRun it ${dash} now.` })
  expect(answer.refuse).toBe(`Edit to Claude.md refused. Fix every error, then edit again.\n\n  3  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} now.\n\n1 more warning in this file was there before this edit. \`rulebook check Claude.md\` lists it.`)
  expect(readFileSync(calls, 'utf8')).toContain('The edit wrote lines 3.')
})

test('a Write that rewrites every line of a 10,000-line file answers within 5 s, where a full line diff takes 18 s, and counts every line it holds as written', () => {
  const dash = String.fromCharCode(0x2014)
  write(join(project, 'rulebook.config.ts'), `export default { rules: { 'global/block-em-dashes': { paths: ['**'] } } }\n`)
  const lines = (word: string) => [`Run it ${dash} now.`, ...Array.from({ length: 10_000 }, (_, index) => `${word} line ${index}.`)].join('\n')
  const file = write(join(project, 'notes.txt'), lines('Old'))
  const started = performance.now()
  const answer = edit('Write', { file_path: file, content: lines('New') })
  expect(performance.now() - started).toBeLessThan(5_000)
  expect(answer.refuse).toBe(`Edit to notes.txt refused. Fix every error, then edit again.\n\n  1  error  global/block-em-dashes  Split the sentence at the em dash.\n     > Run it ${dash} now.`)
}, 30_000)

test('a later rules setting merges over an earlier one key by key, and a level written as a string sets only the level', () => {
  const dash = String.fromCharCode(0x2014)
  const levels = (global: string, local: string) => {
    write(join(home, 'config', 'rulebook', 'rulebook.config.ts'), `export default { plugins: { global: './rules' }, paths: ['**/Claude.md'], rules: { 'global/block-em-dashes': ${global} } }\n`)
    write(join(project, 'rulebook.config.ts'), `export default { rules: { 'global/block-em-dashes': ${local} } }\n`)
    return (edit('Write', { file_path: join(project, 'Claude.md'), content: `Run it ${dash} now.\n` }).findings as { level: string }[]).map(({ level }) => level)
  }
  expect(levels("{ runs: 'manual' }", "'warning'")).toEqual([])
  expect(levels("'warning'", "{ paths: ['**/Claude.md'] }")).toEqual(['warning'])
  expect(levels("'off'", "{ paths: ['**/Claude.md'] }")).toEqual([])
})

function git(...args: readonly string[]): void {
  const run = Bun.spawnSync(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: project, env: { ...process.env, HOME: home } })
  expect(run.stderr.toString()).toBe('')
}

test('rulebook check --staged checks each staged file of any kind as the commit records it, and refuses an error only on a line the commit wrote', () => {
  const dash = String.fromCharCode(0x2014)
  write(join(home, 'config', 'rulebook', 'rules', 'block-console-log.yml'), "description: Don't log to the console.\nlanguage: typescript\npaths: ['**/*.ts']\nrule:\n  pattern: console.log($$$ARGS)\n")
  write(join(project, 'Claude.md'), `# Facts\n\nOld ${dash} line.\n`)
  git('add', 'Claude.md')
  git('commit', '-q', '-m', 'first')
  write(join(project, 'Claude.md'), `# Facts\n\nOld ${dash} line.\nNew ${dash} line.\n`)
  write(join(project, 'src', 'app.ts'), 'const a = 1\nconsole.log(a)\n')
  git('add', 'Claude.md', 'src/app.ts')
  write(join(project, 'Claude.md'), `# Facts\n\nOld ${dash} line.\nNew ${dash} line.\nUnstaged ${dash} line.\n`)
  expect(rulebook(['check', '--staged'])).toEqual({
    code: 1,
    stdout: [
      'Commit refused. Fix every error, stage the fix, then commit again.',
      `Claude.md\n  4  error  global/block-em-dashes  Split the sentence at the em dash.\n     > New ${dash} line.`,
      "src/app.ts\n  2  error  global/block-console-log  Don't log to the console.\n     > console.log(a)",
      '2 errors, 0 warnings in 2 files',
      '1 finding in these files was there before this commit. `rulebook check Claude.md` lists it.',
    ].join('\n\n') + '\n',
    stderr: '',
  })
  write(join(project, 'Claude.md'), `# Facts\n\nOld ${dash} line.\nNew line.\n`)
  write(join(project, 'src', 'app.ts'), 'const a = 1\n')
  git('add', 'Claude.md', 'src/app.ts')
  expect(rulebook(['check', '--staged'])).toEqual({ code: 0, stdout: '0 errors, 0 warnings in 2 files\n\n1 finding in these files was there before this commit. `rulebook check Claude.md` lists it.\n', stderr: '' })
})

test('a rule that runs on commit checks a commit and never an edit, and a manual rule checks neither', () => {
  const rule = (name: string, runs: string, word: string) => write(join(home, 'config', 'rulebook', 'rules', `${name}.ts`), `export default { description: "Don't leave ${word}.", runs: '${runs}', check: ({ lines }) => lines.flatMap((text, index) => (text.includes('${word}') ? [{ line: index + 1 }] : [])) }\n`)
  rule('block-todo', 'commit', 'TODO')
  rule('block-fixme', 'manual', 'FIXME')
  expect(edit('Write', { file_path: join(project, 'Claude.md'), content: 'TODO here.\nFIXME here.\n' })).toEqual(NOTHING)
  write(join(project, 'Claude.md'), 'TODO here.\nFIXME here.\n')
  git('add', 'Claude.md')
  expect(rulebook(['check', '--staged']).stdout).toBe("Commit refused. Fix every error, stage the fix, then commit again.\n\nClaude.md\n  1  error  global/block-todo  Don't leave TODO.\n     > TODO here.\n\n1 error, 0 warnings in 1 file\n")
  expect(rulebook(['check', '--skip=agentic']).stdout).toContain('2  error  global/block-fixme')
})

test("rulebook check --staged refuses a type error the commit causes in a caller it never staged, with the project's own TypeScript", () => {
  write(join(project, '.gitignore'), 'node_modules\n')
  symlinkSync(join(import.meta.dir, '..', 'node_modules'), join(project, 'node_modules'))
  write(join(project, 'rulebook.config.ts'), "export default { linters: ['tsc'] }\n")
  write(join(project, 'tsconfig.json'), '{ "compilerOptions": { "strict": true }, "include": ["src"] }\n')
  write(join(project, 'src', 'price.ts'), 'export function price(): number {\n  return 1\n}\n')
  write(join(project, 'src', 'checkout.ts'), "import { price } from './price'\n\nexport const total: number = price()\n")
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  write(join(project, 'src', 'price.ts'), "export function price(): string {\n  return '1'\n}\n")
  git('add', 'src/price.ts')
  expect(rulebook(['check', '--staged'])).toEqual({
    code: 1,
    stdout: [
      'Commit refused. Fix every error, stage the fix, then commit again.',
      "src/checkout.ts\n  3  error  tsc/TS2322  Type 'string' is not assignable to type 'number'.\n     > export const total: number = price()",
      '1 error, 0 warnings in 2 files',
    ].join('\n\n') + '\n',
    stderr: '',
  })
}, 30_000)

function importingProject(): void {
  write(join(project, 'rulebook.config.ts'), "export default { linters: ['oxlint'] }\n")
  write(join(project, '.oxlintrc.json'), '{ "plugins": ["import"], "rules": { "import/named": "error" } }\n')
  write(join(project, 'src', 'lib.js'), 'export const total = 1\nexport const count = 2\n')
  write(join(project, 'src', 'app.js'), "import { count, total } from './lib.js'\n\nexport const sum = count + total\n")
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
}

const TOTAL_REFUSED = {
  code: 1,
  stdout: [
    'Commit refused. Fix every error, stage the fix, then commit again.',
    'src/app.js\n  1  error  oxlint/import/named  named import "total" not found help: Does "./lib.js" have the export "total"?\n     > import { count, total } from \'./lib.js\'',
    '1 error, 0 warnings in 2 files',
  ].join('\n\n') + '\n',
  stderr: '',
}

test('rulebook check --staged refuses an error the commit adds to a file it never staged, and not one HEAD already had', () => {
  importingProject()
  write(join(project, 'src', 'app.js'), "import { count, total } from './lib.js'\nimport { missing } from './lib.js'\n\nexport const sum = count + total + missing\n")
  git('add', 'src/app.js')
  git('commit', '-q', '-m', 'an error HEAD keeps')
  write(join(project, 'src', 'lib.js'), 'export const count = 2\n')
  git('add', 'src/lib.js')
  expect(rulebook(['check', '--staged'])).toEqual(TOTAL_REFUSED)
  write(join(project, 'src', 'lib.js'), 'export const total = 1\nexport const count = 3\n')
  git('add', 'src/lib.js')
  expect(rulebook(['check', '--staged'])).toEqual({ code: 0, stdout: '0 errors, 0 warnings in 1 file\n', stderr: '' })
})

test("rulebook check --staged lints the commit's tree, never the working tree", () => {
  importingProject()
  write(join(project, 'src', 'lib.js'), 'export const total = 1\nexport const count = 3\n')
  git('add', 'src/lib.js')
  write(join(project, 'src', 'lib.js'), 'export const count = 3\n')
  expect(rulebook(['check', '--staged'])).toEqual({ code: 0, stdout: '0 errors, 0 warnings in 1 file\n', stderr: '' })
  git('add', 'src/lib.js')
  write(join(project, 'src', 'app.js'), "import { count } from './lib.js'\n\nexport const sum = count\n")
  expect(rulebook(['check', '--staged'])).toEqual(TOTAL_REFUSED)
})

function magoProject(): string {
  write(join(project, '.gitignore'), 'vendor\nlib/framework\n')
  write(join(project, 'rulebook.config.ts'), "export default { linters: ['mago'] }\n")
  write(join(project, 'mago.toml'), '[source]\npaths = ["src"]\nincludes = ["vendor", "lib/framework"]\n\n[analyzer]\nminimum-fail-level = "Warning"\n')
  write(join(project, 'lib', 'framework', 'functions.php'), '<?php\n\nfunction framework_version(): string\n{\n    return "";\n}\n')
  write(join(project, 'src', 'Total.php'), '<?php\n\necho 1;\n')
  const log = join(home, 'mago.log')
  const mago = write(join(project, 'vendor', 'bin', 'mago'), `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n')
if (existsSync('broken')) {
  console.error('mago crashed')
  process.exit(2)
}
const text = process.argv.includes('--stdin-input') ? readFileSync(0, 'utf8') : readFileSync('src/Total.php', 'utf8')
const missing = (name) => name === 'undefined_call' || (name === 'framework_version' && !existsSync('lib/framework/functions.php'))
const issues = process.argv[2] !== 'analyze' ? [] : text.split('\\n').flatMap((line, index) => [...line.matchAll(/(\\w+)\\(\\);/g)].filter(([, name]) => missing(name)).map(([, name]) => ({ level: 'Warning', code: 'non-existent-function', message: \`Function \\\`\${name}\\\` could not be found.\`, annotations: [{ kind: 'Primary', span: { file_id: { name: 'src/Total.php', size: text.length, file_type: 'Host' }, start: { line: index } } }] })))
console.log(JSON.stringify({ issues }))
process.exit(issues.length === 0 ? 0 : 1)
`)
  chmodSync(mago, 0o755)
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  return log
}

test("mago lints a write and analyzes only a commit, reads each finding's file by the name Mago gives it, refuses each issue at its minimum-fail-level, and analyzes the commit with the folders mago.toml includes", () => {
  const log = magoProject()
  expect(edit('Write', { file_path: join(project, 'src', 'Total.php'), content: '<?php\n\nundefined_call();\n' })).toEqual(NOTHING)
  expect(readFileSync(log, 'utf8')).toBe('lint\n')
  write(join(project, 'src', 'Total.php'), '<?php\n\necho framework_version();\n')
  git('add', 'src/Total.php')
  expect(rulebook(['check', '--staged'])).toEqual({ code: 0, stdout: '0 errors, 0 warnings in 1 file\n', stderr: '' })
  write(join(project, 'src', 'Total.php'), '<?php\n\necho framework_version();\nundefined_call();\n')
  git('add', 'src/Total.php')
  expect(rulebook(['check', '--staged'])).toEqual({
    code: 1,
    stdout: [
      'Commit refused. Fix every error, stage the fix, then commit again.',
      'src/Total.php\n  4  error  mago/non-existent-function  Function `undefined_call` could not be found.\n     > undefined_call();',
      '1 error, 0 warnings in 1 file',
    ].join('\n\n') + '\n',
    stderr: '',
  })
})

test('mago covers the file extensions mago.toml lists in source.extensions, and .php when it lists none', () => {
  const log = magoProject()
  expect(edit('Write', { file_path: join(project, 'src', 'Ledger.phtml'), content: 'class Ledger {}\n' })).toEqual(NOTHING)
  expect(existsSync(log)).toBe(false)
  write(join(project, 'mago.toml'), '[source]\npaths = ["src"]\nextensions = ["php", "phtml"]\n')
  expect(edit('Write', { file_path: join(project, 'src', 'Ledger.phtml'), content: 'class Ledger {}\n' })).toEqual(NOTHING)
  expect(readFileSync(log, 'utf8')).toBe('lint\n')
})

test('a mago.toml that does not parse leaves every other rule checking', () => {
  magoProject()
  write(join(project, 'mago.toml'), '[source\n')
  expect(edit('Write', { file_path: join(project, 'Claude.md'), content: `Run it ${String.fromCharCode(0x2014)} now.\n` }).refuse).toContain('global/block-em-dashes')
})

test("programs runs a linter through the project's own command, in the linter's folder, on a write and in a commit's tree", () => {
  const log = magoProject()
  const wrapper = write(join(project, 'scripts', 'mago'), `#!/bin/sh\necho wrapped >> ${JSON.stringify(log)}\nexec vendor/bin/mago "$@"\n`)
  chmodSync(wrapper, 0o755)
  write(join(project, 'rulebook.config.ts'), "export default { linters: ['mago'], programs: { mago: ['scripts/mago'] } }\n")
  git('add', '-A')
  git('commit', '-q', '-m', 'wrap mago')
  expect(edit('Write', { file_path: join(project, 'src', 'Total.php'), content: '<?php\n\necho 2;\n' })).toEqual(NOTHING)
  expect(readFileSync(log, 'utf8')).toBe('wrapped\nlint\n')
})

test("rulebook check --staged runs a linter when the commit changes only the linter's config or a baseline it names", () => {
  const log = magoProject()
  write(join(project, 'mago.toml'), '[source]\npaths = ["src"]\n\n[analyzer]\nbaseline = "mago-baseline.toml"\n')
  write(join(project, 'mago-baseline.toml'), '')
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')
  writeFileSync(log, '')
  write(join(project, 'mago-baseline.toml'), '# no entries\n')
  git('add', 'mago-baseline.toml')
  expect(rulebook(['check', '--staged']).code).toBe(0)
  expect(readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').sort()).toEqual(['analyze', 'lint'])
})

test("rulebook claude-hook refuses a Claude Code tool call a message's rule flags, and a rule reads the call's input field by field", () => {
  write(join(project, 'rulebook.config.ts'), "export default { plugins: { app: './rules' }, messages: { bash: { tools: ['Bash'] } } }\n")
  write(join(project, 'rules', 'block-npx.ts'), "export default { description: 'Run the project scripts, never npx.', paths: ['@bash'], check: ({ input, lines }) => (String(input?.command ?? '').startsWith('npx ') ? [{ line: lines.indexOf(String(input?.command)) + 1 }] : []) }\n")
  const hook = (input: Record<string, unknown>) => {
    const run = Bun.spawnSync([process.execPath, MAIN, 'claude-hook'], { cwd: project, stdin: new Blob([JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: input, cwd: project })]), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config') } })
    return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
  }
  expect(hook({ command: 'npx tsc', description: 'Type-check' })).toEqual({ code: 2, stdout: '', stderr: 'Bash refused. Fix every error, then send it again.\n\n  1  error  app/block-npx  Run the project scripts, never npx.\n     > npx tsc\n' })
  expect(hook({ command: 'bun run check', description: 'npx would be slower' })).toEqual({ code: 0, stdout: '', stderr: '' })
})

test('rulebook claude-hook refuses an Edit a rule flags and answers a warning as context for the agent', () => {
  const dash = String.fromCharCode(0x2014)
  write(join(project, 'rulebook.config.ts'), "export default { rules: { 'global/block-em-dashes': 'warning' } }\n")
  const run = Bun.spawnSync([process.execPath, MAIN, 'claude-hook'], { cwd: project, stdin: new Blob([JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(project, 'Claude.md'), content: `Run it ${dash} now.\n` }, cwd: project })]), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config') } })
  expect(run.exitCode).toBe(0)
  expect(JSON.parse(run.stdout.toString())).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('1  warning  global/block-em-dashes') } })
})

test('a script rule reads the project root, so it can read any project file', () => {
  write(join(project, 'rulebook.config.ts'), "export default { plugins: { app: './rules' } }\n")
  write(join(project, 'rules', 'require-changelog.ts'), "import { existsSync } from 'node:fs'\nimport { join } from 'node:path'\nexport default { description: 'Keep a CHANGELOG.md beside the code.', paths: ['src/**'], check: ({ root }) => (existsSync(join(root, 'CHANGELOG.md')) ? [] : [{ line: 1 }]) }\n")
  expect(edit('Write', { file_path: join(project, 'src', 'app.ts'), content: 'export const a = 1\n' }).refuse).toContain('1  error  app/require-changelog  Keep a CHANGELOG.md beside the code.')
  write(join(project, 'CHANGELOG.md'), '# Changelog\n')
  expect(edit('Write', { file_path: join(project, 'src', 'app.ts'), content: 'export const a = 1\n' })).toEqual(NOTHING)
})

test("rulebook check --staged shows each error of a linter that failed on HEAD's tree as a warning, and names the failure", () => {
  magoProject()
  write(join(project, 'broken'), '')
  git('add', 'broken')
  git('commit', '-q', '-m', 'mago fails here')
  git('rm', '-q', 'broken')
  write(join(project, 'src', 'Total.php'), '<?php\n\nundefined_call();\n')
  git('add', 'src/Total.php')
  expect(rulebook(['check', '--staged'])).toEqual({
    code: 0,
    stdout: [
      'src/Total.php\n  3  warning  mago/non-existent-function  Function `undefined_call` could not be found.\n     > undefined_call();',
      'mago did not run on HEAD:mago.toml: it exited 2: mago crashed',
      '0 errors, 1 warning in 2 files',
    ].join('\n\n') + '\n',
    stderr: '',
  })
})

test('rulebook check --staged checks a renamed file against its text at its old path, so its old errors never refuse the rename', () => {
  const dash = String.fromCharCode(0x2014)
  write(join(project, 'a', 'Claude.md'), `Old ${dash} line.\n`)
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  git('mv', 'a', 'b')
  expect(rulebook(['check', '--staged'])).toEqual({ code: 0, stdout: '0 errors, 0 warnings in 1 file\n\n1 finding in these files was there before this commit. `rulebook check b/Claude.md` lists it.\n', stderr: '' })
})

test('a rule with no paths, in a project whose configs list no paths, is named as checking no file', () => {
  write(join(home, 'config', 'rulebook', 'rulebook.config.ts'), 'export default {}\n')
  write(join(project, 'rulebook.config.ts'), "export default { plugins: { app: './rules' } }\n")
  write(join(project, 'rules', 'block-todo.ts'), "export default { description: \"Don't leave TODO.\", check: () => [] }\n")
  expect(rulebook(['check', '--skip=agentic']).stdout).toBe("The rule app/block-todo has no paths, and no config lists paths, so it checks no file. Give the rule paths, such as paths: ['**/*.ts'].\n\n0 errors, 0 warnings in 0 files\n")
})

test("existingErrors: 'error' refuses a commit for an error a staged file already had", () => {
  const dash = String.fromCharCode(0x2014)
  write(join(project, 'rulebook.config.ts'), "export default { existingErrors: 'error' }\n")
  write(join(project, 'Claude.md'), `Old ${dash} line.\n`)
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  write(join(project, 'Claude.md'), `Old ${dash} line.\nNew line.\n`)
  git('add', 'Claude.md')
  expect(rulebook(['check', '--staged'])).toMatchObject({ code: 1, stdout: expect.stringContaining('1  error  global/block-em-dashes') })
})

test('a script rule with a key rulebook does not read fails to load and names the key', () => {
  const rule = write(join(home, 'config', 'rulebook', 'rules', 'block-x.ts'), `export default { description: "Don't write x.", levle: 'warning', check: () => [] }\n`)
  expect(rulebook(['check', '--skip=agentic'])).toEqual({ code: 1, stdout: `${rule}: rulebook does not read the key "levle". It reads description, level, runs, paths, check. The rule global/block-x checks nothing until it loads.\n\n0 errors, 0 warnings in 0 files\n`, stderr: '' })
})
