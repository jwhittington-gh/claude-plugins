import type { SpendDraft } from '../types'

// Keep in sync with SEGMENTS and the budget default in statusline-cost.py.
export const SEGMENTS = ['session', 'today', 'week', 'month', 'avg', 'proj'] as const
export const DEFAULT_BUDGET = 1000

export const EMPTY: SpendDraft = {
  isLoaded: false,
  path: '',
  raw: {},
  segments: [...SEGMENTS],
  budget: String(DEFAULT_BUDGET),
  isBudgetOverridden: false,
}

type Engine = {
  fs: { read: (path: string) => Promise<string | { base64: string }>; write: (path: string, text: string) => Promise<void> }
  env: { get: (name: string) => Promise<string | undefined> }
}

/** CLAUDE_SPEND_CONFIG (with a leading ~ expanded), else ~/.claude/spend_statusline.json. */
export async function configPath($: Pick<Engine, 'env'>): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const custom = await $.env.get('CLAUDE_SPEND_CONFIG')
  if (custom) return custom.startsWith('~/') ? `${home}${custom.slice(1)}` : custom

  return `${home}/.claude/spend_statusline.json`
}

/** Same reading rules as load_config() and the segments/budget lookups in statusline-cost.py. */
export async function loadDraft($: Engine): Promise<SpendDraft> {
  const path = await configPath($)
  const isBudgetOverridden = Boolean(await $.env.get('CLAUDE_MONTHLY_BUDGET'))
  const base = { ...EMPTY, isLoaded: true, path, isBudgetOverridden }
  let text: string
  try {
    const read = await $.fs.read(path)
    text = typeof read === 'string' ? read : ''
  } catch {
    return base // missing file: defaults
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ...base, error: `${path} is not valid JSON; Save overwrites it.` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...base, error: `${path} is not a JSON object; Save overwrites it.` }
  }

  const raw = parsed as Record<string, unknown>
  const segments = Array.isArray(raw.segments)
    ? SEGMENTS.filter(s => (raw.segments as unknown[]).includes(s))
    : [...SEGMENTS]
  const budget = typeof raw.monthly_budget === 'number' && raw.monthly_budget > 0 ? String(raw.monthly_budget) : String(DEFAULT_BUDGET)

  return { ...base, raw, segments, budget }
}

export function parseBudget(text: string): number | undefined {
  const n = Number(text.trim())

  return text.trim() !== '' && Number.isFinite(n) && n > 0 ? n : undefined
}

/** Minimal JSON: defaults are omitted, unknown keys kept. */
export function serialize(draft: SpendDraft): string {
  const out: Record<string, unknown> = { ...draft.raw }
  const chosen = SEGMENTS.filter(s => draft.segments.includes(s))
  if (chosen.length === SEGMENTS.length) delete out.segments
  else out.segments = chosen

  const budget = parseBudget(draft.budget) ?? DEFAULT_BUDGET
  if (budget === DEFAULT_BUDGET) delete out.monthly_budget
  else out.monthly_budget = budget

  return `${JSON.stringify(out, null, 2)}\n`
}
