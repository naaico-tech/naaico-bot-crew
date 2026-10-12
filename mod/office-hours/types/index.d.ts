export type BotRow = {
  slug: string
  name: string
  model: string
  job: string
  isManager: boolean
  activity: string
}

export type TaskRow = {
  id: string
  title: string
  owner: string
  status: string
  updatedAt: string
  last: string
}

export type ApprovalRow = {
  id: string
  bot: string
  taskId: string
  summary: string
}

export type Snapshot = {
  bots: BotRow[]
  tasks: TaskRow[]
  approvals: ApprovalRow[]
  runner: 'running' | 'stopped'
  paused: boolean
  usage: string
  updatedAt: string
}

declare module 'claude-code' {
  interface PluginState {
    'office-hours': { snapshot: Snapshot }
  }
}
