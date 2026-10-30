export type SpendDraft = {
  isLoaded: boolean
  path: string
  /** Parsed file content, kept so unknown keys survive a save. */
  raw: Record<string, unknown>
  /** Selected segments. */
  segments: string[]
  /** Budget as typed. */
  budget: string
  /** Set while the file is malformed or the last save failed. */
  error?: string
  /** CLAUDE_MONTHLY_BUDGET is set and overrides the saved budget. */
  isBudgetOverridden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'spend-statusline': { draft: Shaped<SpendDraft> }
  }
}
