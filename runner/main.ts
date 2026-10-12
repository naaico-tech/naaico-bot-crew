// The crew's background runner. It runs from launchd, outside any Claude Code
// session: it works the task board in ~/.claude/bots, runs each task as its
// bot (on the bot's model) through headless `claude -p`, feeds sub-task
// results back to their parents, and fires routines on schedule.
import { chmod, mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { answerChat, botSystemPrompt, chatSystemPrompt, checkLimits, DEFAULT_EFFORT, finishOrReturn, childFinished, currentPercent, event, RUNAWAY_USD, windowsFromStreamEvent, newId as makeId, readChat, saveChat, unanswered, isDue, makeTask, mcpScope, newId, parseSchedule, taskPrompt, MODEL_IDS, MODEL_LABELS, TERMINAL } from './core.ts'
import type { Bot, ChatThread, Config, Connector, LimitCheck, Store, Task } from './core.ts'
import { startWeb, webInfo } from './web.ts'
import { discoverConnectors, expandHome, notify, nowIso, openStore, runClaude, today, ROOT, RUNNER_DIR } from './node.ts'

const CONNECTOR_REFRESH_MS = 6 * 3_600_000

const TICK_MS = Number(process.env.BOTS_TICK_MS ?? 3000)

const BASE_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite']
const TOOL_MAP: Record<string, string[]> = {
  code: ['Edit', 'Write', 'Bash', 'NotebookEdit'],
  'web search': ['WebSearch', 'WebFetch'],
  browser: ['WebSearch', 'WebFetch'],
}
const CREW_TOOLS = ['list_bots', 'list_tasks', 'create_task', 'handoff', 'assign_task', 'complete_task', 'block_task', 'remember'].map(t => `mcp__bots__${t}`)
const CHAT_TOOLS = ['list_bots', 'list_tasks', 'create_task', 'propose_change', 'remember'].map(t => `mcp__bots__${t}`)
const CHAT_CONCURRENCY = 2

/**
 * Makes sure a run's working folder exists. Folders inside the crew store are
 * created on first use; any other folder must already exist, so a typo in a
 * repo path is reported instead of becoming an empty folder.
 */
export async function ensureWorkdir(dir: string, storeRoot: string): Promise<string | undefined> {
  const ok = await stat(dir).then(st => st.isDirectory(), () => false)
  if (ok) return undefined
  if (resolve(dir).startsWith(resolve(storeRoot) + '/')) {
    await mkdir(dir, { recursive: true })
    return undefined
  }
  return `The working folder ${dir} doesn't exist. Fix it in the bot's settings.`
}

export function builtinTools(bot: Bot): string[] {
  const out = new Set(BASE_TOOLS)
  for (const t of bot.tools) for (const x of TOOL_MAP[t.toLowerCase()] ?? []) out.add(x)
  return [...out]
}

export class Runner {
  readonly s: Store
  readonly kills = new Map<string, () => void>()
  readonly runs = new Map<string, Promise<void>>()
  readonly startedAt = nowIso()
  ticking = false
  connectors: string[] | undefined
  servers: Connector[] = []
  connectorsCheckAt = 0
  readonly chats = new Map<string, Promise<void>>()

  constructor(s: Store) {
    this.s = s
  }

  /** Learns which MCP servers a run would load, so each bot gets only its own. */
  async refreshConnectors(): Promise<void> {
    if (Date.now() < this.connectorsCheckAt) return
    const found = await discoverConnectors(this.s.root)
    if (found) {
      this.connectors = found.prefixes
      this.servers = found.servers
      this.connectorsCheckAt = Date.now() + CONNECTOR_REFRESH_MS
      await this.s.writeJson(this.s.path('connectors.json'), { ...found, checkedAt: nowIso() })
      return
    }
    const cached = await this.s.readJson<{ prefixes?: string[]; servers?: Connector[] }>(this.s.path('connectors.json'), {})
    this.connectors ??= cached.prefixes
    if (!this.servers.length) this.servers = cached.servers ?? []
    this.connectorsCheckAt = Date.now() + 10 * 60_000
  }

  /** Puts work interrupted by a restart back on the board. */
  async recover(): Promise<void> {
    const at = nowIso()
    for (const t of await this.s.tasks()) {
      if (t.status === 'working' || t.status === 'needs_approval') {
        t.status = 'queued'
        t.history.push(event('runner', 'note', 'The runner restarted; picking this up again.', at))
        await this.s.saveTask(t)
      }
    }
    for (const a of await this.s.approvals()) {
      if (a.status === 'pending') await this.s.saveApproval({ ...a, status: 'denied', reason: 'Runner restarted', decidedAt: at })
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.s.writeJson(this.s.path('runner.json'), { pid: process.pid, startedAt: this.startedAt, heartbeat: nowIso(), running: [...this.runs.keys()] })
      const cfg = await this.s.config()
      const tasks = await this.s.tasks()
      for (const t of tasks) if (t.status === 'cancelled' && this.kills.has(t.id)) this.kills.get(t.id)?.()
      if (cfg.paused) return
      await this.fireRoutines()
      const chatFiles = (await this.s.fs.list(this.s.path('chats'))).filter(n => n.endsWith('.json'))
      if (tasks.some(t => t.status === 'queued') || chatFiles.length) await this.refreshConnectors()
      // The user's caps on their plan windows decide whether any new work starts.
      const gate = checkLimits(await this.s.usageWindows(), cfg.limits, new Date())
      for (const t of tasks) {
        if (this.runs.size >= cfg.concurrency) break
        if (t.status !== 'queued' || this.runs.has(t.id)) continue
        if (!gate.ok) {
          await this.noteOnce(t, 'limit', `Waiting: ${gate.reason}.`)
          continue
        }
        const run = this.start(t).finally(() => this.runs.delete(t.id))
        this.runs.set(t.id, run)
      }
      await this.startChats(gate)
    } finally {
      this.ticking = false
    }
  }

  async noteOnce(t: Task, kind: string, text: string): Promise<void> {
    const last = t.history[t.history.length - 1]
    if (last?.kind === kind && last.at.slice(0, 10) === nowIso().slice(0, 10)) return
    t.history.push(event('runner', kind, text, nowIso()))
    await this.s.saveTask(t)
  }

  /**
   * Watches a run's rate-limit readings: saves each one, and stops the run when
   * it pushes a plan window past the user's cap or uses more than its share of
   * the 5-hour window.
   */
  watch(cfg: Config, kill: () => void): { onEvent: (e: Record<string, unknown>) => void; stopped?: { reason: string; perRun: boolean } } {
    let first: number | undefined
    const w8 = {
      stopped: undefined as { reason: string; perRun: boolean } | undefined,
      onEvent: (e: Record<string, unknown>) => {
        const w = windowsFromStreamEvent(e, nowIso())
        if (!w) return
        void this.s.saveUsageWindows(w)
        if (w8.stopped) return
        const now = new Date()
        const five = currentPercent(w.fiveHour, now)
        if (first === undefined) {
          first = five
          return
        }
        if (five - first >= cfg.limits.perRunPct) {
          w8.stopped = { reason: `it used ${Math.round((five - first) * 10) / 10}% of your 5-hour window, over its ${cfg.limits.perRunPct}% share`, perRun: true }
          return kill()
        }
        const gate = checkLimits(w, cfg.limits, now)
        if (!gate.ok) {
          w8.stopped = { reason: gate.reason, perRun: false }
          kill()
        }
      },
    }
    return w8
  }

  async fireRoutines(): Promise<void> {
    const list = await this.s.routines()
    const now = new Date()
    let changed = false
    for (const r of list) {
      const sched = parseSchedule(r.schedule)
      if (r.paused || !sched || !isDue(sched, r.lastRunAt ?? r.createdAt, now)) continue
      const at = now.toISOString()
      await this.s.saveTask(makeTask({ id: newId('t', now.getTime()), title: r.title, body: r.prompt, owner: r.bot, createdBy: `routine:${r.id}`, at }))
      r.lastRunAt = at
      changed = true
    }
    if (changed) await this.s.saveRoutines(list)
  }

  async start(task: Task): Promise<void> {
    const s = this.s
    const [cfg, bots, bot] = await Promise.all([s.config(), s.bots(), s.bot(task.owner)])
    const at = nowIso()
    if (!bot) {
      task.status = 'failed'
      task.result = `No bot called ${task.owner}.`
      task.history.push(event('runner', 'failed', task.result, at))
      await s.saveTask(task)
      return this.after(task)
    }
    const model = task.model ?? bot.model
    task.status = 'working'
    task.runs += 1
    task.updatedAt = at
    task.history.push(event('runner', 'started', `${bot.name} started on ${MODEL_LABELS[model]}, ${bot.effort ?? DEFAULT_EFFORT} effort`, at))
    await s.saveTask(task)

    const mcpPath = s.path('run', `${task.id}.mcp.json`)
    await s.writeJson(mcpPath, {
      mcpServers: {
        bots: {
          command: process.execPath,
          args: [join(RUNNER_DIR, 'mcp.ts')],
          env: { BOTS_ROOT: s.root, BOTS_BOT: bot.slug, BOTS_TASK: task.id, PATH: process.env.PATH ?? '' },
        },
      },
    })
    const cwd = expandHome(task.cwd ?? bot.workdir ?? s.path('workspace', bot.slug))
    const missing = await ensureWorkdir(cwd, s.root)
    if (missing) {
      task.status = 'blocked'
      task.result = missing
      task.history.push(event('runner', 'blocked', missing, at))
      await s.saveTask(task)
      return
    }
    const scope = mcpScope(bot, this.connectors)
    if (scope.missing) task.history.push(event('runner', 'note', `Couldn't list your connectors, so ${bot.name} runs without ${bot.tools.join(', ')} this time.`, at))
    // Variadic flags (--allowedTools, --disallowedTools, --tools) never sit right before the prompt.
    const args = [
      '--model', MODEL_IDS[model],
      '--effort', bot.effort ?? DEFAULT_EFFORT,
      '--mcp-config', mcpPath,
      ...(scope.strict ? ['--strict-mcp-config'] : []),
      ...(scope.deny.length ? ['--disallowedTools', scope.deny.join(',')] : []),
      '--allowedTools', CREW_TOOLS.join(','),
      '--tools', builtinTools(bot).join(','),
      '--append-system-prompt', botSystemPrompt(bot, bots, cfg, await s.memory(bot.slug)),
      '--permission-prompt-tool', 'mcp__bots__approval_prompt',
      '--setting-sources', cfg.settingSources,
      '--max-budget-usd', String(RUNAWAY_USD),
      taskPrompt(task),
    ]
    const watch = this.watch(cfg, () => this.kills.get(task.id)?.())
    const r = await runClaude(args, {
      cwd,
      env: { MCP_TOOL_TIMEOUT: String((cfg.approvalTimeoutMin + 1) * 60_000), BOTS_ROOT: s.root },
      timeoutMs: cfg.runTimeoutMin * 60_000,
      onSpawn: kill => this.kills.set(task.id, kill),
      onEvent: watch.onEvent,
    })
    this.kills.delete(task.id)

    const t = (await s.task(task.id)) ?? task
    const end = nowIso()
    const cost = r.json?.total_cost_usd ?? 0
    t.costUsd = Math.round((t.costUsd + cost) * 10000) / 10000
    if (cost) await s.addUsage(today(), bot.slug, cost)
    const models = Object.keys(r.json?.modelUsage ?? {}).join(', ') || 'none'
    const limited = watch.stopped ?? (r.json?.is_error && /usage limit|rate limit|limit reached/i.test(r.json.result ?? '') ? { reason: 'your plan reported its usage limit', perRun: false } : undefined)
    if (limited && !TERMINAL.includes(t.status) && t.status !== 'blocked') {
      if (limited.perRun) {
        t.status = 'blocked'
        t.result = `Paused because ${limited.reason}. Reply to let ${bot.name} continue, or raise the per-task share in Settings.`
      } else {
        t.status = 'queued'
        t.result = undefined
      }
      t.history.push(event('runner', 'limit', limited.perRun ? t.result ?? '' : `Paused: ${limited.reason}. It continues by itself after the reset.`, end))
      notify(`${bot.name} paused`, limited.reason)
    } else if (r.json?.subtype === 'error_max_budget_usd' && !TERMINAL.includes(t.status)) {
      t.status = 'blocked'
      t.result = `Stopped by the runaway guard: one run may not pass $${RUNAWAY_USD} at API prices. Reply to let ${bot.name} continue.`
      t.history.push(event('runner', 'blocked', t.result, end))
      notify(`${bot.name} stopped`, t.title)
    } else if (t.status === 'working' || t.status === 'needs_approval') {
      const ok = r.json && !r.json.is_error && !r.timedOut
      if (ok) finishOrReturn(t, bot.slug, (r.json?.result ?? '').slice(0, 4000), end)
      else {
        t.status = 'failed'
        t.result = r.timedOut
          ? `Stopped after ${cfg.runTimeoutMin} minutes.`
          : (r.json?.result ?? r.stderr.trim().split('\n').pop() ?? `claude exited with ${r.code}`).slice(0, 1000)
        t.history.push(event(bot.slug, t.status, t.result, end))
      }
    }
    t.updatedAt = end
    t.history.push(event('runner', 'note', `Run ${t.runs} ended: $${cost.toFixed(3)}, ${r.json?.num_turns ?? 0} turns, model ${models}`, end))
    await s.saveTask(t)
    await s.fs.remove(mcpPath)
    await this.after(t)
  }

  /** Sends a finished sub-task's result to its parent and tells the user about what needs them. */
  async after(t: Task): Promise<void> {
    if (t.status === 'blocked' && !t.parentId) return
    if (TERMINAL.includes(t.status) && t.parentId) {
      const parent = await this.s.task(t.parentId)
      if (parent) {
        const siblings = (await Promise.all(parent.children.map(id => this.s.task(id)))).filter((x): x is Task => !!x)
        childFinished(parent, t, siblings.map(x => (x.id === t.id ? t : x)), nowIso())
        await this.s.saveTask(parent)
      }
      return
    }
    if (t.status === 'done' || t.status === 'failed') await this.answer(t)
    if (t.status === 'done') notify(`Done: ${t.title}`, (t.result ?? '').slice(0, 180))
    if (t.status === 'failed') notify(`Failed: ${t.title}`, (t.result ?? '').slice(0, 180))
  }

  /** Posts a finished task's final answer as a reply in the chat it came from. */
  async answer(t: Task): Promise<void> {
    const slug = answerChat(t)
    if (!(await this.s.bot(slug))) return
    const thread = await readChat(this.s, slug)
    if (thread.messages.some(m => m.taskId === t.id && m.role === 'bot')) return
    const head = t.status === 'done' ? `**Done:** ${t.title}` : `**Couldn't finish:** ${t.title}`
    thread.messages.push({ id: makeId('m', Date.now()), role: 'bot', text: `${head}\n\n${t.result ?? ''}`.trim(), at: nowIso(), taskId: t.id })
    await saveChat(this.s, thread)
  }

  async startChats(gate: LimitCheck): Promise<void> {
    for (const name of await this.s.fs.list(this.s.path('chats'))) {
      if (!name.endsWith('.json') || this.chats.size >= CHAT_CONCURRENCY) continue
      const slug = name.slice(0, -5)
      if (this.chats.has(slug)) continue
      const thread = await readChat(this.s, slug)
      if (thread.status !== 'queued' || !unanswered(thread).length) continue
      if (!gate.ok) {
        const text = `Paused: ${gate.reason}. The reply comes after the reset.`
        if (thread.messages[thread.messages.length - 1]?.text !== text) {
          thread.messages.push({ id: makeId('m', Date.now()), role: 'system', text, at: nowIso() })
          await saveChat(this.s, thread)
        }
        continue
      }
      const run = this.chat(thread).finally(() => this.chats.delete(slug))
      this.chats.set(slug, run)
    }
  }

  /** Answers a bot's chat thread, continuing the same conversation so the bot keeps context. */
  async chat(thread: ChatThread): Promise<void> {
    const s = this.s
    const [cfg, bots, bot] = await Promise.all([s.config(), s.bots(), s.bot(thread.bot)])
    if (!bot) {
      thread.status = 'idle'
      thread.messages.push({ id: makeId('m', Date.now()), role: 'system', text: `There is no bot called ${thread.bot} any more.`, at: nowIso() })
      return saveChat(s, thread)
    }
    const asked = unanswered(thread)
    thread.status = 'thinking'
    await saveChat(s, thread)

    const mcpPath = s.path('run', `chat-${bot.slug}.mcp.json`)
    await s.writeJson(mcpPath, {
      mcpServers: { bots: { command: process.execPath, args: [join(RUNNER_DIR, 'mcp.ts')], env: { BOTS_ROOT: s.root, BOTS_BOT: bot.slug, BOTS_CHAT: '1', PATH: process.env.PATH ?? '' } } },
    })
    const cwd = expandHome(bot.workdir ?? s.path('workspace', bot.slug))
    const missing = await ensureWorkdir(cwd, s.root)
    if (missing) {
      const fresh = await readChat(s, bot.slug)
      for (const m of fresh.messages) if (asked.some(a => a.id === m.id)) m.answered = true
      fresh.messages.push({ id: makeId('m', Date.now()), role: 'system', text: missing, at: nowIso() })
      fresh.status = 'idle'
      await s.fs.remove(mcpPath)
      return saveChat(s, fresh)
    }
    const scope = mcpScope(bot, this.connectors)
    const base = [
      '--model', MODEL_IDS[bot.model],
      '--effort', bot.effort ?? DEFAULT_EFFORT,
      '--mcp-config', mcpPath,
      ...(scope.strict ? ['--strict-mcp-config'] : []),
      ...(scope.deny.length ? ['--disallowedTools', scope.deny.join(',')] : []),
      '--allowedTools', CHAT_TOOLS.join(','),
      '--tools', builtinTools(bot).join(','),
      '--append-system-prompt', chatSystemPrompt(bot, bots, cfg, await s.memory(bot.slug), this.servers),
      '--permission-prompt-tool', 'mcp__bots__approval_prompt',
      '--setting-sources', cfg.settingSources,
      '--max-budget-usd', String(RUNAWAY_USD),
    ]
    const text = asked.map(m => m.text).join('\n\n')
    const env = { MCP_TOOL_TIMEOUT: String((cfg.approvalTimeoutMin + 1) * 60_000), BOTS_ROOT: s.root }
    const timeoutMs = cfg.runTimeoutMin * 60_000
    let kill = () => {}
    const watch = this.watch(cfg, () => kill())
    const opts = { cwd, env, timeoutMs, onSpawn: (k: () => void) => (kill = k), onEvent: watch.onEvent }
    let r = await runClaude([...(thread.sessionId ? ['--resume', thread.sessionId] : []), ...base, text], opts)
    if (thread.sessionId && !watch.stopped && (!r.json || (r.json.is_error && r.json.subtype !== 'error_max_budget_usd'))) {
      // The saved conversation is gone (moved folder, cleared sessions): start again with recent history.
      const recent = thread.messages.slice(-12).map(m => `${m.role === 'you' ? 'User' : m.role === 'bot' ? bot.name : 'Note'}: ${m.text}`).join('\n')
      r = await runClaude([...base, `Recent conversation:\n${recent}\n\nReply to the user's latest message.`], opts)
    }
    await s.fs.remove(mcpPath)

    const cost = r.json?.total_cost_usd ?? 0
    if (cost) await s.addUsage(today(), bot.slug, cost)
    const fresh = await readChat(s, bot.slug)
    if (watch.stopped && !watch.stopped.perRun) {
      // Over the user's cap: leave the question unanswered so the reply comes after the reset.
      fresh.messages.push({ id: makeId('m', Date.now()), role: 'system', text: `Paused: ${watch.stopped.reason}. The reply comes after the reset.`, at: nowIso() })
      fresh.status = 'queued'
      return saveChat(s, fresh)
    }
    const reply =
      watch.stopped
        ? `I stopped because ${watch.stopped.reason}. Ask again to continue, or raise the per-task share in Settings.`
        : r.json?.subtype === 'error_max_budget_usd'
        ? `I stopped at the runaway guard ($${RUNAWAY_USD} at API prices for one reply). Ask again to continue.`
        : r.json && !r.json.is_error
          ? (r.json.result ?? '').trim() || '(no reply)'
          : `I couldn't reply: ${(r.json?.result ?? r.stderr.trim().split('\n').pop() ?? 'unknown error').slice(0, 300)}`
    const askedIds = new Set(asked.map(m => m.id))
    for (const m of fresh.messages) if (askedIds.has(m.id)) m.answered = true
    fresh.messages.push({ id: makeId('m', Date.now()), role: 'bot', text: reply, at: nowIso() })
    if (r.json?.session_id && !r.json.is_error) fresh.sessionId = r.json.session_id
    fresh.status = unanswered(fresh).length ? 'queued' : 'idle'
    await saveChat(s, fresh)
  }

  async drain(): Promise<void> {
    await Promise.all([...this.runs.values(), ...this.chats.values()])
  }
}

if (import.meta.main) {
  const store = openStore()
  const other = await store.runner()
  if (other && other.pid !== process.pid && Date.now() - Date.parse(other.heartbeat) < 20_000) {
    let alive = true
    try {
      process.kill(other.pid, 0)
    } catch {
      alive = false
    }
    if (alive) {
      console.error(`Another runner (pid ${other.pid}) is already working ${ROOT}. Stop it first: kill ${other.pid}`)
      process.exit(1)
    }
  }
  // The store holds email snippets, chat logs and the browser token: owner-only.
  await mkdir(store.root, { recursive: true, mode: 0o700 })
  await chmod(store.root, 0o700).catch(() => {})
  const runner = new Runner(store)
  await runner.recover()
  console.log(`Office Hours runner ${process.pid} watching ${ROOT}`)
  void runner.refreshConnectors().catch(() => {})
  const info = await webInfo(store)
  try {
    await startWeb(store, info)
    console.log(`Browser app: http://127.0.0.1:${info.port}/?token=${info.token}`)
  } catch (err) {
    console.error(`Browser app could not start on port ${info.port}: ${(err as Error).message}. Change "port" in ${ROOT}/web.json.`)
  }
  const loop = setInterval(() => void runner.tick().catch(err => console.error('tick failed', err)), TICK_MS)
  const stop = () => {
    clearInterval(loop)
    for (const kill of runner.kills.values()) kill()
    setTimeout(() => process.exit(0), 2000)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
