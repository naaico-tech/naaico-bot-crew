import { describe, expect, mock, test } from 'claude-code/testing'

const ROOT = '/home/t/.claude/bots'

const INBOX = `---
name: Inbox
description: Triage Gmail, draft replies, never send without asking
model: haiku
connectors: Gmail
can_hand_to: calendar
---
`
const MANAGER = `---
name: Manager
description: Split requests and assign them
model: sonnet
connectors:
can_hand_to: inbox
role: manager
---
`

/** An in-memory file system beneath the plugin, seeded with two bots. */
function fakeFs(on: any): Map<string, string> {
  const files = new Map<string, string>([
    [`${ROOT}/bots/inbox.md`, INBOX],
    [`${ROOT}/bots/manager.md`, MANAGER],
  ])
  const isDir = (p: string) => [...files.keys()].some(k => k.startsWith(p + '/'))
  on('fs.exists', (_$: any, e: any) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', (_$: any, e: any) => {
    const v = files.get(e.path)
    if (v === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: v }
  })
  on('fs.write', (_$: any, e: any) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_$: any, e: any) => {
    const names = new Set<string>()
    for (const k of files.keys()) if (k.startsWith(e.path + '/')) names.add(k.slice(e.path.length + 1).split('/')[0])
    return { value: [...names].map(name => ({ name, kind: 'file', size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'rm') files.delete(e.argv[e.argv.length - 1])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on)
  return files
}

const run = ($: any, args: string) =>
  $.command.run({ command: 'bot', args, origin: { kind: 'composer' }, presentation: { layout: 'main', columns: 100 } })

const tasks = (files: Map<string, string>) =>
  [...files.entries()].filter(([k]) => k.startsWith(`${ROOT}/tasks/`)).map(([, v]) => JSON.parse(v))

describe('office-hours', () => {
  test('creates a custom bot with its own model', async ($, on) => {
    const files = fakeFs(on)
    const r = await run($, 'new Recruiter | opus | Screen inbound candidates | Gmail, Calendar | manager')
    expect(r.text).toContain('Created Recruiter on Opus')
    const file = files.get(`${ROOT}/bots/recruiter.md`) ?? ''
    expect(file).toContain('model: opus')
    expect(file).toContain('connectors: Gmail, Calendar')
    expect(file).toContain('can_hand_to: manager')
  })

  test('changes a bot model', async ($, on) => {
    const files = fakeFs(on)
    const r = await run($, 'model Inbox sonnet')
    expect(r.text).toContain('Sonnet')
    expect(files.get(`${ROOT}/bots/inbox.md`)).toContain('model: sonnet')
  })

  test('an @mention becomes a task for that bot, with a model override', async ($, on) => {
    const files = fakeFs(on)
    const r: any = await $.prompt.submit({ text: '@Inbox[opus] triage this morning' } as any)
    expect(r.drop).toContain('Sent to Inbox on Opus')
    const [t] = tasks(files)
    expect(t.owner).toBe('inbox')
    expect(t.model).toBe('opus')
    expect(t.status).toBe('queued')
    expect(t.body).toBe('triage this morning')
  })

  test('ordinary prompts pass through untouched', async ($, on) => {
    const files = fakeFs(on)
    on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
    const r: any = await $.prompt.submit({ text: '@someone not a bot' } as any)
    expect(r.text).toBe('@someone not a bot')
    expect(tasks(files).length).toBe(0)
  })

  test('assign with no bot goes to the Manager', async ($, on) => {
    const files = fakeFs(on)
    const r = await run($, 'assign plan the offsite')
    expect(r.text).toContain('Sent to Manager')
    expect(tasks(files)[0].owner).toBe('manager')
  })

  test('approving with "always" records the decision for the runner', async ($, on) => {
    const files = fakeFs(on)
    const pending = { id: 'a-abc123', taskId: 't-1', bot: 'inbox', tool: 'mcp__gmail__send', input: {}, summary: 'send reply', status: 'pending', createdAt: '2026-10-11T10:00:00.000Z' }
    files.set(`${ROOT}/approvals/a-abc123.json`, JSON.stringify(pending))
    const r = await run($, 'approve a-abc always')
    expect(r.text).toContain('Always allowed for inbox')
    const saved = JSON.parse(files.get(`${ROOT}/approvals/a-abc123.json`) ?? '{}')
    expect(saved.status).toBe('allowed')
    expect(saved.always).toBe(true)
  })

  test('routines need a schedule the runner can read', async ($, on) => {
    const files = fakeFs(on)
    const bad = await run($, 'routine add Inbox | whenever | Triage | Sort the inbox')
    expect(bad.text).toContain("Can't read the schedule")
    const ok = await run($, 'routine add Inbox | weekdays 08:30 | Morning triage | Sort the inbox and draft replies')
    expect(ok.text).toContain('Morning triage')
    const saved = JSON.parse(files.get(`${ROOT}/routines.json`) ?? '[]')
    expect(saved[0].schedule).toBe('weekdays 08:30')
    expect(saved[0].bot).toBe('inbox')
  })
})
