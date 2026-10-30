import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { SpendDraft } from '../types'
import { EMPTY, loadDraft, parseBudget, serialize } from './config'
import { SECTIONS, type Ui } from './sections'

const PANE = 'spend-config'
const draft = atom({ plugin: 'spend-statusline', key: 'draft' } as const, EMPTY, { shape: 'draft-1' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'spend-config',
      description: 'Edit spend status line settings (segments, monthly budget) in a pane',
    })

    return next(e)
  })

  on('command.run', { command: 'spend-config' }, async $ => {
    const loaded = await loadDraft($)
    await update($, draft, () => loaded)
    await $.ui.open({ id: PANE, title: 'Spend status line', focus: true, closeOnEscape: true })

    return { text: 'Spend status line settings opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Mobile has no Input; the pane is for terminal and desktop.
    const ui = $.ui.resolve(e) as Ui
    const { Box, Text, Button } = ui
    const state = await read($, draft)
    const patch = (fn: (d: SpendDraft) => SpendDraft) => update($, draft, fn)
    const close = () => $.ui.close({ id: PANE })
    const save = async () => {
      const current = await read($, draft)
      if (parseBudget(current.budget) === undefined) return
      try {
        await $.fs.write(current.path, serialize(current))
      } catch (err) {
        await update($, draft, d => ({ ...d, error: `Could not write ${d.path}.` }))
        return
      }
      $.ui.toast(`Saved ${current.path}`)
      await close()
    }

    return (
      <Box flexDirection="column">
        {state.error && <Text color="red">{state.error}</Text>}
        {SECTIONS.map(section => (
          <Box key={`section-${section.id}`} flexDirection="column" marginBottom={1}>
            <Text bold>{section.title}</Text>
            {section.render(ui, patch, state)}
          </Box>
        ))}
        <Box flexDirection="row">
          <Button key="save" variant="primary" hotkey="s" onPress={save}>Save</Button>
          <Text> </Text>
          <Button key="cancel" role="dismiss" hotkey="c" onPress={close}>Cancel</Button>
        </Box>
      </Box>
    )
  })
}
