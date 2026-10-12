import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'bots-web-'))
const log = join(root, 'fake.log')
const planPath = join(root, 'plan.json')
writeFileSync(log, '')
Object.assign(process.env, {
  BOTS_ROOT: root,
  BOTS_CLAUDE: join(import.meta.dirname, 'fake-claude.mjs'),
  BOTS_QUIET: '1',
  BOTS_NO_REVIEW: '1',
  BOTS_POLL_MS: '50',
  FAKE_LOG: log,
  FAKE_PLAN: planPath,
})
writeFileSync(
  planPath,
  JSON.stringify({
    'chat:manager': [
      {
        name: 'propose_change',
        arguments: { action: 'create_bot', summary: 'Create Recruiter on Sonnet to screen candidates', bot: { name: 'Recruiter', model: 'sonnet', job: 'Screen inbound candidates', tools: ['Gmail'] } },
      },
    ],
    'chat:manager:reply': 'I proposed a Recruiter bot. Press Apply to create it.',
  }),
)

const { seed } = await import('../plugin/runner/setup.ts')
const { openStore } = await import('../plugin/runner/node.ts')
const { Runner } = await import('../plugin/runner/main.ts')
const { startWeb } = await import('../plugin/runner/web.ts')

const s = openStore(root)
const TOKEN = 'a'.repeat(48)
let base = ''
let port = 0
let cookie = ''
let close = () => {}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { 'content-type': 'application/json', 'x-bots': '1', cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = text
  try {
    data = JSON.parse(text)
  } catch {}
  return { status: res.status, data, res }
}

async function settle(runner: InstanceType<typeof Runner>) {
  await runner.tick()
  await runner.drain()
}

before(async () => {
  await seed(root)
  await s.writeJson(s.path('connectors.json'), {
    prefixes: ['mcp__claude_ai_Gmail', 'mcp__claude_ai_Canva'],
    servers: [
      { prefix: 'mcp__claude_ai_Gmail', name: 'claude.ai Gmail', label: 'Gmail', status: 'connected' },
      { prefix: 'mcp__claude_ai_Canva', name: 'claude.ai Canva', label: 'Canva', status: 'needs-auth' },
    ],
    checkedAt: new Date().toISOString(),
  })
  const server = await startWeb(s, { port: 0, token: TOKEN })
  port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  close = () => server.close()
})
after(() => close())

describe('browser app access', () => {
  it('needs the token link once, then a cookie', async () => {
    assert.equal((await call('GET', '/api/state')).status, 401)
    assert.equal((await call('GET', '/?token=wrong')).status, 401)
    const ok = await call('GET', `/?token=${TOKEN}`)
    assert.equal(ok.status, 303)
    cookie = (ok.res.headers.get('set-cookie') ?? '').split(';')[0]
    assert.match(cookie, /^bots_token=/)
    assert.equal((await call('GET', '/')).status, 200)
    assert.equal((await call('GET', '/api/state')).status, 200)
  })

  it('refuses writes without the X-Bots header', async () => {
    const r = await fetch(base + '/api/tasks', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"text":"x"}' })
    assert.equal(r.status, 403)
  })

  it('refuses ids that are not ids', async () => {
    assert.equal((await call('GET', '/api/tasks/..%2Fconfig')).status, 404)
    assert.equal((await call('GET', '/api/chats/..')).status, 404)
  })

  it('refuses other Host headers (DNS rebinding)', async () => {
    const status = await new Promise<number>(resolve => {
      const req = request({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `evil.example:${port}`, cookie } }, res => resolve(res.statusCode ?? 0))
      req.end()
    })
    assert.equal(status, 403)
  })
})

describe('browser app features', () => {
  it('lists connectors from the account, marking ones that need sign-in', async () => {
    const { data } = await call('GET', '/api/state')
    assert.deepEqual(data.connectors, [
      { label: 'Gmail', status: 'connected', available: true },
      { label: 'Canva', status: 'needs-auth', available: false },
    ])
    assert.deepEqual(data.abilities, ['Code', 'Web search', 'Browser'])
    assert.equal(data.bots.length, 4)
  })

  it('creates, edits and deletes a bot, but never the Manager', async () => {
    const made = await call('POST', '/api/bots', { name: 'Scout', job: 'Find news', model: 'haiku', tools: ['Web search'] })
    assert.equal(made.status, 200)
    assert.equal((await call('POST', '/api/bots', { name: 'Scout', job: 'x', model: 'haiku' })).status, 409)
    assert.equal((await call('POST', '/api/bots', { name: 'Nobody', job: '', model: 'haiku' })).data.error, 'Nobody needs a job.')
    const edited = await call('PUT', '/api/bots/scout', { model: 'opus' })
    assert.equal(edited.data.model, 'opus')
    assert.equal((await s.bot('scout'))?.job, 'Find news')
    assert.equal((await call('DELETE', '/api/bots/scout')).status, 200)
    assert.equal((await call('DELETE', '/api/bots/manager')).status, 400)
  })

  it('chats with the Manager, which proposes a bot that you apply', async () => {
    const runner = new Runner(s)
    const sent = await call('POST', '/api/chats/manager', { text: 'Make me a recruiter bot' })
    assert.equal(sent.data.status, 'queued')
    await settle(runner)

    let thread = (await call('GET', '/api/chats/manager')).data
    assert.equal(thread.status, 'idle')
    assert.equal(thread.sessionId, 'sess-manager')
    const proposal = thread.messages.find((m: any) => m.proposal)
    assert.equal(proposal.proposal.state, 'pending')
    assert.equal(thread.messages.at(-1).text, 'I proposed a Recruiter bot. Press Apply to create it.')
    assert.equal(await s.bot('recruiter'), undefined)

    thread = (await call('POST', `/api/chats/manager/proposals/${proposal.id}`, { apply: true })).data
    assert.equal(thread.messages.find((m: any) => m.id === proposal.id).proposal.state, 'applied')
    const recruiter = await s.bot('recruiter')
    assert.equal(recruiter?.model, 'sonnet')
    assert.deepEqual(recruiter?.tools, ['Gmail'])

    await call('POST', '/api/chats/manager', { text: 'Thanks' })
    await settle(runner)
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.model)
    assert.equal(lines.at(-1).resume, 'sess-manager')
    assert.equal(lines.at(-1).prompt, 'Thanks')
    assert.equal(lines.at(-1).strict, true)
  })

  it('adds, replies to and cancels tasks', async () => {
    const t = (await call('POST', '/api/tasks', { owner: 'inbox', text: 'Triage today', model: 'opus' })).data
    assert.equal(t.owner, 'inbox')
    assert.equal(t.model, 'opus')
    const replied = (await call('POST', `/api/tasks/${t.id}/reply`, { text: 'Skip newsletters' })).data
    assert.equal(replied.history.at(-1).text, 'Skip newsletters')
    assert.equal((await call('POST', `/api/tasks/${t.id}/cancel`)).data.status, 'cancelled')
    assert.equal((await call('POST', `/api/tasks/${t.id}/reply`, { text: 'more' })).status, 400)
  })

  it('answers approvals and validates routines and settings', async () => {
    await s.saveApproval({ id: 'a-1', taskId: 't-1', bot: 'inbox', tool: 'mcp__claude_ai_Gmail__send', input: {}, summary: 'send', status: 'pending', createdAt: new Date().toISOString() })
    assert.equal((await call('POST', '/api/approvals/a-1', { decision: 'always' })).data.status, 'allowed')
    assert.equal((await call('POST', '/api/approvals/a-1', { decision: 'deny' })).status, 404)
    assert.match((await call('POST', '/api/routines', { bot: 'inbox', schedule: 'sometimes', title: 'x', prompt: 'y' })).data.error, /schedule/)
    const list = (await call('POST', '/api/routines', { bot: 'inbox', schedule: 'weekdays 08:30', title: 'Triage', prompt: 'Sort the inbox' })).data
    assert.equal(list.length, 1)
    assert.equal((await call('PATCH', `/api/routines/${list[0].id}`, { paused: true })).data[0].paused, true)
    assert.equal((await call('PUT', '/api/config', { delegation: 'sideways' })).status, 400)
    assert.deepEqual((await call('PUT', '/api/config', { limits: { fiveHourPct: 40, weeklyPct: 60, perRunPct: 5 } })).data.limits, { fiveHourPct: 40, weeklyPct: 60, perRunPct: 5 })
    assert.match((await call('PUT', '/api/config', { limits: { fiveHourPct: 0, weeklyPct: 60, perRunPct: 5 } })).data.error, /from 1 to 100/)
    const state = (await call('GET', '/api/state')).data
    assert.deepEqual(state.usage.fiveHour, { cap: 40 })
  })
})

describe('markdown in replies', async () => {
  const { md } = await import('../plugin/runner/web/markdown.js')
  it('renders the common pieces', () => {
    assert.equal(md('**Done:** Book the call'), '<p><strong>Done:</strong> Book the call</p>')
    assert.equal(md('# Plan\n- one\n- two *now*'), '<h3>Plan</h3><ul><li>one</li><li>two <em>now</em></li></ul>')
    assert.equal(md('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>')
    assert.equal(md('use `npm test`'), '<p>use <code>npm test</code></p>')
    assert.equal(md('```\nconst a = 1 < 2\n```'), '<pre class="md-code"><code>const a = 1 &lt; 2</code></pre>')
    assert.equal(md('| a | b |\n|---|---|\n| 1 | 2 |'), '<table class="md-table"><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
    assert.equal(md('> quoted'), '<blockquote><p>quoted</p></blockquote>')
    assert.equal(md('line one\nline two'), '<p>line one<br>line two</p>')
  })
  it('never lets HTML or script links through', () => {
    assert.equal(md('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>')
    assert.equal(md('[click](javascript:alert(1))'), '<p>click</p>')
    assert.equal(md('[docs](https://example.com/a?b=1&c=2)'), '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>')
    assert.equal(md('`<b>`'), '<p><code>&lt;b&gt;</code></p>')
  })
})

describe('media, artifacts and links in chat', async () => {
  const { md } = await import('../plugin/runner/web/markdown.js')
  it('shows images and video, from the web or from the bots folders', () => {
    assert.equal(md('![chart](https://example.com/c.png)'), '<p><a class="md-media-link" href="https://example.com/c.png" target="_blank" rel="noopener noreferrer"><img class="md-media" src="https://example.com/c.png" alt="chart" loading="lazy"></a></p>')
    assert.match(md('Rendered: ~/marketing/promo.mp4'), /<video class="md-media" controls preload="metadata" src="\/api\/file\?path=~%2Fmarketing%2Fpromo\.mp4"/)
    assert.match(md('![](file:///Users/x/out/shot.webp)'), /src="\/api\/file\?path=%2FUsers%2Fx%2Fout%2Fshot\.webp"/)
    assert.match(md('https://cdn.example.com/clip.webm'), /<video class="md-media"/)
  })
  it('turns Claude Artifact links into cards and bare links into links', () => {
    assert.match(md('Here it is: https://claude.ai/artifact/72zxbvWEkLFS2UAR8RNDnW'), /<a class="md-artifact" href="https:\/\/claude\.ai\/artifact\/72zxbvWEkLFS2UAR8RNDnW"[^>]*><span class="md-artifact-kicker">Claude artifact<\/span><span class="md-artifact-title">Claude artifact<\/span>/)
    assert.match(md('[Launch plan](https://claude.ai/code/artifact/abc-123)'), /md-artifact-title">Launch plan</)
    assert.equal(md('see https://example.com/docs.'), '<p>see <a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">https://example.com/docs</a>.</p>')
  })
  it('stays safe', () => {
    assert.equal(md('![x](javascript:alert(1))'), '<p>x</p>')
    assert.doesNotMatch(md('![" onerror="alert(1)](https://e.com/a.png)'), /" onerror="/)
    assert.equal(md('[pdf](/etc/passwd)'), '<p>pdf</p>')
    assert.equal(md('\u00000\u0000 plain'), '<p>0 plain</p>')
  })
})

describe('files, unread and approvals in chat', () => {
  it('serves only images and video from the bots folders, with byte ranges', async () => {
    const { mkdirSync, symlinkSync } = await import('node:fs')
    const dir = join(root, 'workspace', 'social')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'clip.mp4'), Buffer.from('0123456789'))
    writeFileSync(join(dir, 'notes.txt'), 'secret')
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    writeFileSync(join(outside, 'x.png'), 'png')
    symlinkSync(join(outside, 'x.png'), join(dir, 'escape.png'))
    const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base}/api/file?path=${encodeURIComponent(p)}`, { headers: { cookie, ...headers } })
    const ok = await get(join(dir, 'clip.mp4'))
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('content-type'), 'video/mp4')
    assert.equal(await ok.text(), '0123456789')
    const part = await get(join(dir, 'clip.mp4'), { range: 'bytes=2-5' })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10')
    assert.equal(await part.text(), '2345')
    assert.equal((await get(join(dir, 'notes.txt'))).status, 404)
    assert.equal((await get(join(outside, 'x.png'))).status, 403)
    assert.equal((await get(join(dir, 'escape.png'))).status, 403)
    assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent(join(dir, 'clip.mp4'))}`)).status, 401)
  })

  it('counts unread replies and approvals per bot, and clears unread when read', async () => {
    const { saveChat } = await import('../plugin/runner/core.ts')
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
    await saveChat(s, { bot: 'calendar', status: 'idle', messages: [
      { id: 'm1', role: 'you', text: 'hi', at: at(5), answered: true },
      { id: 'm2', role: 'bot', text: 'hello', at: at(4) },
      { id: 'm3', role: 'bot', text: '**Done:** booked', at: at(1) },
    ] })
    await s.saveApproval({ id: 'a-cal', taskId: 't-9', bot: 'calendar', tool: 'mcp__claude_ai_Google_Calendar__create_event', input: {}, summary: 'create_event', status: 'pending', createdAt: at(1) })
    let chats = (await call('GET', '/api/state')).data.chats
    assert.equal(chats.calendar.unread, 2)
    assert.equal(chats.calendar.approvals, 1)
    assert.equal((await call('POST', '/api/chats/calendar/seen')).status, 200)
    chats = (await call('GET', '/api/state')).data.chats
    assert.equal(chats.calendar.unread, 0)
    assert.equal(chats.calendar.approvals, 1)
    const thread = await (await import('../plugin/runner/core.ts')).readChat(s, 'calendar')
    assert.equal(thread.messages.length, 3)
  })
})
