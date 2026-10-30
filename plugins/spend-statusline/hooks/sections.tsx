import type { Elements, RenderChildren } from 'claude-code'

import type { SpendDraft } from '../types'
import { PERIODS, parseBudget } from './config'

// A section is a heading plus rows. Adding one (Breakdown, Extras) = one entry
// in SECTIONS, one field in SpendDraft/EMPTY/loadDraft/serialize.

export type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input'>
// `patch` updates the draft; `$` itself cannot be passed to a section (the engine refuses it).
export type Patch = (fn: (d: SpendDraft) => SpendDraft) => Promise<unknown>
export type Render = (ui: Ui, patch: Patch, state: SpendDraft) => RenderChildren
export type Section = { id: string; title: string; render: Render }

function toggles(field: 'segments' | 'breakdown', ids: readonly string[], prefix: string): Render {
  return ({ Box, Button }, patch, state) => (
    <Box flexDirection="row">
      {ids.map(id => (
        <Button
          key={`${prefix}-${id}`}
          plain
          onPress={() =>
            patch(d => ({
              ...d,
              [field]: d[field].includes(id) ? d[field].filter(s => s !== id) : [...d[field], id],
            }))
          }
        >
          {state[field].includes(id) ? '[x]' : '[ ]'} {id}{'  '}
        </Button>
      ))}
    </Box>
  )
}

const budget: Render = ({ Box, Input, Text }, patch, state) => (
  <Box flexDirection="column">
    <Input
      key="budget"
      label="Monthly budget (USD) "
      value={state.budget}
      onInput={value => patch(d => ({ ...d, budget: value }))}
      onSubmit={value => patch(d => ({ ...d, budget: value }))}
    />
    {parseBudget(state.budget) === undefined && <Text color="red">Enter a positive number.</Text>}
    {state.isBudgetOverridden && <Text dimColor>CLAUDE_MONTHLY_BUDGET is set and overrides this value.</Text>}
  </Box>
)

export const SECTIONS: Section[] = [
  { id: 'granularity', title: 'Granularity', render: toggles('segments', ['session', 'today', 'week', 'month'], 'seg') },
  { id: 'stats', title: 'Spend stats', render: toggles('segments', ['avg', 'proj'], 'seg') },
  { id: 'breakdown', title: 'Spend breakdown (main/cold/agents per period; none = off)', render: toggles('breakdown', PERIODS, 'bd') },
  { id: 'budget', title: 'Budget', render: budget },
]
