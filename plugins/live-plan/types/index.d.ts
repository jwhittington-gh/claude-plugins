export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type Step = {
  id: string
  subject: string
  status: StepStatus
  parentId?: string
  etaSec?: number
  startedAt?: number
  doneAt?: number
  /** Created after the plan had already started moving. */
  isAddedLate: boolean
  source: 'task' | 'todo'
}

export type ShellStatus = 'running' | 'done' | 'failed' | 'interrupted' | 'killed'

export type Shell = {
  id: string
  command: string
  description: string
  agentId?: string
  startedAt: number
  endedAt?: number
  etaSec?: number
  etaSource?: 'hint' | 'history'
  isBackground: boolean
  bgTaskId?: string
  outputPath?: string
  tail: string[]
  status: ShellStatus
}

export type QueueMode = 'unclassified' | 'after_done' | 'while_waiting'

export type QueueItem = {
  id: number
  text: string
  mode: QueueMode
  modeBy?: 'user' | 'agent'
  reason?: string
  addedAt: number
  state: 'pending' | 'running' | 'done'
  /** The agent has been told about it mid-turn. */
  isAnnounced: boolean
  /** A classification-only turn has already been spent on it. */
  isAskedToClassify: boolean
}

export type Queue = {
  items: QueueItem[]
  nextId: number
  isPaused: boolean
  /** Item whose turn is in flight; 0 = a classification turn. */
  activeId?: number
  isTurnRunning: boolean
  /** Background task ids from the last main-loop Stop. */
  bgTasks: string[]
}

export type Tab = 'plan' | 'shells' | 'queue'

declare module 'claude-code' {
  interface PluginState {
    'live-plan': {
      steps: Shaped<Step[]>
      shells: Shaped<Shell[]>
      queue: Shaped<Queue>
      tab: Tab
      expandedShells: string[]
    }
  }
}
