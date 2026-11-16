export type Severity = 'error' | 'warn'

export type Runs = 'always' | 'manual'

export type Call = {
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
  readonly cwd: string
  readonly session?: string
  readonly agentType?: string
  readonly agentId?: string
  readonly transcriptPath?: string
}

export type Document = { readonly lineNumber: 1; readonly text: string }

export type Line = { readonly lineNumber: number; readonly text: string; readonly isInCodeBlock: boolean }

export type Command = {
  readonly lineNumber: number
  readonly program: string
  readonly args: readonly string[]
  readonly argv: readonly [string, ...string[]]
  readonly folder: string
  readonly input?: number
}

export type Shell = {
  readonly reads: readonly string[]
  readonly writes: readonly string[]
  readonly fetches: readonly string[]
  readonly isFullyParsed: boolean
}

export type Node = Document | Line | Command

export type Context = {
  readonly root: string
  readonly path: string
  readonly text: string
  readonly lines: readonly Line[]
  readonly commands: readonly Command[]
  readonly shell?: Shell
  readonly call?: Call
  report(finding: { readonly node: Node }): void
}

export type Visitors = {
  readonly Document?: (document: Document) => void | Promise<void>
  readonly Line?: (line: Line) => void | Promise<void>
  readonly Command?: (command: Command) => void | Promise<void>
}

export type Rule = {
  readonly description: string
  readonly message?: string
  readonly files?: readonly string[]
  readonly severity?: Severity
  readonly runs?: Runs
  create(context: Context): Visitors | Promise<Visitors>
}

export type RuleSettings = {
  readonly severity?: Severity | 'off'
  readonly runs?: Runs
  readonly files?: readonly string[]
  readonly timeout?: number
  readonly agent?: string
  readonly model?: string
  readonly effort?: string
  readonly threshold?: number
}

export type LinterName = 'mago' | 'oxlint' | 'biome' | 'stylelint' | 'ruff' | 'selene' | 'shellcheck' | 'pint' | 'tsc'

export type Config = {
  readonly extends?: readonly (string | Config)[]
  readonly plugins?: Readonly<Record<string, string>>
  readonly files?: readonly string[]
  readonly probes?: readonly string[]
  readonly timeout?: number
  readonly existingErrors?: Severity
  readonly rules?: Readonly<Record<string, Severity | 'off' | RuleSettings>>
  readonly linters?: readonly LinterName[]
  readonly programs?: Readonly<Partial<Record<LinterName, readonly string[]>>>
  readonly messages?: Readonly<Record<string, { readonly tools?: readonly string[]; readonly folder?: string }>>
}

export function defineRule(rule: Rule): Rule {
  return rule
}

export function defineConfig(config: Config): Config {
  return config
}

export const recommended = defineConfig({
  files: ['**/{CLAUDE,Claude}.md', '**/{CLAUDE,Claude}.local.md', '**/AGENTS.md', '**/.claude/{rules,agents,commands,skills}/**/*.md'],
  rules: { 'rulebook/imports': 'error' },
})
