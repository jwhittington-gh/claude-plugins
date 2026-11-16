import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Queue, QueueItem, QueueMode, Shell, Step, StepStatus, Tab } from '../types'

type $T = EngineInterface

const PLUGIN = 'live-plan'
const PANE = 'live-plan'
const CLASSIFY_TOOL = 'queue_classify'
const CLASSIFY_FULL = `mcp__${PLUGIN}__${CLASSIFY_TOOL}`
const STEP_TOOL = 'step'
const STEP_FULL = `mcp__${PLUGIN}__${STEP_TOOL}`
const KEEP_DONE_SHELLS = 8
const TAIL_LINES = 12
const HISTORY_SIZE = 5

// Bump a shape when its value's fields change: an older stored value is then declined.
const steps = atom({ plugin: 'live-plan', key: 'steps' } as const, [] as Step[], { shape: 'steps-1' })
const shells = atom({ plugin: 'live-plan', key: 'shells' } as const, [] as Shell[], { shape: 'shells-1' })
const EMPTY_QUEUE: Queue = { items: [], nextId: 1, isPaused: false, isTurnRunning: false, bgTasks: [] }
const queue = atom({ plugin: 'live-plan', key: 'queue' } as const, EMPTY_QUEUE, { shape: 'queue-1' })
const tab = atom({ plugin: 'live-plan', key: 'tab' } as const, 'plan' as Tab)
const expandedShells = atom({ plugin: 'live-plan', key: 'expandedShells' } as const, [] as string[])

const PROMPT_SECTION = {
  id: `${PLUGIN}:progress`,
  scope: 'session',
  text: [
    '# Progress reporting (live-plan pane)',
    'The user watches a live pane of your plan and shells. Keep it accurate:',
    `- For work with 3+ steps, track steps with TaskCreate/TaskUpdate (or ${STEP_FULL} when TaskCreate is unavailable; same fields).`,
    '  With TaskCreate/TaskUpdate: Put a rough estimate in `metadata.eta_s` (seconds) on each step. Set status in_progress when you start a step and completed when it is done.',
    '- A step you discover mid-work is a new TaskCreate. If it belongs under an existing step, set `metadata.parent` to that task id.',
    '- If an estimate turns out wrong, update `metadata.eta_s` with TaskUpdate.',
    '- When a Bash command may take more than ~10s, end its `description` with an estimate such as `(~90s)` or `(~4m)`.',
    `- The user can queue follow-up tasks. When told of an unclassified queued task, call ${CLASSIFY_FULL}. Use while_waiting if it can safely run while background work is still in flight (independent of it and of the files you are changing). Use after_done if it depends on or conflicts with the current work. Do not start a queued task until it is handed to you as a prompt.`,
  ].join('\n'),
} as const

// ---------- helpers ----------

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** `(~90s)`, `~4m`, `(~1h)`, `(~2.5m)` at the end of a description. */
export function parseEtaHint(text: string | undefined): number | undefined {
  const m = /~\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)\)?\s*$/i.exec(text ?? '')
  if (!m) return undefined
  const n = Number(m[1])
  const unit = (m[2] ?? 's').toLowerCase()[0]
  return Math.round(unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n)
}

/** Key for duration history: first 3 non-flag tokens, env assignments and `cd x &&` dropped. */
export function commandKey(command: string): string {
  const last = command.split(/&&|;/).map(s => s.trim()).filter(Boolean).pop() ?? command
  const tokens = last
    .split(/\s+/)
    .filter(t => t && !/^[A-Z_][A-Z0-9_]*=/.test(t) && !t.startsWith('-'))
  return tokens.slice(0, 3).join(' ').slice(0, 120)
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** `12s`, `1m05s/~4m`, `5m10s +1m10s` (over its ETA). */
function compactTiming(startedAt: number, endedAt: number | undefined, etaSec: number | undefined, now: number): string {
  const elapsed = (endedAt ?? now) - startedAt
  if (endedAt !== undefined || !etaSec) return fmt(elapsed)
  const left = etaSec * 1000 - elapsed
  return left >= 0 ? `${fmt(elapsed)}/~${fmt(etaSec * 1000)}` : `${fmt(elapsed)} +${fmt(-left)}`
}

function wrapLines(text: string, width: number): string[] {
  const flat = text.replace(/\s*\n\s*/g, ' ')
  const w = Math.max(10, width)
  const out: string[] = []
  for (let i = 0; i < flat.length && out.length < 6; i += w) out.push(flat.slice(i, i + w))
  if (flat.length > w * 6) out[5] = clip(out[5] ?? '', w - 1) + '…'
  return out
}

function tailOf(text: string, n = TAIL_LINES): string[] {
  return text.replace(/\s+$/, '').split('\n').slice(-n).map(l => l.replace(/\t/g, '  '))
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text
}

function etaNum(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

function meta(input: { metadata?: unknown }): Record<string, unknown> {
  return input.metadata && typeof input.metadata === 'object'
    ? (input.metadata as Record<string, unknown>)
    : {}
}

// ---------- ticker: redraws countdowns, tails background output ----------

let ticker: Timer | undefined
let tickCount = 0

function ensureTicker($: $T) {
  if (ticker) return
  ticker = $.clock.every(1000, () => {
    void tick($)
  })
}

async function tick($: $T) {
  tickCount += 1
  const [shellList, stepList] = [await read($, shells), await read($, steps)]
  const running = shellList.filter(s => s.status === 'running')
  const isStepRunning = stepList.some(s => s.status === 'in_progress')

  if (running.length === 0 && !isStepRunning) {
    ticker?.cancel()
    ticker = undefined
    return
  }

  if (tickCount % 2 === 0) {
    for (const sh of running) {
      if (!sh.outputPath) continue
      let tail: string[]
      try {
        tail = tailOf(await $.fs.read(sh.outputPath))
      } catch {
        continue
      }
      if (tail.join('\n') !== sh.tail.join('\n')) {
        await update($, shells, list => list.map(s => (s.id === sh.id ? { ...s, tail } : s)))
      }
    }
  }
  $.ui.invalidate('ui.render')
}

// ---------- plan steps ----------

function isPlanMoving(list: Step[]): boolean {
  return list.some(s => s.status !== 'pending')
}

async function setStatus($: $T, id: string, status: StepStatus | 'deleted' | undefined, patch: Partial<Step>) {
  const now = await $.clock.now()
  await update($, steps, list => {
    if (status === 'deleted') return list.filter(s => s.id !== id && s.parentId !== id)
    return list.map(s => {
      if (s.id !== id) return s
      const next: Step = { ...s, ...patch }
      if (status && status !== s.status) {
        next.status = status
        if (status === 'in_progress') next.startedAt = now
        if (status === 'completed') next.doneAt = now
      }
      return next
    })
  })
  if (status === 'in_progress') ensureTicker($)
}

// ---------- queue ----------

function describeMode(item: QueueItem): string {
  const by = item.modeBy === 'user' ? ' (you)' : item.modeBy === 'agent' ? ' (agent)' : ''
  return item.mode === 'unclassified' ? 'unclassified' : `${item.mode.replace('_', ' ')}${by}`
}

function queueLines(q: Queue): string {
  const pending = q.items.filter(i => i.state !== 'done')
  if (pending.length === 0) return 'Queue is empty.'
  return [
    q.isPaused ? 'Queue is PAUSED (/queue resume).' : '',
    ...pending.map(i => `#${i.id} [${i.state}, ${describeMode(i)}] ${i.text}`),
  ]
    .filter(Boolean)
    .join('\n')
}

/** Hands the next eligible item to the agent as a prompt, or asks it to classify. */
async function tryDispatch($: $T) {
  const q = await read($, queue)
  if (q.isPaused || q.activeId !== undefined || q.isTurnRunning) return
  const pending = q.items.filter(i => i.state === 'pending')
  if (pending.length === 0) return

  const isWaiting = q.bgTasks.length > 0
  const item = isWaiting ? pending.find(i => i.mode === 'while_waiting') : pending[0]

  if (item) {
    await update($, queue, cur => ({
      ...cur,
      activeId: item.id,
      items: cur.items.map(i => (i.id === item.id ? { ...i, state: 'running' as const } : i)),
    }))
    const why = isWaiting ? ' Background work is still running; this task was judged safe to do meanwhile.' : ''
    void $.prompt.submit({
      text: `[Queued follow-up #${item.id}]${why}\n\n${item.text}`,
    })
    $.ui.toast(`live-plan: running queued #${item.id}`)
    return
  }

  // Waiting on async work and nothing is cleared to run: get the agent's verdict once per item.
  const toAsk = pending.filter(i => i.mode === 'unclassified' && !i.isAskedToClassify)
  if (toAsk.length === 0) return
  const ids = new Set(toAsk.map(i => i.id))
  await update($, queue, cur => ({
    ...cur,
    activeId: 0,
    items: cur.items.map(i => (ids.has(i.id) ? { ...i, isAskedToClassify: true, isAnnounced: true } : i)),
  }))
  void $.prompt.submit({
    text: [
      '[live-plan] You are idle but background work is still in flight. Classify these queued follow-ups with',
      `${CLASSIFY_FULL} (while_waiting = safe to do now, after_done = must wait). Do not start them; just classify and stop.`,
      ...toAsk.map(i => `#${i.id}: ${i.text}`),
    ].join('\n'),
  })
}

/** In-flight background work: our running background shells plus running subagents. */
async function refreshBackground($: $T) {
  const list = await read($, shells)
  const ids = list.filter(s => s.status === 'running' && s.bgTaskId).map(s => s.bgTaskId!)
  try {
    for (const a of await $.agent.list()) if (a.status === 'running' || a.status === 'pending') ids.push(a.id)
  } catch {
    // agent list unavailable; shells alone
  }
  await update($, queue, q => ({ ...q, bgTasks: ids }))
}

/** Marks background shells a task notification reports as ended. */
async function markEnded($: $T, raw: string) {
  if (!raw.includes('task-notification')) return
  const ended = new Map<string, string>()
  for (const m of raw.matchAll(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g)) {
    if (m[1] && m[2]) ended.set(m[1].trim(), m[2].trim())
  }
  if (ended.size === 0) return
  const now = await $.clock.now()
  await update($, shells, list =>
    list.map(s => {
      const st = s.bgTaskId ? ended.get(s.bgTaskId) : undefined
      if (!st || s.status !== 'running') return s
      const status: Shell['status'] = st === 'completed' ? 'done' : st === 'killed' ? 'killed' : 'failed'
      return { ...s, status, endedAt: now }
    }),
  )
  await refreshBackground($)
}

/** prompt.submit can't run inside the hook holding the turn (command.run, Stop): defer it. */
function scheduleDispatch($: $T) {
  $.clock.after(300, () => {
    void tryDispatch($)
  })
}

// ---------- register ----------

const DISABLED_KEY = 'pane-disabled'

export const register: Register = (on, options) => {
  const isAutoOpen = options.auto_open !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'plan-pane', description: 'Live plan pane: /plan-pane [close|off|on]' })
    await $.command.register({
      name: 'queue',
      description: 'Queue a follow-up task: /queue [--after-done|--while-waiting] <task> | list | drop <n> | clear | pause | resume',
    })
    await $.tool.register({
      name: STEP_TOOL,
      description:
        'Add or update a step in the live plan pane. Use when TaskCreate/TaskUpdate are unavailable. An unknown id creates the step.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Your id for the step, e.g. "1" or "1.a"' },
          subject: { type: 'string', description: 'Short title (required when creating)' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
          eta_s: { type: 'number', description: 'Rough estimate in seconds' },
          parent: { type: 'string', description: 'Parent step id, for a sub-step' },
        },
        required: ['id'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: CLASSIFY_TOOL,
      description:
        'Classify a task the user queued with /queue. while_waiting: safe to run while background work is still in flight. after_done: must wait until all current work, background included, is finished.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Queue item number (#n)' },
          mode: { type: 'string', enum: ['while_waiting', 'after_done'] },
          reason: { type: 'string', description: 'One short sentence' },
        },
        required: ['id', 'mode'],
      },
      isDeferred: false,
    })
    // A reload resets module variables; restart the countdown if something is live.
    const list = await read($, shells)
    if (list.some(s => s.status === 'running')) ensureTicker($)
    if (isAutoOpen && (await $.store.get(DISABLED_KEY)) !== true) void $.ui.open({ id: PANE, title: 'Live plan' })
    return next(e)
  })

  // `off` closes the pane and keeps it from opening in later sessions; tracking carries on.
  on('command.run', { command: 'plan-pane' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      await $.store.set(DISABLED_KEY, true)
      await $.ui.close({ id: PANE })
      return { text: 'Live plan pane off. It stays closed in new sessions; /plan-pane on to bring it back.' }
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Live plan pane closed. /plan-pane reopens it.' }
    }
    if (arg !== '' && arg !== 'on' && arg !== 'open') return { text: 'Usage: /plan-pane [close|off|on]' }
    await $.store.set(DISABLED_KEY, false)
    await $.ui.open({ id: PANE, title: 'Live plan', focus: true })
    return {
      text: isAutoOpen
        ? 'Live plan pane opened.'
        : 'Live plan pane opened. It will not open by itself: the plugin\'s auto_open setting is off.',
    }
  })

  on('command.run', { command: 'queue' }, async ($, e) => {
    const args = e.args.trim()
    const [verb, ...rest] = args.split(/\s+/)

    if (args === '' || verb === 'list') return { text: queueLines(await read($, queue)) }
    if (verb === 'clear') {
      await update($, queue, q => ({ ...q, items: q.items.filter(i => i.state === 'running') }))
      return { text: 'Cleared pending queued tasks.' }
    }
    if (verb === 'pause' || verb === 'resume') {
      await update($, queue, q => ({ ...q, isPaused: verb === 'pause' }))
      if (verb === 'resume') scheduleDispatch($)
      return { text: `Queue ${verb}d.` }
    }
    if (verb === 'drop') {
      const id = Number(rest[0]?.replace('#', ''))
      const q = await read($, queue)
      if (!q.items.some(i => i.id === id && i.state === 'pending')) return { text: `No pending item #${rest[0] ?? ''}.` }
      await update($, queue, cur => ({ ...cur, items: cur.items.filter(i => i.id !== id) }))
      return { text: `Dropped #${id}.` }
    }

    let mode: QueueMode = 'unclassified'
    let text = args
    const flag = /^--(after-done|while-waiting)\s+/.exec(text)
    if (flag) {
      mode = flag[1] === 'after-done' ? 'after_done' : 'while_waiting'
      text = text.slice(flag[0].length).trim()
    }
    if (!text) return { text: 'Nothing to queue.' }

    const now = await $.clock.now()
    let id = 0
    await update($, queue, q => {
      id = q.nextId
      const item: QueueItem = {
        id,
        text,
        mode,
        modeBy: mode === 'unclassified' ? undefined : 'user',
        addedAt: now,
        state: 'pending',
        isAnnounced: false,
        isAskedToClassify: false,
      }
      return { ...q, nextId: q.nextId + 1, items: [...q.items.filter(i => i.state !== 'done').slice(-50), item] }
    })
    scheduleDispatch($)
    return { text: `Queued #${id} (${mode.replace('_', ' ')}).` }
  })

  // prompt.compose is passed over by a security plugin above us, so the
  // instructions ride the first message's context (fresh conversations and
  // after compaction) and, for a conversation already under way, the next prompt.
  let isIntroduced = false

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    isIntroduced = true
    return { ...r, blocks: [...r.blocks.filter(b => b.name !== PLUGIN), { name: PLUGIN, text: PROMPT_SECTION.text }] }
  })

  on('prompt.submit', async ($, e, next) => {
    await markEnded($, e.text)
    if (isIntroduced) return next(e)
    isIntroduced = true
    return next({ ...e, context: [...(e.context ?? []), PROMPT_SECTION.text] })
  })

  // ----- turn lifecycle (main loop only) -----

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, queue, q => ({ ...q, isTurnRunning: true }))
    return next(e)
  })

  // classic.Stop is passed over by a security plugin above us, so turn.complete
  // ends a queued item and works out what background work is still in flight.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.isAborted) {
      // An interrupt pauses the queue and hands an in-flight item back as pending.
      await update($, queue, q => {
        const items = q.items.map(i => (i.id === q.activeId ? { ...i, state: 'pending' as const } : i))
        const hasPending = items.some(i => i.state === 'pending')
        return { ...q, items, activeId: undefined, isTurnRunning: false, isPaused: q.isPaused || hasPending }
      })
      if ((await read($, queue)).isPaused) $.ui.toast('live-plan: queue paused after interrupt (/queue resume)')
      return next(e)
    }
    await update($, queue, q => ({
      ...q,
      isTurnRunning: false,
      activeId: undefined,
      items: q.items.map(i => (i.id === q.activeId ? { ...i, state: 'done' as const } : i)),
    }))
    await refreshBackground($)
    scheduleDispatch($)
    return next(e)
  })

  // Background task notifications: rows (session.append) and, where a plugin
  // above passes that over, the notification's own submission (prompt.submit).
  on('session.append', async ($, e, next) => {
    await markEnded($, JSON.stringify(e.message ?? ''))
    return next(e)
  })

  // ----- plan steps -----

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const task = (ran.result as { task?: { id: string; subject: string } } | undefined)?.task
    if (!task) return ran
    const m = meta(e)
    await update($, steps, list => [
      ...list.filter(s => s.id !== task.id && s.source === 'task'),
      {
        id: task.id,
        subject: task.subject,
        status: 'pending' as const,
        parentId: m.parent !== undefined && m.parent !== null ? String(m.parent) : undefined,
        etaSec: etaNum(m.eta_s),
        isAddedLate: isPlanMoving(list),
        source: 'task' as const,
      },
    ])
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const m = meta(e)
    const patch: Partial<Step> = {}
    if (e.subject) patch.subject = e.subject
    if ('eta_s' in m) patch.etaSec = etaNum(m.eta_s)
    if ('parent' in m) patch.parentId = m.parent === null ? undefined : String(m.parent)
    await setStatus($, e.taskId, e.status, patch)
    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const now = await $.clock.now()
    await update($, steps, list => {
      const prev = new Map(list.filter(s => s.source === 'todo').map(s => [s.subject, s]))
      const moving = isPlanMoving(list)
      const todos: Step[] = e.todos.map((t, i) => {
        const old = prev.get(t.content)
        return {
          id: `todo-${i}`,
          subject: t.content,
          status: t.status,
          startedAt: t.status === 'in_progress' ? (old?.startedAt ?? now) : old?.startedAt,
          doneAt: t.status === 'completed' ? (old?.doneAt ?? now) : undefined,
          isAddedLate: old ? old.isAddedLate : moving && prev.size > 0,
          source: 'todo',
        }
      })
      return [...list.filter(s => s.source === 'task'), ...todos]
    })
    if (e.todos.some(t => t.status === 'in_progress')) ensureTicker($)
    return ran
  })

  on('tool.call', { tool: STEP_FULL }, async ($, e) => {
    const input = e as unknown as { id?: string; subject?: string; status?: string; eta_s?: number; parent?: string }
    const id = input.id === undefined ? '' : String(input.id)
    if (!id) return { result: 'Need id.' }
    const status = (['pending', 'in_progress', 'completed', 'deleted'] as const).find(v => v === input.status)
    const exists = (await read($, steps)).some(s => s.id === id)
    if (!exists) {
      if (!input.subject) return { result: `Step ${id} is new: give it a subject.` }
      await update($, steps, list => [
        ...list,
        {
          id,
          subject: input.subject!,
          status: 'pending' as const,
          parentId: input.parent ? String(input.parent) : undefined,
          etaSec: etaNum(input.eta_s),
          isAddedLate: isPlanMoving(list),
          source: 'task' as const,
        },
      ])
    }
    const patch: Partial<Step> = {}
    if (exists && input.subject) patch.subject = input.subject
    if (exists && input.eta_s !== undefined) patch.etaSec = etaNum(input.eta_s)
    if (exists && input.parent !== undefined) patch.parentId = input.parent ? String(input.parent) : undefined
    await setStatus($, id, status, patch)
    return { result: `Step ${id} ${exists ? 'updated' : 'added'}${status ? ` (${status})` : ''}.` }
  })

  // ----- shells -----

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const now = await $.clock.now()
    const id = e.tool_use_id ?? `sh-${now}`
    const key = commandKey(e.command)
    const hint = parseEtaHint(e.description)
    const history = ((await $.store.get(`eta:${key}`)) as number[] | undefined) ?? []
    const hist = median(history)
    const shell: Shell = {
      id,
      command: e.command,
      description: e.description ?? '',
      agentId: e.agentId,
      startedAt: now,
      etaSec: hint ?? (hist !== undefined && hist >= 3000 ? Math.round(hist / 1000) : undefined),
      etaSource: hint !== undefined ? 'hint' : hist !== undefined && hist >= 3000 ? 'history' : undefined,
      isBackground: false,
      tail: [],
      status: 'running',
    }
    await update($, shells, list => [...list, shell])
    ensureTicker($)

    const ran = await next(e)
    const end = await $.clock.now()
    const res = (ran.result ?? {}) as {
      stdout?: string
      stderr?: string
      interrupted?: boolean
      backgroundTaskId?: string
    }

    if (ran.deny === undefined && res.backgroundTaskId) {
      const outputPath = /(\/\S+?\.output)\b/.exec(ran.text ?? '')?.[1]
      await update($, shells, list =>
        list.map(s => (s.id === id ? { ...s, isBackground: true, bgTaskId: res.backgroundTaskId, outputPath } : s)),
      )
      return ran
    }

    const status: Shell['status'] =
      ran.deny !== undefined ? 'failed' : res.interrupted ? 'interrupted' : ran.isError ? 'failed' : 'done'
    const output = [res.stdout, res.stderr].filter(Boolean).join('\n') || (ran.deny ?? ran.text ?? '')
    await update($, shells, list => {
      const updated = list.map(s => (s.id === id ? { ...s, status, endedAt: end, tail: tailOf(output, 4) } : s))
      const live = updated.filter(s => s.status === 'running')
      const done = updated.filter(s => s.status !== 'running').slice(-KEEP_DONE_SHELLS)
      return [...done, ...live]
    })
    if (status === 'done') {
      await $.store.set(`eta:${key}`, [...history, end - now].slice(-HISTORY_SIZE))
    }
    return ran
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const taskId = e.task_id ?? e.shell_id
    if (ran.deny === undefined && taskId) {
      const now = await $.clock.now()
      await update($, shells, list =>
        list.map(s => (s.bgTaskId === taskId && s.status === 'running' ? { ...s, status: 'killed', endedAt: now } : s)),
      )
    }
    return ran
  })

  // ----- queue: agent classification + mid-turn announcements -----

  on('tool.call', { tool: CLASSIFY_FULL }, async ($, e) => {
    const input = e as unknown as { id?: number; mode?: string; reason?: string }
    const mode: QueueMode | undefined =
      input.mode === 'while_waiting' || input.mode === 'after_done' ? input.mode : undefined
    if (!mode || typeof input.id !== 'number') return { result: 'Need id (number) and mode (while_waiting | after_done).' }
    const q = await read($, queue)
    const item = q.items.find(i => i.id === input.id)
    if (!item) return { result: `No queued item #${input.id}.` }
    if (item.modeBy === 'user') return { result: `#${item.id} was set to ${item.mode} by the user; left as is.` }
    await update($, queue, cur => ({
      ...cur,
      items: cur.items.map(i => (i.id === item.id ? { ...i, mode, modeBy: 'agent' as const, reason: input.reason } : i)),
    }))
    return { result: `#${item.id} → ${mode}.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || e.tool === CLASSIFY_FULL || ran.deny !== undefined) return ran
    const q = await read($, queue)
    const fresh = q.items.filter(i => i.state === 'pending' && i.mode === 'unclassified' && !i.isAnnounced)
    if (fresh.length === 0) return ran
    const ids = new Set(fresh.map(i => i.id))
    await update($, queue, cur => ({
      ...cur,
      items: cur.items.map(i => (ids.has(i.id) ? { ...i, isAnnounced: true } : i)),
    }))
    const note = [
      `[live-plan] The user queued follow-up task(s) for after this work. Classify each with ${CLASSIFY_FULL}, then carry on with your current work:`,
      ...fresh.map(i => `#${i.id}: ${i.text}`),
    ].join('\n')
    return { ...ran, context: [...(ran.context ?? []), note] }
  })

  // ----- pane -----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns ?? 60)
    const [current, stepList, shellList, q, now] = [
      await read($, tab),
      await read($, steps),
      await read($, shells),
      await read($, queue),
      await $.clock.now(),
    ]
    const runningShells = shellList.filter(s => s.status === 'running').length
    const pendingQueue = q.items.filter(i => i.state !== 'done').length

    const tabs = (
      <Box flexDirection="row" gap={1}>
        <Button key="tab-plan" label={current === 'plan' ? '• Plan' : 'Plan'} onPress={() => update($, tab, () => 'plan')} />
        <Button
          key="tab-shells"
          label={`${current === 'shells' ? '• ' : ''}Shells (${runningShells})`}
          onPress={() => update($, tab, () => 'shells')}
        />
        <Button
          key="tab-queue"
          label={`${current === 'queue' ? '• ' : ''}Queue (${pendingQueue}${q.isPaused ? ' ⏸' : ''})`}
          onPress={() => update($, tab, () => 'queue')}
        />
        <Button key="close" label="✕ Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    const timing = (startedAt: number | undefined, endedAt: number | undefined, etaSec: number | undefined) => {
      if (startedAt === undefined) return etaSec ? `~${fmt(etaSec * 1000)}` : ''
      const elapsed = (endedAt ?? now) - startedAt
      if (endedAt !== undefined || !etaSec) return fmt(elapsed)
      const left = etaSec * 1000 - elapsed
      return left >= 0 ? `${fmt(elapsed)} · ~${fmt(left)} left` : `${fmt(elapsed)} · +${fmt(-left)} over`
    }

    let body
    if (current === 'plan') {
      const top = stepList.filter(s => !s.parentId || !stepList.some(p => p.id === s.parentId))
      const childrenOf = (id: string) => stepList.filter(s => s.parentId === id)
      const done = stepList.filter(s => s.status === 'completed').length
      const leftMs = stepList
        .filter(s => s.status !== 'completed' && s.etaSec)
        .reduce((sum, s) => sum + Math.max(0, s.etaSec! * 1000 - (s.startedAt ? now - s.startedAt : 0)), 0)
      const row = (s: Step, depth: number) => {
        const icon = s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '▶' : '○'
        const t = timing(s.startedAt, s.doneAt, s.etaSec)
        const label = `${'  '.repeat(depth)}${depth ? '└ ' : ''}${icon} ${s.subject}${s.isAddedLate ? ' +' : ''}`
        return (
          <Box flexDirection="row" justifyContent="space-between">
            <Text
              dimColor={s.status === 'completed'}
              bold={s.status === 'in_progress'}
              color={s.status === 'in_progress' ? 'cyan' : undefined}
            >
              {clip(label, width - t.length - 1)}
            </Text>
            <Text dimColor>{t}</Text>
          </Box>
        )
      }
      const walk = (s: Step, depth: number): ReturnType<typeof row>[] => [
        row(s, depth),
        ...childrenOf(s.id).flatMap(c => walk(c, depth + 1)),
      ]
      body =
        stepList.length === 0 ? (
          <Text dimColor>No plan steps yet.</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>
              {done}/{stepList.length} done{leftMs > 0 ? ` · ~${fmt(leftMs)} left` : ''} (+ = added mid-plan)
            </Text>
            {top.flatMap(s => walk(s, 0))}
          </Box>
        )
    } else if (current === 'shells') {
      const ordered = [...shellList.filter(s => s.status === 'running'), ...shellList.filter(s => s.status !== 'running').reverse()]
      const open = new Set(await read($, expandedShells))
      const toggle = (id: string) =>
        update($, expandedShells, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id].slice(-20)))
      body =
        ordered.length === 0 ? (
          <Text dimColor>No shell commands yet.</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>Click a row for details.</Text>
            {ordered.map(s => {
              const isLive = s.status === 'running'
              const isOpen = open.has(s.id)
              const icon = isLive ? '▶' : s.status === 'done' ? '✓' : s.status === 'killed' ? '■' : '✗'
              const t = compactTiming(s.startedAt, s.endedAt, isLive ? s.etaSec : undefined, now)
              const label = `${isOpen ? '▾' : '▸'} ${icon} ${s.isBackground ? 'bg ' : ''}${s.description || s.command}`
              const room = Math.max(8, width - t.length - 1)
              const color = s.status === 'failed' ? 'red' : isLive ? 'cyan' : undefined
              const facts = [
                s.isBackground ? `background ${s.bgTaskId ?? ''}`.trim() : 'foreground',
                s.agentId ? `subagent ${s.agentId}` : '',
                isLive && s.etaSec ? `ETA ~${fmt(s.etaSec * 1000)} from ${s.etaSource === 'history' ? 'past runs' : 'hint'}` : '',
                isLive ? '' : s.status,
              ].filter(Boolean)
              return (
                <Box flexDirection="column">
                  <Button key={`sh-${s.id}`} plain dimColor={!isLive} onPress={() => toggle(s.id)}>
                    <Text bold={isLive} color={color}>
                      {clip(label, room).padEnd(room)}
                    </Text>{' '}
                    <Text dimColor>{t}</Text>
                  </Button>
                  {isOpen && (
                    <Box flexDirection="column" marginLeft={4}>
                      {wrapLines(`$ ${s.command}`, width - 4).map(l => (
                        <Text dimColor>{l}</Text>
                      ))}
                      <Text dimColor>{clip(facts.join(' · '), width - 4)}</Text>
                      {isLive && !s.isBackground && <Text dimColor>(output shows when it finishes)</Text>}
                      {s.tail.map(l => (
                        <Text dimColor>{clip(`│ ${l}`, width - 4)}</Text>
                      ))}
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        )
    } else {
      const items = q.items.filter(i => i.state !== 'done')
      body = (
        <Box flexDirection="column">
          <Text dimColor>
            {q.isPaused ? 'PAUSED: /queue resume · ' : ''}
            {q.bgTasks.length ? `${q.bgTasks.length} background task(s) in flight` : 'no background work'}
          </Text>
          {items.length === 0 && <Text dimColor>Nothing queued. /queue {'<task>'}</Text>}
          {items.map(i => (
            <Box flexDirection="column">
              <Text bold={i.state === 'running'} color={i.state === 'running' ? 'cyan' : undefined}>
                {clip(`${i.state === 'running' ? '▶' : '○'} #${i.id} ${i.text}`, width)}
              </Text>
              <Text dimColor>{clip(`   ${describeMode(i)}${i.reason ? `: ${i.reason}` : ''}`, width)}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {tabs}
        {body}
      </Box>
    )
  })
}
