// The crew's control surface inside Claude Code: the Bots pane, /bot commands
// and @Bot mentions. It reads and writes the shared store (~/.claude/bots);
// the background runner does the work, so nothing here depends on the session
// staying open.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import {
  checkLimits,
  currentPercent,
  event,
  makeTask,
  newId,
  parseMention,
  parseModel,
  parseSchedule,
  slugify,
  splitList,
  titleFrom,
  MODEL_LABELS,
  Store,
  TERMINAL,
  windowsFromSession,
} from './core.ts'
import type { Approval, Bot, Fs, ModelName, Routine, Task } from './core.ts'
import type { Snapshot } from '../types'

const PANE = 'bots'
const EMPTY: Snapshot = { bots: [], tasks: [], approvals: [], runner: 'stopped', paused: false, usage: '', updatedAt: '' }
const snapshot = atom({ plugin: 'naaico-bot-crew', key: 'snapshot' } as const, EMPTY)

const HELP = `Bot crew commands:
  @Bot <request>                 give a bot a task (add [opus|sonnet|haiku|fable] after the name to change its model for this task)
  /bot assign [Bot] <request>    same; with no bot, the Manager takes it
  /bot list                      your bots, their models and what they are doing
  /bot new Name | model | job | connectors | can hand to
  /bot model <Bot> <model>       change a bot's model
  /bot job <Bot> <job>           change a bot's job
  /bot delete <Bot>
  /bot tasks                     recent tasks      /bot show <task>
  /bot reply <task> <answer>     answer a blocked task
  /bot cancel <task>
  /bot approve <id> [always]     /bot deny <id> [reason]
  /bot remember <Bot> <fact>
  /bot routine add <Bot> | <schedule> | <title> | <instructions>
  /bot routine list | pause <id> | resume <id> | delete <id>
  /bot teach <Bot> | <schedule> | <title>   turn this conversation into a routine
  /bot pause | resume            stop or restart the runner picking up work
  /bot runner                    is the background runner alive?
  /bot pane                      open the Bots pane
  /bot web                       link to the browser app (chat, bot builder, board)
Schedules: "every 30m", "daily 08:30", "weekdays 09:00", "mon,wed 10:15".`

async function storeFor($: any): Promise<Store> {
  const root = (await $.env.get('BOTS_ROOT')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude/bots`
  const fs: Fs = {
    read: async p => ((await $.fs.exists(p)) ? await $.fs.read(p) : undefined),
    write: (p, t) => $.fs.write(p, t),
    list: async d => ((await $.fs.exists(d)) ? (await $.fs.list(d)).map((x: { name: string }) => x.name) : []),
    remove: async p => {
      await $.process.run(['rm', '-f', p])
    },
  }
  return new Store(root, fs)
}

function findBot(bots: Bot[], name: string): Bot | undefined {
  const key = name.trim().toLowerCase()
  return bots.find(b => b.slug === slugify(key) || b.name.toLowerCase() === key)
}

/** Splits "Bug fixer rest of text" into the bot and the rest, longest name first. */
function botAndRest(bots: Bot[], text: string): { bot?: Bot; rest: string } {
  const lower = text.trim().toLowerCase()
  for (const b of [...bots].sort((x, y) => y.name.length - x.name.length)) {
    for (const key of [b.name.toLowerCase(), b.slug]) {
      if (lower === key || lower.startsWith(key + ' ')) return { bot: b, rest: text.trim().slice(key.length).trim() }
    }
  }
  return { rest: text.trim() }
}

async function byPrefix<T extends { id: string }>(list: T[], id: string): Promise<T | undefined> {
  const hits = list.filter(x => x.id === id || x.id.startsWith(id))
  return hits.length === 1 ? hits[0] : list.find(x => x.id === id)
}

async function assign(s: Store, bot: Bot, text: string, model: ModelName | undefined, now: Date): Promise<Task> {
  const t = makeTask({ id: newId('t', now.getTime()), title: titleFrom(text), body: text, owner: bot.slug, createdBy: 'you', at: now.toISOString(), model })
  await s.saveTask(t)
  return t
}

async function decide(s: Store, id: string, allowed: boolean, always: boolean, reason?: string): Promise<string> {
  const a = await byPrefix((await s.approvals()).filter(x => x.status === 'pending'), id)
  if (!a) return `No pending approval ${id}.`
  const next: Approval = { ...a, status: allowed ? 'allowed' : 'denied', always: allowed && always, reason, decidedAt: new Date().toISOString() }
  await s.saveApproval(next)
  return `${allowed ? (always ? 'Always allowed' : 'Allowed') : 'Denied'} for ${a.bot}: ${a.summary}`
}

function usageLine(w: Awaited<ReturnType<Store['usageWindows']>>, limits: { fiveHourPct: number; weeklyPct: number; perRunPct: number }, now: Date): string {
  if (!w) return `Plan usage: no reading yet · crew stops at ${limits.fiveHourPct}% (5-hour) / ${limits.weeklyPct}% (week)`
  const gate = checkLimits(w, limits, now)
  const line = `Plan usage: 5-hour ${currentPercent(w.fiveHour, now)}% of ${limits.fiveHourPct}% · week ${currentPercent(w.weekly, now)}% of ${limits.weeklyPct}%`
  return gate.ok ? line : `${line} · crew paused: ${gate.reason}`
}

/** Hands Claude Code's own readings of the plan windows to the crew, which shares them. */
async function recordWindows($: any, rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[] | undefined): Promise<void> {
  const w = windowsFromSession(rateLimits ?? [], new Date(await $.clock.now()).toISOString())
  if (w) await (await storeFor($)).saveUsageWindows(w)
}

async function snap(s: Store, now: Date): Promise<Snapshot> {
  const [bots, tasks, approvals, runner, cfg, windows] = await Promise.all([s.bots(), s.tasks(), s.approvals(), s.runner(), s.config(), s.usageWindows()])
  const alive = !!runner && now.getTime() - new Date(runner.heartbeat).getTime() < 20_000
  const open = tasks.filter(t => !TERMINAL.includes(t.status))
  return {
    bots: bots.map(b => {
      const mine = open.filter(t => t.owner === b.slug)
      const active = mine.find(t => t.status === 'working' || t.status === 'needs_approval')
      const activity = active
        ? `${active.status === 'needs_approval' ? 'needs approval' : 'working'}: ${active.title}`
        : mine.length
          ? `${mine.length} ${mine[0].status}`
          : 'idle'
      return { slug: b.slug, name: b.name, model: MODEL_LABELS[b.model], job: b.job, isManager: !!b.isManager, activity }
    }),
    tasks: tasks
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 12)
      .map(t => ({ id: t.id, title: t.title, owner: t.owner, status: t.status, updatedAt: t.updatedAt, last: t.history[t.history.length - 1]?.text ?? '' })),
    approvals: approvals.filter(a => a.status === 'pending').map(a => ({ id: a.id, bot: a.bot, taskId: a.taskId, summary: a.summary })),
    runner: alive ? 'running' : 'stopped',
    paused: cfg.paused,
    usage: usageLine(windows, cfg.limits, now),
    updatedAt: now.toISOString(),
  }
}

export async function runCommand($: any, args: string, now: Date = new Date()): Promise<string> {
  const s = await storeFor($)
  const [sub = '', ...restWords] = args.trim().split(/\s+/)
  const rest = args.trim().slice(sub.length).trim()
  const bots = await s.bots()
  const cfg = await s.config()

  switch (sub.toLowerCase()) {
    case '':
    case 'help':
      return HELP
    case 'web': {
      const info = await s.readJson<{ port?: number; token?: string }>(s.path('web.json'), {})
      if (!info.token) return 'The browser app starts with the runner: cd ~/workspaces/claude-bots && npm run runner'
      const live = (await snap(s, now)).runner === 'running'
      return `${live ? '' : 'The runner is not running, so this link will not open until you start it (npm run runner).\n'}Browser app: http://127.0.0.1:${info.port ?? 4545}/?token=${info.token}`
    }
    case 'pane':
      await $.ui.open({ id: PANE, title: 'Bots' })
      return 'Bots pane opened.'
    case 'list':
      if (!bots.length) return 'No bots yet. Run `node runner/setup.ts` in ~/workspaces/claude-bots, or /bot new.'
      return (await snap(s, now)).bots.map(b => `${b.name} (${b.slug}) · ${b.model} · ${b.activity}\n  ${b.job}`).join('\n')
    case 'new': {
      const [name, model, job, connectors, handTo] = rest.split('|').map(x => x.trim())
      const m = parseModel(model)
      if (!name || !m || !job) return 'Usage: /bot new Name | model | job | connectors | can hand to\nExample: /bot new Recruiter | sonnet | Screen inbound candidates | Gmail, Calendar | manager'
      const slug = slugify(name)
      if (bots.some(b => b.slug === slug)) return `There's already a bot called ${name}.`
      const bot: Bot = { slug, name, job, model: m, tools: splitList(connectors), canHandTo: splitList(handTo).map(slugify) }
      await s.saveBot(bot)
      return `Created ${name} on ${MODEL_LABELS[m]}. Give it work with @${name} <request>.`
    }
    case 'model': {
      const { bot, rest: modelText } = botAndRest(bots, rest)
      const m = parseModel(modelText)
      if (!bot || !m) return 'Usage: /bot model <Bot> <opus|sonnet|haiku|fable>'
      await s.saveBot({ ...bot, model: m })
      return `${bot.name} now runs on ${MODEL_LABELS[m]}.`
    }
    case 'job': {
      const { bot, rest: job } = botAndRest(bots, rest)
      if (!bot || !job) return 'Usage: /bot job <Bot> <new job>'
      await s.saveBot({ ...bot, job })
      return `Updated ${bot.name}'s job.`
    }
    case 'delete': {
      const bot = findBot(bots, rest)
      if (!bot) return `No bot called ${rest}.`
      if (bot.slug === cfg.managerSlug) return 'The Manager hands out all work, so it cannot be deleted.'
      await s.removeBot(bot.slug)
      return `Deleted ${bot.name}. Its memory and task history are kept.`
    }
    case 'assign': {
      const mention = parseMention('@' + rest, bots)
      if (mention) return confirmAssign(await assign(s, mention.bot, mention.text, mention.model, now), mention.bot)
      const manager = bots.find(b => b.slug === cfg.managerSlug)
      if (!manager || !rest) return 'Usage: /bot assign [Bot] <request>'
      return confirmAssign(await assign(s, manager, rest, undefined, now), manager)
    }
    case 'tasks': {
      const rows = (await snap(s, now)).tasks
      return rows.length ? rows.map(t => `${t.id}  ${t.status.padEnd(14)} ${t.owner.padEnd(10)} ${t.title}`).join('\n') : 'No tasks yet.'
    }
    case 'show': {
      const t = await byPrefix(await s.tasks(), restWords[0] ?? '')
      if (!t) return `No task ${restWords[0] ?? ''}.`
      const lines = t.history.map(e => `${e.at.slice(5, 16).replace('T', ' ')}  ${e.actor}: ${e.text}`)
      return [`${t.id} · ${t.status} · ${t.owner} · $${t.costUsd.toFixed(3)}`, t.title, '', ...lines, t.result ? `\nResult: ${t.result}` : ''].join('\n')
    }
    case 'reply': {
      const t = await byPrefix(await s.tasks(), restWords[0] ?? '')
      const answer = rest.slice((restWords[0] ?? '').length).trim()
      if (!t || !answer) return 'Usage: /bot reply <task> <answer>'
      if (TERMINAL.includes(t.status)) return `${t.id} is ${t.status}; start a new task instead.`
      t.history.push(event('you', 'reply', answer, now.toISOString()))
      if (t.status === 'blocked') t.status = 'queued'
      t.updatedAt = now.toISOString()
      await s.saveTask(t)
      return `Sent to ${t.owner}; ${t.id} is ${t.status}.`
    }
    case 'cancel': {
      const t = await byPrefix(await s.tasks(), restWords[0] ?? '')
      if (!t) return `No task ${restWords[0] ?? ''}.`
      t.status = 'cancelled'
      t.history.push(event('you', 'cancelled', 'Cancelled by you', now.toISOString()))
      t.updatedAt = now.toISOString()
      await s.saveTask(t)
      return `Cancelled ${t.id}.`
    }
    case 'approve':
      return decide(s, restWords[0] ?? '', true, restWords[1] === 'always')
    case 'deny':
      return decide(s, restWords[0] ?? '', false, false, restWords.slice(1).join(' ') || undefined)
    case 'remember': {
      const { bot, rest: fact } = botAndRest(bots, rest)
      if (!bot || !fact) return 'Usage: /bot remember <Bot> <fact>'
      await s.remember(bot.slug, fact, now.toISOString())
      return `${bot.name} will remember that.`
    }
    case 'routine':
      return routineCommand(s, bots, rest, now)
    case 'teach': {
      const [who, schedule, title] = rest.split('|').map(x => x.trim())
      const bot = findBot(bots, who ?? '')
      if (!bot || !schedule || !parseSchedule(schedule) || !title) return 'Usage: /bot teach <Bot> | <schedule> | <title>'
      const r = await $.model.fork({
        prompt: `Turn what we did in this conversation into a routine ${bot.name} can repeat on its own: numbered steps, the tools to use, what to check, and when to stop and ask the user. Write only the routine.`,
      })
      if (!r.isAnswered) return `Could not read this conversation (${r.reason}).`
      return addRoutine(s, bot, schedule, title, r.text, now)
    }
    case 'pause':
    case 'resume':
      await s.saveConfig({ ...cfg, paused: sub === 'pause' })
      return sub === 'pause' ? 'Runner paused: running tasks finish, nothing new starts.' : 'Runner resumed.'
    case 'runner': {
      const r = await s.runner()
      const st = await snap(s, now)
      return st.runner === 'running'
        ? `Runner is running (pid ${r?.pid}, ${r?.running.length ?? 0} task(s) in progress)${st.paused ? ', paused' : ''}.`
        : `Runner is not running${r ? ` (last seen ${r.heartbeat})` : ''}. Start it: node ~/workspaces/claude-bots/runner/main.ts`
    }
    default:
      return `Unknown subcommand "${sub}".\n\n${HELP}`
  }
}

function confirmAssign(t: Task, bot: Bot): string {
  return `Sent to ${bot.name}${t.model ? ` on ${MODEL_LABELS[t.model]}` : ''} as ${t.id}. Track it in the Bots pane or with /bot show ${t.id}.`
}

async function addRoutine(s: Store, bot: Bot, schedule: string, title: string, prompt: string, now: Date): Promise<string> {
  const list = await s.routines()
  const r: Routine = { id: newId('r', now.getTime()), bot: bot.slug, title, prompt, schedule, paused: false, createdAt: now.toISOString() }
  await s.saveRoutines([...list, r])
  return `Routine ${r.id} "${title}" for ${bot.name}: ${schedule}.`
}

async function routineCommand(s: Store, bots: Bot[], rest: string, now: Date): Promise<string> {
  const [verb = 'list', id = ''] = rest.split(/\s+/)
  const list = await s.routines()
  if (verb === 'list') {
    return list.length ? list.map(r => `${r.id}  ${r.paused ? 'paused ' : ''}${r.schedule}  ${r.bot}: ${r.title}`).join('\n') : 'No routines yet.'
  }
  if (verb === 'add') {
    const [who, schedule, title, prompt] = rest.slice(3).split('|').map(x => x.trim())
    const bot = findBot(bots, who ?? '')
    if (!bot || !schedule || !title || !prompt) return 'Usage: /bot routine add <Bot> | <schedule> | <title> | <instructions>'
    if (!parseSchedule(schedule)) return `Can't read the schedule "${schedule}". Try "every 2h", "daily 08:30" or "weekdays 09:00".`
    return addRoutine(s, bot, schedule, title, prompt, now)
  }
  const r = await byPrefix(list, id)
  if (!r) return `No routine ${id}.`
  if (verb === 'pause' || verb === 'resume') r.paused = verb === 'pause'
  const next = verb === 'delete' ? list.filter(x => x.id !== r.id) : list
  if (!['pause', 'resume', 'delete'].includes(verb)) return 'Usage: /bot routine list | pause <id> | resume <id> | delete <id>'
  await s.saveRoutines(next)
  return `${verb === 'delete' ? 'Deleted' : verb === 'pause' ? 'Paused' : 'Resumed'} ${r.title}.`
}

const seen = new Set<string>()
let cancelTimer: (() => void) | undefined

async function refresh($: any): Promise<void> {
  const s = await storeFor($)
  const next = await snap(s, new Date(await $.clock.now()))
  await update($, snapshot, () => next)
  for (const a of next.approvals) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    $.ui.toast(`${a.bot} needs approval: ${a.summary}`)
  }
  const working = next.bots.filter(b => b.activity.startsWith('working')).length
  const waiting = next.approvals.length
  $.ui.status(
    next.runner === 'stopped'
      ? 'bots: runner stopped'
      : `bots: ${working} working${waiting ? ` · ${waiting} need approval` : ''}${next.paused ? ' · paused' : ''}`,
  )
}

async function decideAndRefresh($: any, id: string, allowed: boolean, always: boolean): Promise<void> {
  await decide(await storeFor($), id, allowed, always)
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'bot', description: 'Your bot crew: assign tasks, manage bots and models, approve actions' })
    void $.ui.open({ id: PANE, title: 'Bots' })
    cancelTimer?.()
    cancelTimer = $.clock.every(3000, () => void refresh($).catch(() => {}))
    void $.session.usage().then((u: { rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[] }) => recordWindows($, u.rateLimits)).catch(() => {})
    void refresh($).catch(() => {})
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await recordWindows($, e.rateLimits).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'bot' }, async ($, e) => {
    const text = await runCommand($, e.args)
    void refresh($).catch(() => {})
    return { text }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.text.trimStart().startsWith('@')) return next(e)
    const s = await storeFor($)
    const mention = parseMention(e.text, await s.bots())
    if (!mention) return next(e)
    const t = await assign(s, mention.bot, mention.text, mention.model, new Date(await $.clock.now()))
    void refresh($).catch(() => {})
    return { drop: confirmAssign(t, mention.bot) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const st = await read($, snapshot)
    return (
      <Box flexDirection="column">
        <Text dimColor>Chat and build bots in the browser: /bot web</Text>
        <Text dimColor>{st.usage}</Text>
        <Text bold>
          Runner: {st.runner}
          {st.paused ? ' (paused)' : ''}
        </Text>
        {st.approvals.length > 0 && <Text bold>Needs your approval</Text>}
        {st.approvals.map(a => (
          <Box key={`ap-${a.id}`} flexDirection="column">
            <Text>
              {a.bot}: {a.summary}
            </Text>
            <Box>
              <Button key={`ok-${a.id}`} label="Allow once" onPress={() => decideAndRefresh($, a.id, true, false)} />
              <Button key={`al-${a.id}`} label="Always allow" onPress={() => decideAndRefresh($, a.id, true, true)} />
              <Button key={`no-${a.id}`} label="Deny" onPress={() => decideAndRefresh($, a.id, false, false)} />
            </Box>
          </Box>
        ))}
        <Text bold>Bots</Text>
        {st.bots.length === 0 && <Text dimColor>No bots yet. /bot new Name | model | job</Text>}
        {st.bots.map(b => (
          <Text key={`b-${b.slug}`}>
            {b.name} · {b.model} · {b.activity}
          </Text>
        ))}
        <Text bold>Recent tasks</Text>
        {st.tasks.length === 0 && <Text dimColor>Give a bot work: @Inbox triage today's email</Text>}
        {st.tasks.slice(0, 8).map(t => (
          <Text key={`t-${t.id}`} dimColor={t.status === 'done' || t.status === 'cancelled'} wrap="truncate-end">
            {t.status} · {t.owner} · {t.title}
          </Text>
        ))}
      </Box>
    )
  })
}
