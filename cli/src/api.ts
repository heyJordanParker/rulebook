export type Level = 'error' | 'warning'

export type Runs = 'always' | 'manual'

export type PromptFile = {
  readonly path: string
  readonly text: string
  readonly lines: readonly string[]
}

export type Finding = {
  readonly line: number
  readonly message?: string
}

export type Rule = {
  readonly description: string
  readonly level?: Level
  readonly runs?: Runs
  readonly paths?: readonly string[]
  check(file: PromptFile): readonly Finding[] | Promise<readonly Finding[]>
}

export type RuleSettings = {
  readonly level?: Level | 'off'
  readonly runs?: Runs
  readonly paths?: readonly string[]
  readonly timeout?: number
  readonly agent?: string
  readonly model?: string
  readonly effort?: string
  readonly threshold?: number
}

export type LinterName = 'mago' | 'oxlint' | 'biome' | 'stylelint' | 'ruff' | 'selene' | 'shellcheck'

export type Config = {
  readonly extends?: readonly (string | Config)[]
  readonly plugins?: Readonly<Record<string, string>>
  readonly paths?: readonly string[]
  readonly probes?: readonly string[]
  readonly timeout?: number
  readonly existingErrors?: Level
  readonly rules?: Readonly<Record<string, Level | 'off' | RuleSettings>>
  readonly linters?: readonly LinterName[]
  readonly messages?: Readonly<Record<string, { readonly tools?: readonly string[]; readonly folder?: string }>>
}

export function defineRule(rule: Rule): Rule {
  return rule
}

export function defineConfig(config: Config): Config {
  return config
}

export const recommended = defineConfig({
  paths: ['**/{CLAUDE,Claude}.md', '**/{CLAUDE,Claude}.local.md', '**/AGENTS.md', '**/.claude/{rules,agents,commands,skills}/**/*.md'],
  rules: { 'rulebook/imports': 'error' },
})
