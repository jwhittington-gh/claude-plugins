import type { CommandRunInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PATH = '/home/u/.claude/spend_statusline.json'
const PANE = {
  plugin: 'spend-statusline',
  component: 'Pane',
  requestId: 'spend-config',
  props: {
    title: 'Spend status line',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const FILE = JSON.stringify({ segments: ['session', 'proj'], monthly_budget: 500, extra: { keep: true } })

// Answers the engine beneath the plugin; returns the writes made.
function setup(on: Parameters<typeof mock.env>[0], file: string | undefined, env: Record<string, string> = {}) {
  const writes: { path: string; text: string }[] = []
  mock.env(on, { HOME: '/home/u', ...env })
  on('command.register', () => ({ value: { command: 'spend-config' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', () => {
    if (file === undefined) throw new Error('ENOENT')

    return { value: file }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })

    return { value: undefined }
  })

  return writes
}

async function open($: Engine, surface: 'terminal' | 'desktop') {
  await $.command.run({ command: 'spend-config', args: '' } as CommandRunInput)

  return $.ui.mount({ ...PANE, surface })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`prefill, toggle, budget, Save writes JSON and keeps unknown keys (${surface})`, async ($, on) => {
    const writes = setup(on, FILE)
    const ui = await open($, surface)

    expect((await ui.find({ key: 'seg-session' }))?.text).toMatch(/\[x\]/)
    expect((await ui.find({ key: 'seg-today' }))?.text).toMatch(/\[ \]/)
    expect((await ui.find({ key: 'budget' }))?.text).toBe('500')

    await ui.press({ key: 'seg-today' })
    await ui.press({ key: 'seg-session' })
    await ui.input({ key: 'budget', text: '750', kind: 'change' })
    await ui.press({ key: 'save' })

    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe(PATH)
    expect(JSON.parse(writes[0]?.text ?? '')).toEqual({
      segments: ['today', 'proj'],
      monthly_budget: 750,
      extra: { keep: true },
    })
  })

  test(`options form one vertical focus column, Save and Cancel last, no hotkeys (${surface})`, async ($, on) => {
    setup(on, FILE)
    const ui = await open($, surface)

    // Document order is the order arrows and Tab walk; no kit act moves the ring.
    const order = (await ui.findAll({})).filter(el => el.type === 'Button' || el.type === 'Input').map(el => el.key)
    expect(order).toEqual(['seg-session', 'seg-today', 'seg-week', 'seg-month', 'seg-avg', 'seg-proj', 'bd-session', 'bd-today', 'bd-week', 'bd-month', 'budget', 'save', 'cancel'])

    // A row Box holding two focusables is what broke Down; none may remain.
    const tree = JSON.stringify(await ui.drawn())
    expect(tree).not.toMatch(/"hotkey"/)
    expect(tree).not.toMatch(/"flexDirection":"row"/)
  })

  test(`Enter on a focused option is its press; Budget edit then Save (${surface})`, async ($, on) => {
    const writes = setup(on, FILE)
    const ui = await open($, surface)

    await ui.press({ key: 'seg-month' })
    await ui.input({ key: 'budget', text: 's', kind: 'change' })
    expect(writes).toHaveLength(0)
    await ui.input({ key: 'budget', text: '5', kind: 'change' })
    await ui.press({ key: 'save' })

    expect(JSON.parse(writes[0]?.text ?? '')).toEqual({
      segments: ['session', 'month', 'proj'],
      monthly_budget: 5,
      extra: { keep: true },
    })
  })

  test(`Cancel writes nothing (${surface})`, async ($, on) => {
    const writes = setup(on, FILE)
    const ui = await open($, surface)

    await ui.press({ key: 'seg-week' })
    await ui.press({ key: 'cancel' })

    expect(writes).toHaveLength(0)
  })
}

test('invalid budget blocks Save', async ($, on) => {
  const writes = setup(on, FILE)
  const ui = await open($, 'terminal')

  await ui.input({ key: 'budget', text: '-5', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /positive number/ })).toBeDefined()
  await ui.press({ key: 'save' })

  expect(writes).toHaveLength(0)
})

test('missing file shows defaults; Save writes minimal JSON', async ($, on) => {
  const writes = setup(on, undefined)
  const ui = await open($, 'terminal')

  expect((await ui.find({ key: 'budget' }))?.text).toBe('1000')
  await ui.press({ key: 'seg-avg' })
  await ui.press({ key: 'save' })

  expect(JSON.parse(writes[0]?.text ?? '')).toEqual({ segments: ['session', 'today', 'week', 'month', 'proj'] })
})

test('malformed file shows an error and is untouched until Save', async ($, on) => {
  const writes = setup(on, '{oops')
  const ui = await open($, 'terminal')

  expect(await ui.find({ type: 'Text', text: /not valid JSON/ })).toBeDefined()
  expect(writes).toHaveLength(0)
  await ui.press({ key: 'save' })

  expect(JSON.parse(writes[0]?.text ?? '')).toEqual({})
})

test('CLAUDE_SPEND_CONFIG sets the path', async ($, on) => {
  const writes = setup(on, FILE, { CLAUDE_SPEND_CONFIG: '~/alt.json' })
  const ui = await open($, 'terminal')

  await ui.press({ key: 'save' })

  expect(writes[0]?.path).toBe('/home/u/alt.json')
})

test('Breakdown: prefill, toggle, Save writes the breakdown key', async ($, on) => {
  const file = JSON.stringify({ breakdown: { enabled: true, periods: ['session', 'week'], keep: 1 } })
  const writes = setup(on, file)
  const ui = await open($, 'terminal')

  expect((await ui.find({ key: 'bd-session' }))?.text).toMatch(/\[x\]/)
  expect((await ui.find({ key: 'bd-today' }))?.text).toMatch(/\[ \]/)
  await ui.press({ key: 'bd-today' })
  await ui.press({ key: 'bd-session' })
  await ui.press({ key: 'save' })

  expect(JSON.parse(writes[0]?.text ?? '')).toEqual({ breakdown: { enabled: true, periods: ['today', 'week'], keep: 1 } })
})

test('Breakdown: all periods omit periods', async ($, on) => {
  const writes = setup(on, undefined)
  const ui = await open($, 'terminal')

  for (const p of ['session', 'today', 'week', 'month']) await ui.press({ key: `bd-${p}` })
  await ui.press({ key: 'save' })

  expect(JSON.parse(writes[0]?.text ?? '')).toEqual({ breakdown: { enabled: true } })
})

test('Breakdown: none selected disables', async ($, on) => {
  const writes = setup(on, JSON.stringify({ breakdown: { enabled: true } }))
  const ui = await open($, 'terminal')

  for (const p of ['session', 'today', 'week', 'month']) await ui.press({ key: `bd-${p}` })
  await ui.press({ key: 'save' })

  expect(JSON.parse(writes[0]?.text ?? '')).toEqual({ breakdown: { enabled: false } })
})

test('Breakdown: disabled file shows none selected; untouched default writes no breakdown key', async ($, on) => {
  const writes = setup(on, JSON.stringify({ monthly_budget: 500 }))
  const ui = await open($, 'terminal')

  expect((await ui.find({ key: 'bd-session' }))?.text).toMatch(/\[ \]/)
  await ui.press({ key: 'save' })
  expect(JSON.parse(writes[0]?.text ?? '')).toEqual({ monthly_budget: 500 })
})
