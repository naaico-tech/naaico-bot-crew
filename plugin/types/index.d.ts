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

export type ChatLine = {
  id: string
  role: 'you' | 'bot' | 'system'
  text: string
  /** A crew change the bot proposed, waiting for Apply or Discard while `pending`. */
  proposal?: { summary: string; state: string }
}

export type ChatView = {
  bot: string
  name: string
  status: 'idle' | 'queued' | 'thinking'
  lines: ChatLine[]
  /** Older messages not shown in the pane. */
  more: number
}

export type Snapshot = {
  bots: BotRow[]
  tasks: TaskRow[]
  approvals: ApprovalRow[]
  runner: 'running' | 'stopped'
  paused: boolean
  usage: string
  updatedAt: string
  /** The chat open in the pane, and unread replies per bot. */
  chat?: ChatView
  unread: Record<string, number>
  webLink: string
}

declare module 'claude-code' {
  interface PluginState {
    'office-hours': {
      snapshot: Snapshot
      /** The bot whose chat the pane shows. */
      chatBot: string
      tab: 'chat' | 'crew'
      /** Messages sent from the pane; part of the input's key, so the field clears after each send. */
      sent: number
    }
  }
}
