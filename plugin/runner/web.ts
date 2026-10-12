// The crew's browser app, served by the runner on 127.0.0.1 so it works
// whether or not Claude Code is open. A token in web.json guards it: the
// link carries it once, then an HttpOnly cookie does. Writes also need the
// X-Bots header (a cross-site page can't send one without CORS) and a
// localhost Host header (no DNS rebinding).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { extname, join, sep } from 'node:path'

import {
  ABILITIES,
  applyProposal,
  DEFAULT_EFFORT,
  EFFORTS,
  checkLimits,
  currentPercent,
  botFromInput,
  event,
  isAvailable,
  makeTask,
  MODEL_LABELS,
  nextRun,
  newId,
  parseModel,
  parseSchedule,
  postToChat,
  readChat,
  saveChat,
  slugify,
  TERMINAL,
  titleFrom,
} from './core.ts'
import type { Approval, ChatThread, Connector, Store, UsageLimits, UsageWindows } from './core.ts'
import { expandHome, nowIso, RUNNER_DIR } from './node.ts'

export type WebInfo = { port: number; token: string }

export async function webInfo(s: Store): Promise<WebInfo> {
  const saved = await s.readJson<Partial<WebInfo>>(s.path('web.json'), {})
  const info = { port: saved.port ?? 4545, token: saved.token ?? randomBytes(24).toString('hex') }
  if (saved.port !== info.port || saved.token !== info.token) await s.writeJson(s.path('web.json'), info)
  await chmod(s.path('web.json'), 0o600).catch(() => {})
  return info
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function sameToken(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 200_000) throw new HttpError(413, 'Too much data.')
  }
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'Send JSON.')
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

/** Everything the page shows, in one snapshot. */
export async function buildState(s: Store) {
  const [bots, tasks, approvals, routines, cfg, windows, runner, conn] = await Promise.all([
    s.bots(),
    s.tasks(),
    s.approvals(),
    s.routines(),
    s.config(),
    s.usageWindows(),
    s.runner(),
    s.readJson<{ servers?: Connector[]; checkedAt?: string }>(s.path('connectors.json'), {}),
  ])
  const seen = await s.readJson<Record<string, string>>(s.path('seen.json'), {})
  const pending = approvals.filter(a => a.status === 'pending')
  const chats: Record<string, { status: string; count: number; lastAt?: string; unread: number; approvals: number }> = {}
  for (const b of bots) {
    const t = await readChat(s, b.slug)
    const since = seen[b.slug] ?? ''
    chats[b.slug] = {
      status: t.status,
      count: t.messages.length,
      lastAt: t.messages[t.messages.length - 1]?.at,
      unread: t.messages.filter(m => m.role !== 'you' && m.at > since).length,
      approvals: pending.filter(a => a.bot === b.slug).length,
    }
  }
  const open = tasks.filter(t => !TERMINAL.includes(t.status))
  return {
    bots: bots.map(b => {
      const mine = open.filter(t => t.owner === b.slug)
      const active = mine.find(t => t.status === 'working' || t.status === 'needs_approval')
      return {
        ...b,
        modelLabel: MODEL_LABELS[b.model],
        state: active?.status ?? (chats[b.slug]?.status === 'thinking' ? 'chatting' : mine.length ? 'queued' : 'idle'),
        activity: active?.title ?? (mine.length ? `${mine.length} queued` : ''),
      }
    }),
    tasks: tasks
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 80)
      .map(t => ({ id: t.id, title: t.title, owner: t.owner, status: t.status, updatedAt: t.updatedAt, createdBy: t.createdBy, parentId: t.parentId, costUsd: t.costUsd, result: t.result?.slice(0, 400), last: t.history[t.history.length - 1]?.text.slice(0, 200) })),
    approvals: approvals.filter(a => a.status === 'pending'),
    routines: routines.map(r => {
      const sched = parseSchedule(r.schedule)
      const next = sched && !r.paused ? nextRun(sched, r.lastRunAt ?? r.createdAt, new Date()) : undefined
      return { ...r, nextRunAt: next?.toISOString() }
    }),
    config: { delegation: cfg.delegation, approvals: cfg.approvals, limits: cfg.limits, concurrency: cfg.concurrency, paused: cfg.paused, managerSlug: cfg.managerSlug },
    connectors: (conn.servers ?? []).map(c => ({ label: c.label, status: c.status, available: isAvailable(c) })),
    connectorsCheckedAt: conn.checkedAt,
    abilities: ABILITIES,
    models: Object.entries(MODEL_LABELS).map(([id, label]) => ({ id, label })),
    efforts: EFFORTS,
    defaultEffort: DEFAULT_EFFORT,
    runner: { alive: !!runner && Date.now() - Date.parse(runner.heartbeat) < 20_000, pid: runner?.pid },
    chats,
    usage: usageView(windows, cfg.limits, new Date()),
  }
}

/** The plan windows as the page shows them: percent used now (0 once a window has reset), the cap, and why the crew is paused if it is. */
function usageView(w: UsageWindows | undefined, limits: UsageLimits, now: Date) {
  const one = (win: UsageWindows['fiveHour'], cap: number) => (win ? { percent: currentPercent(win, now), cap, resetsAt: win.resetsAt } : { percent: undefined, cap, resetsAt: undefined })
  const gate = checkLimits(w, limits, now)
  return {
    fiveHour: one(w?.fiveHour, limits.fiveHourPct),
    weekly: one(w?.weekly, limits.weeklyPct),
    perRunPct: limits.perRunPct,
    observedAt: w?.observedAt,
    source: w?.source,
    paused: gate.ok ? undefined : gate.reason,
  }
}

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
}

/**
 * Serves an image or video a bot made, so chat can show it. Only media types, and only
 * from inside the crew store or a bot's working folder (symlinks resolved first).
 * Supports byte ranges so videos can seek.
 */
async function serveFile(s: Store, req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
  const type = MEDIA_TYPES[extname(raw).slice(1).toLowerCase()]
  if (!type) throw new HttpError(404, 'Only images and video can be shown.')
  const file = await realpath(expandHome(raw)).catch(() => undefined)
  if (!file) throw new HttpError(404, 'File not found.')
  const roots = [s.root, ...(await s.bots()).map(b => b.workdir).filter((w): w is string => !!w).map(expandHome)]
  const real = (await Promise.all(roots.map(r => realpath(r).catch(() => undefined)))).filter((r): r is string => !!r)
  if (!real.some(r => file === r || file.startsWith(r.endsWith(sep) ? r : r + sep))) throw new HttpError(403, 'That file is outside the bots\' folders.')
  const info = await stat(file)
  if (!info.isFile()) throw new HttpError(404, 'File not found.')
  const headers: Record<string, string | number> = {
    'content-type': type,
    'cache-control': 'private, max-age=60',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : info.size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : info.size - 1
    start = Math.max(0, start)
    end = Math.min(info.size - 1, end)
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` })
      return void res.end()
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 })
    return void createReadStream(file, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...headers, 'content-length': info.size })
  createReadStream(file).pipe(res)
}

async function decide(s: Store, id: string, decision: string): Promise<Approval> {
  const a = await s.approval(id)
  if (!a || a.status !== 'pending') throw new HttpError(404, 'That approval is no longer waiting.')
  if (!['allow', 'always', 'deny'].includes(decision)) throw new HttpError(400, 'decision must be allow, always or deny.')
  const next: Approval = { ...a, status: decision === 'deny' ? 'denied' : 'allowed', always: decision === 'always', decidedAt: nowIso() }
  await s.saveApproval(next)
  return next
}

async function route(s: Store, req: IncomingMessage, url: URL): Promise<unknown> {
  const parts = url.pathname.split('/').filter(Boolean).slice(1) // after "api"
  const method = req.method ?? 'GET'
  const at = nowIso()
  const [noun, id, sub, subId] = parts
  if ([id, subId].some(x => x !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(x))) throw new HttpError(404, 'Not found.')

  if (noun === 'state' && method === 'GET') return buildState(s)

  if (noun === 'chats' && id) {
    const bot = await s.bot(id)
    if (!bot) throw new HttpError(404, `No bot called ${id}.`)
    if (method === 'GET' && !sub) return readChat(s, id)
    if (method === 'POST' && !sub) {
      const text = String((await body(req)).text ?? '').trim()
      if (!text) throw new HttpError(400, 'Type a message first.')
      await postToChat(s, id, text, at)
      return readChat(s, id)
    }
    if (method === 'POST' && sub === 'seen') {
      // Read state lives apart from the thread, so marking a chat read never races the runner's replies.
      const seen = await s.readJson<Record<string, string>>(s.path('seen.json'), {})
      seen[id] = at
      await s.writeJson(s.path('seen.json'), seen)
      return { seen: at }
    }
    if (method === 'DELETE' && !sub) {
      const cleared: ChatThread = { bot: id, status: 'idle', messages: [] }
      await saveChat(s, cleared)
      return cleared
    }
    if (method === 'POST' && sub === 'proposals' && subId) {
      const { apply } = await body(req)
      const thread = await readChat(s, id)
      const msg = thread.messages.find(m => m.id === subId)
      if (!msg?.proposal || msg.proposal.state !== 'pending') throw new HttpError(404, 'That proposal is no longer waiting.')
      if (apply) {
        try {
          msg.proposal.outcome = await applyProposal(s, msg.proposal, at)
          msg.proposal.state = 'applied'
        } catch (err) {
          msg.proposal.outcome = (err as Error).message
          msg.proposal.state = 'failed'
        }
      } else {
        msg.proposal.state = 'discarded'
        msg.proposal.outcome = 'Discarded.'
      }
      thread.messages.push({ id: newId('m', Date.now()), role: 'system', text: `${msg.proposal.state === 'applied' ? 'Applied' : msg.proposal.state === 'failed' ? 'Could not apply' : 'Discarded'}: ${msg.proposal.outcome}`, at })
      await saveChat(s, thread)
      return thread
    }
  }

  if (noun === 'bots') {
    if (method === 'POST' && !id) {
      const bot = botFromInput(await body(req))
      if (await s.bot(bot.slug)) throw new HttpError(409, `There's already a bot called ${bot.name}.`)
      await s.saveBot(bot)
      return bot
    }
    const existing = id ? await s.bot(id) : undefined
    if (!existing) throw new HttpError(404, `No bot called ${id}.`)
    if (method === 'PUT') {
      const bot = botFromInput(await body(req), existing)
      await s.saveBot({ ...bot, slug: existing.slug })
      return bot
    }
    if (method === 'DELETE') {
      if (existing.slug === (await s.config()).managerSlug) throw new HttpError(400, 'The Manager hands out all work, so it cannot be deleted.')
      await s.removeBot(existing.slug)
      return { deleted: existing.slug }
    }
  }

  if (noun === 'tasks') {
    if (method === 'POST' && !id) {
      const b = await body(req)
      const text = String(b.text ?? '').trim()
      const owner = slugify(String(b.owner ?? (await s.config()).managerSlug))
      if (!text) throw new HttpError(400, 'Describe the task first.')
      if (!(await s.bot(owner))) throw new HttpError(404, `No bot called ${owner}.`)
      const t = makeTask({ id: newId('t', Date.now()), title: titleFrom(text), body: text, owner, createdBy: 'you', at, model: parseModel(String(b.model ?? '')) })
      await s.saveTask(t)
      return t
    }
    const t = id ? await s.task(id) : undefined
    if (!t) throw new HttpError(404, `No task ${id}.`)
    if (method === 'GET' && !sub) return t
    if (method === 'POST' && sub === 'reply') {
      const text = String((await body(req)).text ?? '').trim()
      if (!text) throw new HttpError(400, 'Type a reply first.')
      if (TERMINAL.includes(t.status)) throw new HttpError(400, `${t.id} is ${t.status}; start a new task instead.`)
      t.history.push(event('you', 'reply', text, at))
      if (t.status === 'blocked') t.status = 'queued'
      t.updatedAt = at
      await s.saveTask(t)
      return t
    }
    if (method === 'POST' && sub === 'cancel') {
      t.status = 'cancelled'
      t.history.push(event('you', 'cancelled', 'Cancelled by you', at))
      t.updatedAt = at
      await s.saveTask(t)
      return t
    }
  }

  if (noun === 'approvals' && id && method === 'POST') return decide(s, id, String((await body(req)).decision ?? ''))

  if (noun === 'routines') {
    const list = await s.routines()
    if (method === 'POST' && !id) {
      const b = await body(req)
      const bot = slugify(String(b.bot ?? ''))
      const schedule = String(b.schedule ?? '').trim()
      const title = String(b.title ?? '').trim()
      const prompt = String(b.prompt ?? '').trim()
      if (!(await s.bot(bot))) throw new HttpError(400, 'Pick a bot.')
      if (!parseSchedule(schedule)) throw new HttpError(400, `Can't use the schedule "${schedule}". Try "every 2h", "daily 08:30" or "weekdays 09:00" (15 minutes apart at least).`)
      if (!title || !prompt) throw new HttpError(400, 'A routine needs a title and instructions.')
      list.push({ id: newId('r', Date.now()), bot, schedule, title, prompt, paused: false, createdAt: at })
      await s.saveRoutines(list)
      return list
    }
    const r = list.find(x => x.id === id)
    if (!r) throw new HttpError(404, `No routine ${id}.`)
    if (method === 'PATCH') {
      r.paused = !!(await body(req)).paused
      await s.saveRoutines(list)
      return list
    }
    if (method === 'DELETE') {
      const next = list.filter(x => x.id !== id)
      await s.saveRoutines(next)
      return next
    }
  }

  if (noun === 'config' && method === 'PUT') {
    const b = await body(req)
    await applyProposal(s, { action: 'update_config', summary: 'Settings from the browser', config: b, state: 'pending' }, at)
    return (await buildState(s)).config
  }

  throw new HttpError(404, 'Not found.')
}

export function startWeb(s: Store, info: WebInfo, host = '127.0.0.1'): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : info.port
      const hostHeader = req.headers.host ?? ''
      if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) throw new HttpError(403, 'Open the crew from 127.0.0.1 or localhost.')
      const url = new URL(req.url ?? '/', `http://${hostHeader}`)

      const asset = ['/hognt.css', '/markdown.js', '/favicon.svg'].includes(url.pathname) ? url.pathname.slice(1) : url.pathname.match(/^\/fonts\/([a-z0-9-]+\.woff2)$/)?.[1]
      if (asset) {
        const isFont = asset.endsWith('.woff2')
        const data = await readFile(join(RUNNER_DIR, 'web', isFont ? 'fonts' : '', asset)).catch(() => undefined)
        if (!data) throw new HttpError(404, 'Not found.')
        const type = isFont ? 'font/woff2' : asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : asset.endsWith('.svg') ? 'image/svg+xml' : 'text/css; charset=utf-8'
        res.writeHead(200, { 'content-type': type, 'cache-control': isFont ? 'max-age=3600' : 'no-store' })
        return res.end(data)
      }

      if (url.pathname === '/' && url.searchParams.has('token')) {
        if (!sameToken(url.searchParams.get('token') ?? undefined, info.token)) throw new HttpError(401, 'That link is out of date. Run /bot web in Claude Code for a fresh one.')
        res.writeHead(303, { location: '/', 'set-cookie': `bots_token=${info.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` })
        return res.end()
      }
      const authed = sameToken(cookie(req, 'bots_token'), info.token)
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (!authed) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
          return res.end('<!doctype html><meta charset="utf-8"><title>Office Hours</title><body style="font:16px system-ui;padding:40px;max-width:560px">Open Office Hours with the link from <code>/bot web</code> in Claude Code, or from the runner log.</body>')
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'; frame-ancestors 'none'" })
        return res.end(await readFile(join(RUNNER_DIR, 'web', 'index.html'), 'utf8'))
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.')
      if (!authed) throw new HttpError(401, 'Open the crew with the link from /bot web.')
      if (req.method !== 'GET' && req.headers['x-bots'] !== '1') throw new HttpError(403, 'Missing X-Bots header.')

      if (url.pathname === '/api/file' && req.method === 'GET') return await serveFile(s, req, res, url.searchParams.get('path') ?? '')
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        let last = ''
        const push = async () => {
          const json = JSON.stringify(await buildState(s))
          if (json !== last) {
            last = json
            res.write(`event: state\ndata: ${json}\n\n`)
          } else res.write(': ping\n\n')
        }
        await push()
        const timer = setInterval(() => void push().catch(() => {}), 1500)
        req.on('close', () => clearInterval(timer))
        return
      }
      send(res, 200, await route(s, req, url))
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400
      if (!res.headersSent) send(res, status, { error: (err as Error).message })
      else res.end()
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(info.port, host, () => resolve(server))
  })
}
