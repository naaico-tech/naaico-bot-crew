// Shared logic for the bot crew: data shapes, the file store, delegation
// policy, task transitions, @mentions, schedules and approval classification.
// Pure TypeScript with no Node imports, so the runner (Node) and the Claude
// Code mod (its own sandbox) can both use it through the Fs adapter.

export type ModelName = 'opus' | 'sonnet' | 'haiku' | 'fable'

// What the runner passes to `claude --model`: aliases, so each bot gets the
// newest model of its tier that the installed CLI knows.
export const MODEL_IDS: Record<ModelName, string> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  fable: 'fable',
}

// Tier names: the exact model is whatever the installed CLI maps the alias
// to, and each run records it in the task history.
export const MODEL_LABELS: Record<ModelName, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** Every bot thinks at medium effort unless the user picks another level for it. */
export const DEFAULT_EFFORT: Effort = 'medium'

export function parseEffort(s: unknown): Effort | undefined {
  const v = String(s ?? '').trim().toLowerCase()
  return (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : undefined
}

export type Bot = {
  slug: string
  name: string
  job: string
  model: ModelName
  effort?: Effort
  tools: string[]
  canHandTo: string[]
  workdir?: string
  isManager?: boolean
  instructions?: string
}

export type TaskStatus =
  | 'queued'
  | 'working'
  | 'waiting'
  | 'needs_approval'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled'

export type TaskEvent = { at: string; actor: string; kind: string; text: string }

export type Task = {
  id: string
  title: string
  body: string
  owner: string
  status: TaskStatus
  createdBy: string
  createdAt: string
  updatedAt: string
  parentId?: string
  children: string[]
  depth: number
  handoffs: number
  model?: ModelName
  cwd?: string
  history: TaskEvent[]
  result?: string
  costUsd: number
  runs: number
  /** Bots that handed this task over, most recent last: a finished task goes back to each in turn. */
  returnTo?: string[]
  /** The bot the user (or a routine) first asked; the final answer is posted in its chat. */
  askedBot?: string
}

export type Approval = {
  id: string
  taskId: string
  bot: string
  tool: string
  input: unknown
  summary: string
  status: 'pending' | 'allowed' | 'denied'
  always?: boolean
  reason?: string
  createdAt: string
  decidedAt?: string
}

export type Config = {
  delegation: 'manager' | 'list' | 'free'
  approvals: 'auto' | 'ask' | 'strict'
  managerSlug: string
  maxHandoffs: number
  maxDepth: number
  concurrency: number
  limits: UsageLimits
  runTimeoutMin: number
  approvalTimeoutMin: number
  settingSources: string
  allow: Record<string, string[]>
  paused: boolean
  /** Claude Code starts the runner when a session opens; `/bot stop` turns this off. */
  autoStart?: boolean
}

export type Routine = {
  id: string
  bot: string
  title: string
  prompt: string
  schedule: string
  paused: boolean
  createdAt: string
  lastRunAt?: string
}

export type RunnerState = { pid: number; startedAt: string; heartbeat: string; running: string[] }

export const DEFAULT_CONFIG: Config = {
  delegation: 'manager',
  approvals: 'auto',
  managerSlug: 'manager',
  maxHandoffs: 8,
  maxDepth: 3,
  concurrency: 2,
  limits: { fiveHourPct: 50, weeklyPct: 50, perRunPct: 10 },
  runTimeoutMin: 240,
  approvalTimeoutMin: 120,
  settingSources: 'project',
  allow: {},
  paused: false,
}

export const TERMINAL: readonly TaskStatus[] = ['done', 'failed', 'cancelled']

// ---------- plan usage limits ----------

/**
 * Caps on the user's own plan windows, in percent used: the crew starts no work
 * once the 5-hour or weekly window reaches its cap, so the rest stays free for
 * the user's own Claude use. perRunPct caps how much of the 5-hour window one
 * run may use.
 */
export type UsageLimits = { fiveHourPct: number; weeklyPct: number; perRunPct: number }

export type UsageWindow = { percent: number; resetsAt: string }

/** The plan's rate-limit windows as Claude Code last reported them. */
export type UsageWindows = {
  fiveHour?: UsageWindow
  weekly?: UsageWindow
  status?: string
  observedAt: string
  source: string
}

/** Safety net only: no single run may pass this API-equivalent cost, whatever the windows say. */
export const RUNAWAY_USD = 5

function toIso(v: unknown): string | undefined {
  if (typeof v === 'number') return new Date(v * (v < 1e12 ? 1000 : 1)).toISOString()
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString()
  return undefined
}

function windowFrom(w: unknown): UsageWindow | undefined {
  const o = w as { utilization?: number; percentUsed?: number; resetsAt?: unknown } | undefined
  if (!o) return undefined
  const percent = typeof o.percentUsed === 'number' ? o.percentUsed : typeof o.utilization === 'number' ? o.utilization * 100 : undefined
  const resetsAt = toIso(o.resetsAt)
  if (percent === undefined || !resetsAt) return undefined
  return { percent: Math.round(percent * 10) / 10, resetsAt }
}

/** Reads a `rate_limit_event` line of `claude -p --output-format stream-json`. */
export function windowsFromStreamEvent(e: unknown, at: string): UsageWindows | undefined {
  const info = (e as { type?: string; rate_limit_info?: { status?: string; unifiedWindows?: Record<string, unknown> } })
  if (info?.type !== 'rate_limit_event' || !info.rate_limit_info) return undefined
  const w = info.rate_limit_info.unifiedWindows ?? {}
  const out: UsageWindows = { fiveHour: windowFrom(w.five_hour), weekly: windowFrom(w.seven_day), status: info.rate_limit_info.status, observedAt: at, source: 'runner' }
  return out.fiveHour || out.weekly ? out : undefined
}

/** Reads Claude Code's own session figures (`$.session.usage().rateLimits`). */
export function windowsFromSession(rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[], at: string): UsageWindows | undefined {
  const find = (k: string) => windowFrom(rateLimits.find(r => r.kind === k))
  const out: UsageWindows = { fiveHour: find('five_hour'), weekly: find('seven_day'), observedAt: at, source: 'claude-code' }
  return out.fiveHour || out.weekly ? out : undefined
}

/** A window that has reset since it was read counts as empty. */
export function currentPercent(w: UsageWindow | undefined, now: Date): number {
  if (!w) return 0
  return Date.parse(w.resetsAt) <= now.getTime() ? 0 : w.percent
}

export type LimitCheck = { ok: true } | { ok: false; reason: string; until: string }

/** Whether the crew may start work now under the user's caps. */
export function checkLimits(w: UsageWindows | undefined, limits: UsageLimits, now: Date): LimitCheck {
  if (!w) return { ok: true }
  const at = (win: UsageWindow) => new Date(win.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  const five = currentPercent(w.fiveHour, now)
  const week = currentPercent(w.weekly, now)
  if (w.weekly && week >= limits.weeklyPct) {
    return { ok: false, reason: `weekly usage is at ${week}% (crew limit ${limits.weeklyPct}%); resumes ${at(w.weekly)}`, until: w.weekly.resetsAt }
  }
  if (w.fiveHour && five >= limits.fiveHourPct) {
    return { ok: false, reason: `5-hour usage is at ${five}% (crew limit ${limits.fiveHourPct}%); resumes ${at(w.fiveHour)}`, until: w.fiveHour.resetsAt }
  }
  if (w.status === 'rejected' && w.fiveHour && Date.parse(w.fiveHour.resetsAt) > now.getTime()) {
    return { ok: false, reason: `your plan's usage limit is reached; resumes ${at(w.fiveHour)}`, until: w.fiveHour.resetsAt }
  }
  return { ok: true }
}

export function validLimits(l: Partial<UsageLimits>): UsageLimits {
  const pct = (v: unknown, name: string) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error(`${name} must be a percentage from 1 to 100.`)
    return Math.round(n)
  }
  return { fiveHourPct: pct(l.fiveHourPct, '5-hour limit'), weeklyPct: pct(l.weeklyPct, 'Weekly limit'), perRunPct: pct(l.perRunPct, 'Per-task share') }
}

// ---------- small helpers ----------

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function parseModel(s: string | undefined): ModelName | undefined {
  const v = (s ?? '').toLowerCase()
  if (v.includes('opus')) return 'opus'
  if (v.includes('sonnet')) return 'sonnet'
  if (v.includes('haiku')) return 'haiku'
  if (v.includes('fable')) return 'fable'
  return undefined
}

export function splitList(s: string | undefined): string[] {
  return (s ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
}

export function newId(prefix: string, now: number, rand: () => number = Math.random): string {
  const r = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `${prefix}-${now.toString(36).slice(-5)}${r}`
}

export function event(actor: string, kind: string, text: string, at: string): TaskEvent {
  return { at, actor, kind, text }
}

// ---------- bot files (agent-style markdown) ----------

export function parseBotFile(slug: string, text: string): Bot | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return undefined
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const model = parseModel(fm.model)
  if (!fm.name || !model) return undefined
  return {
    slug,
    name: fm.name,
    job: fm.description ?? '',
    model,
    effort: parseEffort(fm.effort),
    tools: splitList(fm.connectors),
    canHandTo: splitList(fm.can_hand_to).map(slugify),
    workdir: fm.workdir || undefined,
    isManager: fm.role === 'manager',
    instructions: m[2].trim() || undefined,
  }
}

export function formatBotFile(bot: Bot): string {
  const lines = [
    '---',
    `name: ${bot.name}`,
    `description: ${bot.job}`,
    `model: ${bot.model}`,
    `effort: ${bot.effort ?? DEFAULT_EFFORT}`,
    `connectors: ${bot.tools.join(', ')}`,
    `can_hand_to: ${bot.canHandTo.join(', ')}`,
  ]
  if (bot.workdir) lines.push(`workdir: ${bot.workdir}`)
  if (bot.isManager) lines.push('role: manager')
  lines.push('---', '', bot.instructions ?? '', '')
  return lines.join('\n')
}

// ---------- the file store ----------

export interface Fs {
  read(path: string): Promise<string | undefined>
  write(path: string, text: string): Promise<void>
  list(dir: string): Promise<string[]>
  remove(path: string): Promise<void>
}

export class Store {
  readonly root: string
  readonly fs: Fs

  constructor(root: string, fs: Fs) {
    this.root = root
    this.fs = fs
  }

  path(...parts: string[]): string {
    return [this.root, ...parts].join('/')
  }

  async readJson<T>(path: string, fallback: T): Promise<T> {
    const text = await this.fs.read(path)
    if (text === undefined) return fallback
    try {
      return JSON.parse(text) as T
    } catch {
      return fallback
    }
  }

  writeJson(path: string, value: unknown): Promise<void> {
    return this.fs.write(path, JSON.stringify(value, null, 2) + '\n')
  }

  async config(): Promise<Config> {
    const saved = await this.readJson<Partial<Config>>(this.path('config.json'), {})
    return { ...DEFAULT_CONFIG, ...saved, limits: { ...DEFAULT_CONFIG.limits, ...saved.limits } }
  }

  saveConfig(cfg: Config): Promise<void> {
    return this.writeJson(this.path('config.json'), cfg)
  }

  async bots(): Promise<Bot[]> {
    const names = (await this.fs.list(this.path('bots'))).filter(n => n.endsWith('.md')).sort()
    const out: Bot[] = []
    for (const n of names) {
      const text = await this.fs.read(this.path('bots', n))
      const bot = text && parseBotFile(n.slice(0, -3), text)
      if (bot) out.push(bot)
    }
    return out
  }

  async bot(slug: string): Promise<Bot | undefined> {
    const text = await this.fs.read(this.path('bots', `${slug}.md`))
    return text ? parseBotFile(slug, text) : undefined
  }

  saveBot(bot: Bot): Promise<void> {
    return this.fs.write(this.path('bots', `${bot.slug}.md`), formatBotFile(bot))
  }

  removeBot(slug: string): Promise<void> {
    return this.fs.remove(this.path('bots', `${slug}.md`))
  }

  task(id: string): Promise<Task | undefined> {
    return this.readJson<Task | undefined>(this.path('tasks', `${id}.json`), undefined)
  }

  saveTask(task: Task): Promise<void> {
    return this.writeJson(this.path('tasks', `${task.id}.json`), task)
  }

  async tasks(): Promise<Task[]> {
    const names = (await this.fs.list(this.path('tasks'))).filter(n => n.endsWith('.json'))
    const out: Task[] = []
    for (const n of names) {
      const t = await this.task(n.slice(0, -5))
      if (t) out.push(t)
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  approval(id: string): Promise<Approval | undefined> {
    return this.readJson<Approval | undefined>(this.path('approvals', `${id}.json`), undefined)
  }

  saveApproval(a: Approval): Promise<void> {
    return this.writeJson(this.path('approvals', `${a.id}.json`), a)
  }

  async approvals(): Promise<Approval[]> {
    const names = (await this.fs.list(this.path('approvals'))).filter(n => n.endsWith('.json'))
    const out: Approval[] = []
    for (const n of names) {
      const a = await this.approval(n.slice(0, -5))
      if (a) out.push(a)
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  routines(): Promise<Routine[]> {
    return this.readJson<Routine[]>(this.path('routines.json'), [])
  }

  saveRoutines(list: Routine[]): Promise<void> {
    return this.writeJson(this.path('routines.json'), list)
  }

  async memory(slug: string): Promise<string> {
    return (await this.fs.read(this.path('memory', slug, 'MEMORY.md'))) ?? ''
  }

  async remember(slug: string, fact: string, at: string): Promise<void> {
    const prev = await this.memory(slug)
    const line = `- ${fact.replace(/\s+/g, ' ').trim()} _(${at.slice(0, 10)})_`
    await this.fs.write(this.path('memory', slug, 'MEMORY.md'), (prev ? prev.trimEnd() + '\n' : '# Memory\n\n') + line + '\n')
  }

  usageWindows(): Promise<UsageWindows | undefined> {
    return this.readJson<UsageWindows | undefined>(this.path('limits.json'), undefined)
  }

  /** Keeps the newest reading, from whichever side (runner or Claude Code) saw it last. */
  async saveUsageWindows(w: UsageWindows): Promise<void> {
    const prev = await this.usageWindows()
    if (prev && Date.parse(prev.observedAt) > Date.parse(w.observedAt)) return
    await this.writeJson(this.path('limits.json'), w)
  }

  usage(day: string): Promise<Record<string, number>> {
    return this.readJson<Record<string, number>>(this.path('usage', `${day}.json`), {})
  }

  async addUsage(day: string, slug: string, usd: number): Promise<void> {
    const u = await this.usage(day)
    u[slug] = Math.round(((u[slug] ?? 0) + usd) * 10000) / 10000
    await this.writeJson(this.path('usage', `${day}.json`), u)
  }

  runner(): Promise<RunnerState | undefined> {
    return this.readJson<RunnerState | undefined>(this.path('runner.json'), undefined)
  }
}

// ---------- tasks and delegation ----------

export function makeTask(opts: {
  id: string
  title: string
  body: string
  owner: string
  createdBy: string
  at: string
  parentId?: string
  depth?: number
  model?: ModelName
  cwd?: string
}): Task {
  return {
    id: opts.id,
    title: opts.title,
    body: opts.body,
    owner: opts.owner,
    status: 'queued',
    createdBy: opts.createdBy,
    createdAt: opts.at,
    updatedAt: opts.at,
    parentId: opts.parentId,
    children: [],
    depth: opts.depth ?? 0,
    handoffs: 0,
    model: opts.model,
    cwd: opts.cwd,
    history: [event(opts.createdBy, 'created', `Assigned to ${opts.owner}: ${opts.title}`, opts.at)],
    costUsd: 0,
    runs: 0,
    returnTo: [],
    askedBot: opts.owner,
  }
}

export function titleFrom(text: string): string {
  const first = text.trim().split('\n')[0]
  return first.length > 80 ? first.slice(0, 77) + '...' : first
}

export type Check = { ok: true } | { ok: false; reason: string }

/** Whether `from` may pass work to `to` under the crew's delegation policy. */
export function mayDelegate(cfg: Config, from: Bot, to: string, bots: Bot[]): Check {
  const target = bots.find(b => b.slug === to)
  if (!target) return { ok: false, reason: `No bot called "${to}". Bots: ${bots.map(b => b.slug).join(', ')}` }
  if (target.slug === from.slug) return { ok: false, reason: 'A bot cannot hand work to itself.' }
  if (cfg.delegation === 'free') return { ok: true }
  if (cfg.delegation === 'manager') {
    if (from.slug === cfg.managerSlug) return { ok: true }
    if (to === cfg.managerSlug) return { ok: true }
    return { ok: false, reason: `Only the Manager assigns work. Hand the task back to "${cfg.managerSlug}" with a note saying ${target.name} should take it.` }
  }
  if (to === cfg.managerSlug || from.canHandTo.includes(to)) return { ok: true }
  return { ok: false, reason: `${from.name} can only hand tasks to: ${from.canHandTo.join(', ') || 'nobody'}.` }
}

export function handoff(task: Task, cfg: Config, from: string, to: string, note: string, at: string): Check {
  if (task.handoffs >= cfg.maxHandoffs) {
    return { ok: false, reason: `This task has been handed over ${task.handoffs} times, the limit. Finish it or block it for the user.` }
  }
  if (from !== to) task.returnTo = [...(task.returnTo ?? []), from]
  task.owner = to
  task.status = 'queued'
  task.handoffs += 1
  task.updatedAt = at
  task.history.push(event(from, 'handoff', `Handed to ${to}. Note: ${note}`, at))
  return { ok: true }
}

export function assignChild(
  parent: Task,
  cfg: Config,
  from: string,
  to: string,
  title: string,
  details: string,
  id: string,
  at: string,
): Task | { error: string } {
  if (parent.depth + 1 > cfg.maxDepth) {
    return { error: `Delegation is ${parent.depth} levels deep, the limit is ${cfg.maxDepth}. Do this part yourself or block for the user.` }
  }
  const child = makeTask({ id, title, body: details, owner: to, createdBy: from, at, parentId: parent.id, depth: parent.depth + 1, cwd: parent.cwd })
  parent.children.push(child.id)
  parent.history.push(event(from, 'assigned', `Assigned ${child.id} to ${to}: ${title}`, at))
  parent.updatedAt = at
  return child
}

/**
 * A bot finished its part. If someone handed the task over, it goes back to them with
 * the result (they review it and finish it for whoever asked them); otherwise the task
 * is done and its result is the answer for the user.
 */
export function finishOrReturn(task: Task, by: string, result: string, at: string): { returnedTo?: string } {
  task.result = result
  task.updatedAt = at
  const stack = task.returnTo ?? []
  const back = stack.pop()
  task.returnTo = stack
  if (back && back !== by) {
    task.owner = back
    task.status = 'queued'
    task.history.push(event(by, 'returned', `Finished and returned to ${back}: ${result}`, at))
    return { returnedTo: back }
  }
  task.status = 'done'
  task.history.push(event(by, 'done', result, at))
  return {}
}

/** Where the final answer goes: the chat it was asked in, else the chat of the bot first asked. */
export function answerChat(task: Task): string {
  return task.createdBy.startsWith('chat:') ? task.createdBy.slice(5) : (task.askedBot ?? task.owner)
}

/** Records a finished child on its parent; returns true when the parent should run again. */
export function childFinished(parent: Task, child: Task, siblings: Task[], at: string): boolean {
  const verb = child.status === 'done' ? 'finished' : child.status
  parent.history.push(event(child.owner, 'result', `${child.id} ${verb}: ${child.result ?? '(no result)'}`, at))
  parent.updatedAt = at
  const open = siblings.filter(s => s.id !== child.id && !TERMINAL.includes(s.status))
  if (open.length === 0 && parent.status === 'waiting') {
    parent.status = 'queued'
    return true
  }
  return false
}

// ---------- @mentions ----------

export type Mention = { bot: Bot; model?: ModelName; text: string }

/** `@Bug fixer[opus] fix the login test` → bot, optional model override, text. */
export function parseMention(input: string, bots: Bot[]): Mention | undefined {
  const t = input.trimStart()
  if (!t.startsWith('@')) return undefined
  const rest = t.slice(1)
  const lower = rest.toLowerCase()
  const byLength = [...bots].sort((a, b) => b.name.length - a.name.length)
  for (const bot of byLength) {
    for (const key of [bot.name.toLowerCase(), bot.slug]) {
      if (!lower.startsWith(key)) continue
      let after = rest.slice(key.length)
      if (after && !/^[\s\[:,]/.test(after)) continue
      let model: ModelName | undefined
      const m = after.match(/^\[([a-z0-9 .-]+)\]/i)
      if (m) {
        model = parseModel(m[1])
        after = after.slice(m[0].length)
      }
      const text = after.replace(/^[\s:,]+/, '').trim()
      if (!text) return undefined
      return { bot, model, text }
    }
  }
  return undefined
}

// ---------- routines ----------

export type Schedule =
  | { kind: 'every'; ms: number }
  | { kind: 'at'; days: number[]; hour: number; minute: number }

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** "every 30m" | "every 2h" | "daily 08:30" | "weekdays 09:00" | "mon,wed 10:15" */
/** Routines run at most this often, so a schedule can't hammer the user's plan. */
export const MIN_ROUTINE_MS = 15 * 60_000

export function parseSchedule(s: string): Schedule | undefined {
  const v = s.trim().toLowerCase()
  const every = v.match(/^every\s+(\d+)\s*(m|min|h|d)$/)
  if (every) {
    const n = Number(every[1])
    const unit = every[2].startsWith('m') ? 60_000 : every[2] === 'h' ? 3_600_000 : 86_400_000
    return n * unit >= MIN_ROUTINE_MS ? { kind: 'every', ms: n * unit } : undefined
  }
  const at = v.match(/^([a-z,]+)\s+(\d{1,2}):(\d{2})$/)
  if (!at) return undefined
  const hour = Number(at[2])
  const minute = Number(at[3])
  if (hour > 23 || minute > 59) return undefined
  let days: number[]
  if (at[1] === 'daily') days = [0, 1, 2, 3, 4, 5, 6]
  else if (at[1] === 'weekdays') days = [1, 2, 3, 4, 5]
  else if (at[1] === 'weekends') days = [0, 6]
  else {
    days = at[1].split(',').map(d => DAYS.indexOf(d.slice(0, 3)))
    if (days.some(d => d < 0)) return undefined
  }
  return { kind: 'at', days, hour, minute }
}

/** Whether a routine should fire now. Local-time schedules; missed runs older than an hour are skipped. */
export function isDue(sched: Schedule, lastRunAt: string, now: Date): boolean {
  const last = new Date(lastRunAt).getTime()
  if (sched.kind === 'every') return now.getTime() - last >= sched.ms
  for (let back = 0; back < 8; back++) {
    const d = new Date(now)
    d.setDate(d.getDate() - back)
    d.setHours(sched.hour, sched.minute, 0, 0)
    if (d.getTime() > now.getTime() || !sched.days.includes(d.getDay())) continue
    return last < d.getTime() && now.getTime() - d.getTime() < 3_600_000
  }
  return false
}

/** When a routine fires next, in local time: `now` when it is due, undefined for a schedule with no days. */
export function nextRun(sched: Schedule, lastRunAt: string, now: Date): Date | undefined {
  if (isDue(sched, lastRunAt, now)) return now
  if (sched.kind === 'every') return new Date(Math.max(new Date(lastRunAt).getTime() + sched.ms, now.getTime()))
  for (let ahead = 0; ahead < 8; ahead++) {
    const d = new Date(now)
    d.setDate(d.getDate() + ahead)
    d.setHours(sched.hour, sched.minute, 0, 0)
    if (d.getTime() > now.getTime() && sched.days.includes(d.getDay())) return d
  }
  return undefined
}

// ---------- approvals ----------

export type Verdict = 'allow' | 'ask' | 'deny' | 'review'

const CONNECTOR_KEYS: Record<string, RegExp> = {
  gmail: /gmail|mail/i,
  calendar: /calendar/i,
  slack: /slack/i,
  notion: /notion/i,
  jira: /jira|atlassian|confluence/i,
  datadog: /datadog/i,
}

const SAFE_BUILTINS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebSearch', 'WebFetch', 'NotebookRead'])
const RISKY_NAME = /(send|delete|trash|remove|publish|post|pay|transfer|merge|share|respond|invite|create_event|update_event|forward|archive|spam)/i
// A connector action is a read when its name starts with a read verb (list_posts, get_event, search_threads).
const READ_START = /^(get|list|search|read|fetch|find|query|describe|lookup|whoami|view)[_-]/i
const SAFE_BASH = /^\s*(ls|cat|head|tail|wc|pwd|echo|grep|rg|find|git (status|diff|log|show|branch|rev-parse|fetch)|npm (test|run (test|lint|build|typecheck))|pnpm (test|lint)|yarn (test|lint)|npx (tsc|vitest|jest|eslint)|pytest|go test|cargo (test|check)|node --test|tsc)\b/
const RISKY_BASH = /(git push|gh pr (merge|close)|rm -rf|sudo|npm publish|curl[^|]*-X\s*(POST|PUT|DELETE)|launchctl|chmod|chown|>\s*\/etc)/

/** The connector a tool belongs to, or undefined for built-in tools. */
export function connectorOf(tool: string): string | undefined {
  if (!tool.startsWith('mcp__') || tool.startsWith('mcp__bots__')) return undefined
  const server = tool.split('__')[1] ?? ''
  for (const [key, re] of Object.entries(CONNECTOR_KEYS)) if (re.test(server)) return key
  return server.toLowerCase()
}

/** Whether an MCP tool prefix (`mcp__claude_ai_Gmail`) is one of the bot's granted connectors. */
export function grants(bot: Bot, prefix: string): boolean {
  const server = prefix.replace(/^mcp__/, '')
  return bot.tools.some(t => {
    const key = t.toLowerCase()
    return CONNECTOR_KEYS[key]?.test(server) || server.toLowerCase().includes(key.replace(/\s+/g, '_'))
  })
}

/**
 * Which MCP servers a run loads. Every connector would add its tools to each
 * request (hundreds of tools, past the context of small models), so a bot
 * sees only the crew tools plus its own connectors: `strict` when it has none,
 * else every other known server denied. With no known server list, a bot that
 * needs connectors runs strict rather than with everything.
 */
export function mcpScope(bot: Bot, knownPrefixes: string[] | undefined): { strict: boolean; deny: string[]; missing: boolean } {
  const wanted = bot.tools.filter(t => CONNECTOR_KEYS[t.toLowerCase()] || !['code', 'web search', 'browser'].includes(t.toLowerCase()))
  if (wanted.length === 0) return { strict: true, deny: [], missing: false }
  if (!knownPrefixes) return { strict: true, deny: [], missing: true }
  const others = knownPrefixes.filter(p => p !== 'mcp__bots' && !grants(bot, p))
  return { strict: false, deny: others, missing: false }
}

/** Code-level rules first; 'review' means the Auto Review model decides. */
export function classify(cfg: Config, bot: Bot, tool: string, input: Record<string, unknown>): { verdict: Verdict; reason: string } {
  if (tool.startsWith('mcp__bots__')) return { verdict: 'allow', reason: 'crew tool' }
  const connector = connectorOf(tool)
  if (connector !== undefined) {
    if (!grants(bot, `mcp__${tool.split('__')[1] ?? ''}`)) {
      return { verdict: 'deny', reason: `${bot.name} is not allowed to use ${connector}. Hand the task back if it needs that.` }
    }
  }
  if (matchesRule(cfg.allow[bot.slug] ?? [], tool, input)) return { verdict: 'allow', reason: 'always allowed' }
  const command = typeof input.command === 'string' ? input.command : ''
  const safe =
    SAFE_BUILTINS.has(tool) ||
    (connector !== undefined && READ_START.test(tool.split('__')[2] ?? '')) ||
    (tool === 'Bash' && SAFE_BASH.test(command) && !/[;&|`$]/.test(command))
  const risky = (connector !== undefined && RISKY_NAME.test(tool.split('__')[2] ?? '')) || (tool === 'Bash' && RISKY_BASH.test(command))
  if (cfg.approvals === 'strict') return safe ? { verdict: 'allow', reason: 'read-only' } : { verdict: 'ask', reason: 'strict mode' }
  if (cfg.approvals === 'ask') return safe ? { verdict: 'allow', reason: 'read-only' } : { verdict: 'ask', reason: 'first use' }
  if (safe) return { verdict: 'allow', reason: 'read-only' }
  if (risky) return { verdict: 'ask', reason: 'sends, deletes or publishes' }
  // Anything else that changes an outside account (a post, a mutation, an upload) waits for the user, never a model's review.
  if (connector !== undefined) return { verdict: 'ask', reason: 'changes something in a connected account' }
  return { verdict: 'review', reason: 'needs review' }
}

/** Rules are tool names, `Bash(prefix*)` or `mcp__server__*`. */
export function matchesRule(rules: string[], tool: string, input: Record<string, unknown>): boolean {
  return rules.some(rule => {
    const m = rule.match(/^(\w+)\((.*)\)$/)
    if (m) {
      if (m[1] !== tool || typeof input.command !== 'string') return false
      const pat = m[2]
      return pat.endsWith('*') ? input.command.startsWith(pat.slice(0, -1)) : input.command === pat
    }
    return rule.endsWith('*') ? tool.startsWith(rule.slice(0, -1)) : rule === tool
  })
}

/** The rule "Always allow" saves: a command prefix for Bash, otherwise the tool. */
export function ruleFor(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof input.command === 'string') {
    const words = input.command.trim().split(/\s+/).slice(0, 2).join(' ')
    return `Bash(${words}*)`
  }
  return tool
}

export function summarize(tool: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return `${tool}: ${input.command}`.slice(0, 300)
  if (typeof input.file_path === 'string') return `${tool}: ${input.file_path}`
  const brief = JSON.stringify(input)
  return `${tool} ${brief.length > 240 ? brief.slice(0, 237) + '...' : brief}`
}

// ---------- prompts ----------

/** Input token figures from a claude -p result. */
export type TokenUsage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }

/** "91% of input from cache", or '' when the run reported no figures. */
export function cacheShare(u: TokenUsage | undefined): string {
  const read = u?.cache_read_input_tokens ?? 0
  const all = read + (u?.cache_creation_input_tokens ?? 0) + (u?.input_tokens ?? 0)
  return all ? `${Math.round((read / all) * 100)}% of input from cache` : ''
}

/** A reply's own cost: a resumed session reports its running total, so subtract what came before. */
export function replyCost(total: number, resumed: boolean, before: number | undefined): number {
  return resumed ? Math.max(0, total - (before ?? 0)) : total
}

export function botSystemPrompt(bot: Bot, bots: Bot[], cfg: Config, memory: string): string {
  const roster = bots.map(b => `- ${b.slug} (${b.name}, ${MODEL_LABELS[b.model]}): ${b.job}`).join('\n')
  const rules =
    cfg.delegation === 'manager'
      ? bot.slug === cfg.managerSlug
        ? 'You are the Manager. Split requests into tasks and assign them with assign_task, then end your run: you are started again with each result. When all results are in, combine them and call complete_task with a report for the user.'
        : `Only the Manager assigns work. If the task needs another bot, call handoff with to="${cfg.managerSlug}" and a note that says what is done and what is left.`
      : `You may hand work to: ${bot.canHandTo.join(', ') || 'nobody'}${bot.slug !== cfg.managerSlug ? ` and ${cfg.managerSlug}` : ''}.`
  return [
    `You are ${bot.name}, one bot in the user's crew of AI teammates. Your job: ${bot.job}`,
    bot.instructions ?? '',
    `Connectors you may use: ${bot.tools.join(', ') || 'none beyond the crew tools'}.`,
    `The crew:\n${roster}`,
    `How work moves: ${rules}`,
    'When a task comes back to you with another bot\'s result, check it and finish it for whoever asked you. Write results in Markdown (short headings, lists, bold, code) when it helps.',
    'Finish every run with exactly one of: complete_task (with the result the user or Manager needs), handoff (with a note the next bot can act on without asking), or block_task (when you need the user to decide or supply something). Never send, delete, publish, pay or invite without the approval prompt allowing it. Never type passwords.',
    'Use remember to save lasting preferences or corrections the user gives you.',
    memory ? `What you remember:\n${memory}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function taskPrompt(task: Task): string {
  const recent = task.history.slice(-20).map(e => `[${e.at.slice(0, 16)}] ${e.actor} ${e.kind}: ${e.text}`)
  return [
    `Task ${task.id}: ${task.title}`,
    task.body && task.body !== task.title ? `Details:\n${task.body}` : '',
    `History so far:\n${recent.join('\n')}`,
    'Pick up from where the history leaves off.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ---------- connectors ----------

/** One MCP server a run can load, as the CLI reports it at startup. */
export type Connector = { prefix: string; name: string; label: string; status: string }

/** Built-in abilities, not connectors: they switch on Claude Code tools. */
export const ABILITIES = ['Code', 'Web search', 'Browser'] as const

export type ConnectorList = { prefixes: string[]; servers: Connector[]; checkedAt: string }

/** Connected, or still connecting when the CLI started; not ones that need signing in. */
export function isAvailable(c: Connector): boolean {
  return !['needs-auth', 'failed', 'disabled'].includes(c.status)
}

/** "claude.ai Google Calendar" → "Google Calendar". */
export function connectorLabel(serverName: string): string {
  return serverName.replace(/^claude\.ai\s+/i, '').trim()
}

// ---------- chat ----------

export type Proposal = {
  action: 'create_bot' | 'update_bot' | 'delete_bot' | 'add_routine' | 'update_config'
  summary: string
  slug?: string
  bot?: Record<string, unknown>
  routine?: { bot: string; schedule: string; title: string; prompt: string }
  config?: Record<string, unknown>
  state: 'pending' | 'applied' | 'discarded' | 'failed'
  outcome?: string
}

export type ChatMessage = {
  id: string
  role: 'you' | 'bot' | 'system'
  text: string
  at: string
  proposal?: Proposal
  taskId?: string
  answered?: boolean
}

export type ChatThread = {
  bot: string
  status: 'idle' | 'queued' | 'thinking'
  sessionId?: string
  /** The resumed session's running cost; each reply's own cost is the difference. */
  sessionCostUsd?: number
  messages: ChatMessage[]
}

export async function readChat(s: Store, bot: string): Promise<ChatThread> {
  return s.readJson<ChatThread>(s.path('chats', `${bot}.json`), { bot, status: 'idle', messages: [] })
}

export function saveChat(s: Store, thread: ChatThread): Promise<void> {
  return s.writeJson(s.path('chats', `${thread.bot}.json`), thread)
}

export async function postToChat(s: Store, bot: string, text: string, at: string): Promise<ChatMessage> {
  const thread = await readChat(s, bot)
  const msg: ChatMessage = { id: newId('m', Date.parse(at)), role: 'you', text: text.trim(), at }
  thread.messages.push(msg)
  if (thread.status === 'idle') thread.status = 'queued'
  await saveChat(s, thread)
  return msg
}

/** The user's messages the bot has not replied to yet. */
export function unanswered(thread: ChatThread): ChatMessage[] {
  return thread.messages.filter(m => m.role === 'you' && !m.answered)
}

export function chatSystemPrompt(bot: Bot, bots: Bot[], cfg: Config, memory: string, connectors: Connector[]): string {
  // Sorted and deduplicated so the prompt stays byte-identical between replies.
  const available = [...new Set(connectors.filter(isAvailable).map(c => c.label))].sort()
  return [
    botSystemPrompt(bot, bots, cfg, memory),
    'You are now chatting with the user directly, not working a task. Answer conversationally and briefly.',
    'For real work that takes more than a quick answer, call create_task (for yourself, or for another bot if the crew rules allow) and tell the user you have queued it.',
    'To change the crew (create, update or delete a bot, change a model, job or connectors, add a routine, change settings) call propose_change. Nothing changes until the user presses Apply on your proposal, so say what you proposed and that it is waiting for them.',
    `Models: opus (hardest work), sonnet (balanced), haiku (fast and cheap), fable. Effort: low, medium (default), high, xhigh, max. Connectors the user has connected: ${available.join(', ') || 'none'}. Abilities: ${ABILITIES.join(', ')}.`,
  ].join('\n\n')
}

// ---------- applying changes ----------

const CONFIG_KEYS = ['delegation', 'approvals', 'limits', 'concurrency', 'paused'] as const

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map(x => x.trim()).filter(Boolean)
  return typeof v === 'string' ? splitList(v) : []
}

/** Builds a bot from loose input (a form or a model's proposal); throws a readable error when it can't. */
export function botFromInput(input: Record<string, unknown>, existing?: Bot): Bot {
  const name = String(input.name ?? existing?.name ?? '').trim()
  const job = String(input.job ?? input.description ?? existing?.job ?? '').trim()
  const model = parseModel(String(input.model ?? existing?.model ?? ''))
  const effort = parseEffort(input.effort) ?? existing?.effort ?? DEFAULT_EFFORT
  if (input.effort !== undefined && input.effort !== '' && !parseEffort(input.effort)) throw new Error('Effort must be low, medium, high, xhigh or max.')
  if (!name) throw new Error('A bot needs a name.')
  if (!job) throw new Error(`${name} needs a job.`)
  if (!model) throw new Error('Pick a model: opus, sonnet, haiku or fable.')
  const tools = input.tools !== undefined || input.connectors !== undefined ? asList(input.tools ?? input.connectors) : (existing?.tools ?? [])
  const handTo = input.canHandTo !== undefined || input.can_hand_to !== undefined ? asList(input.canHandTo ?? input.can_hand_to).map(slugify) : (existing?.canHandTo ?? [])
  const workdir = input.workdir !== undefined ? String(input.workdir).trim() || undefined : existing?.workdir
  const instructions = input.instructions !== undefined ? String(input.instructions).trim() || undefined : existing?.instructions
  return { slug: existing?.slug ?? slugify(name), name, job, model, effort, tools, canHandTo: handTo, workdir, isManager: existing?.isManager, instructions }
}

export async function applyProposal(s: Store, p: Proposal, at: string): Promise<string> {
  const cfg = await s.config()
  if (p.action === 'create_bot') {
    const bot = botFromInput(p.bot ?? {})
    if (await s.bot(bot.slug)) throw new Error(`There's already a bot called ${bot.name}.`)
    await s.saveBot(bot)
    return `Created ${bot.name} on ${MODEL_LABELS[bot.model]}.`
  }
  if (p.action === 'update_bot' || p.action === 'delete_bot') {
    const existing = await s.bot(slugify(p.slug ?? String(p.bot?.name ?? '')))
    if (!existing) throw new Error(`No bot called ${p.slug ?? p.bot?.name}.`)
    if (p.action === 'delete_bot') {
      if (existing.slug === cfg.managerSlug) throw new Error('The Manager hands out all work, so it cannot be deleted.')
      await s.removeBot(existing.slug)
      return `Deleted ${existing.name}.`
    }
    const bot = botFromInput({ ...(p.bot ?? {}), name: p.bot?.name ?? existing.name }, existing)
    await s.saveBot({ ...bot, slug: existing.slug })
    return `Updated ${bot.name}.`
  }
  if (p.action === 'add_routine') {
    const r = p.routine
    if (!r || !(await s.bot(slugify(r.bot)))) throw new Error('A routine needs an existing bot.')
    if (!parseSchedule(r.schedule)) throw new Error(`Can't read the schedule "${r.schedule}".`)
    const list = await s.routines()
    list.push({ id: newId('r', Date.parse(at)), bot: slugify(r.bot), title: r.title, prompt: r.prompt, schedule: r.schedule, paused: false, createdAt: at })
    await s.saveRoutines(list)
    return `Added routine "${r.title}" (${r.schedule}).`
  }
  if (p.action === 'update_config') {
    const next = { ...cfg } as Record<string, unknown>
    for (const k of CONFIG_KEYS) if (p.config && k in p.config) next[k] = p.config[k]
    if (!['manager', 'list', 'free'].includes(String(next.delegation))) throw new Error('Delegation must be manager, list or free.')
    if (!['auto', 'ask', 'strict'].includes(String(next.approvals))) throw new Error('Approvals must be auto, ask or strict.')
    next.limits = validLimits({ ...cfg.limits, ...(next.limits as Partial<UsageLimits>) })
    const conc = Number(next.concurrency)
    if (!Number.isInteger(conc) || conc < 1 || conc > 4) throw new Error('Tasks at once must be 1 to 4.')
    await s.saveConfig(next as Config)
    return 'Settings updated.'
  }
  throw new Error(`Unknown change ${p.action}.`)
}
