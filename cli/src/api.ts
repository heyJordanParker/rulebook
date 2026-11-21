import type { SgNode } from '@ast-grep/napi'

export type Severity = 'error' | 'warn' | 'ask'

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

export type { SgNode }

export type Document = { readonly text: string }

export type Command = {
  readonly lineNumber: number
  readonly program: string
  readonly args: readonly string[]
  readonly argv: readonly [string, ...string[]]
  readonly folder: string
  readonly input?: number
  readonly runner?: number
}

export type Shell = {
  readonly commands: readonly Command[]
  readonly reads: readonly string[]
  readonly writes: readonly string[]
  readonly fetches: readonly string[]
  readonly isFullyParsed: boolean
}

export type Node = SgNode | Command | Shell | Document

export type SourceCode = {
  readonly text: string
  readonly lines: readonly string[]
  readonly ast: SgNode | Shell | Document
}

export type Position = { readonly line: number; readonly column: number }

export type Problem = { readonly node: Node } | { readonly loc: { readonly start: Position; readonly end?: Position } }

export type Context = {
  readonly root: string
  readonly filename: string
  readonly sourceCode: SourceCode
  readonly previous?: SourceCode
  readonly call?: Call
  report(problem: Problem): void
}

export type Visitors = {
  readonly Command?: (command: Command) => void | Promise<void>
  readonly [kind: string]: ((node: SgNode) => void | Promise<void>) | ((command: Command) => void | Promise<void>) | undefined
}

export type Rule = {
  readonly description: string
  readonly message?: string
  readonly files?: readonly string[]
  readonly severity?: Severity
  readonly runs?: Runs
  readonly metadata?: Readonly<Record<string, unknown>>
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
  readonly existingErrors?: 'error' | 'warn'
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
