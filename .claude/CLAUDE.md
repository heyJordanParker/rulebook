# rulebook

You write a rule once, and no Agent's work breaks it again. Every decision passes three tests:

- **Agents know the rules before they write.** An Agent sees every rule that covers the file, reply, or inbox item it is about to write.
- **Every write is checked before it lands, as fast as possible.** A broken rule refuses the write with the flagged line, and the fastest check that can catch a mistake catches it.
- **A rule graduates from narrow to broad.** A rule starts in the narrowest scope that needs it and moves broader once it proves true there, so no project learns the same lesson twice.

# Facts

## The mod and the server
- `node_modules/@cmodjs/core/docs/` documents the installed cmod, from `index.md`. Read it before cmod work, because training data is out of date.
- The repository root is the mod, `src/mod.tsx`. It only relays each `edit`, `text`, or `rules` question to the server, so every lint behavior lives in `cli/src/`.
- The mod runs `rulebook __run_server` with `singleInstance: true` and asks `ready()` before each question, because the one copy moves when the session that started it ends. It sends its session's `env -0` with each question, because the server has the environment of whichever session started it.
- The server answers in worker threads, one per project root and `ENVIRONMENT` values, so no project's configs answer for another. A worker stops after 15 idle minutes, as eslint_d does.
- After each answer a worker names every path its state read. Before each question the server stats them and replaces the worker when one appeared, went away, or changed since it started, because a process cannot unload a module. `readPaths` holds failed tries too, because `loadSettings` caches a failed load.
- A worker caches the imported set, because `git ls-files` took seconds in large repositories. A checked write to a Claude.md or rules file joins `watchImportSource`, so the worker is replaced after the write lands, never before.
- `Bun.spawn` and `Bun.which` read the process's environment, not a worker's, so every spawn passes `process.env`. Bun 1.4.4 closes a quiet request after 10 s, so `serve.ts` casts its options to pass `idleTimeout: 0`.
- `sessions.current.beforeTurnEnd` hears only the main agent and has no `answer` yet, so the mod checks the turn's last `Reply`, once per turn through `memory.refusedTurn`.
- The mod lists the rules once per session and drops the listing when `fs.onChange` sees its `sources` change, because asking at the change made every session ask at once. It tests files and tool names in process, against regular expressions from `globRegExp`, because Claude Code's hooks loader runs only relative ES modules and picomatch is CommonJS. `memory.shown` holds what each Agent has read, reset at its start and compaction.
- The mod provides `rulebook/Rules`, typed in `types/index.d.ts`, and asks `Check` before each `edit` and `text` question, which carries the answers as `rules` for `withSeverities`. `providers()` lists nothing during `setup`.
- cmod's `beforeToolCall` cannot ask, and Claude Code runs `tool.check` after PreToolUse, so the mod keeps an `ask` answer by `callId` for `beforePermissionCheck`, which needs `registerPermissionCheck` and `"approve": true`.

## Checks
- The command line copies Biome's: `rulebook check` and its flags, `rulebook inspect rules`, `rulebook claude-hook` named for its protocol, and a hidden `rulebook __run_server`. `claude-hook` runs in a fresh process with no server: an error exits 2 on stderr, an ask is `permissionDecision: ask`, and a warning is `additionalContext`.
- An `ask` finding asks only in a check with a `call`, and is an `error` in any other.
- `cli/tests/ask.ts` answers a question in a fresh process, so the tests compare the server's answers with it.
- `inScope` drops `runs: manual` rules only from an Agent's write or tool call, as pre-commit's `manual` stage does.
- A Claude.md, or a file one imports, reaches a rule as Claude Code reads it, with a blank line for each hidden line. `linesWritten` diffs whole lines with `diffArrays` and counts every line written past 1,000 changed lines, because the diff's cost grows with length times change. A finding on any other line is existing.
- `context.previous` is the disk text before an edit, or the `HEAD` text in a commit, in the same Claude.md view, and absent for a new file and in a full run. A finding on the root is `isWhole` and never existing, so a rule about the whole file compares with `previous`. A probe pin with only blank lines after it matches only an `isWhole` finding.
- A write whose text `editedText` cannot compute is checked with no text, so only a rule that reads `context.call` and reports the root flags it.
- A tool call's message is every string field of its input joined by blank lines. `@command` is only the command, and its `ast` is a `Shell` from `parseShell` of `@cmodjs/core`, because the ast-grep bash tree missed `sudo`, `bash -c`, and full paths.
- A message's name, such as `@reply`, never reaches the disk, and only a glob that starts with `@` matches one.
- `rulebook check --staged` checks each staged file against its `HEAD` text. Linters lint the whole project instead, because a change can break a file it never touched: on a `git archive` of the staged tree and, only when that has an error, on `HEAD`'s, one after the other because runs share a cache folder. It refuses each error only the staged tree has, matched by file, rule, message, and count.
- The copies link each ignored dependency folder a linter's `copies` names and Mago's `source.includes`, and no other ignored file, because a generated file holds uncommitted work. A linter that fails on `HEAD` turns its errors into warnings. A staged change to a linter's `configs` or `inputs` runs it too.

## Rules and configs
- `cli/` is the program and the npm package `@cmodjs/rulebook`. `cli/src/api.ts` is its Public API, which `cli/src/modules.ts` serves at runtime, because a rule folder has no `node_modules`.
- `loadSettings` merges `BUILT_IN`, the global config, and the nearest `rulebook.config.ts` walking up to the filesystem root, as ESLint 10 does, flattening `extends` left to right. It reads no Claude Code plugin's config.
- A config's globs are relative to its folder, and `rootRelative` rewrites them to the project root at load.
- `rulebook/imports` and `rulebook/no-suppressions` are built in and `off` until a config sets them. `SUPPRESSIONS` needs one entry per `LinterName`, so a new linter fails the type check until it adds its own.
- `loadRules` skips a rule file that fails, and only the `rules` listing and a full run report it, once across all sessions, because reporting it on every check flooded each session.
- A script rule is an ESLint 9.7 rule. `visited` runs its visitors from one ast-grep `findAll`, because visiting every node took 45 times as long, so it offers no selectors or `:exit` visitors. `unknownKinds` fails a visitor that names no node kind.
- An agentic rule runs as the one Skill of a temporary plugin through `claude -p` with hooks off, so its `agent`'s frontmatter applies and the mod never runs again inside it.
- `model: jev` runs a rule on TypeSafe's Jev through `runJev`, one `noul` question per line, flagged below `threshold`. It sends windows of `WINDOW` characters, because Jev refused 1,100 lines at once. TypeSafe refuses the alias `jev`, so it sends `jev-latest`. The key is the cmod secret `jev`.
- `cli/src/claude-md.ts` reads Claude.md files, rules folders, and imports the way Claude Code 2.1.317 does, with `marked` pinned at Claude Code's 15.0.0, because 15.0.12 and later lex images and loose lists differently. It alone reads `CLAUDE_CONFIG_DIR`.

## Linters
- `cli/src/linters.ts` owns every linter. A linter runs only when a config's `linters` lists it. A full run lints from each outermost config folder and keeps findings only for files whose configs list that linter.
- `programOf` runs the project's own copy first. oxlint, Biome, and Stylelint ship inside rulebook, and the rest fall back to `PATH`. Pint is Composer's `laravel/pint`, never Homebrew's `pint`.
- `mago analyze` and `tsc` run only over the whole project, because one analyzed write took up to 105 s.
- oxlint has no stdin, and Biome's stdin lint prints nothing, so `cli/src/lsp.ts` reads both from their language servers. A write also runs `biome format` and flags the first changed line, because Biome's server skips formatting, and `assist/` findings are errors, because the server reports an unsorted import as information where `biome check` fails.
- oxlint and Stylelint run under rulebook's own Bun, because oxlint starts several times faster than under Node. oxlint's napi and Biome's JS API ignore config files on disk, so both start per write.
- Linter output goes to temp files, because Bun leaves a child's stdout non-blocking and oxlint's writer stopped halfway. Biome's socket path must stay under 104 bytes, so test homes live under `/tmp`.

## Build and release
- `cli/build.ts` compiles each of `CMOD_MACHINES` with every parser and linter embedded, rewrites embedded paths to `/$bunfs/root/` so no build folder leaks, packs linters with the system `tar`, because `Bun.Archive` writes every mode as 644 and Biome then cannot run, and turns off `autoloadDotenv` so a project's `.env` cannot move the config folder. A compiled program embeds the worker at `src/worker.js`, so `serve.ts` starts `./src/worker.ts` there.
- `.claude-plugin/plugin.json` and `cli/package.json` carry one version. Raising both and pushing to `main` releases through `.github/workflows/release.yml`, to cmod and npm.
- `bun test` in the root runs every test. `bun run check` in `cli/` type-checks, after `cmod check` in a fresh clone. `cmod link` loads this checkout and builds `rulebook` into cmod's programs folder.
