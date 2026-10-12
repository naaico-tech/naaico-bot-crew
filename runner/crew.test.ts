import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  classify,
  DEFAULT_CONFIG,
  formatBotFile,
  handoff,
  isDue,
  makeTask,
  mayDelegate,
  mcpScope,
  checkLimits,
  finishOrReturn,
  answerChat,
  validLimits,
  windowsFromStreamEvent,
  parseBotFile,
  parseMention,
  parseSchedule,
  ruleFor,
} from './core.ts'
import type { Config } from './core.ts'
import { STARTER_CREW } from './setup.ts'

const cfg: Config = { ...DEFAULT_CONFIG, delegation: 'manager', approvals: 'auto' }
const [manager, inbox, calendar, bugFixer] = STARTER_CREW

describe('bot files', () => {
  it('round-trips every starter bot', () => {
    for (const bot of STARTER_CREW) {
      const back = parseBotFile(bot.slug, formatBotFile(bot))
      assert.deepEqual(back, { ...bot, effort: 'medium', workdir: bot.workdir, isManager: !!bot.isManager, instructions: bot.instructions })
    }
  })
})

describe('@mentions', () => {
  it('matches multi-word names, slugs and a model override', () => {
    const m = parseMention('@Bug fixer[opus] fix the auth test', STARTER_CREW)
    assert.equal(m?.bot.slug, 'bug-fixer')
    assert.equal(m?.model, 'opus')
    assert.equal(m?.text, 'fix the auth test')
    assert.equal(parseMention('@inbox: triage today', STARTER_CREW)?.bot.slug, 'inbox')
  })
  it('ignores unknown names, partial words and empty requests', () => {
    assert.equal(parseMention('@Inboxer do it', STARTER_CREW), undefined)
    assert.equal(parseMention('@Nobody do it', STARTER_CREW), undefined)
    assert.equal(parseMention('@Inbox', STARTER_CREW), undefined)
    assert.equal(parseMention('hello @Inbox', STARTER_CREW), undefined)
  })
})

describe('manager delegation', () => {
  it('lets only the Manager assign, and workers hand back to it', () => {
    assert.equal(mayDelegate(cfg, manager, 'calendar', STARTER_CREW).ok, true)
    assert.equal(mayDelegate(cfg, inbox, 'manager', STARTER_CREW).ok, true)
    assert.equal(mayDelegate(cfg, inbox, 'calendar', STARTER_CREW).ok, false)
    assert.equal(mayDelegate(cfg, inbox, 'inbox', STARTER_CREW).ok, false)
    assert.equal(mayDelegate(cfg, inbox, 'ghost', STARTER_CREW).ok, false)
  })
  it('follows per-bot lists in list mode', () => {
    const list = { ...cfg, delegation: 'list' as const }
    assert.equal(mayDelegate(list, inbox, 'calendar', STARTER_CREW).ok, true)
    assert.equal(mayDelegate(list, inbox, 'bug-fixer', STARTER_CREW).ok, false)
  })
  it('caps handovers per task', () => {
    const t = makeTask({ id: 't-1', title: 'x', body: 'x', owner: 'inbox', createdBy: 'you', at: '2026-10-11T10:00:00.000Z' })
    for (let i = 0; i < cfg.maxHandoffs; i++) assert.equal(handoff(t, cfg, 'a', 'b', 'n', 'now').ok, true)
    assert.equal(handoff(t, cfg, 'a', 'b', 'n', 'now').ok, false)
  })
})

describe('routines', () => {
  it('parses schedules', () => {
    assert.deepEqual(parseSchedule('every 30m'), { kind: 'every', ms: 1_800_000 })
    assert.deepEqual(parseSchedule('weekdays 08:30'), { kind: 'at', days: [1, 2, 3, 4, 5], hour: 8, minute: 30 })
    assert.deepEqual(parseSchedule('mon,wed 10:15')?.kind, 'at')
    assert.equal(parseSchedule('sometimes'), undefined)
    assert.equal(parseSchedule('every 5m'), undefined)
    assert.equal(parseSchedule('every 15m')?.kind, 'every')
    assert.equal(parseSchedule('daily 25:00'), undefined)
  })
  it('fires once per slot and skips stale slots', () => {
    const sched = parseSchedule('daily 08:30')!
    const at = (h: number, m: number) => new Date(2026, 9, 12, h, m)
    assert.equal(isDue(sched, at(7, 0).toISOString(), at(8, 31)), true)
    assert.equal(isDue(sched, at(8, 31).toISOString(), at(8, 40)), false)
    assert.equal(isDue(sched, at(7, 0).toISOString(), at(11, 0)), false)
  })
})

describe('approvals', () => {
  const gcal = 'mcp__claude_ai_Google_Calendar__'
  it('denies connectors a bot was not given', () => {
    assert.equal(classify(cfg, inbox, `${gcal}create_event`, {}).verdict, 'deny')
    assert.equal(classify(cfg, bugFixer, 'mcp__claude_ai_Gmail__send_email', {}).verdict, 'deny')
  })
  it('allows reads, asks for sends, reviews the rest', () => {
    assert.equal(classify(cfg, calendar, `${gcal}list_events`, {}).verdict, 'allow')
    assert.equal(classify(cfg, calendar, `${gcal}create_event`, {}).verdict, 'ask')
    assert.equal(classify(cfg, bugFixer, 'Bash', { command: 'npm test' }).verdict, 'allow')
    assert.equal(classify(cfg, bugFixer, 'Bash', { command: 'git push origin main' }).verdict, 'ask')
    assert.equal(classify(cfg, bugFixer, 'Bash', { command: 'npm test && curl x' }).verdict, 'review')
    assert.equal(classify(cfg, bugFixer, 'Edit', { file_path: '/x' }).verdict, 'review')
  })
  it('makes every non-read connector action wait for the user', () => {
    const marketer = { ...inbox, slug: 'marketer', name: 'Marketer', tools: ['Buffer', 'Resend'] }
    assert.equal(classify(cfg, marketer, 'mcp__claude_ai_Buffer__execute_mutation', {}).verdict, 'ask')
    assert.equal(classify(cfg, marketer, 'mcp__claude_ai_Resend__create-broadcast', {}).verdict, 'ask')
    assert.equal(classify(cfg, marketer, 'mcp__claude_ai_Buffer__list_posts', {}).verdict, 'allow')
  })
  it('honours always-allow rules and strict mode', () => {
    const withRule = { ...cfg, allow: { 'bug-fixer': [ruleFor('Bash', { command: 'gh pr create --fill' })] } }
    assert.equal(classify(withRule, bugFixer, 'Bash', { command: 'gh pr create -t x' }).verdict, 'allow')
    assert.equal(classify({ ...cfg, approvals: 'strict' }, bugFixer, 'Edit', {}).verdict, 'ask')
  })
})

describe('connector scope', () => {
  const known = ['mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Calendar', 'mcp__claude_ai_Resend', 'mcp__graft']
  it('runs bots without connectors on the crew tools alone', () => {
    assert.deepEqual(mcpScope(manager, known), { strict: true, deny: [], missing: false })
    assert.deepEqual(mcpScope(bugFixer, known).deny.includes('mcp__claude_ai_Gmail'), true)
  })
  it('denies every server a bot was not given', () => {
    assert.deepEqual(mcpScope(inbox, known).deny, ['mcp__claude_ai_Google_Calendar', 'mcp__claude_ai_Resend', 'mcp__graft'])
    assert.deepEqual(mcpScope(calendar, known).deny, ['mcp__claude_ai_Resend', 'mcp__graft'])
  })
  it('falls back to no connectors when the server list is unknown', () => {
    assert.deepEqual(mcpScope(inbox, undefined), { strict: true, deny: [], missing: true })
  })
})

describe('runner end to end (fake claude)', () => {
  it('runs a Manager-led task with a handover refusal, an approval and sub-task results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bots-'))
    const log = join(root, 'fake.log')
    const planPath = join(root, 'plan.json')
    writeFileSync(log, '')
    Object.assign(process.env, {
      BOTS_ROOT: root,
      BOTS_CLAUDE: join(import.meta.dirname, 'test', 'fake-claude.mjs'),
      BOTS_QUIET: '1',
      BOTS_NO_REVIEW: '1',
      BOTS_POLL_MS: '50',
      FAKE_LOG: log,
      FAKE_PLAN: planPath,
    })
    const { seed } = await import('./setup.ts')
    const { openStore } = await import('./node.ts')
    const { Runner } = await import('./main.ts')
    await seed(root)
    const s = openStore(root)
    await s.saveConfig({ ...(await s.config()), concurrency: 2 })

    writeFileSync(
      planPath,
      JSON.stringify({
        manager: [
          { name: 'assign_task', arguments: { to: 'inbox', title: 'Read the Acme thread', details: 'What do they want?' } },
          { name: 'assign_task', arguments: { to: 'calendar', title: 'Book the Acme call', details: 'Tuesday morning' } },
        ],
        'manager:after': [{ name: 'complete_task', arguments: { result: 'Acme call booked for Tuesday.' } }],
        inbox: [
          { name: 'handoff', arguments: { to: 'calendar', note: 'skip the manager' } },
          { name: 'remember', arguments: { fact: 'Acme prefers mornings' } },
          { name: 'complete_task', arguments: { result: 'Acme wants a renewal call.' } },
        ],
        calendar: [
          { name: 'approval_prompt', arguments: { tool_name: 'mcp__claude_ai_Google_Calendar__create_event', input: { title: 'Acme' } } },
          { name: 'complete_task', arguments: { result: 'Invite sent for Tue 10:00.' } },
        ],
      }),
    )

    await s.writeJson(s.path('connectors.json'), { prefixes: ['mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Calendar', 'mcp__claude_ai_Resend'] })

    const parent = makeTask({ id: 't-parent', title: 'Set up the Acme call', body: 'Set up the Acme call', owner: 'manager', createdBy: 'you', at: new Date().toISOString() })
    await s.saveTask(parent)

    const runner = new Runner(s)
    const deadline = Date.now() + 30_000
    let done = false
    while (!done && Date.now() < deadline) {
      await runner.tick()
      for (const a of await s.approvals()) {
        if (a.status === 'pending') await s.saveApproval({ ...a, status: 'allowed', always: true, decidedAt: new Date().toISOString() })
      }
      done = (await s.task('t-parent'))?.status === 'done'
      await new Promise(r => setTimeout(r, 100))
    }
    await runner.drain()

    const finished = (await s.task('t-parent'))!
    assert.equal(finished.status, 'done', JSON.stringify(finished.history, null, 1))
    assert.equal(finished.result, 'Acme call booked for Tuesday.')
    assert.equal(finished.children.length, 2)
    for (const id of finished.children) assert.equal((await s.task(id))?.status, 'done')
    assert.ok(finished.history.some(e => e.kind === 'result' && e.text.includes('Invite sent')))

    const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const models = Object.fromEntries(lines.filter(l => l.model).map(l => [l.bot, l.model]))
    assert.deepEqual(models, { manager: 'sonnet', inbox: 'haiku', calendar: 'sonnet' })
    assert.ok(lines.filter(l => l.model).every(l => l.effort === 'medium'))
    const scopes = Object.fromEntries(lines.filter(l => l.model).map(l => [l.bot, { strict: l.strict, deny: l.deny }]))
    assert.deepEqual(scopes, {
      manager: { strict: true, deny: '' },
      inbox: { strict: false, deny: 'mcp__claude_ai_Google_Calendar,mcp__claude_ai_Resend' },
      calendar: { strict: false, deny: 'mcp__claude_ai_Resend' },
    })
    assert.ok(lines.filter(l => l.model).every(l => Number(l.budget) === 5))
    const inboxReplies = lines.find(l => l.bot === 'inbox' && l.replies)!.replies
    assert.match(inboxReplies[0], /Only the Manager assigns work/)
    const calReplies = lines.find(l => l.bot === 'calendar' && l.replies)!.replies
    assert.deepEqual(JSON.parse(calReplies[0]), { behavior: 'allow', updatedInput: { title: 'Acme' } })

    assert.deepEqual((await s.config()).allow.calendar, ['mcp__claude_ai_Google_Calendar__create_event'])
    assert.match(await s.memory('inbox'), /Acme prefers mornings/)
    const spend = await s.usage((await import('./node.ts')).today())
    assert.ok((spend.manager ?? 0) > 0 && (spend.inbox ?? 0) > 0)
  })
})

describe('returning finished work', () => {
  it('goes back up the handover chain, then finishes for the user', () => {
    const t = makeTask({ id: 't-r', title: 'x', body: 'x', owner: 'inbox', createdBy: 'chat:inbox', at: 'now' })
    handoff(t, cfg, 'inbox', 'manager', 'needs a meeting', 'now')
    handoff(t, cfg, 'manager', 'calendar', 'book it', 'now')
    assert.deepEqual(t.returnTo, ['inbox', 'manager'])
    assert.deepEqual(finishOrReturn(t, 'calendar', 'Booked Tue 10:00', 'now'), { returnedTo: 'manager' })
    assert.equal(t.status, 'queued')
    assert.equal(t.owner, 'manager')
    assert.deepEqual(finishOrReturn(t, 'manager', 'Booked; tell Acme', 'now'), { returnedTo: 'inbox' })
    assert.deepEqual(finishOrReturn(t, 'inbox', 'Booked Tue 10:00 and replied to Acme', 'now'), {})
    assert.equal(t.status, 'done')
    assert.equal(answerChat(t), 'inbox')
  })

  it('posts the final answer as a reply in the chat it came from (end to end)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bots-'))
    Object.assign(process.env, { BOTS_ROOT: root, FAKE_LOG: join(root, 'fake.log'), FAKE_PLAN: join(root, 'plan.json'), FAKE_UTIL: '' })
    writeFileSync(join(root, 'fake.log'), '')
    writeFileSync(join(root, 'plan.json'), JSON.stringify({
      'inbox@0': [{ name: 'handoff', arguments: { to: 'manager', note: 'Acme wants a call' } }],
      'manager@0': [{ name: 'handoff', arguments: { to: 'calendar', note: 'Book Tuesday morning' } }],
      'calendar@0': [{ name: 'complete_task', arguments: { result: 'Booked Tue 10:00' } }],
      'manager@1': [{ name: 'complete_task', arguments: { result: 'Call booked Tue 10:00' } }],
      'inbox@1': [{ name: 'complete_task', arguments: { result: '**Booked** Tue 10:00 and replied to Acme' } }],
    }))
    const { seed } = await import('./setup.ts')
    const { openStore } = await import('./node.ts')
    const { Runner } = await import('./main.ts')
    const { readChat } = await import('./core.ts')
    await seed(root)
    const s = openStore(root)
    await s.saveTask(makeTask({ id: 't-chain', title: 'Sort out the Acme call', body: 'Sort out the Acme call', owner: 'inbox', createdBy: 'chat:inbox', at: new Date().toISOString() }))
    const runner = new Runner(s)
    for (let i = 0; i < 8 && (await s.task('t-chain'))?.status !== 'done'; i++) {
      await runner.tick()
      await runner.drain()
    }
    const t = (await s.task('t-chain'))!
    assert.equal(t.status, 'done', JSON.stringify(t.history, null, 1))
    assert.deepEqual(t.history.filter(e => e.kind === 'returned').map(e => e.actor), ['calendar', 'manager'])
    const chat = await readChat(s, 'inbox')
    assert.equal(chat.messages.at(-1)?.taskId, 't-chain')
    assert.match(chat.messages.at(-1)?.text ?? '', /\*\*Done:\*\* Sort out the Acme call\n\n\*\*Booked\*\* Tue 10:00/)
  })
})

describe('plan usage limits', () => {
  const soon = (min: number) => new Date(Date.now() + min * 60_000).toISOString()
  const limits = { fiveHourPct: 50, weeklyPct: 50, perRunPct: 10 }
  it('reads the windows from a stream rate_limit_event', () => {
    const w = windowsFromStreamEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1791795600 }, seven_day: { utilization: 0.163, resetsAt: 1792123200 } } } }, 'now')!
    assert.equal(w.fiveHour?.percent, 8)
    assert.equal(w.weekly?.percent, 16.3)
    assert.equal(w.fiveHour?.resetsAt, new Date(1791795600 * 1000).toISOString())
    assert.equal(windowsFromStreamEvent({ type: 'assistant' }, 'now'), undefined)
  })
  it('pauses at either cap and ignores windows that have reset', () => {
    const now = new Date()
    const at = (five: number, week: number, fiveReset = soon(60)) => ({ fiveHour: { percent: five, resetsAt: fiveReset }, weekly: { percent: week, resetsAt: soon(3000) }, observedAt: '', source: 'runner' })
    assert.equal(checkLimits(undefined, limits, now).ok, true)
    assert.equal(checkLimits(at(49, 10), limits, now).ok, true)
    assert.match((checkLimits(at(50, 10), limits, now) as { reason: string }).reason, /5-hour usage is at 50%/)
    assert.match((checkLimits(at(10, 70), limits, now) as { reason: string }).reason, /weekly usage is at 70%/)
    assert.equal(checkLimits(at(90, 10, new Date(Date.now() - 1000).toISOString()), limits, now).ok, true)
  })
  it('validates percentages', () => {
    assert.throws(() => validLimits({ fiveHourPct: 0, weeklyPct: 50, perRunPct: 10 }), /from 1 to 100/)
    assert.deepEqual(validLimits({ fiveHourPct: 40.4, weeklyPct: '60' as unknown as number, perRunPct: 5 }), { fiveHourPct: 40, weeklyPct: 60, perRunPct: 5 })
  })

  async function crew(extra: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'bots-'))
    Object.assign(process.env, { BOTS_ROOT: root, FAKE_LOG: join(root, 'fake.log'), FAKE_PLAN: join(root, 'plan.json'), FAKE_UTIL: '' }, extra)
    writeFileSync(join(root, 'plan.json'), JSON.stringify({ inbox: [{ name: 'complete_task', arguments: { result: 'done' } }] }))
    writeFileSync(join(root, 'fake.log'), '')
    const { seed } = await import('./setup.ts')
    const { openStore } = await import('./node.ts')
    const { Runner } = await import('./main.ts')
    await seed(root)
    const s = openStore(root)
    await s.saveTask(makeTask({ id: 't-1', title: 'Triage', body: 'Triage', owner: 'inbox', createdBy: 'you', at: new Date().toISOString() }))
    return { s, runner: new Runner(s) }
  }

  it('starts nothing while a window is over its cap', async () => {
    const { s, runner } = await crew()
    await s.writeJson(s.path('limits.json'), { fiveHour: { percent: 62, resetsAt: soon(90) }, observedAt: new Date().toISOString(), source: 'claude-code' })
    await runner.tick()
    await runner.drain()
    const t = (await s.task('t-1'))!
    assert.equal(t.status, 'queued')
    assert.match(t.history.at(-1)!.text, /Waiting: 5-hour usage is at 62% \(crew limit 50%\)/)
  })

  it('stops a task that uses more than its share, and keeps the reading', async () => {
    const { s, runner } = await crew({ FAKE_UTIL: '0.10,0.25,0.30' })
    await runner.tick()
    await runner.drain()
    const t = (await s.task('t-1'))!
    assert.equal(t.status, 'blocked')
    assert.match(t.result ?? '', /used 15% of your 5-hour window, over its 10% share/)
    assert.equal((await s.usageWindows())?.fiveHour?.percent, 25)
  })

  it('requeues a task whose run crosses the crew cap, to continue after the reset', async () => {
    const { s, runner } = await crew({ FAKE_UTIL: '0.45,0.52' })
    await s.saveConfig({ ...(await s.config()), limits: { fiveHourPct: 50, weeklyPct: 50, perRunPct: 30 } })
    await runner.tick()
    await runner.drain()
    const t = (await s.task('t-1'))!
    assert.equal(t.status, 'queued')
    assert.match(t.history.find(e => e.kind === 'limit')!.text, /Paused: 5-hour usage is at 52%/)
  })

  it('blocks a task whose working folder is missing outside the store', async () => {
    const { s, runner } = await crew()
    await s.saveBot({ ...(await s.bot('inbox'))!, workdir: '/nonexistent/folder' })
    await runner.tick()
    await runner.drain()
    const t = (await s.task('t-1'))!
    assert.equal(t.status, 'blocked')
    assert.match(t.result ?? '', /working folder \/nonexistent\/folder doesn't exist/)
    process.env.FAKE_UTIL = ''
  })
})
