# Changelog

What changed in each version of rulebook, for the people who use it. cmod publish releases the section for the version, and Settings shows it.

## [0.10.1]

### Fixed
- A write is still checked when the session that runs the rulebook server ends mid-check. The mod sends the check once more, to the server's new copy, where before the write landed unchecked.
- An agentic rule starts when many files are checked at once. rulebook passes the rule's Skill to `claude -p` as its prompt, where before Claude Code stopped waiting for stdin after 3 s and the rule did not run.
- The README no longer promises that a commit or a push runs the `manual` rules. Every `rulebook check` runs them, and `--skip` picks the rules each place leaves out.

### Changed
- The mod bundles `@cmodjs/core` 8.3.1.

## [0.10.0]

### Added
- A rule's `severity` can be `ask`. An `ask` finding on an agent's write or tool call makes Claude Code ask you before the call runs, with the finding as the reason, the way Claude Code's own `ask` permission does. A commit, `rulebook check`, and a reply have nobody to ask, so there `ask` refuses as an error does. `rulebook claude-hook` answers it with `permissionDecision: ask`.
- Every kind of rule takes `metadata`, a map of any keys, such as `{ mode: 'propose' }`. rulebook never reads it and passes it to other mods with the rule. `rulebook inspect rules` lists each rule's `severity` and `metadata`.
- The rulebook mod provides the cmod interface `rulebook/Rules` in each session. Another mod lists the rules of a folder with `rules(folder)`. Its `beforeCheck` listener answers rule settings before each check of an agent's write, tool call, or reply, and rulebook merges them over your configs for that one check. So a mod such as Modes can run only the rules of the mode each agent is in.

### Changed
- The mod bundles `@cmodjs/core` 8.0.0 and needs cmod 8.0.0 or later. `/rulebook` shows its results as a view beside the session.
- The mod declares `"approve": true`, which asking you before a call needs. Anthropic's plugin directory does not list a mod that can approve a call.

## [0.9.0]

### Added
- A script rule reads the file before the write as `context.previous`, the text on disk before an edit and the `HEAD` text in a commit, in the shape of `context.sourceCode`. It is absent for a new file and in a full `rulebook check`. So a rule about the whole file, such as a length cap, refuses only a write that makes the file worse, and a file that already breaks it can still be shortened or reverted.
- A probe pin with nothing after it but blank lines expects its rule to flag the whole file, so a probe proves a rule that reports `context.sourceCode.ast`.

## [0.8.0]

### Added
- A script rule reads the file's syntax tree as `context.sourceCode.ast`, parsed by its extension in TypeScript, TSX, JavaScript, HTML, CSS, PHP, Python, Bash, Lua, JSON, YAML, TOML, Markdown, or Rust, so one rule can tell a call from a string that names it, in every language at once.
- A visitor named for a node kind, such as `call_expression`, runs for each node of that kind in file order, and never runs in a language that lacks the kind. A visitor that names no node kind of any language stops the rule with an error that names it.
- `context.report({ loc: { start: { line, column } } })` flags any line, as in ESLint.
- Pattern rules and script rules read Rust.

### Changed
- A script rule reads the file the way an ESLint rule does. Change each rule:
  - `context.text` and `context.lines` are `context.sourceCode.text` and `context.sourceCode.lines`, and each line is its text.
  - A `Line(line)` visitor is a loop over `context.sourceCode.lines` inside `create` that reports `{ loc: { start: { line: index + 1, column } } }`. `isInCodeBlock` is gone: find a Markdown file's code blocks with `context.sourceCode.ast.findAll({ rule: { kind: 'fenced_code_block' } })`.
  - A `Document(document)` visitor is a check inside `create` that reports `{ node: context.sourceCode.ast }`, which refuses a write whatever lines it changed.
  - `context.commands` and `context.shell` are `context.sourceCode.ast`, a `Shell` with `commands`, `reads`, `writes`, `fetches`, and `isFullyParsed`, in a `@command`. The `Command` visitor is unchanged.
  - `context.path` is `context.filename`, the file's absolute path or its `@` name.

## [0.7.0]

### Added
- A `Command` knows its `runner`, the index of the command that runs it, such as `sudo`, `xargs`, `find -exec`, or `bash -c`. It is absent for a command the shell runs itself, `$(…)` and `( … )` included, so a rule tells `rm x` from `sudo rm x`.

## [0.6.0]

### Added
- rulebook checks every shell command an agent runs, on Claude Code and on codex, as `@command`. A rule visits each program the command runs as a `Command`, with its `program`, `args`, and `folder`, even inside `sudo`, `env`, `bash -c`, `$(…)`, or a pipe, so it never parses the command text itself.
- A script rule reads the tool call it checks as `context.call`: the tool, its input, its folder, and the session and agent that make it, so a rule can refuse a write by one agent and allow it for another.
- rulebook checks NotebookEdit calls as it checks Edit, Write, and MultiEdit, and codex's `apply_patch` calls through `rulebook claude-hook`. A write whose result rulebook cannot compute, such as an Edit whose `old_string` the file does not hold, is checked with no text, so a rule that reads `context.call` judges every write.
- A rule's `Line` knows `isInCodeBlock`, so a prose rule leaves Markdown code blocks alone.

### Changed
- A script rule is laid out as an ESLint rule. `create(context)` returns a visitor for each kind of node it checks, `Document`, `Line`, or `Command`, and a visitor flags a node with `context.report({ node })`. Change each rule:
  - `check: ({ lines }) => lines.flatMap(…)` is `create(context) { return { Line(line) { if (…) context.report({ node: line }) } } }`.
  - A finding's `message` moves to the rule's one `message`, and a rule without one shows its `description`. A rule that needs two messages is two rules.
- The keys are ESLint's:
  - a rule's and a config's `paths` is `files`
  - `level` is `severity`, and `'warning'` is `'warn'`, in a rule, a config's `rules` setting, and `existingErrors`
  - an agentic rule's `metadata` keys sit at the top of its frontmatter
- `runs` is `always` or `manual`. `runs: 'commit'` is gone: an agent's write runs only the `always` rules, and every `rulebook check`, `--staged` included, runs both, so a slow rule runs `manual` and a pre-commit hook or CI runs it.

## [0.5.0]

### Changed
- rulebook's commands and flags are Biome's, so `rulebook check` works the way `biome check` does. Change each call:
  - `rulebook [files...]` is `rulebook check [files...]`.
  - `rulebook commit` is `rulebook check --staged`, so a pre-commit hook runs `exec rulebook check --staged`.
  - `rulebook text <@name>` is `rulebook check --stdin-file-path=<@name>`. It prints the refusal or the note an agent reads and exits 1 on a refusal, and a path that names a file checks stdin as the text that file will hold.
  - `--json` is `--reporter=json`. A full, staged, and stdin check each print `{ reports, failures }`.
  - `--static` is `--skip=agentic`. `--skip` also skips a rule, every rule of a plugin or rule folder, or a linter, and repeats.
  - `rulebook rules` is `rulebook inspect rules`.
  - `rulebook hook` is `rulebook claude-hook`, so change the command in `.claude/settings.json`.
- `rulebook edit` is gone. `rulebook claude-hook` checks the same Edit, Write, and MultiEdit calls.
- The mod starts its server as `rulebook __run_server`, which the help leaves out, as Biome leaves out its own.

## [0.4.0]

### Added
- `rulebook commit` checks every commit as the git pre-commit hook. It reads each staged file from the staging area, checks it against its committed text the way an edit is checked, and refuses the commit only for an error on a line the commit wrote, so another agent's unstaged work and errors already in a file never refuse it.
- The project's linters check the whole commit: each listed linter that covers a staged or deleted file runs over a copy of the commit's tree and of `HEAD`'s tree, and the commit is refused for each error it adds, such as a type error in a caller the commit never touched.
- `runs: commit` runs a rule on every commit and every full run, never on an edit, for a check too slow for every write.
- `linters: ['pint']` runs Laravel Pint on every PHP write without touching the project folder, and names each fixer Pint would apply.
- `linters: ['tsc']` type-checks the whole project with `tsc -b --noEmit` on every commit and full run.
- A script rule's `check` receives `root`, the project root's absolute path, so it can read other project files, ask git about uncommitted work, or run a program, as a git hook can.
- Biome checks what `biome check` checks: formatting, as `biome/format` on the first line Biome would change, and assists such as `biome/assist/source/organizeImports`, beside its lint rules. Biome's config turns each one off.
- `programs` names the command that runs a linter, such as `{ mago: ['bun', 'scripts/mago.ts'] }`, so a project's own wrapper can set the linter's arguments and environment, or build what it reads first.
- `rulebook hook` checks the tool calls of every Claude Code session in a project from its `.claude/settings.json`, with no cmod: it refuses an Edit, Write, MultiEdit, or message tool call a rule's error flags.
- A script rule gets a tool call's fields one by one as `input`, such as a Bash call's `command`.
- `rulebook commit` runs a linter when the commit changes only its config or a baseline its config names.
- Mago covers the extensions `mago.toml` lists in `source.extensions`, such as `.phtml`, as well as `.php`.
- oxlint reads `oxlint.config.ts`, `oxlint.config.mts`, and `.oxlintrc.jsonc` as well as `.oxlintrc.json`.

### Changed
- rulebook checks any file a rule covers, code as much as docs. A script rule's `check` now receives a `CheckedFile`, the type `PromptFile` was.
- `mago analyze` runs only over the whole project, on a commit and a full run, as `tsc` does. A PHP write runs `mago lint` alone, so it no longer waits on a whole-program analysis, which took 37 to 105 s on one write in a large project.

- A rule with no `paths`, in a project whose configs list no `paths`, is named as a rule that checks no file in `rulebook rules`, a full run, and a commit, instead of checking nothing silently.
- A whole-project linter failure reads `tsc did not run: ...`, without `on .`.
- The README opens with a project setup for code rules, linters, and the commit hook, kept in a `.githooks` folder the repository holds.

### Fixed
- `existingErrors: 'error'` refuses a commit for an error a staged file already had, as it refuses an edit.
- A Mago issue at or above the `minimum-fail-level` of `mago.toml`'s `[linter]` or `[analyzer]` is an error, so rulebook refuses what `mago` itself fails on. Every Mago level below `error` was a warning before.
- A project with Mago extensions gets Mago's findings. rulebook read each finding's file from a field extension findings leave out, so every such run failed with "mago did not run".

## [0.3.0]

### Added
- An agentic rule with `model: jev` runs on Jev, TypeSafe's decision model, instead of Claude Code. Jev answers in under a second, where a Claude Code subagent takes seconds to minutes. On a 7-line file, a metaphor rule took 0.8 s on Jev and 13.0 s on Claude Code's `haiku`, and both flagged the same lines. A line passes when Jev gives it a probability of following the rule of at least `metadata.threshold`, 0.7 unless the rule or a config sets it. A config's `model` setting moves any agentic rule to Jev or back. A Jev rule reads your TypeSafe API key from rulebook's cmod secret, which `cmod secret store rulebook jev` stores from stdin.

### Changed
- The mod bundles `@cmodjs/core` 6.0.2 and needs cmod 6.0.0 or later.

## [0.2.5]

### Changed
- `npm install @cmodjs/rulebook` installs the newest version again. A rerun of the 0.2.3 release published 0.2.3 after 0.2.4, and npm tagged it `latest`. A release run for an older version than the one on `main` now releases nothing.

## [0.2.4]

### Changed
- The mod bundles `@cmodjs/core` 5.13.1 and needs cmod 5.13.1 or later, so a busy session start no longer runs a rulebook check past the 10 seconds Claude Code gives a hook.

## [0.2.3]

### Changed
- A rule file that fails to load shows one warning toast, in the first session that loads the rules after it broke, whatever number of sessions and projects you run. It shows again only once a load found it fixed and it broke again. Before, every session showed it once, so 30 sessions showed it 30 times, each at a time no one could predict.
- A rule or linter that did not run on a write goes to the Log in cmod's Settings as a warning, beside the note the agent reads. Before, it showed a warning toast in each session it happened in.
- After a rulebook config or rule file changes, a session loads the rules again at its next check, instead of every open session asking `rulebook serve` at the same moment.
- The `rules` answer of `rulebook serve` lists each failure only the first time, until a listing of the same project no longer holds it. `rulebook rules` still lists every failure.
- The mod bundles `@cmodjs/core` 5.13.0 and needs cmod 5.13.0 or later, so a session start that cmod answers late is a warning in the Log, never an error.
- Each push to `main` with a new version releases the mod and the `rulebook` programs on GitHub, and publishes `@cmodjs/rulebook` to npm, from GitHub Actions.

## [0.2.2]

### Changed
- `recommended` makes every CLAUDE.md, CLAUDE.local.md, AGENTS.md, and `.claude/` rule, agent, command, and Skill file a Prompt, so a config that only extends `recommended` checks them. Before, it checked nothing until a config listed `paths`.
- Each rulebook warning, such as a rule that fails to load or a linter that did not run, shows once per session. Before, it showed again each time the rules reloaded and on every write it touched.
- Two builds of one checkout at once no longer fail each other.
- The README starts with an install section and a quick start that reaches a first refused write, and says what rulebook runs and what leaves your machine.
- The released programs no longer hold the folder they were built in.
- `rulebook --help` lists `--version`.

## [0.2.1]

### Changed
- A rule file that fails to load, such as one without a `description`, checks nothing, and every other rule keeps checking. Each session shows its failure once, as a warning, and a full `rulebook` run lists it and exits 1. Before, one broken rule failed every check in every session that loaded it.
- The mod bundles `@cmodjs/core` 5.11.0.

## [0.2.0]

### Changed
- plint is now rulebook. The program is `rulebook`, the package is `@cmodjs/rulebook`, the slash command is `/rulebook`, and the repository is `heyJordanParker/rulebook`.
- The configs are `~/.config/rulebook/rulebook.config.ts` and a project's `rulebook.config.ts`, and a probe pin is `rulebook-expect`. rulebook reads no `plint.config.ts` and no `plint-expect` pin, so rename yours.
- A rule is one file, at any depth of its rule folder, and its path is its name: `rules/writing/block-em-dashes.ts` is `global/writing/block-em-dashes`. A config setting or a probe pin that names a moved rule's old name fails and names it.
- An agentic rule is one `.md` file named for the rule, holding what its `SKILL.md` held without `name` and `context`. Move each `<name>/SKILL.md` to `<name>.md` and remove those two keys.
- Every rule has a one-line `description`, the Rule in plain words, such as "Don't write em dashes." A rule without one fails to load.
- `runs` is `always` or `manual`, in rules and in config settings. Change each `runs: edit` to `runs: always`.
- The config's `timeout` replaces `editTimeout` and is every agentic rule's default, 30 000 ms. An agentic rule's `metadata.timeout`, or a config setting for one agentic rule, sets its own. The agentic rules of one file share one deadline, the longest `timeout` among them, which starts when they start. Every agentic rule of a run starts at once. A `rulebook` run no longer gives every agentic rule 10 minutes, so give a slow manual rule the `timeout` it needs.
- A rule's `paths` decide what it checks: any file, not only a Prompt. A rule without `paths` still checks every Prompt. An edit to any file a rule covers is checked, and a full run checks each file a rule covers, except a binary file.
- A refusal names what it refused, never the program: `Edit to <path> refused.`, or the message, such as `Reply refused.` or `Inbox refused.`. Each finding quotes the line it flags.
- `rulebook edit` answers `failures` and `findings` every time, and `{ failures: [], findings: [] }` for a file no rule covers.
- The `rulebook/imports` message names the missing file, and the line it quotes shows the import.
- An edit's refusal or note lists only the findings on lines the edit wrote, by a line diff of the file before and after, so a written line counts even when the same text sits elsewhere in the file. The findings already in the file collapse into one line, such as "183 more warnings in this file were there before this edit. `rulebook palette.mjs` lists them." An edit that adds and removes more than 1,000 lines in all counts every line as written, so a rewrite of a large file answers in a fraction of a second.
- The count line says "in N files", in the terminal and in the Sidebar, because a run counts every file a rule covers.
- Each file is checked with the global config and the nearest `rulebook.config.ts` in its folder or a folder above it, the way ESLint 10 and oxlint find theirs, so a nested package holds its own config. Only that one project config applies to the file. A full run checks each file with its own nearest config.
- rulebook turns on no rule by itself. `rulebook/imports` runs only when a config extends `recommended`, so add `extends: [recommended]` to your global config to keep your Claude.md imports checked.
- A config's `paths`, and its rules' `paths`, are relative to the config's folder. The global config's paths, and those of a config outside the project, stay relative to the project root.
- `rulebook rules` lists the rules of each folder that holds a `rulebook.config.ts`, and the mod shows each file the rules of its nearest folder.
- A full run lints a file outside every linter config folder with the linter's own defaults, as an edit does, and lints each file only with the linters its own configs list.
- Every session's checks go to one `rulebook serve` on the computer, which keeps each project's configs, rules, and parsers loaded, so a write, a turn-end reply check, and a checked tool call each take a fraction of what a fresh `rulebook` process takes. A changed config or rule file applies to the next check, and so does a plugin folder or `extends` file a config names, once it appears or is fixed, so a config that failed on a missing or broken one answers again. A server that is down fails each check with an error toast.
- A write's Stylelint check runs Stylelint in process, with the same findings its command line gives. A Stylelint failure now reads as its message, with no stack trace.
- A later `rules` setting merges over an earlier one key by key, as ESLint merges its rule settings, and a level written as a string sets only `level`. A project's `'warning'` keeps the `runs` or `paths` the global config gave the rule.
- A script rule with a key rulebook does not read, such as a misspelled `levle`, fails to load and names the key.
- A rule that reads `text` of a Claude.md flags the same line as one that reads `lines`, because `text` keeps a blank line for each line Claude Code removes.
- A write through a symlinked folder, such as `~/.claude/rules`, is checked as a write to the file the link reaches.
- A probe skips each pin of a rule the run leaves out, such as a `runs: manual` rule's pin in an edit or a `--static` run. A pin that names no rule still fails.
- A config, rule, or `extends` file that does not parse fails and names the file.

### Added
- Messages: a rule covers the agent's final reply with `@reply`, and any message a mod checks by name, such as `@inbox/**` for each item the inbox checks with `rulebook text`, with no config naming the mod. A config's `messages` let rulebook find a message by itself: `tools` checks each matching tool call as `@<name>`, and `folder` makes a full run check each file under that folder as `@<name>/<path>`. A glob that starts with `@` matches only a message, so `**` never covers one.
- `rulebook text <@name>` checks the message on stdin and answers as `rulebook edit` does. A full run also checks each file in every message `folder`.
- `extends` in a config pulls in other configs: paths relative to the config, with `~` read as the home folder, and config objects from packages, such as `recommended` from `@cmodjs/rulebook`. The global config merges first, then each `extends` entry from left to right, then the config's own keys, and a later `rules` setting turns an inherited rule off or down. An `extends` path that names no file fails and names it. A Claude Code plugin's rules, and the tool calls and folders its `messages` name, apply only when a config extends its `rulebook.config.ts`.
- A finding without a `message` shows its rule's description.
- Agents read each rule's description before they can break it. A rule whose `paths` cover every file (`**`) or a message (a path that starts with `@`) reaches every agent as its session starts, after each compaction, and as each subagent starts. A rule for some files, and a rule with no `paths`, reaches an agent with its first read or write of a file it covers. Each agent reads each description once per context.
- `rulebook rules` prints each rule that is on, with its id, description, and the paths it covers, and each registered message with the tools that send it, as JSON.
- `rulebook serve` answers `edit`, `text`, and `rules` as `POST /edit`, `/text`, and `/rules` on a Unix socket, with the JSON the commands print, and prints `unix:<socket path>` first.
- The main agent's final reply is checked before its turn ends. An error keeps the agent from stopping once per turn, and it writes the whole reply again. A rewrite that still breaks a rule ends the turn, and its findings show as a warning toast. A subagent's answer is never checked.
- A tool call that a config's `messages` `tools` match, by any agent, is checked as that message before it runs, with the text of every field it sends. An error refuses the call.
- Pattern rules: a `.yml` rule matches files with an ast-grep rule, in TypeScript, TSX, JavaScript, HTML, CSS, PHP, Python, Bash, Lua, JSON, YAML, TOML, or Markdown, and flags each match at its first line.
- Linters: `linters: ['oxlint', 'biome']` in any config runs those linters on every write, on the text it will leave, before it lands, with the project's own config and baseline: Mago (`mago.toml`, lint and analyze), oxlint (`.oxlintrc.json`), Biome (`biome.json`, lint only), Stylelint (`stylelint.config.*` or `.stylelintrc*`), ruff (`ruff.toml` or `[tool.ruff]`), selene (`selene.toml`), and shellcheck on every shell script. A linter no config lists never runs, and the lists of every config add up. A listed linter with no config file of its own runs with its own defaults, so a linter the global config lists runs in every project.
- Every finding a linter reports joins the same answer as `<linter>/<rule>`: an error refuses the write, and everything else, such as Mago's notes and help and shellcheck's info and style, is a warning. An error on a line already in the file is a warning too. The config's `timeout` also bounds each linter run.
- rulebook brings its own oxlint 1.86.0, Biome 2.6.4, and Stylelint 17.15.0, built into the program, and runs the project's own copy in `node_modules` when it has one. Mago, ruff, selene, and shellcheck run from the project's copy or `PATH`, and a missing program lands the write with a note that names it.
- A full `rulebook` run runs each listed linter once over its project and lists its findings with the rest.
- `rulebook/no-suppressions` bans the comments that silence a linter's rule: `oxlint-disable` and its `eslint-disable` forms, `biome-ignore`, `@mago-expect` and `@mago-ignore`, ruff's `noqa`, `shellcheck disable=`, `stylelint-disable`, and `selene: allow(`. It is off until a config turns it on with `rules: { 'rulebook/no-suppressions': 'error' }`, and it checks every file with an extension a linter covers or with no extension. A suppression already in the file is an existing finding.

## [0.1.0]

### Added
- Every Edit, Write, and MultiEdit of a Prompt, by any agent or subagent, is checked before it runs. An error refuses the edit with the rule, the line, and the fix. A warning lets the edit land with a note.
- Static rules as TypeScript files, and agentic rules as Skills that run the way Claude Code runs any forked Skill, with their `agent`'s tools, model, and preloaded Skills.
- The `@cmodjs/plint` package, which gives a project the rule and config types and the `plint` command.
- `~/.config/plint/plint.config.ts` for rules that apply to every project, and a project's `plint.config.ts` for its own rules and levels.
- `metadata.runs: manual` keeps a slow rule off edits. `plint` in a terminal and `/plint` in a session run every rule.
- Probes with `plint-expect` pins prove each rule still flags what it should, and nothing else.
- The write-rule Skill, which teaches Claude to write a rule and its probe.
