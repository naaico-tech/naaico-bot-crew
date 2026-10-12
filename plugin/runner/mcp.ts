// The crew's MCP server, started by `claude -p` for one bot run: either a
// task run (BOTS_TASK) or a chat with the user (BOTS_CHAT). It gives the bot
// its crew tools and answers every permission prompt of the run
// (approval_prompt), so approvals can wait for the user wherever they are.
import { createInterface } from 'node:readline'

import { assignChild, classify, DEFAULT_EFFORT, finishOrReturn, event, handoff, makeTask, mayDelegate, newId, readChat, ruleFor, saveChat, slugify, summarize, MODEL_LABELS, parseModel, TERMINAL } from './core.ts'
import type { Approval, Bot, Config, Proposal, Store, Task } from './core.ts'
import { notify, nowIso, openStore, runClaude, ROOT } from './node.ts'

const BOT = process.env.BOTS_BOT ?? ''
const TASK = process.env.BOTS_TASK ?? ''
const CHAT = !!process.env.BOTS_CHAT
const POLL_MS = Number(process.env.BOTS_POLL_MS ?? 1000)

type Args = Record<string, unknown>
type ToolResult = { text: string; isError?: boolean }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const obj = { type: 'object' } as const

const ALL_TOOLS = [
  { name: 'list_bots', description: 'List the bots in the crew with their jobs and models.', inputSchema: { ...obj, properties: {} } },
  { name: 'list_tasks', description: 'List recent tasks on the crew board with their status and owner.', inputSchema: { ...obj, properties: {} } },
  {
    name: 'handoff',
    description: 'Pass the current task to another bot with a note saying what is done and what is left. End your run right after.',
    inputSchema: { ...obj, properties: { to: { type: 'string', description: 'The bot slug, e.g. "manager"' }, note: { type: 'string' } }, required: ['to', 'note'] },
  },
  {
    name: 'assign_task',
    description: 'Create a sub-task for another bot. You are started again with its result. After assigning everything, end your run.',
    inputSchema: { ...obj, properties: { to: { type: 'string' }, title: { type: 'string' }, details: { type: 'string' } }, required: ['to', 'title', 'details'] },
  },
  {
    name: 'create_task',
    description: 'Queue real work on the crew board, for yourself or (if the crew rules allow) another bot. The background runner does it.',
    inputSchema: {
      ...obj,
      properties: { to: { type: 'string', description: 'Bot slug; leave out for yourself' }, title: { type: 'string' }, details: { type: 'string' }, model: { type: 'string', description: 'opus, sonnet, haiku or fable, to override for this task' } },
      required: ['title', 'details'],
    },
  },
  {
    name: 'propose_change',
    description:
      'Propose a change to the crew. It is shown to the user with Apply and Discard buttons and only happens if they apply it. ' +
      'action: create_bot | update_bot | delete_bot | add_routine | update_config. ' +
      'bot: {name, job, model, tools (connector labels or Code/Web search/Browser), canHandTo, workdir, instructions}. ' +
      'slug: the bot to update or delete. routine: {bot, schedule ("every 2h", "daily 08:30", "weekdays 09:00"), title, prompt}. ' +
      'config: {delegation, approvals, limits: {fiveHourPct, weeklyPct, perRunPct}, concurrency, paused}.',
    inputSchema: {
      ...obj,
      properties: {
        action: { type: 'string', enum: ['create_bot', 'update_bot', 'delete_bot', 'add_routine', 'update_config'] },
        summary: { type: 'string', description: 'One sentence the user reads on the Apply button card' },
        slug: { type: 'string' },
        bot: { type: 'object' },
        routine: { type: 'object' },
        config: { type: 'object' },
      },
      required: ['action', 'summary'],
    },
  },
  { name: 'complete_task', description: 'Mark the current task done with the result. End your run right after.', inputSchema: { ...obj, properties: { result: { type: 'string' } }, required: ['result'] } },
  { name: 'block_task', description: 'Pause the task until the user answers a question or supplies something. End your run right after.', inputSchema: { ...obj, properties: { question: { type: 'string' } }, required: ['question'] } },
  { name: 'remember', description: 'Save a lasting preference or correction to your memory.', inputSchema: { ...obj, properties: { fact: { type: 'string' } }, required: ['fact'] } },
  {
    name: 'approval_prompt',
    description: 'Internal: decides whether a tool call may run.',
    inputSchema: { ...obj, properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
  },
]

const CHAT_TOOLS = ['list_bots', 'list_tasks', 'create_task', 'propose_change', 'remember', 'approval_prompt']
const TASK_ONLY = ['handoff', 'assign_task', 'complete_task', 'block_task']

export function toolsFor(chat: boolean) {
  return ALL_TOOLS.filter(t => (chat ? CHAT_TOOLS.includes(t.name) : t.name !== 'propose_change'))
}

async function context(s: Store): Promise<{ cfg: Config; bots: Bot[]; me: Bot; task?: Task }> {
  const [cfg, bots, task] = await Promise.all([s.config(), s.bots(), TASK ? s.task(TASK) : Promise.resolve(undefined)])
  const me = bots.find(b => b.slug === BOT)
  if (!me) throw new Error(`No bot "${BOT}" in ${ROOT}`)
  if (!CHAT && !task) throw new Error(`No task "${TASK}" in ${ROOT}`)
  return { cfg, bots, me, task }
}

function isOwnedWork(task: Task): boolean {
  return task.owner === BOT && ['working', 'needs_approval', 'waiting'].includes(task.status)
}

export async function callTool(s: Store, name: string, args: Args): Promise<ToolResult> {
  const at = nowIso()
  const { cfg, bots, me, task } = await context(s)

  if (name === 'list_bots') {
    return { text: bots.map(b => `${b.slug}: ${b.name} (${MODEL_LABELS[b.model]}) - ${b.job}`).join('\n') }
  }
  if (name === 'list_tasks') {
    const list = (await s.tasks()).slice(-15).reverse()
    return { text: list.map(t => `${t.id} [${t.status}] ${t.owner}: ${t.title}${t.result ? ` → ${t.result.slice(0, 120)}` : ''}`).join('\n') || 'No tasks yet.' }
  }
  if (name === 'remember') {
    const fact = str(args.fact)
    if (!fact) return { text: 'fact is empty', isError: true }
    await s.remember(BOT, fact, at)
    return { text: 'Saved to memory.' }
  }
  if (name === 'approval_prompt') {
    return { text: JSON.stringify(await decide(s, cfg, me, task, str(args.tool_name), (args.input ?? {}) as Args)) }
  }
  if (name === 'create_task') {
    const to = slugify(str(args.to) || BOT)
    if (to !== BOT) {
      const may = mayDelegate(cfg, me, to, bots)
      if (!may.ok) return { text: may.reason, isError: true }
    }
    const t = makeTask({ id: newId('t', Date.now()), title: str(args.title), body: str(args.details) || str(args.title), owner: to, createdBy: CHAT ? `chat:${BOT}` : BOT, at, model: parseModel(str(args.model)) })
    await s.saveTask(t)
    if (CHAT) {
      const thread = await readChat(s, BOT)
      thread.messages.push({ id: newId('m', Date.now()), role: 'system', text: `Queued ${t.id} for ${to}: ${t.title}`, at, taskId: t.id })
      await saveChat(s, thread)
    }
    return { text: `Queued ${t.id} for ${to}. The runner will pick it up; results show on the board.` }
  }
  if (name === 'propose_change') {
    if (!CHAT) return { text: 'Crew changes can only be proposed in a chat with the user.', isError: true }
    const proposal: Proposal = {
      action: str(args.action) as Proposal['action'],
      summary: str(args.summary),
      slug: str(args.slug) || undefined,
      bot: (args.bot as Record<string, unknown>) ?? undefined,
      routine: (args.routine as Proposal['routine']) ?? undefined,
      config: (args.config as Record<string, unknown>) ?? undefined,
      state: 'pending',
    }
    const thread = await readChat(s, BOT)
    thread.messages.push({ id: newId('m', Date.now()), role: 'bot', text: proposal.summary, at, proposal })
    await saveChat(s, thread)
    return { text: 'Proposed. The user sees Apply and Discard buttons; tell them it is waiting for them.' }
  }

  if (!TASK_ONLY.includes(name)) return { text: `Unknown tool ${name}`, isError: true }
  if (!task) return { text: `${name} only works inside a task run.`, isError: true }
  if (!isOwnedWork(task)) return { text: `Task ${task.id} is ${task.status} and owned by ${task.owner}; stop now.`, isError: true }

  if (name === 'handoff') {
    const to = str(args.to).toLowerCase()
    const may = mayDelegate(cfg, me, to, bots)
    if (!may.ok) return { text: may.reason, isError: true }
    const moved = handoff(task, cfg, BOT, to, str(args.note), at)
    if (!moved.ok) return { text: moved.reason, isError: true }
    await s.saveTask(task)
    return { text: `Handed ${task.id} to ${to}. Stop now.` }
  }
  if (name === 'assign_task') {
    const to = str(args.to).toLowerCase()
    const may = mayDelegate(cfg, me, to, bots)
    if (!may.ok) return { text: may.reason, isError: true }
    const child = assignChild(task, cfg, BOT, to, str(args.title), str(args.details), newId('t', Date.now()), at)
    if ('error' in child) return { text: child.error, isError: true }
    task.status = 'waiting'
    await s.saveTask(child)
    await s.saveTask(task)
    return { text: `Assigned ${child.id} to ${to}. Its result will appear in this task's history.` }
  }
  if (name === 'complete_task') {
    const { returnedTo } = finishOrReturn(task, BOT, str(args.result), at)
    await s.saveTask(task)
    return { text: returnedTo ? `Done; returned to ${returnedTo}, who handed it to you. Stop now.` : 'Task done; the result goes to the user. Stop now.' }
  }
  // block_task
  const open = (await Promise.all(task.children.map(id => s.task(id)))).filter(c => c && !TERMINAL.includes(c.status))
  if (open.length) {
    task.status = 'waiting'
    task.updatedAt = at
    await s.saveTask(task)
    return { text: `${open.length} sub-task(s) are still running. You will be started again with their results; end your run now.` }
  }
  task.status = 'blocked'
  task.updatedAt = at
  task.history.push(event(BOT, 'blocked', str(args.question), at))
  await s.saveTask(task)
  notify(`${me.name} needs you`, str(args.question))
  return { text: 'Task blocked until the user replies. Stop now.' }
}

type Decision = { behavior: 'allow'; updatedInput: Args } | { behavior: 'deny'; message: string }

async function decide(s: Store, cfg: Config, me: Bot, task: Task | undefined, tool: string, input: Args): Promise<Decision> {
  const allow = (): Decision => ({ behavior: 'allow', updatedInput: input })
  let { verdict, reason } = classify(cfg, me, tool, input)
  if (verdict === 'review') verdict = await autoReview(me, task?.title ?? 'a chat with the user', tool, input)
  if (verdict === 'allow') return allow()
  if (verdict === 'deny') return { behavior: 'deny', message: reason }

  const at = nowIso()
  const approval: Approval = {
    id: newId('a', Date.now()),
    taskId: task?.id ?? `chat:${me.slug}`,
    bot: me.slug,
    tool,
    input,
    summary: summarize(tool, input),
    status: 'pending',
    createdAt: at,
  }
  await s.saveApproval(approval)
  await setTaskStatus(s, 'needs_approval', `Waiting for approval: ${approval.summary}`)
  notify(`${me.name} needs approval`, approval.summary)

  const deadline = Date.now() + cfg.approvalTimeoutMin * 60_000
  let answer = approval
  while (answer.status === 'pending' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS))
    answer = (await s.approval(approval.id)) ?? answer
  }
  if (answer.status === 'pending') {
    answer = { ...answer, status: 'denied', reason: 'No answer in time', decidedAt: nowIso() }
    await s.saveApproval(answer)
  }
  if (answer.status === 'allowed' && answer.always) {
    const fresh = await s.config()
    const rules = new Set(fresh.allow[me.slug] ?? [])
    rules.add(ruleFor(tool, input))
    fresh.allow[me.slug] = [...rules]
    await s.saveConfig(fresh)
  }
  await setTaskStatus(s, 'working', `${answer.status === 'allowed' ? 'Allowed' : 'Denied'}: ${approval.summary}`)
  return answer.status === 'allowed' ? allow() : { behavior: 'deny', message: answer.reason ?? 'The user denied this action.' }
}

async function setTaskStatus(s: Store, status: 'working' | 'needs_approval', text: string): Promise<void> {
  if (!TASK) return
  const t = await s.task(TASK)
  if (!t || !isOwnedWork(t)) return
  t.status = status
  t.updatedAt = nowIso()
  t.history.push(event(BOT, 'approval', text, t.updatedAt))
  await s.saveTask(t)
}

/** Auto Review: a fast model decides whether an unlisted action is safe to run unasked. */
async function autoReview(me: Bot, doing: string, tool: string, input: Args): Promise<'allow' | 'ask'> {
  if (process.env.BOTS_NO_REVIEW) return 'ask'
  const prompt = [
    `A bot named ${me.name} (job: ${me.job}) is working on: ${doing}.`,
    `It wants to run ${summarize(tool, input)}.`,
    'Answer ALLOW if this is routine, reversible and within the job (reading, drafting, editing files in its working folder, running tests).',
    'Answer ASK if it sends or publishes anything, deletes data, spends money, changes accounts or settings, touches files outside the job, or you are unsure.',
    'Reply with one word: ALLOW or ASK.',
  ].join('\n')
  const r = await runClaude(['--tools', '', '--model', 'haiku', '--effort', DEFAULT_EFFORT, '--strict-mcp-config', '--setting-sources', 'project', prompt], { cwd: ROOT, timeoutMs: 60_000 })
  return r.json && !r.json.is_error && /^\s*ALLOW\b/i.test(r.json.result ?? '') ? 'allow' : 'ask'
}

// ---------- minimal MCP stdio server ----------

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function fail(id: unknown, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

async function handle(s: Store, msg: { id?: unknown; method?: string; params?: Record<string, unknown> }): Promise<void> {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, { protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bots', version: '0.2.0' } })
  }
  if (method === 'tools/list') return reply(id, { tools: toolsFor(CHAT) })
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/call') {
    try {
      const r = await callTool(s, String(params?.name), (params?.arguments ?? {}) as Args)
      return reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError ?? false })
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: String(err) }], isError: true })
    }
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`)
}

if (import.meta.main) {
  const s = openStore()
  const rl = createInterface({ input: process.stdin })
  rl.on('line', line => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return fail(null, -32700, 'Parse error')
    }
    void handle(s, msg)
  })
}
