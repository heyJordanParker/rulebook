---
name: write-rule
description: Write or change a rulebook rule, a check rulebook runs on any file, agent reply, or tool call it covers, on every agent write and every commit. TRIGGER when asked to add, change, or test a rulebook rule, or to edit a rulebook.config.ts. DO NOT TRIGGER to fix a Prompt that a rulebook rule flagged; fix the Prompt.
---

# Write a rulebook rule

rulebook checks every file and message a rule's `paths` cover, on every Agent write and every commit. An error refuses the write or the commit, and a warning lets it land with a note. `rulebook check` in a terminal, or `/rulebook` in a session, checks every file of the project a rule covers, with every rule and the project's linters.

## 1. Find the config that holds the rule

- `~/.config/rulebook/rulebook.config.ts` holds the rules that apply to every project.
- The nearest `rulebook.config.ts` in a file's folder or a folder above it holds the rules of that folder's files, so a nested package holds its own. Only that one config applies to the file, merged over the global config.
- `extends` pulls in other configs: paths relative to the config, with `~` read as the home folder, and config objects such as `recommended` from `@cmodjs/rulebook`. The global config merges first, then each `extends` entry from left to right, then the config's own keys, so a later `rules` setting turns an inherited rule off or down.
- rulebook turns on no rule by itself. `extends: [recommended]` turns on `rulebook/imports`. `rules: { 'rulebook/no-suppressions': 'error' }` turns on the rule that flags a comment that suppresses a linter's rule, such as `// oxlint-disable-next-line` or `# noqa`. A Claude Code plugin's rules apply only when a config extends the plugin's `rulebook.config.ts`.
- `messages` tells rulebook where to find a message by itself: `tools` checks each matching tool call as `@<name>`, and `folder` makes a full run check each file under that folder as `@<name>/<path>`. A rule covers any `@` name without it.
- `plugins` names each rule folder. A rule is one file at any depth of that folder, and its name is `<plugin>/<path in the folder, without the extension>`: with `plugins: { global: './rules' }`, `rules/writing/block-em-dashes.ts` is `global/writing/block-em-dashes`.
- `paths` lists the Prompts, the files every rule without its own `paths` checks, relative to the config's folder, and `probes` the probe files. The global config's `paths` are relative to the project root.
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

## 3. Pick the fastest kind of rule that can catch the mistake

The file's extension picks the kind:

- `.yml` is a pattern rule, which matches the code's syntax tree with ast-grep
- `.ts` is a script rule, which runs your own TypeScript
- `.md` is an agentic rule, which runs a Claude Code subagent, or Jev with `model: jev`

A pattern or script rule checks a file in about a millisecond. A Jev rule takes under a second, and a Claude Code rule takes seconds to minutes, so write an agentic rule only when the check takes judgment.

IF the project's own linter can express the check:
### Add it to that linter's config instead of writing a rule
rulebook runs each linter a config's `linters` lists on every write with the project's config, and reports its findings as `<linter>/<rule>`, such as `mago/no-direct-db-query`. List the linter in the project's `rulebook.config.ts` when no config lists it yet. The linter's config stays the one place its rules live.

### Cover what the rule checks with `paths`
A rule without `paths` checks every Prompt, so a rule for code names its files. `paths` takes globs for any file, relative to the folder of the config whose `plugins` names the rule's folder, or to the project root for the global config, and messages named with `@`: `@reply` is the main Agent's final reply, and any other `@` path covers the message a mod checks by that name, such as `@inbox/**` for each inbox item. A glob that starts with `@` matches only a message, so `**` covers every file and no message.
Example: `paths: ['**', '@reply', '@inbox/**']`

## 4. Write a pattern rule when the code's shape decides

A pattern rule flags each match of its ast-grep rule, at the match's first line, with its description as the message. It never matches inside a comment or a string.

```yaml
description: Don't log to the console.
language: typescript
paths: ['**/*.ts']
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

A script rule returns each line it flags. A finding without a `message` shows the rule's description. `check` receives `root`, the project root's absolute path, `path`, the file's path from that root or its `@` name, `text`, and `lines`, so a rule can read other project files, ask git, or run a program. A rule on a tool call's message also gets the call's fields as `input`, such as a Bash call's `command`.

```ts
import { defineRule } from '@cmodjs/rulebook'

export default defineRule({
  description: "Don't write em dashes.",
  check: ({ lines }) =>
    lines.flatMap((text, index) => (text.includes('—') ? [{ line: index + 1, message: 'An em dash joins two ideas in one sentence. Split it into two sentences.' }] : [])),
})
```

## 6. Write an agentic rule when it takes judgment

An agentic rule's frontmatter is Claude Code's Skill frontmatter, without `name` and `context`, and rulebook's own keys sit under `metadata`. Its body is the check.

```md
---
description: Name code with code words, never Domain.md words.
model: haiku
effort: low
paths:
  - "**/Claude.md"
metadata:
  level: error
  runs: always
---

A Domain.md word names the business, never code. Report each sentence that uses a Domain.md word to name a file, method, or class.
```

- rulebook runs each agentic rule with a Claude model the way Claude Code runs a forked Skill, in a subagent in the project, so it reads the project's Claude.md files.
- `agent` names the subagent type, `general-purpose` when it is left out. That agent's frontmatter applies: its tools, its model, and the Skills it preloads.
- A Claude `model`, `effort`, `allowed-tools`, and `disallowed-tools` work as in any Skill. No rule can edit a file.

IF one line shows the mistake by itself, such as a metaphor or a hedge:
### Run the rule on Jev with `model: jev`
`model: jev` runs the rule on Jev, TypeSafe's decision model, in under a second. rulebook asks Jev whether each line follows the rule, and flags each line it gives a probability below `metadata.threshold`, 0.7 by default, with the description as the message. Jev reads only the rule and the file, so a check that needs the project, such as a Fact the code contradicts, stays on Claude Code. A Jev rule takes no `agent`, `effort`, `allowed-tools`, or `disallowed-tools`, and runs only where `cmod secret store rulebook jev` stored a TypeSafe API key.
Example:
```md
---
description: Write literally, with no metaphors or idioms.
model: jev
metadata:
  threshold: 0.8
---

A line breaks the rule when it describes code with a metaphor or an idiom, such as code that "asks questions".
```

## 7. Set its level and when it runs

A pattern or script rule sets these keys at its top level, and an agentic rule sets them under `metadata`:

- `level` is `error`, the default, or `warning`.
- `runs` is `always`, the default, `commit`, or `manual`. A commit rule never runs on an edit, only on a commit's `rulebook check --staged` and when someone runs `rulebook check` or `/rulebook`. A manual rule runs only when someone runs `rulebook check` or `/rulebook`.

### Give an agentic rule the time it needs with `metadata.timeout`
`timeout` is the milliseconds an agentic rule may take, the config's `timeout` by default, which is 30 000 unless the config sets it. Only an agentic rule has one, because the deadline stops only agentic sessions. rulebook refuses a `timeout` on a pattern or script rule.

The agentic rules of one file share one deadline, the longest `timeout` among them. Every agentic rule of a run starts at once, and the deadline starts with them. A rule still running at the deadline stops, and the edit lands with a note that names it.

IF an agentic rule takes longer than an edit can wait:
### Run it on commit, or make it manual, and give it the timeout it needs
Measure one run on the largest file it covers, and set `timeout` well past that. Use `runs: commit` when a commit can wait that long, and `runs: manual` when it cannot.

## 8. Write a probe for the rule

A probe is a file the config's `probes` names, such as `probes/<name>.md`. Put each line the rule must flag under a pin, and add lines it must leave alone. A pattern rule's probe is a file in its language, such as `probes/block-console-log.ts`, and its pins are the same HTML comments.

```md
<!-- rulebook-expect global/block-hedging -->
The tests probably pass.

The tests pass.
```

A probe runs only the rules it pins. A pin works only in a probe file.

## 9. Run the rule

Run `rulebook check <probe>` and `rulebook check <a Prompt the rule covers>`. A probe passes with no output above the count line. For a rule that covers a message, pipe a sample into `rulebook check --stdin-file-path=<@name>`, such as `printf 'Run it now.' | rulebook check --stdin-file-path=@reply`.
