import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { commandKey, parseEtaHint } from './register'

const PANE = {
  plugin: 'live-plan',
  component: 'Pane',
  requestId: 'live-plan',
  props: {
    title: 'Live plan',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

const opened: string[] = []
const closed: string[] = []

function engine(on: On) {
  opened.length = 0
  closed.length = 0
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__live-plan__${e.name}` } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('classic.Stop', () => ({}))
  return clock
}

test('eta hint and command key parsing', async () => {
  expect(parseEtaHint('Run tests (~90s)')).toBe(90)
  expect(parseEtaHint('Build ~4m')).toBe(240)
  expect(parseEtaHint('Deploy (~1.5h)')).toBe(5400)
  expect(parseEtaHint('List files')).toBe(undefined)
  expect(commandKey('cd foo && FOO=1 ./gradlew :svc:test --tests X')).toBe('./gradlew :svc:test X')
})

test('task calls fill the plan tab with nesting and ETAs', async ($, on) => {
  engine(on)
  let nextId = 1
  on('tool.call', (_, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(nextId++), subject: (e as { subject: string }).subject } } }
    return { result: { success: true } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.tool.call({ tool: 'TaskCreate', subject: 'Write code', description: 'x', metadata: { eta_s: 120 } })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Fix import', description: 'x', metadata: { parent: '1' } })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /▶ Write code/ }))?.text).toBe('▶ Write code')
    expect((await ui.find({ type: 'Text', text: /Fix import/ }))?.text).toBe('  └ ○ Fix import +')
    expect((await ui.find({ type: 'Text', text: /left$/ }))?.text).toMatch(/~2m00s left/)
    await ui.unmount()
  }
})

test('shells are one line each; clicking a row shows its details', async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: { stdout: 'line one\nok\n', stderr: '', interrupted: false } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'yarn test --watch=false', description: 'Run tests (~30s)' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-shells' })
    const row = await ui.find({ type: 'Text', text: /Run tests/ })
    expect(row?.text).toMatch(/^▸ ✓ Run tests \(~30s\)/)
    expect(await ui.find({ type: 'Text', text: /\$ yarn test/ })).toBe(undefined)

    const button = await ui.find({ type: 'Button', text: /Run tests/ })
    await ui.press({ key: button!.key! })
    expect((await ui.find({ type: 'Text', text: /\$ yarn test/ }))?.text).toBe('$ yarn test --watch=false')
    expect((await ui.find({ type: 'Text', text: /│ ok/ }))?.text).toBe('│ ok')
    expect((await ui.find({ type: 'Text', text: /foreground/ }))?.text).toBe('foreground · done')

    await ui.press({ key: button!.key! })
    expect(await ui.find({ type: 'Text', text: /\$ yarn test/ })).toBe(undefined)
    await ui.unmount()
  }
})

test('queue: waits on background work unless while_waiting, then runs in order', async ($, on) => {
  const submitted: string[] = []
  const clock = engine(on)
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash') return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: 'Output is being written to: /tmp/b1.output.' }
    return { result: 'ok' }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const endTurn = async () => {
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't' } as never)
    await clock.advance(500)
  }

  // A background shell is in flight when the turn ends.
  await $.tool.call({ tool: 'Bash', command: 'sleep 100', description: 'wait', run_in_background: true })
  await endTurn()

  // after_done waits; nothing goes out.
  await $.command.run({ command: 'queue', args: '--after-done write docs' } as never)
  await clock.advance(500)
  expect(submitted.length).toBe(0)

  // An unclassified item gets one classification turn.
  await $.command.run({ command: 'queue', args: 'lint the other module' } as never)
  await clock.advance(500)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toMatch(/Classify/)
  expect(submitted[0]).toMatch(/#2: lint the other module/)

  // Agent says while_waiting; that turn ends with bg still running, so #2 runs.
  await $.tool.call({ tool: 'mcp__live-plan__queue_classify', id: 2, mode: 'while_waiting', reason: 'independent' } as never)
  await endTurn()
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toMatch(/Queued follow-up #2/)

  // Background shell ends, #2's turn ends, so #1 runs.
  await $.tool.call({ tool: 'TaskStop', task_id: 'b1' })
  await endTurn()
  expect(submitted.length).toBe(3)
  expect(submitted[2]).toMatch(/Queued follow-up #1[\s\S]*write docs/)

  await endTurn()
  expect(submitted.length).toBe(3)
})

test('/plan-pane off closes the pane and keeps it closed next session; on reopens it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened.length).toBe(1)

  await $.command.run({ command: 'plan-pane', args: 'off' } as never)
  expect(closed).toEqual(['live-plan'])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened.length).toBe(1)

  await $.command.run({ command: 'plan-pane', args: 'on' } as never)
  expect(opened.length).toBe(2)
})

test('auto_open off: no pane at session start', { options: { auto_open: false } }, async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened.length).toBe(0)
})

test('close button and /plan-pane close close the pane for now; /plan-pane reopens it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  expect(closed).toEqual(['live-plan', 'live-plan'])

  await $.command.run({ command: 'plan-pane', args: 'close' } as never)
  expect(closed.length).toBe(3)

  // Closing doesn't disable: the next session still opens it.
  const before = opened.length
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened.length).toBe(before + 1)

  await $.command.run({ command: 'plan-pane', args: '' } as never)
  expect(opened.length).toBe(before + 2)
})
