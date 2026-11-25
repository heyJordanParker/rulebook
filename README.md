# rulebook

rulebook checks your files against your rules: any file a rule covers, code and docs alike, every CLAUDE.md, rule, Skill, and agent file, and every agent message a rule covers. A rule is an ast-grep pattern in any of 13 languages, a TypeScript check, or a check an agent runs, and rulebook runs your project's own linters beside them. When any agent writes a file with Edit, Write, MultiEdit, or NotebookEdit, rulebook checks it as the write will leave it. An error refuses the edit, and the agent reads why, with the line it wrote. A warning lets the edit land, and the agent reads it beside the result. As the git pre-commit hook, `rulebook check --staged` checks every commit, by an agent or a person, with the project's rules and linters and the committer's global config.

rulebook checks what agents send you the same way. Before the main agent ends its turn, rulebook checks its final reply as `@reply`. An error keeps the agent from stopping once per turn, and the agent writes the whole reply again. A rewrite that still breaks a rule ends the turn, and its findings show as a warning toast. A subagent's answer is never checked. Before any agent runs a shell command, rulebook checks the command as `@command`, and a rule reads each program the command runs, even one inside `sudo`, `env`, `bash -c`, or `$(…)`. Before any agent calls a tool that a config's `messages` `tools` match, such as an inbox tool, rulebook checks the text of every field the call sends. An error refuses the call before it runs, and an `ask` finding makes Claude Code ask you before it runs. A script rule also reads the call itself as `context.call`: the tool, its input, and the session and agent that make it.

```text
Edit to .claude/rules/testing.md refused. Fix every error, then edit again.

  12  error  global/block-em-dashes  Split the sentence at the em dash.
      > Run the tests — they take a minute.
```

## Install

rulebook is a mod for [Claude Mod Manager (cmod)](https://github.com/heyJordanParker/cmod), version 6.0.0 or later. With cmod installed, run:

```sh
cmod install heyJordanParker/rulebook
```

That installs the mod in Claude Code and puts the `rulebook` program on your `PATH`. The program runs on macOS and Linux (glibc), on arm64 and x64.

A project with a `package.json` adds `@cmodjs/rulebook` as a dev dependency, so every teammate and CI run the same version without cmod, and `tsc` finds the types its config and rule files import:

```sh
bun add -d @cmodjs/rulebook
```

Its `node_modules/.bin/rulebook` runs under Bun. Rules and configs also run without the package, because the program serves `@cmodjs/rulebook` to them itself.

## Quick start

rulebook turns on no rule until a config does. Put `rulebook.config.ts` at the root of your project:

```ts
import { defineConfig } from '@cmodjs/rulebook'

export default defineConfig({
  plugins: { app: './rules' },
  linters: ['oxlint'],
})
```

`plugins` names `rules/` as the `app` rule folder, and `linters` runs oxlint with the project's own config. Add your first rule as `rules/block-console-log.yml`:

```yaml
description: Don't log to the console.
language: typescript
files: ['src/**/*.ts']
rule:
  pattern: console.log($$$ARGS)
```

Run `rulebook check` in the project to check every file a rule covers. In a Claude Code session, the agent reads "Don't log to the console." before it writes a file under `src/`, and a write that adds a `console.log` is refused. To check every commit too, commit this as `.githooks/pre-commit`:

```sh
#!/bin/sh
exec rulebook check --staged
```

Then make it run, once per clone:

```sh
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
```

The `/rulebook:write-rule` Skill walks an agent through writing more rules.

### Rules for every project

Your own rules, such as rules for every CLAUDE.md you write, go in your global config at `~/.config/rulebook/rulebook.config.ts`:

```ts
import { defineConfig, recommended } from '@cmodjs/rulebook'

export default defineConfig({
  extends: [recommended],
  plugins: { global: './rules' },
})
```

`recommended` makes every CLAUDE.md, CLAUDE.local.md, AGENTS.md, and `.claude/` rule, agent, command, and Skill file a Prompt, and flags a CLAUDE.md import that names no file. `plugins` names `~/.config/rulebook/rules/` as the `global` rule folder. Add your first rule there as `~/.config/rulebook/rules/block-em-dashes.ts`:

```ts
import { defineRule } from '@cmodjs/rulebook'

const EM_DASH = String.fromCharCode(0x2014)

export default defineRule({
  description: "Don't write em dashes.",
  message: 'Split the sentence at the em dash.',
  create(context) {
    context.sourceCode.lines.forEach((text, index) => {
      if (text.includes(EM_DASH)) context.report({ loc: { start: { line: index + 1, column: text.indexOf(EM_DASH) } } })
    })
    return {}
  },
})
```

A rule without `files` checks every Prompt, the files a config's `files` lists, so this rule checks every CLAUDE.md in every project. The agent reads "Don't write em dashes." beside each Prompt it opens, and a write that puts an em dash in a CLAUDE.md is refused. `/rulebook` in a session shows a full run's results in the Sidebar.

## Configure it

rulebook checks each file with two configs, the second merged over the first:

- `~/.config/rulebook/rulebook.config.ts`, or `$XDG_CONFIG_HOME/rulebook/rulebook.config.ts` when `XDG_CONFIG_HOME` is set, is your own global config. It applies in every project.
- The nearest `rulebook.config.ts`, in the file's folder or the nearest folder above it, up to the filesystem root, the way ESLint 10 finds its config. Only that one config applies to the file, so a nested package can hold its own, and a folder above your projects, such as `~/Developer`, holds the config of every project under it that holds none. A full run checks each file with its own nearest config.

A config pulls in other configs only through `extends`: a list of config paths, relative to the config, with `~` read as the home folder, and config objects imported from packages. A file gets the global config, then each `extends` entry from left to right, then the config's own keys. Lists add up, and a later `rules` setting merges over an earlier one key by key, as ESLint merges its rule settings, so a nearer config can turn any rule it inherits off or down. A severity written as a string, such as `'warn'`, sets only `severity`. A config reached twice merges once, at its first place. An `extends` path that names no file fails and names it.

rulebook turns on no rule by itself. `recommended`, which `@cmodjs/rulebook` exports, makes the files Claude Code reads as instructions Prompts, `**/{CLAUDE,Claude}.md`, `**/{CLAUDE,Claude}.local.md`, `**/AGENTS.md`, and `**/.claude/{rules,agents,commands,skills}/**/*.md`, and turns on `rulebook/imports`, which flags a CLAUDE.md import that names no file, the way ESLint's `js.configs.recommended` turns on its rules. `rulebook/no-suppressions`, which flags a comment that suppresses a linter's rule, stays off until a config sets its severity. rulebook always registers the `@reply` and `@command` messages, and flags a `rulebook-expect` comment outside a rule test as `rulebook/expect-comments`.

rulebook reads no config from the Claude Code plugins that are turned on. A plugin's rules, and the tool calls and folders its `messages` name, reach a project only when a config extends the plugin's `rulebook.config.ts`.

```ts
import { defineConfig, recommended } from '@cmodjs/rulebook'

export default defineConfig({
  extends: [recommended, '../rulebook.config.ts'],
  plugins: { app: './rules' },
  files: ['docs/**/*.md'],
  tests: ['tests/**/*.md'],
  timeout: 30_000,
  existingErrors: 'warn',
  rules: {
    'global/block-em-dashes': 'off',
    'global/writing/require-plain-words': { severity: 'warn', model: 'sonnet' },
    'app/require-owners': { runs: 'manual', timeout: 300_000 },
  },
  linters: ['oxlint', 'ruff'],
  programs: { ruff: ['uv', 'run', 'ruff'] },
})
```

| Key | What it sets |
| --- | --- |
| `extends` | The configs this one builds on: paths relative to the config, and config objects such as `recommended`. |
| `plugins` | Each rule folder, by the name its rules carry, such as `app/require-owners`. |
| `files` | The Prompts: the files every rule without its own `files` checks, relative to the config's folder. The global config's globs, and those of a config outside the project, are relative to the project root. Every file a Claude.md or `.claude/rules/` file among them imports, four hops deep, counts too. |
| `tests` | The rule tests, relative to the config. |
| `timeout` | How long an agentic rule or a linter run may take, in milliseconds, unless the rule sets its own. 30 000 by default. |
| `existingErrors` | `warn`, the default, lets an edit through an error that was already in the file. `error` blocks it too. Either way, an edit's answer lists only the findings on lines the edit wrote, and counts the rest in one line that names the `rulebook check <file>` command that lists them. An edit that adds and removes more than 1,000 lines in all counts every line as written, because finding the lines it wrote took 18 s for a rewrite of a 10,000-line file. |
| `rules` | A severity, `"off"`, or the settings of any rule: `severity`, `runs`, `files`, and for an agentic rule `timeout`, `agent`, `model`, `effort`. `model: 'jev'` runs the rule on Jev, and `threshold` sets the probability a line needs to pass on Jev. |
| `linters` | The linters to run on every write, every commit, and every full run, such as `['mago', 'oxlint']`. A linter no config lists never runs. |
| `programs` | The command that runs a linter in place of the program rulebook finds, such as `{ mago: ['bun', 'scripts/mago.ts'] }`. It runs in the linter's folder, and rulebook adds its usual arguments, so a project's own wrapper can set the linter's arguments and environment, or build what the linter reads first. |
| `messages` | Where rulebook finds a message by itself. `tools` checks each matching tool call, such as `['mcp__inbox__*']`, as `@<name>` before it runs. `folder` makes a full run check each file under that folder, relative to the config, as `@<name>/<path>`. A rule covers any `@` name without it. |

## Write a rule

A rule is one file in a rule folder, at any depth. Its path in the folder is its name: with `plugins: { global: './rules' }`, `rules/writing/block-em-dashes.ts` is `global/writing/block-em-dashes`, so moving a rule renames it. Every rule has a `description`, the Rule in one line of plain words, and rulebook refuses to load a rule without one.

A rule's `files` decide what it checks, as ESLint's `files` do. Each entry is a glob for any file, or a message named with `@`. A file glob is relative to the folder of the config that declares it: the config whose `plugins` names the rule's folder, or the config whose `rules` setting gives the rule new `files`. The global config's globs, and those of a config outside the project, are relative to the project root. `@reply` is the agent's final reply, and `@command` is each shell command an agent runs. Any other `@` name covers the message a mod checks by that name, such as `@inbox/**` for each item the inbox checks with `rulebook check --stdin-file-path=@inbox/<id>.md`, so a rule covers a mod's messages without any config naming the mod. A glob that starts with `@` matches only a message, and any other glob only a file, so `**` covers every file and no message. A rule without `files` checks every Prompt, and when no config lists `files`, a full run, a commit, and `rulebook inspect rules` name it as a rule that checks no file.

```ts
files: ['**', '@reply', '@command', '@inbox/**']
```

A rule has one `message`, the text each finding shows, the way an ast-grep or Semgrep rule carries one message. A rule without one shows its `description`. A rule that needs two messages is two rules, so each stays small. `severity` is `error`, the default, `warn`, or `ask`. An `ask` finding on an agent's write or tool call makes Claude Code ask you before the call runs, with the finding as the reason, the way Claude Code's own `ask` permission does. A commit, `rulebook check`, and a reply have nobody to ask, so there `ask` counts as `error`.

A rule's `metadata` is a map of any keys, such as `{ mode: 'propose' }`. rulebook never reads it. It passes it to other mods with the rule, so a mod can group rules by its own keys.

The file's extension picks the kind of rule.

A pattern rule is a `.yml` file. It matches the file's syntax tree with [ast-grep](https://ast-grep.github.io), so it never flags a comment or a string, and flags each match at its first line. Its keys are `description`, `message`, `files`, `severity`, `runs`, `metadata`, `language`, and `rule`. `language` is `typescript`, `tsx`, `javascript`, `html`, `css`, `php`, `python`, `bash`, `lua`, `json`, `yaml`, `toml`, `markdown`, or `rust`, and `rule` is any ast-grep rule object.

```yaml
description: Don't log to the console.
language: typescript
files: ['**/*.ts']
rule:
  pattern: console.log($$$ARGS)
```

A script rule is a `.ts` file laid out as an ESLint rule. `create` receives the `context` and returns a visitor for each kind of node the rule checks. A visitor reports a node it flags with `context.report({ node })`, and a rule reports a line with `context.report({ loc: { start: { line, column } } })`. Its keys are `description`, `message`, `files`, `severity`, `runs`, `metadata`, and `create`, and rulebook refuses to load a rule with any other key.

```ts
import { defineRule, type SgNode } from '@cmodjs/rulebook'

export default defineRule({
  description: "Don't sleep in a test.",
  files: ['**/*.test.ts', '**/test_*.py'],
  create(context) {
    const check = (call: SgNode) => {
      if (/sleep$/.test(call.field('function')?.text() ?? '')) context.report({ node: call })
    }
    return { call_expression: check, call: check }
  },
})
```

`context.sourceCode` is the file the way ESLint hands it to a rule: its `text`, its `lines`, and `ast`, the parsed file. rulebook parses a file by its extension with ast-grep, in TypeScript, TSX, JavaScript, HTML, CSS, PHP, Python, Bash, Lua, JSON, YAML, TOML, Markdown, or Rust, and every `@` message but `@command` as Markdown. Its `ast` is the root of the tree, an ast-grep `SgNode` with `kind()`, `text()`, `range()`, `field()`, `children()`, `parent()`, `find`, and `findAll`. A file no parser reads, such as a `.txt`, gets a `Document` that holds its `text`.

A visitor named for a node kind runs for every node of that kind, in file order, from one ast-grep search. A kind the file's language lacks never runs, so the rule above checks a TypeScript `call_expression` and a Python `call` with one function. A visitor that names no node kind of any language rulebook parses stops the rule with an error that names it. rulebook offers no ESLint selectors and no `:exit` visitors, because visiting every node of a 5,470-line file took 265 ms, where one search took 5.8 ms.

A `@command`'s `ast` is a `Shell`: its `commands`, the files the command `reads` and `writes`, the URLs it `fetches`, and `isFullyParsed`, false when a part of the command, such as a `$VAR` program, cannot be known before it runs. The `Command` visitor visits each program a `@command` runs, with its `program`, the name without its folder, its `args`, its `argv`, the `folder` it runs in, `input`, the index of the command whose output a pipe feeds it, and `runner`, the index of the command that runs it, such as `sudo`, `xargs`, `find -exec`, or `bash -c`, absent for a command the shell runs itself.

```ts
import { defineRule } from '@cmodjs/rulebook'

export default defineRule({
  description: "Don't send 3rd party software feedback.",
  files: ['@command'],
  create(context) {
    return {
      Command(command) {
        if (command.program === 'herdr-app' && command.args[0] === 'feedback') context.report({ node: command })
      },
    }
  },
})
```

A finding on `context.sourceCode.ast`, the root of the file, refuses a write whatever lines the write changed. A rule that judges the write as a whole, such as who makes it, reports the root inside `create`.

`context.previous` is the file before the write, the text on disk before an edit and the `HEAD` text in a commit, in the same shape as `context.sourceCode`. It is absent for a new file and in a full `rulebook check`. So a rule about the whole file refuses only a write that makes the file worse, and a full run still flags every file that breaks it:

```ts
export default defineRule({
  description: 'Keep a Prompt under 10,000 characters.',
  create({ sourceCode, previous, report }) {
    const { length } = sourceCode.text
    if (length >= 10_000 && length > (previous?.text.length ?? 0)) report({ node: sourceCode.ast })
    return {}
  },
})
```

`context` also holds `root`, the project root's absolute path, `filename`, the file's absolute path or its `@` name, and `call`, the tool call being checked, when there is one: its `tool`, its `input`, its `cwd`, and the `session`, `agentType`, `agentId`, and `transcriptPath` the harness sends. A script rule is any TypeScript, so with `root` it can read other project files, ask git about uncommitted work, or run a program, the way a git hook does.

An agentic rule is a `.md` file. Its frontmatter is Claude Code's Skill frontmatter without `name` and `context`, plus rulebook's `message`, `files`, `severity`, `runs`, `timeout`, and `threshold`, and its body is the check. `metadata` is the Skill frontmatter's own key. Each finding shows the text its subagent writes for it. Unless its `model` is `jev`, rulebook runs it the way Claude Code runs any `context: fork` Skill: in a subagent in the project, which reads the project's Claude.md files. `agent` picks the subagent, whose own frontmatter applies, its preloaded Skills included.

```md
---
description: Don't state a Fact the code contradicts.
model: sonnet
allowed-tools: Read, Grep, Glob
files:
  - "**/CLAUDE.md"
runs: manual
timeout: 600000
---

Check each Fact in this Claude.md against the code, folders, and commands it names.
Report each Fact the code contradicts, with what the code shows instead.
```

An agentic rule with `model: jev` runs on Jev, TypeSafe's decision model, instead of Claude Code, and rulebook sends it to Jev's newest model, `jev-latest`. rulebook asks Jev whether each line that holds text follows the rule, and flags each line Jev gives a probability below `threshold`, with the rule's message, or its description when it has none. The threshold is 0.7 unless the rule or a config sets it, the starting point TypeSafe's docs give for a yes. Raise it to flag more lines Jev is unsure of. On a 7-line file, a rule that flags metaphors took 0.8 s on Jev and 13.0 s on Claude Code with `model: haiku`, and both flagged the same two lines. Jev reads only the rule and the file, never the project, so write a Jev rule for a mistake a line shows by itself, such as a metaphor or a hedge. It runs no agent, so rulebook refuses `agent`, `effort`, `allowed-tools`, and `disallowed-tools` on it.

```md
---
description: Write literally, with no metaphors or idioms.
model: jev
threshold: 0.8
---

A line breaks the rule when it describes code with a metaphor or an idiom, such as code that "asks questions".
```

A Jev rule reads your TypeSafe API key from rulebook's cmod secret. Store it once on each computer, with the key on stdin:

```sh
printf '%s' "$TYPESAFE_API_KEY" | cmod secret store rulebook jev
```

Without it, the rule does not run, and the write lands with a note that names the command. `JEV_BASE_URL` sends the requests to a gateway instead of `https://api.typesafe.ai`.

`runs` decides when a rule runs. A rule runs `always` by default: on every agent write, every tool call, and every `rulebook check`. A rule too slow for an agent's write, such as an agentic rule that reads the whole project, runs `manual`. An agent's write never runs it, and every `rulebook check` does, whatever starts it: a person, a git hook, or CI. [Run the manual rules](#run-the-manual-rules) shows where to run them.

Only an agentic rule has a `timeout`, because the deadline stops only agentic sessions. The agentic rules of one file share one deadline, the longest `timeout` among them, so many agentic rules never hold an edit past it. Every agentic rule of a run starts at once, and the deadline starts with them. A rule still running at the deadline stops, and the edit lands with a note that names it.

## Run the project's linters

rulebook runs each linter a config's `linters` lists on every write, on the text the write will leave, before it lands. Type checks are the exception: one file cannot be type-checked alone, so `tsc` and `mago analyze` run only over the whole project, in a full run and in a commit, never on a write. A project whose configs list no linter runs none, whatever linter configs it holds. Its findings join the same answer as rulebook's own, named `<linter>/<rule>`, such as `mago/no-eval`, at the severity the linter gives them. The linter's config and baseline stay the only place its rules live.

| Linter | Files | Its config |
| --- | --- | --- |
| `mago` | `.php`, or the extensions `mago.toml` lists in `source.extensions` | `mago.toml`. rulebook runs `mago lint` on a write, and `mago lint` and `mago analyze` in a full run and a commit. |
| `oxlint` | JavaScript and TypeScript | `.oxlintrc.json`, `.oxlintrc.jsonc`, `oxlint.config.ts`, or `oxlint.config.mts`. Its `jsPlugins` rules run on a write and in a full run. |
| `biome` | JavaScript, TypeScript, CSS, and JSON | `biome.json` or `biome.jsonc`. rulebook checks what `biome check` checks: the linter, the formatter as `biome/format` on the first line Biome would change, and assists such as `biome/assist/source/organizeImports`. Biome's config turns each one off. |
| `stylelint` | `.css` | `stylelint.config.*` or `.stylelintrc*` |
| `ruff` | `.py` and `.pyi` | `ruff.toml`, `.ruff.toml`, or a `pyproject.toml` that holds `[tool.ruff]` |
| `selene` | `.lua` | `selene.toml` |
| `shellcheck` | `.sh`, `.bash`, `.ksh`, `.dash`, and a file with no extension whose first line is an sh, bash, dash, or ksh shebang | none: it checks every shell script |
| `pint` | `.php` | `pint.json`. rulebook runs `pint --test`, which changes no file, and names each fixer Pint would apply, such as `pint/braces_position`, on the first line Pint would change. |
| `tsc` | JavaScript and TypeScript | `tsconfig.json`. rulebook runs `tsc -b --noEmit` in a full run and a commit, never on a write. |

rulebook finds a listed linter's config in the file's folder or the nearest folder above it in the project, and runs the linter in that folder, so the linter reads its own config, ignore files, and baseline for the real path. A listed linter runs the way its own command line runs in that folder: with its config when it finds one, and with its own defaults when it finds none. A linter that refuses to run without a config, such as Stylelint, lands the write with a note that quotes its refusal.

rulebook runs the project's own copy first, so the linter matches the version the project's CI runs: `vendor/bin/mago`, `vendor/bin/pint`, `node_modules/oxlint`, `node_modules/stylelint`, and `node_modules/typescript` under Bun, Biome's native program in `node_modules/@biomejs/cli-<os>-<arch>`, and `.venv/bin/ruff`. rulebook brings its own oxlint 1.86.0, Biome 2.6.4, and Stylelint 17.15.0, built into the program, and runs them when the project has none. For Mago, Pint, `tsc`, ruff, selene, and shellcheck, rulebook runs the program on `PATH` next, and when neither copy exists the write lands with a note that names the missing program.

Pint reads only files on disk, so on a write rulebook copies the pending text to the file's path inside a temporary folder outside the project and runs `pint --test` there with the project's `pint.json`. Its `exclude`, `notName`, and `notPath` apply to that path as they do in the project, and nothing lands in the project folder. A file Pint cannot parse is a `pint/error` finding on the line Pint names.

`tsc` runs `tsc -b --noEmit` from the outermost folder that holds a `tsconfig.json`, so a root `tsconfig.json` that lists every project in its `references` checks them all, as `tsc -b` does there. It writes no JavaScript, and keeps its `.tsbuildinfo` files as `tsc -b` does. Each error is `tsc/TS<code>` on its file and line. A `tsc` that reports an error outside every JavaScript and TypeScript file, such as a broken `tsconfig.json`, or that finds no `tsconfig.json`, lands the run with a note that quotes it.

An error on a line that was already in the file is a warning, as with rulebook's own rules. Every finding a linter reports reaches the agent: an error refuses the write, and everything else, such as shellcheck's info and style, is a warning. A Mago issue is an error at or above the `minimum-fail-level` that `mago.toml` sets for `[linter]` or `[analyzer]`, `error` by default, so rulebook refuses what `mago` itself fails on. Each linter run may take the config's `timeout`.

`linters` in a config lists the linters to run:

```ts
linters: ['mago', 'oxlint']
```

The lists of the global config, every config a config extends, and the config itself add up, so a linter the global config lists runs in every project. A file runs only the linters its own configs list.

An agent whose write a linter refuses can silence the rule with a comment instead of fixing the code. `rulebook/no-suppressions` bans those comments, the way `eslint-comments/no-use` bans ESLint's. It is off until a config turns it on:

```ts
rules: { 'rulebook/no-suppressions': 'error' }
```

It flags each line that holds a suppression comment of a linter rulebook runs, whether or not a config lists that linter:

| Linter | Suppression comments |
| --- | --- |
| `oxlint` | `oxlint-disable`, `oxlint-disable-line`, `oxlint-disable-next-line`, and the same `eslint-disable` forms |
| `biome` | `biome-ignore`, `biome-ignore-all`, and `biome-ignore-start` |
| `mago` | `@mago-expect` and `@mago-ignore` |
| `ruff` | `noqa`, `ruff: noqa`, `flake8: noqa`, `ruff: ignore[`, `ruff: disable[`, and `ruff: file-ignore[` |
| `shellcheck` | `shellcheck disable=` |
| `stylelint` | `stylelint-disable`, `stylelint-disable-line`, and `stylelint-disable-next-line` |
| `selene` | `-- selene: allow(` and `--# selene: allow(` |
| `pint` | `@php-cs-fixer-ignore`, which Pint reads at the start or end of a file |
| `tsc` | `@ts-expect-error`, `@ts-ignore`, and `@ts-nocheck` |

It checks every file with an extension a linter covers, and every file with no extension, so a Markdown file that names a suppression comment is never flagged. Its `files` setting changes that. A suppression that was already in the file is an existing finding, as with every rule.

## Check every commit

`rulebook check --staged` checks every file a commit stages, as the commit will record it, with every rule, the `manual` ones too. It reads each file from the staging area, so another agent's unstaged work never decides the result. It refuses the commit only for a rule's error on a line the commit wrote, and counts the findings that were already in those files. A renamed file is checked against its text at its old path. Make it the project's pre-commit hook in a folder the repository holds, so every clone gets it:

```sh
#!/bin/sh
exec rulebook check --staged
```

```sh
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
```

Git skips a hook that is not executable, and `core.hooksPath` is set once per clone. A project that installs `@cmodjs/rulebook` as a dev dependency runs `exec node_modules/.bin/rulebook check --staged`, so a teammate without cmod commits with the same version.

The project's linters check the whole commit, because a change can also break a file the commit never touched, such as a caller whose type no longer fits. So when a listed linter covers a file the commit stages or deletes, or the commit changes the linter's config or a baseline its config names, `rulebook check --staged` runs that linter over the whole project, on a copy of the tree the commit makes. When that copy has an error, it runs the linter again on a copy of `HEAD`'s tree, and refuses the commit for each error the commit's tree has and `HEAD`'s tree does not, matched by file, rule, and message, so an error the project already had never refuses it. It lists those errors with the rest, under their file:

```text
Commit refused. Fix every error, stage the fix, then commit again.

src/app.ts
  2  error  app/block-console-log  Don't log to the console.
     > console.log(order)

src/checkout.ts
  14  error  tsc/TS2322  Type 'string' is not assignable to type 'number'.
      > const total: number = formatTotal(order)

2 errors, 0 warnings in 4 files
```

Git holds neither copy's dependencies, so each copy links the ignored `node_modules`, `vendor`, and `.venv` folders of the working tree, and each ignored folder a `mago.toml` lists in `includes`, the third-party code Mago reads for its symbols, and no other ignored file. Another agent's unstaged work never reaches either copy. rulebook lints one copy after the other, and deletes both when the check ends. In a repository with no commit yet, every error counts.

A rule or linter that did not run lists why, and lets the commit through, as it lets a write through. A linter that did not run on `HEAD`'s copy, listed as `HEAD:<config>`, leaves nothing to compare, so each of its errors shows as a warning and none refuses the commit. With `existingErrors: 'error'`, an error a staged file already had refuses the commit too.

## Run the manual rules

An agent's write runs only the rules that run `always`, so a slow `manual` rule never holds up a write. Every `rulebook check` runs it, whoever starts the check: you, a git hook, or CI.

Each place you run rulebook picks its own rules. `--skip` leaves out each rule, rule folder, or linter it names, and `--skip=agentic` leaves out every agentic rule:

```sh
rulebook check --skip=global/require-true-facts
```

A pre-commit hook is one place to run a check. With git 2.54 or later, a hook set in git's config runs beside the project's own hooks, so it fits a repository whose `core.hooksPath` already holds a pre-commit hook:

```sh
git config hook.rulebook.event pre-commit
git config hook.rulebook.command "rulebook check --staged"
```

CI is another. A project that installs `@cmodjs/rulebook` as a dev dependency runs the same version CI does:

```yaml
name: rulebook
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: node_modules/.bin/rulebook check
```

An agentic rule runs `claude -p`, so CI that has no logged-in `claude` runs `rulebook check --skip=agentic`.

## Agents read the rules first

Every agent reads each rule's description before it can break it. A rule whose `files` cover every file (`**`) or a message (a glob that starts with `@`, such as `@reply`) reaches the agent as its session starts, after each compaction, and as each subagent starts:

```text
- Don't write em dashes.
```

A rule for some files, and a rule with no `files`, which covers every Prompt, reaches the agent with its first read or write of a file it covers:

```text
Rules for docs/CLAUDE.md:
- Don't state a Fact the code contradicts.
```

An agent reads each description once, until its context compacts. The mod loads the rules once per session with the `rules` answer of the rulebook server, which lists the rules of each folder that holds a `rulebook.config.ts`, and again at the session's next check after a rulebook config or rule file it lists changes, so a session that sits idle asks nothing. The mod shows each file the rules of its nearest folder in that list, and the session start shows the rules of the session's own folder.

## Other mods take part in each check

The rulebook mod provides the cmod interface `rulebook/Rules` in each session. Another mod in the session lists the rules of a folder with `rules(folder)`, each with its `id`, `description`, `severity`, and `metadata`. Before the mod checks an agent's write, tool call, or reply, it asks each `beforeCheck` listener, and a listener answers rule settings the way a config's `rules` does. rulebook merges every answer over the configs, as a later config wins, for that one check. A commit and `rulebook check` ask nobody.

```ts
for (const rulebook of await providers('rulebook/Rules'))
  rulebook.beforeCheck(({ task, rules }) => ({
    rules: Object.fromEntries(rules.filter(({ metadata }) => metadata.mode !== undefined && metadata.mode !== modeOf(task)).map(({ id }) => [id, 'off'])),
  }), { timeoutMs: 1000 })
```

Each check names its `path`, the `session`, and for a subagent its `task` and `agentType`, the `tool` it calls, and the `rules` of the path's folder. `types/index.d.ts` types the interface.

## Test a rule

A rule test is a file that `tests` names. It holds lines the rule must flag, each under a `rulebook-expect` comment, and lines it must leave alone, the way a Semgrep test file holds `ruleid:` comments. rulebook fails on a comment whose rule stops flagging its line and on a flag no comment expects. It skips each comment of a rule the run leaves out, such as a `runs: manual` rule's comment in an edit or a rule a `--skip` names, and fails a comment that names no rule. A `rulebook-expect` comment works only in a rule test.

```md
<!-- rulebook-expect global/block-em-dashes -->
Run the tests — they take a minute.

Run the tests. They take a minute.
```

A `rulebook-expect` comment with nothing after it but blank lines expects its rule to flag the whole file, the finding a rule reports on `context.sourceCode.ast`.

## Run it

rulebook's commands and flags are Biome's, so `rulebook check` works the way `biome check` does:

```text
rulebook check [files...]                Check every file a rule covers, every Prompt, and every rule test of this project, or only the files named, with every rule and linter.
rulebook check --staged                  Check what the next commit records, on the lines it writes, with every rule and linter. Run it from a git pre-commit hook.
rulebook check --stdin-file-path=<path>  Check stdin as the text of the file or message at <path>, such as @reply or @command, with the rules that run always, as an agent's write is checked.
rulebook check --reporter=json           Print the results as JSON.
rulebook check --skip=<name>             Skip a rule, every rule of a plugin or folder, a linter, or every agentic rule, such as --skip=agentic. Repeat it to skip more.
rulebook inspect rules                   Print, for each folder that holds a rulebook.config.ts, each rule that is on there, with its description and the files it covers, and each message with the tools that send it, as JSON.
rulebook claude-hook                     Check the tool call a Claude Code or codex PreToolUse hook sends on stdin: a file write, a shell command as @command, or a call a message's tools match. An error refuses it, and an ask asks the person first.
rulebook --version                       Print the version.
```

A full run also checks every file a rule's `files` cover, and every file in each message `folder`, by its @-name. It skips a file that holds a NUL byte in its first 8000 bytes, as git does for a binary file.

A full run also runs each listed linter once over its project, in the linter's own whole-project mode, from the outermost folder that holds its config, and once from the project root with the linter's own defaults for the files no config folder holds, and lists its findings with the rest. So a full run gives each file the findings an edit gives it. Named files list only their own linter findings.

`rulebook check --stdin-file-path=@reply` checks the text on stdin as the agent's reply, and `--stdin-file-path=src/app.ts` checks it as the text that file will hold, with the rules and linters an edit runs. It prints what an agent reads: a refusal, which exits 1, or a note with the warnings, and nothing when nothing is flagged. A refusal names what it refused, such as `Reply refused.` or, for `@inbox/<id>.md`, `Inbox refused.`, and quotes each line it flags. With `--reporter=json`, every check prints `{ reports, failures }`: each checked file's `path`, `findings`, and the `failures` of rules and linters that did not run, and the rule files that did not load.

`/rulebook` in a session runs the same check and lists the results in the Sidebar.

## Check Claude Code without cmod

The rulebook mod checks every session on a computer with cmod. A project can also check every clone's Claude Code sessions with a hook its `.claude/settings.json` holds:

```json
{ "hooks": { "PreToolUse": [{ "hooks": [{ "type": "command", "command": "rulebook claude-hook" }] }] } }
```

`rulebook claude-hook` reads the tool call Claude Code sends, checks an Edit, Write, or MultiEdit as the write will leave the file, checks a shell command as `@command`, and checks any call a message's `tools` match as that message. A write whose result rulebook cannot compute, such as a NotebookEdit or a codex `apply_patch`, is checked with no text, so only a rule that reads `context.call` flags it. An error exits 2 with the refusal, which refuses the call, an `ask` finding answers `permissionDecision: ask`, and a warning reaches the agent as context. It starts a fresh `rulebook` for each call, so each check pays a cold start the mod's server does not.

Codex reads the same hook from its `config.toml`, and sends its shell calls as `Bash`, `shell_command`, or `exec_command`, which `@command` covers:

```toml
[[hooks.PreToolUse]]
matcher = "Bash"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "rulebook claude-hook"
```

## One server checks every session

The mod starts one rulebook server for the whole computer, and every session's checks go to it. It keeps each project's configs, rules, ast-grep parsers, and Stylelint loaded in that project's own worker, so a check skips the load a fresh `rulebook` pays. A changed config or rule file, or a new config on the way up from the file, replaces that project's worker before the next check, so an edit to a rule applies to the next write. So does a plugin folder or `extends` file that a config names, once it appears or changes, so a config that failed because one was missing or did not parse answers as soon as it is fixed.

The worker also keeps the set of files the project's Claude.md files import, so an edit to an existing file skips the walk over every file of the project. A changed, new, or deleted Claude.md, rules link, or import that the walk read replaces the worker too, and so does a Claude.md or rules file a checked write creates, once the write lands, so the next check walks again. A Claude.md created outside any checked write, such as by `git checkout`, counts at the next worker replacement. So does an approval of imports from outside the project in `~/.claude.json`, because Claude Code writes that file so often that watching it would replace the worker before nearly every check.

These are the medians of 20 checks, a fresh `rulebook` process against the server, measured while other sessions held the computer's 1-minute load average at 31 to 33, and at 19 for the edits to an existing file:

| Check | Fresh process | Server |
| --- | --- | --- |
| A Write no rule covers | 41.1 ms | 1.1 ms |
| A Write to a Claude.md | 45.2 ms | 0.9 ms |
| A turn-end reply check | 39.3 ms | 0.5 ms |
| A Biome write | 386.1 ms | 348.2 ms |
| An edit to an existing file, 485-file repository | 52.9 ms | 0.6 ms |
| An edit to an existing file, 29,618-file repository | 628.3 ms | 0.5 ms |

Biome, oxlint, Mago, Pint, ruff, selene, shellcheck, and each agentic rule's Claude Code session still start per write, because none of them lints pending text in process with the findings its own command line gives. A server that is down, or a config that fails to load, fails each check with an error toast and lets the write through, so a broken setup never blocks an agent's work. A rule file that fails to load is skipped, and every other rule keeps checking. Its failure shows as one warning toast, in the first session that loads the rules after the rule broke, whatever number of sessions and projects you run, and shows again only once a load found it fixed and it broke again. A rule or linter that did not run on a write tells the agent in the write's note, and goes to the Log in cmod's Settings as a warning. `rulebook check` keeps working on its own, for full runs and CI.

## What runs and what leaves your machine

A config and a `.ts` rule are code, and rulebook runs them, the way ESLint runs its configs. A session in a project loads that project's `rulebook.config.ts` files and their rules, so open a cloned repository only when you trust its configs.

rulebook sends nothing anywhere by itself. The mod talks to the rulebook server over a Unix socket on your computer, and the program starts only `git`, the linters your configs list, and `claude`. Agentic rules are the exception. A Claude Code rule runs `claude -p` with your own Claude Code account, and that session reads the checked file and sends it to Anthropic, as any Claude Code session does. A Jev rule sends the rule and the checked file to TypeSafe's API with your TypeSafe API key.
