import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts')
const ASK = join(import.meta.dir, 'ask.ts')
const OWN_OXLINT = join(import.meta.dir, '..', 'node_modules', 'oxlint', 'bin', 'oxlint')
const OWN_TSC = join(import.meta.dir, '..', 'node_modules', 'typescript', 'lib', 'tsc.js')
const NO_LINTERS_PATH = '/usr/bin:/bin'

setDefaultTimeout(30_000)

let home: string
let project: string

beforeEach(() => {
  home = realpathSync(mkdtempSync('/tmp/rulebook-home-'))
  project = join(home, 'project')
  mkdirSync(project)
  Bun.spawnSync(['git', 'init', '-q'], { cwd: project })
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

function write(file: string, text: string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

function withLinters(...names: readonly string[]): void {
  write(join(project, 'rulebook.config.ts'), `export default { linters: ${JSON.stringify(names)} }\n`)
}

function rulebook(args: readonly string[], stdin?: string, path = process.env.PATH ?? '', entry = MAIN) {
  const run = Bun.spawnSync([process.execPath, entry, ...args], {
    cwd: project,
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), PATH: path },
  })
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}

function edit(tool: string, input: Record<string, unknown>, path?: string) {
  const run = rulebook(['edit'], JSON.stringify({ tool_name: tool, tool_input: input, cwd: project }), path, ASK)
  expect(run.stderr).toBe('')
  return JSON.parse(run.stdout) as { refuse?: string; note?: string; failures: string[]; findings: { rule: string; line: number; level: string; isExisting: boolean }[] }
}

function existingLineLands(file: string, old: string, edited: string, rule: string) {
  const answer = edit('Edit', { file_path: file, old_string: old, new_string: edited })
  expect(answer.refuse).toBeUndefined()
  expect(answer.findings).toContainEqual(expect.objectContaining({ rule, level: 'warning', isExisting: true }))
  expect(answer.note).toContain('there before this edit.')
}

test('a project with .oxlintrc.json and no rulebook config runs no linter on a write that breaks an oxlint rule', () => {
  write(join(project, '.oxlintrc.json'), '{ "rules": { "no-unused-vars": "error" } }\n')
  expect(edit('Write', { file_path: join(project, 'src', 'app.ts'), content: 'export function total(): number {\n  const unused = 1\n  return 2\n}\n' })).toEqual({ failures: [], findings: [] })
})

test("linters: ['oxlint'] refuses a write with rulebook's own oxlint when the project has none installed", () => {
  withLinters('oxlint')
  write(join(project, '.oxlintrc.json'), '{ "rules": { "no-unused-vars": "error" } }\n')
  const answer = edit('Write', { file_path: join(project, 'src', 'app.ts'), content: 'export function total(): number {\n  const unused = 1\n  return 2\n}\n' }, NO_LINTERS_PATH)
  expect(answer.refuse).toStartWith('Edit to src/app.ts refused. Fix every error, then edit again.\n\n  2  error  oxlint/no-unused-vars  Variable \'unused\' is declared but never used.')
  expect(answer.refuse).toContain('> const unused = 1')
})

test("linters: ['oxlint'] runs the project's own oxlint when its node_modules holds one", () => {
  withLinters('oxlint')
  write(join(project, '.oxlintrc.json'), '{ "rules": { "no-unused-vars": "error" } }\n')
  const ran = join(home, 'project-oxlint-ran')
  write(join(project, 'node_modules', 'oxlint', 'bin', 'oxlint'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(ran)}, '')\nawait import(${JSON.stringify(OWN_OXLINT)})\n`)
  const answer = edit('Write', { file_path: join(project, 'src', 'app.ts'), content: 'export function total(): number {\n  const unused = 1\n  return 2\n}\n' })
  expect(answer.refuse).toContain('2  error  oxlint/no-unused-vars')
  expect(existsSync(ran)).toBe(true)
})

test('oxlint lets a write land with a warning when the violation was already in the file', () => {
  withLinters('oxlint')
  write(join(project, '.oxlintrc.json'), '{ "rules": { "no-unused-vars": "error" } }\n')
  const file = write(join(project, 'src', 'app.ts'), 'export function total(): number {\n  const unused = 1\n  return 2\n}\n')
  existingLineLands(file, 'return 2', 'return 3', 'oxlint/no-unused-vars')
})

test('oxlint names its plugin rules the way .oxlintrc.json does', () => {
  withLinters('oxlint')
  write(join(project, '.oxlintrc.json'), '{ "plugins": ["typescript"], "rules": { "typescript/no-explicit-any": "error" } }\n')
  const answer = edit('Write', { file_path: join(project, 'src', 'app.ts'), content: 'export const total = (value: any): number => value\n' })
  expect(answer.findings).toContainEqual(expect.objectContaining({ rule: 'oxlint/typescript/no-explicit-any', line: 1, level: 'error' }))
})

test("oxlint reads an oxlint.config.ts and runs its JS plugin's rules on a write's pending text and in a full run", () => {
  withLinters('oxlint')
  write(join(project, 'oxlint.config.ts'), "export default { jsPlugins: ['./plugin.ts'], rules: { 'demo/no-foo': 'error' } }\n")
  write(join(project, 'plugin.ts'), "export default { meta: { name: 'demo' }, rules: { 'no-foo': { create: (context) => ({ Identifier: (node) => node.name === 'foo' && context.report({ node, message: 'Name it something other than foo.' }) }) } } }\n")
  const file = write(join(project, 'src', 'app.ts'), 'export const total = 2\n')
  expect(edit('Edit', { file_path: file, old_string: 'export const total = 2', new_string: 'export const total = 2\nexport const foo = 1' }).findings).toEqual([expect.objectContaining({ rule: 'oxlint/demo/no-foo', line: 2, level: 'error' })])
  write(file, 'export const total = 2\nexport const foo = 1\n')
  expect(rulebook(['check']).stdout).toBe('src/app.ts\n  2  error  oxlint/demo/no-foo  Name it something other than foo.\n     > export const foo = 1\n\n1 error, 0 warnings in 1 file\n')
})

test('the pending text is linted, not the file on disk', () => {
  withLinters('oxlint')
  write(join(project, '.oxlintrc.json'), '{ "rules": { "no-unused-vars": "error" } }\n')
  const file = write(join(project, 'src', 'app.ts'), 'export function total(): number {\n  return 2\n}\n')
  expect(rulebook(['check']).stdout).toBe('0 errors, 0 warnings in 0 files\n')
  const answer = edit('Edit', { file_path: file, old_string: '  return 2', new_string: '  const unused = 1\n  return 2' })
  expect(answer.refuse).toContain('2  error  oxlint/no-unused-vars')
})

test('linters in a config is a list of linter names, and any other shape fails the config', () => {
  write(join(project, 'rulebook.config.ts'), "export default { linters: { oxlint: 'off' } }\n")
  const run = rulebook(['check', '--stdin-file-path=src/app.ts'], 'export const total = 2\n')
  expect(run.stderr).toBe(`rulebook: ${join(project, 'rulebook.config.ts')}: linters is a list of the linters to run, such as ['oxlint', 'biome']. The linters are mago, oxlint, biome, stylelint, ruff, selene, shellcheck, pint, tsc.\n`)
  expect(run.code).toBe(2)
})

test("linters: ['oxlint'] with no .oxlintrc.json runs oxlint's default rules on a write", () => {
  withLinters('oxlint')
  const answer = edit('Write', { file_path: join(project, 'src', 'app.ts'), content: 'export function total(): number {\n  debugger\n  return 2\n}\n' })
  expect(answer.failures).toEqual([])
  expect(answer.findings).toEqual([expect.objectContaining({ rule: 'oxlint/no-debugger', line: 2, level: 'warning' })])
})

test("a linter's note-level finding, such as shellcheck's info, reaches the edit answer as a warning", () => {
  withLinters('shellcheck')
  const answer = edit('Write', { file_path: join(project, 'run.sh'), content: '#!/bin/sh\necho $1\n' })
  expect(answer.refuse).toBeUndefined()
  expect(answer.findings).toEqual([expect.objectContaining({ rule: 'shellcheck/SC2086', line: 2, level: 'warning', isExisting: false })])
  expect(answer.note).toStartWith('Edit to run.sh allowed with warnings:\n\n  2  warning  shellcheck/SC2086  Double quote to prevent globbing and word splitting.')
})

test('biome refuses a write that adds a new violation', () => {
  withLinters('biome')
  write(join(project, 'biome.json'), '{ "linter": { "rules": { "suspicious": { "noDebugger": "error" } } } }\n')
  const answer = edit('Write', { file_path: join(project, 'src', 'app.ts'), content: 'export function total(): number {\n  debugger\n  return 2\n}\n' })
  expect(answer.refuse).toContain('2  error  biome/suspicious/noDebugger')
})

test('biome lets a write land with a warning when the violation was already in the file', () => {
  withLinters('biome')
  write(join(project, 'biome.json'), '{ "linter": { "rules": { "suspicious": { "noDebugger": "error" } } } }\n')
  const file = write(join(project, 'src', 'app.ts'), 'export function total(): number {\n  debugger\n  return 2\n}\n')
  existingLineLands(file, 'return 2', 'return 3', 'biome/suspicious/noDebugger')
})

test("biome checks a write's formatting and import order the way biome check does, and a full run gives the same findings", () => {
  withLinters('biome')
  write(join(project, 'biome.json'), '{ "formatter": { "indentStyle": "space" } }\n')
  const file = join(project, 'src', 'app.ts')
  const text = 'import { z } from "./z";\nimport { a } from "./a";\n\nexport const total   =  a + z;\n'
  const found = edit('Write', { file_path: file, content: text }).findings.map(({ rule, line, level }) => ({ rule, line, level }))
  write(file, text)
  const run = rulebook(['check'])
  expect(found).toEqual([
    { rule: 'biome/assist/source/organizeImports', line: 1, level: 'error' },
    { rule: 'biome/format', line: 4, level: 'error' },
  ])
  expect(run.stdout).toContain('1  error  biome/assist/source/organizeImports')
  expect(run.stdout).toContain("4  error  biome/format                         The file breaks Biome's formatting, and Biome's first change is on this line.")
})

test("stylelint and oxlint flag a disable comment that disables nothing when their configs ask for it, on a write and in a full run", () => {
  withLinters('stylelint', 'oxlint')
  write(join(project, 'stylelint.config.mjs'), "export default { reportNeedlessDisables: true, rules: { 'color-no-invalid-hex': true } }\n")
  write(join(project, '.oxlintrc.json'), '{ "options": { "reportUnusedDisableDirectives": "error" }, "rules": { "no-debugger": "error" } }\n')
  const css = join(project, 'src', 'app.css')
  const ts = join(project, 'src', 'app.ts')
  const cssText = '/* stylelint-disable-next-line color-no-invalid-hex */\na {\n  color: #fff;\n}\n'
  const tsText = '// oxlint-disable-next-line no-debugger\nexport const total = 1\n'
  const rules = (path: string, content: string) => edit('Write', { file_path: path, content }).findings.map(({ rule, level }) => `${level} ${rule}`)
  const written = [...rules(css, cssText), ...rules(ts, tsText)]
  write(css, cssText)
  write(ts, tsText)
  const run = rulebook(['check'])
  expect({ written, run: run.stdout }).toEqual({ written: expect.arrayContaining([expect.stringMatching(/^error stylelint\//), expect.stringMatching(/^error oxlint\//)]), run: expect.stringContaining('2 errors') })
})

test("biome leaves a file its files.includes leaves out", () => {
  withLinters('biome')
  write(join(project, 'biome.json'), '{ "files": { "includes": ["**", "!src/generated.ts"] }, "linter": { "rules": { "suspicious": { "noDebugger": "error" } } } }\n')
  expect(edit('Write', { file_path: join(project, 'src', 'generated.ts'), content: 'debugger\n' })).toEqual({ failures: [], findings: [] })
})

test('stylelint refuses a write that adds a new violation', () => {
  withLinters('stylelint')
  write(join(project, 'stylelint.config.mjs'), "export default { rules: { 'color-no-invalid-hex': true } }\n")
  const answer = edit('Write', { file_path: join(project, 'src', 'app.css'), content: 'a {\n  color: #ggg;\n}\n' })
  expect(answer.refuse).toContain('2  error  stylelint/color-no-invalid-hex  Invalid hex color "#ggg"')
})

test('stylelint lets a write land with a warning when the violation was already in the file', () => {
  withLinters('stylelint')
  write(join(project, 'stylelint.config.mjs'), "export default { rules: { 'color-no-invalid-hex': true } }\n")
  const file = write(join(project, 'src', 'app.css'), 'a {\n  color: #ggg;\n}\n')
  existingLineLands(file, '}', '  margin: 0;\n}', 'stylelint/color-no-invalid-hex')
})

test("Stylelint as a library gives each write the findings Stylelint's command line gives the same text, under extends, ignoreFiles, .stylelintignore, a nested config, a syntax error, and a disable comment", () => {
  withLinters('stylelint')
  write(join(project, 'stylelint.config.mjs'), "export default { extends: ['./base.mjs'], ignoreFiles: ['vendor/**'], rules: { 'color-no-invalid-hex': true } }\n")
  write(join(project, 'base.mjs'), "export default { rules: { 'block-no-empty': true } }\n")
  write(join(project, '.stylelintignore'), 'ignored.css\n')
  write(join(project, 'packages', 'a', '.stylelintrc.json'), '{ "rules": { "color-no-invalid-hex": null, "block-no-empty": [true, { "severity": "warning" }] } }\n')
  const broken = 'a {\n  color: #ggg;\n}\nb {}\n'
  const cases = [
    ['src/app.css', broken],
    ['ignored.css', broken],
    ['vendor/lib.css', broken],
    ['packages/a/x.css', broken],
    ['src/unclosed.css', 'a {\n  color: red\n'],
    ['src/disabled.css', '/* stylelint-disable color-no-invalid-hex */\na {\n  color: #ggg;\n}\n'],
  ] as const
  for (const [path, text] of cases) {
    const file = join(project, path)
    const folder = path.startsWith('packages/a/') ? join(project, 'packages', 'a') : project
    const command = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'node_modules', 'stylelint', 'bin', 'stylelint.mjs'), '--stdin-filename', file, '--formatter', 'json'], { cwd: folder, stdin: new Blob([text]), env: { ...process.env, BUN_BE_BUN: '1' } })
    const results = JSON.parse(command.stdout.toString() || command.stderr.toString()) as { warnings: { line: number; rule: string; severity: string }[] }[]
    const expected = results.flatMap(({ warnings }) => warnings.map(({ line, rule, severity }) => ({ line, rule: `stylelint/${rule}`, level: severity })))
    const found = edit('Write', { file_path: file, content: text }).findings.map(({ line, rule, level }) => ({ line, rule, level }))
    expect({ path, found: found.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule)) }).toEqual({ path, found: expected.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule)) })
  }
})

test('ruff refuses a write that adds a new violation', () => {
  withLinters('ruff')
  write(join(project, 'pyproject.toml'), '[project]\nname = "probe"\n\n[tool.ruff]\n')
  const answer = edit('Write', { file_path: join(project, 'app.py'), content: 'def total():\n    unused = 1\n    return 2\n' })
  expect(answer.refuse).toContain('2  error  ruff/F841  Local variable `unused` is assigned to but never used')
})

test('ruff lets a write land with a warning when the violation was already in the file', () => {
  withLinters('ruff')
  write(join(project, 'ruff.toml'), '')
  const file = write(join(project, 'app.py'), 'def total():\n    unused = 1\n    return 2\n')
  existingLineLands(file, 'return 2', 'return 3', 'ruff/F841')
})

test('shellcheck refuses a write that adds a new violation', () => {
  withLinters('shellcheck')
  const answer = edit('Write', { file_path: join(project, 'run.sh'), content: '#!/bin/bash\nfor name in $@; do\n  echo "$name"\ndone\n' })
  expect(answer.refuse).toContain('2  error  shellcheck/SC2068  Double quote array expansions to avoid re-splitting elements.')
})

test('shellcheck lets a write land with a warning when the violation was already in the file', () => {
  withLinters('shellcheck')
  const file = write(join(project, 'bin', 'run'), '#!/bin/sh\nfor name in $@; do\n  echo "$name"\ndone\n')
  existingLineLands(file, '  echo "$name"', '  printf \'%s\\n\' "$name"', 'shellcheck/SC2068')
})

test('mago is not installed here, so a write it covers lands with the missing-program failure', () => {
  withLinters('mago')
  write(join(project, 'mago.toml'), 'php-version = "8.4"\n')
  const answer = edit('Write', { file_path: join(project, 'src', 'Total.php'), content: '<?php\n\necho 1;\n' }, NO_LINTERS_PATH)
  expect(answer.refuse).toBeUndefined()
  expect(answer.failures).toEqual([`mago did not run on src/Total.php: linters names mago, but no mago program is installed: there is no vendor/bin/mago in ${project} or a folder above it and no mago on PATH. Install mago, or take mago out of linters in rulebook.config.ts.`])
  expect(answer.note).toStartWith('Edit to src/Total.php allowed, but not every rule checked it:')
})

test('selene is not installed here, so a write it covers lands with the missing-program failure', () => {
  withLinters('selene')
  write(join(project, 'selene.toml'), 'std = "lua51"\n')
  const answer = edit('Write', { file_path: join(project, 'init.lua'), content: 'local unused = 1\n' }, NO_LINTERS_PATH)
  expect(answer.refuse).toBeUndefined()
  expect(answer.failures).toEqual([`selene did not run on init.lua: linters names selene, but no selene program is installed: there is no selene on PATH. Install selene, or take selene out of linters in rulebook.config.ts.`])
})

test("pint flags a write's pending text with each fixer it would apply, at the first line it would change, writes nothing into the project folder, and leaves a file its exclude leaves out", () => {
  withLinters('pint')
  write(join(project, 'pint.json'), '{ "preset": "psr12", "exclude": ["legacy"] }\n')
  const composerBin = Bun.spawnSync(['composer', 'global', 'config', 'bin-dir', '--absolute']).stdout.toString().trim()
  mkdirSync(join(project, 'vendor', 'bin'), { recursive: true })
  symlinkSync(join(composerBin, 'pint'), join(project, 'vendor', 'bin', 'pint'))
  const before = readdirSync(project, { recursive: true }).sort()
  const file = join(project, 'src', 'Total.php')
  const text = '<?php\n\nfunction total(): int\n{\n    if(true){ return 1; }\n    return 2;\n}\n'
  const answer = edit('Write', { file_path: file, content: text })
  expect(answer.findings.map(({ rule, line, level }) => ({ rule, line, level }))).toEqual([
    { rule: 'pint/braces_position', line: 5, level: 'error' },
    { rule: 'pint/single_space_around_construct', line: 5, level: 'error' },
    { rule: 'pint/statement_indentation', line: 5, level: 'error' },
  ])
  expect(readdirSync(project, { recursive: true }).sort()).toEqual(before)
  expect(edit('Write', { file_path: join(project, 'legacy', 'Total.php'), content: text })).toEqual({ failures: [], findings: [] })
  expect(edit('Write', { file_path: file, content: '<?php\n\nfunction total( {\n' }).findings).toEqual([expect.objectContaining({ rule: 'pint/error', line: 3, level: 'error' })])
  write(file, text)
  expect(rulebook(['check']).stdout).toBe([
    'src/Total.php',
    ...['braces_position', 'single_space_around_construct', 'statement_indentation'].flatMap((fixer) => [
      `  5  error  ${`pint/${fixer}`.padEnd(34)}  The file breaks Pint's ${fixer}, and Pint's first change is on this line. Run pint on the file to fix it.`,
      '     > if(true){ return 1; }',
    ]),
    '',
    '3 errors, 0 warnings in 1 file',
    '',
  ].join('\n'))
})

test('a full run runs each listed linter once over its project and lists its findings', () => {
  withLinters('oxlint', 'ruff')
  write(join(project, '.oxlintrc.json'), '{ "rules": { "no-unused-vars": "error" } }\n')
  write(join(project, 'src', 'app.ts'), 'export function total(): number {\n  const unused = 1\n  return 2\n}\n')
  write(join(project, 'ruff.toml'), '')
  write(join(project, 'tools', 'report.py'), 'def total():\n    unused = 1\n    return 2\n')
  const run = rulebook(['check'])
  expect(run.stdout).toContain("src/app.ts\n  2  error  oxlint/no-unused-vars  Variable 'unused' is declared but never used.")
  expect(run.stdout).toContain('tools/report.py\n  2  error  ruff/F841  Local variable `unused` is assigned to but never used')
  expect(run.stdout).toEndWith('2 errors, 0 warnings in 2 files\n')
  expect(run.code).toBe(1)
  expect(readdirSync(join(project, 'src'))).toEqual(['app.ts'])
})

test("a full run gives every file the findings an edit gives it, under its own nearest rulebook config: a file outside every linter config folder gets the linter's defaults, and a package whose config lists no linter gets none", () => {
  withLinters('oxlint')
  write(join(project, 'packages', 'a', '.oxlintrc.json'), '{ "rules": { "no-unused-vars": "error" } }\n')
  const unused = 'export function total(): number {\n  const unused = 1\n  return 2\n}\n'
  const debug = 'export function total(): number {\n  debugger\n  return 2\n}\n'
  write(join(project, 'packages', 'b', 'rulebook.config.ts'), 'export default {}\n')
  expect(edit('Write', { file_path: join(project, 'packages', 'a', 'app.ts'), content: unused }).findings).toEqual([expect.objectContaining({ rule: 'oxlint/no-unused-vars', line: 2, level: 'error' })])
  expect(edit('Write', { file_path: join(project, 'tools', 'debug.ts'), content: debug }).findings).toEqual([expect.objectContaining({ rule: 'oxlint/no-debugger', line: 2, level: 'warning' })])
  expect(edit('Write', { file_path: join(project, 'packages', 'b', 'debug.ts'), content: debug })).toEqual({ failures: [], findings: [] })
  write(join(project, 'packages', 'a', 'app.ts'), unused)
  write(join(project, 'tools', 'debug.ts'), debug)
  write(join(project, 'packages', 'b', 'debug.ts'), debug)
  const run = rulebook(['check'])
  expect(run.stdout).toBe([
    'packages/a/app.ts',
    "  2  error  oxlint/no-unused-vars  Variable 'unused' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.",
    '     > const unused = 1',
    '',
    'tools/debug.ts',
    '  2  warning  oxlint/no-debugger  `debugger` statement is not allowed help: Remove the debugger statement',
    '     > debugger',
    '',
    '1 error, 1 warning in 2 files',
    '',
  ].join('\n'))
})

test("tsc type-checks the nearest tsconfig.json's program on a full run, and a single write runs no tsc", () => {
  withLinters('tsc')
  write(join(project, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n')
  const ran = join(home, 'project-tsc-ran')
  write(join(project, 'node_modules', 'typescript', 'bin', 'tsc'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(ran)}, '')\nawait import(${JSON.stringify(OWN_TSC)})\n`)
  const file = join(project, 'src', 'app.ts')
  const text = "export function total(): number {\n  const value: number = 'two'\n  return value\n}\n"
  expect(edit('Write', { file_path: file, content: text })).toEqual({ failures: [], findings: [] })
  expect(existsSync(ran)).toBe(false)
  write(file, text)
  expect(rulebook(['check']).stdout).toBe("src/app.ts\n  2  error  tsc/TS2322  Type 'string' is not assignable to type 'number'.\n     > const value: number = 'two'\n\n1 error, 0 warnings in 1 file\n")
  expect(existsSync(ran)).toBe(true)
})
