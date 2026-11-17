---
name: write-rule
description: Write or change a rulebook rule, a check rulebook runs on any file, agent reply, shell command, or tool call it covers, on every agent write and every commit. TRIGGER when asked to add, change, or test a rulebook rule, or to edit a rulebook.config.ts. DO NOT TRIGGER to fix a Prompt that a rulebook rule flagged; fix the Prompt.
---

# Write a rulebook rule

rulebook checks every file and message a rule's `files` cover, on every Agent write and every commit. An error refuses the write, the tool call, or the commit, and a warning lets it land with a note. `rulebook check` in a terminal, or `/rulebook` in a session, checks every file of the project a rule covers, with every rule and the project's linters.

## 1. Find the config that holds the rule

- `~/.config/rulebook/rulebook.config.ts` holds the rules that apply to every project.
- The nearest `rulebook.config.ts` in a file's folder or a folder above it holds the rules of that folder's files, so a nested package holds its own. Only that one config applies to the file, merged over the global config.
- `extends` pulls in other configs: paths relative to the config, with `~` read as the home folder, and config objects such as `recommended` from `@cmodjs/rulebook`. The global config merges first, then each `extends` entry from left to right, then the config's own keys, so a later `rules` setting turns an inherited rule off or down.
- `rules` sets each rule by its name: `'off'`, `'warn'`, `'error'`, or an object that also overrides its `files`, `runs`, and, for an agentic rule, `timeout`, `agent`, `model`, `effort`, and `threshold`, such as `rules: { 'global/require-true-facts': { runs: 'manual', timeout: 600000 } }`.
- rulebook turns on no rule by itself. `extends: [recommended]` turns on `rulebook/imports`. `rules: { 'rulebook/no-suppressions': 'error' }` turns on the rule that flags a comment that suppresses a linter's rule, such as `// oxlint-disable-next-line` or `# noqa`. A Claude Code plugin's rules apply only when a config extends the plugin's `rulebook.config.ts`.
- `messages` tells rulebook where to find a message by itself: `tools` checks each matching tool call as `@<name>`, and `folder` makes a full run check each file under that folder as `@<name>/<path>`. A rule covers any `@` name without it. `@reply` and `@command` are built in.
- `plugins` names each rule folder. A rule is one file at any depth of that folder, and its name is `<plugin>/<path in the folder, without the extension>`: with `plugins: { global: './rules' }`, `rules/writing/block-em-dashes.ts` is `global/writing/block-em-dashes`.
- `files` lists the Prompts, the files every rule without its own `files` checks, relative to the config's folder, and `probes` the probe files. The global config's `files` are relative to the project root.
- `linters` lists the linters rulebook runs on every write, such as `['mago', 'oxlint']`, from `mago`, `pint`, `oxlint`, `biome`, `stylelint`, `tsc`, `ruff`, `selene`, and `shellcheck`. `tsc` and `mago analyze` run only over the whole project, on a commit and a full run. A linter no config lists never runs.

IF you move or rename a rule:
### Rename it in every config setting and probe pin
The new path is a new name. A config setting or a pin that still names the old one fails with an error that names it.

## 2. Name the rule for what it does

Start the name with a verb: `block` when the thing is refused everywhere the rule covers, `limit` when it is allowed only in one place, `require` when every match must take one shape.
Example: `block-em-dashes`, `require-true-facts`.

### Give every rule a description
`description` is the Rule itself, in one line of plain words. rulebook refuses to load a rule without one.
Example: `description: Don't write em dashes.`

### Give a rule one message, or none
`message` is the text each finding shows, such as how to fix it. A rule without one shows its `description`. A rule that needs two messages is two rules.
Example: `message: Split the sentence at the em dash.`

## 3. Pick the fastest kind of rule that can catch the mistake

The file's extension picks the kind:

- `.yml` is a pattern rule, which matches the code's syntax tree with ast-grep
- `.ts` is a script rule, which runs your own TypeScript
- `.md` is an agentic rule, which runs a Claude Code subagent, or Jev with `model: jev`

A pattern or script rule checks a file in about a millisecond. A Jev rule takes under a second, and a Claude Code rule takes seconds to minutes, so write an agentic rule only when the check takes judgment.

IF the project's own linter can express the check:
### Add it to that linter's config instead of writing a rule
rulebook runs each linter a config's `linters` lists on every write with the project's config, and reports its findings as `<linter>/<rule>`, such as `mago/no-direct-db-query`. List the linter in the project's `rulebook.config.ts` when no config lists it yet. The linter's config stays the one place its rules live.

### Cover what the rule checks with `files`
A rule without `files` checks every Prompt, so a rule for code names its files. `files` takes globs for any file, relative to the folder of the config whose `plugins` names the rule's folder, or to the project root for the global config, and messages named with `@`: `@reply` is the main Agent's final reply, `@command` is each shell command an Agent runs, and any other `@` name covers the message a mod checks by that name, such as `@inbox/**` for each inbox item. A glob that starts with `@` matches only a message, so `**` covers every file and no message.
Example: `files: ['**', '@reply', '@inbox/**']`

## 4. Write a pattern rule when the code's shape decides

A pattern rule flags each match of its ast-grep rule, at the match's first line. A `pattern` never matches inside a comment or a string.

```yaml
description: Don't log to the console.
language: typescript
files: ['**/*.ts']
rule:
  pattern: console.log($$$ARGS)
```

`language` is one of `typescript`, `tsx`, `javascript`, `html`, `css`, `php`, `python`, `bash`, `lua`, `json`, `yaml`, `toml`, or `markdown`. `rule` is an ast-grep rule object, passed to ast-grep as written: `pattern`, `kind`, `regex`, `inside`, `has`, `not`, `all`, `any`, and the rest of ast-grep's rule keys.

IF the language is PHP:
### Give the pattern a `<?php` context and a selector
The PHP grammar reads a whole file, so a bare pattern such as `var_dump($$$ARGS)` parses as text and matches nothing.
Example:
```yaml
rule:
  pattern:
    context: '<?php var_dump($$$ARGS);'
    selector: function_call_expression
```

## 5. Write a script rule when a program decides

A script rule is laid out as an ESLint rule. `create` receives the `context` and returns a visitor for each kind of node the rule checks, and a visitor reports a node it flags with `context.report({ node })`.

```ts
import { defineRule } from '@cmodjs/rulebook'

const EM_DASH = String.fromCharCode(0x2014)

export default defineRule({
  description: "Don't write em dashes.",
  message: 'Split the sentence at the em dash.',
  create(context) {
    return {
      Line(line) {
        if (!line.isInCodeBlock && line.text.includes(EM_DASH)) context.report({ node: line })
      },
    }
  },
})
```

rulebook visits three kinds of node:
- `Document`, the whole text, once. A finding on it refuses a write whatever lines the write changed.
- `Line`, each line, with `lineNumber`, `text`, and `isInCodeBlock`.
- `Command`, each program a `@command` runs, with `program`, `args`, `argv`, `folder`, `input`, the index of the command whose output a pipe feeds it, and `runner`, the index of the command that runs it, such as `sudo`, `xargs`, `find -exec`, or `bash -c`, absent for a command the shell runs itself.

`context` holds `root`, the project root's absolute path, `path`, the file's path from that root or its `@` name, `text`, `lines`, and `commands`, so a rule can read other project files, ask git, or run a program. A `@command` also holds `shell`, the files the command `reads` and `writes`, the URLs it `fetches`, and `isFullyParsed`. `context.call` is the tool call being checked: its `tool`, `input`, `cwd`, `session`, `agentType`, `agentId`, and `transcriptPath`.

IF the rule checks shell commands:
### Cover `@command` and visit `Command`
rulebook finds every program a command runs, even inside `sudo`, `env`, `bash -c`, `$(…)`, or a pipe, so a rule never parses the command text itself.
Example:
```ts
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

IF the rule judges who makes the call, such as an agent that must never write:
### Cover every file and `@command`, and decide in `Document` from `context.call`
A write whose next text rulebook cannot compute, such as a NotebookEdit, a codex `apply_patch`, or an Edit whose `old_string` the file lacks, reaches the rule with no text and no lines. Only a `Document` visitor sees it, and its finding refuses the write whatever lines it changed.
Example:
```ts
export default defineRule({
  description: 'A reviewer never writes.',
  files: ['**', '@command'],
  create(context) {
    return {
      Document(document) {
        if (context.call?.agentType === 'reviewer' && context.call.agentId !== undefined) context.report({ node: document })
      },
    }
  },
})
```

IF several rules share code:
### Put the shared module beside the plugin folder and import it by relative path
rulebook loads every `.ts` file at any depth of a plugin folder as a rule, and a rule can import only `@cmodjs/rulebook` by package name.
Example: `rules/commands/block-git-stash.ts` imports `'../../lib/shell.ts'`, where `lib/` sits beside `rules/`.

## 6. Write an agentic rule when it takes judgment

An agentic rule's frontmatter takes `description`, `message`, `files`, `severity`, `runs`, `timeout`, `threshold`, and the Skill keys `agent`, `model`, `effort`, `allowed-tools`, and `disallowed-tools`. rulebook refuses any other key. Its body is the check. Each finding shows the text the subagent writes for it.

```md
---
description: Name code with code words, never Domain.md words.
model: haiku
effort: low
files:
  - "**/Claude.md"
---

A Domain.md word names the business, never code. Report each sentence that uses a Domain.md word to name a file, method, or class.
```

- rulebook runs each agentic rule with a Claude model the way Claude Code runs a forked Skill, in a subagent in the project, so it reads the project's Claude.md files.
- `agent` names the subagent type, `general-purpose` when it is left out. That agent's frontmatter applies: its tools, its model, and the Skills it preloads.
- A Claude `model`, `effort`, `allowed-tools`, and `disallowed-tools` work as in any Skill. No rule can edit a file.

IF one line shows the mistake by itself, such as a metaphor or a hedge:
### Run the rule on Jev with `model: jev`
`model: jev` runs the rule on Jev, TypeSafe's decision model, in under a second. rulebook asks Jev whether each line follows the rule, and flags each line it gives a probability below `threshold`, 0.7 by default, with the rule's message or description. Jev reads only the rule and the file, so a check that needs the project, such as a Fact the code contradicts, stays on Claude Code. A Jev rule takes no `agent`, `effort`, `allowed-tools`, or `disallowed-tools`, and runs only where `cmod secret store rulebook jev` stored a TypeSafe API key.
Example:
```md
---
description: Write literally, with no metaphors or idioms.
model: jev
threshold: 0.8
---

A line breaks the rule when it describes code with a metaphor or an idiom, such as code that "asks questions".
```

## 7. Set its severity and when it runs

Every kind of rule sets these keys at its top level:

- `severity` is `error`, the default, or `warn`.
- `runs` is `always`, the default, or `manual`. A manual rule never runs on an Agent's write or tool call. Every `rulebook check` runs it: a commit's `rulebook check --staged`, a full run, `/rulebook`, and CI.
- An error refuses a write or a commit only on a line it writes. An error on a line the file held before shows as a warning, unless the config sets `existingErrors: 'error'`. A finding on the `Document` always refuses.

### Give an agentic rule the time it needs with `timeout`
`timeout` is the milliseconds an agentic rule may take, the config's `timeout` by default, which is 30 000 unless the config sets it. Only an agentic rule has one, because the deadline stops only agentic sessions. rulebook refuses a `timeout` on a pattern or script rule.

The agentic rules of one file share one deadline, the longest `timeout` among them. Every agentic rule of a run starts at once, and the deadline starts with them. A rule still running at the deadline stops, and the edit lands with a note that names it.

IF an agentic rule takes longer than an edit can wait:
### Make it manual, and give it the timeout it needs
Measure one run on the largest file it covers, and set `timeout` well past that, with `runs: manual`.

## 8. Write a probe for the rule

A probe is a file the config's `probes` names, such as `probes/<name>.md`. Put each line the rule must flag under a pin, and add lines it must leave alone. A pattern rule's probe is a file in its language, such as `probes/block-console-log.ts`, and its pins are the same HTML comments.

```md
<!-- rulebook-expect global/block-hedging -->
The tests probably pass.

The tests pass.
```

A probe runs only the rules it pins. A pin works only in a probe file.

## 9. Run the rule

Run `rulebook inspect rules` and find the rule's name in it, with no failure beside it. Then run `rulebook check <probe>` and `rulebook check <a file the rule covers>`. A probe passes with no output above the count line. For a rule that covers a message, write a sample to a file and send it as stdin, such as `rulebook check --stdin-file-path=@command < sample.txt` for a sample that holds `herdr-app feedback hi`. It exits 1 and prints the refusal when the rule flags the sample.
