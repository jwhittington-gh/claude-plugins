import type { Elements, RenderChildren } from 'claude-code'

import type { SpendDraft } from '../types'
import { parseBudget } from './config'

// One option per line, every option a focusable Button: arrows/Tab walk the
// column in document order and Enter presses (a Button takes no Space).
// A section is a heading plus rows. Adding one (Breakdown, Extras) = one entry
// in SECTIONS, one field in SpendDraft/EMPTY/loadDraft/serialize.

export type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input'>
// `patch` updates the draft; `$` itself cannot be passed to a section (the engine refuses it).
export type Patch = (fn: (d: SpendDraft) => SpendDraft) => Promise<unknown>
export type Render = (ui: Ui, patch: Patch, state: SpendDraft) => RenderChildren
export type Section = { id: string; title: string; render: Render }

function toggles(ids: readonly string[]): Render {
  return ({ Box, Button }, patch, state) => (
    <Box flexDirection="column">
      {ids.map(id => (
        <Button
          key={`seg-${id}`}
          plain
          onPress={() =>
            patch(d => ({
              ...d,
              segments: d.segments.includes(id) ? d.segments.filter(s => s !== id) : [...d.segments, id],
            }))
          }
        >
          {state.segments.includes(id) ? '[x]' : '[ ]'} {id}
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
  { id: 'granularity', title: 'Granularity', render: toggles(['session', 'today', 'week', 'month']) },
  { id: 'stats', title: 'Spend stats', render: toggles(['avg', 'proj']) },
  { id: 'budget', title: 'Budget', render: budget },
]
