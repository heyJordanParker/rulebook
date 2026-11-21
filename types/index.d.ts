export type RuleSeverity = 'error' | 'warn' | 'ask'

export type ListedRule = {
  readonly id: string
  readonly description: string
  readonly severity: RuleSeverity
  readonly metadata: Readonly<Record<string, unknown>>
}

export type RulebookCheck = {
  readonly path: string
  readonly session: string
  readonly task?: string
  readonly agentType?: string
  readonly tool?: string
  readonly rules: readonly ListedRule[]
}

export type RulebookCheckAnswer = { readonly rules: Readonly<Record<string, RuleSeverity | 'off'>> }

declare module 'claude-code' {
  interface CmodInterfaces {
    'rulebook/Rules': {
      methods: { rules(folder: string): readonly ListedRule[] }
      events: { Check: RulebookCheck }
    }
  }
}
