---
name: write-rule
description: Write or change a rulebook rule, a check rulebook runs on any file, agent reply, shell command, or tool call it covers, on every agent write and every commit. TRIGGER when asked to add, change, or test a rulebook rule, or to edit a rulebook.config.ts. DO NOT TRIGGER to fix a Prompt that a rulebook rule flagged; fix the Prompt.
---

# Write a rulebook rule

## 1. Find the config that holds the rule

- `~/.config/rulebook/rulebook.config.ts` applies to every project, and the nearest `rulebook.config.ts` at or above a file's folder merges over it.
- `extends` merges config paths, `~` as home, and objects such as `recommended`, left to right, before the config's own keys.
- `plugins` names each rule folder. A rule is a file at any depth, named `<plugin>/<path without extension>`: `rules/writing/block-em-dashes.ts` under `global` is `global/writing/block-em-dashes`.
- `rules` sets a rule to `'off'`, `'warn'`, `'error'`, or an object that also overrides `files`, `runs`, and an agentic rule's `timeout`, `agent`, `model`, `effort`, and `threshold`.
- No rule is on by default. `extends: [recommended]` turns on `rulebook/imports`, and `'rulebook/no-suppressions': 'error'` flags comments that suppress a linter, such as `# noqa`. A Claude Code plugin's rules apply only when a config extends its `rulebook.config.ts`.
- `files` lists the Prompts a rule without `files` checks, and `probes` the probe files, relative to the config's folder, or the project root for the global config.
- `messages` registers a message: `tools` checks each matching tool call as `@<name>`, and `folder` makes a full run check its files as `@<name>/<path>`. `@reply` and `@command` are built in.
- `linters` lists the linters rulebook runs: `mago`, `pint`, `oxlint`, `biome`, `stylelint`, `tsc`, `ruff`, `selene`, and `shellcheck`.

IF you move or rename a rule:
### Rename it in every config setting and probe pin
A setting or pin that names the old path fails with an error.

## 2. Name the rule for what it does

Start the name with `block` when the thing is refused everywhere, `limit` when it is allowed in one place, or `require` when every match takes one shape.

### Give every rule a `description`, and a `message` only when it differs
`description` is the Rule in one plain line, and rulebook refuses a rule without one. `message` is the text each finding shows, such as how to fix it. A rule that needs two messages is two rules.
Example: `description: Don't write em dashes.` with `message: Split the sentence at the em dash.`

## 3. Pick the fastest kind of rule that can catch the mistake

The extension picks the kind. A pattern or script rule takes a millisecond, a Jev rule under a second, and a Claude Code rule seconds to minutes:

- `.yml` is a pattern rule, which matches the syntax tree with ast-grep
- `.ts` is a script rule, which runs your TypeScript on the text and syntax tree
- `.md` is an agentic rule, which runs a Claude Code subagent, or Jev with `model: jev`

IF the project's own linter can express the check:
### Add it to that linter's config instead
rulebook reports its findings as `<linter>/<rule>` once a config's `linters` lists it.

### Cover what the rule checks with `files`
A rule without `files` checks every Prompt. Globs are relative to the config that names the rule's plugin. `@reply` is the main Agent's final reply, `@command` each shell command an Agent runs, and any other `@` name a mod's message, such as `@inbox/**`. Only a glob that starts with `@` matches a message.
Example: `files: ['**', '@reply', '@inbox/**']`

## 4. Write a pattern rule when the code's shape decides

It flags each match at its first line, never inside a comment or a string. `language` is `typescript`, `tsx`, `javascript`, `html`, `css`, `php`, `python`, `bash`, `lua`, `json`, `yaml`, `toml`, `markdown`, or `rust`, and `rule` is any ast-grep rule object.

```yaml
description: Don't log to the console.
language: typescript
files: ['**/*.ts']
rule:
  pattern: console.log($$$ARGS)
```

IF the language is PHP:
### Give the pattern a `<?php` context and a selector
A bare pattern such as `var_dump($$$ARGS)` parses as text and matches nothing.
Example: `pattern: { context: '<?php var_dump($$$ARGS);', selector: function_call_expression }`

## 5. Write a script rule when a program decides

A script rule is an ESLint rule. `create(context)` returns a visitor per node kind, and reports with `context.report({ node })` or `context.report({ loc: { start: { line, column } } })`.

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

- `context.sourceCode` holds `text`, `lines`, and `ast`, the root ast-grep `SgNode`, with `kind()`, `text()`, `range()`, `field()`, `parent()`, and `findAll`. Every `@` message but `@command` parses as Markdown, and a file no parser reads gets a `Document`.
- A visitor named for a node kind runs on each node of that kind in file order, never in a language that lacks it, so one rule covers several languages: a call is `call_expression` in TypeScript and Rust, `call` in Python, and `function_call_expression` in PHP. A name that is no node kind stops the rule.
- `context` also holds `root`, `filename`, `previous`, the file before the write, and `call`, the tool call: `tool`, `input`, `cwd`, `session`, `agentType`, `agentId`, and `transcriptPath`. A rule can read files, ask git, or run programs.

IF the rule checks shell commands:
### Cover `@command` and visit `Command`
`ast` is a `Shell` with `commands`, `reads`, `writes`, `fetches`, and `isFullyParsed`. `Command` visits every program, even inside `sudo`, `bash -c`, `$(…)`, or a pipe, with `program`, `args`, `argv`, `folder`, `input`, the index of the command piping into it, and `runner`, the index of the command running it, such as `sudo`.
Example: `Command(command) { if (command.program === 'herdr-app' && command.args[0] === 'feedback') context.report({ node: command }) }`

IF the rule judges the whole write, such as who makes it or the file's length:
### Report the root inside `create`
A finding on `context.sourceCode.ast` refuses the write whatever lines it changed. A rule about who writes covers every file and `@command` and reads `context.call`, because a write rulebook cannot compute, such as a NotebookEdit, reaches `create` with no text. A rule about the file compares with `context.previous`, absent for a new file and in a full run, so a file that already breaks it can still be fixed.
Example:
```ts
create({ sourceCode, previous, report }) {
  const { length } = sourceCode.text
  if (length >= 10_000 && length > (previous?.text.length ?? 0)) report({ node: sourceCode.ast })
  return {}
},
```

IF several rules share code:
### Put the shared module beside the plugin folder and import it by relative path
Every `.ts` file in a plugin folder loads as a rule, and a rule imports only `@cmodjs/rulebook` by package name.
Example: `rules/commands/block-git-stash.ts` imports `'../../lib/shell.ts'`.

## 6. Write an agentic rule when it takes judgment

Its body is the check. It runs as a forked Skill in a subagent in the project, `general-purpose` unless `agent` names one, and each finding shows the subagent's text. It cannot edit a file. Its frontmatter adds `timeout`, `threshold`, `agent`, `model`, `effort`, `allowed-tools`, and `disallowed-tools`.

```md
---
description: Name code with code words, never Domain.md words.
model: haiku
effort: low
files: ["**/Claude.md"]
---

Report each sentence that names a file, method, or class with a Domain.md word.
```

IF one line shows the mistake by itself, such as a metaphor or a hedge:
### Run the rule on Jev with `model: jev`
Jev, TypeSafe's decision model, judges each line in under a second and flags each line below `threshold`, 0.7 by default. It reads only the rule and the file, so a check that needs the project stays on Claude Code. It takes no `agent`, `effort`, or tool keys, and needs a key from `cmod secret store rulebook jev`.

## 7. Set when it runs

- `severity` is `error`, the default, which refuses the write, tool call, or commit, or `warn`, which lands with a note. An error on a line the write did not write is a warning, unless the config sets `existingErrors: 'error'`.
- `runs` is `always`, the default, or `manual`, which never runs on an Agent's write or tool call, only in `rulebook check`: commits, full runs, `/rulebook`, and CI.
- `timeout` is an agentic rule's milliseconds, 30 000 unless the config sets it. A file's agentic rules share the longest one, and a rule still running then stops with a note.

IF an agentic rule takes longer than an edit can wait:
### Make it manual with the timeout it needs
Measure one run on the largest file it covers, and set `timeout` well past that.

## 8. Write a probe for the rule

A probe is a file the config's `probes` names, in the rule's language. Put each line the rule must flag under a pin, and add lines it must leave alone. A pin with only blank lines after it expects a flag on the whole file. A probe runs only the rules it pins, and a pin works only in a probe.

```md
<!-- rulebook-expect global/block-hedging -->
The tests probably pass.

The tests pass.
```

## 9. Run the rule

Find the rule in `rulebook inspect rules` with no failure beside it. Run `rulebook check <probe>`, which passes with no output above the count line, and `rulebook check <a covered file>`. Check a message sample through stdin: `rulebook check --stdin-file-path=@command < sample.txt` exits 1 when the rule flags it.
