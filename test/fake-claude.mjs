#!/usr/bin/env node
// A stand-in for `claude -p` in tests. It starts the crew MCP server named in
// --mcp-config, plays the tool calls the plan in FAKE_PLAN lists for this bot,
// logs its arguments to FAKE_LOG and prints a result line like the real CLI.
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = name => args[args.indexOf(name) + 1]
const cfg = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.bots
const bot = cfg.env.BOTS_BOT
const chat = !!cfg.env.BOTS_CHAT
const task = chat ? { id: `chat:${bot}`, history: [] } : JSON.parse(readFileSync(`${cfg.env.BOTS_ROOT}/tasks/${cfg.env.BOTS_TASK}.json`, 'utf8'))
const scope = { strict: args.includes('--strict-mcp-config'), deny: args.includes('--disallowedTools') ? flag('--disallowedTools') : '' }
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bot, model: flag('--model'), effort: flag('--effort'), tools: flag('--tools'), budget: flag('--max-budget-usd'), resume: args.includes('--resume') ? flag('--resume') : '', prompt: args[args.length - 1], ...scope, task: task.id }) + '\n')
// FAKE_UTIL="0.10,0.25": one rate_limit_event per value, 5-hour utilization rising, a beat apart.
for (const u of (process.env.FAKE_UTIL ?? '').split(',').filter(Boolean)) {
  console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: Number(u), resetsAt: Math.floor(Date.now() / 1000) + 3600 }, seven_day: { utilization: 0.2, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } } }))
  await new Promise(r => setTimeout(r, 300))
}
if (process.env.FAKE_BUDGET_HIT) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 1.02 }))
  process.exit(1)
}

const plan = JSON.parse(readFileSync(process.env.FAKE_PLAN, 'utf8'))
const second = task.history.some(e => e.kind === 'result')
// "<bot>@<n>" plans the n-th run (from 0) of that bot on this task, ahead of the other keys.
const runIndex = readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.model && l.bot === bot && l.task === task.id).length - 1
const steps = plan[`${bot}@${runIndex}`] ?? plan[chat ? `chat:${bot}` : second ? `${bot}:after` : bot] ?? []

const server = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
const waiting = new Map()
server.stdout.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    const msg = JSON.parse(line)
    waiting.get(msg.id)?.(msg)
  }
})
let next = 1
const call = (method, params) =>
  new Promise(resolve => {
    const id = next++
    waiting.set(id, resolve)
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

await call('initialize', { protocolVersion: '2025-06-18' })
const replies = []
for (const step of steps) {
  const r = await call('tools/call', step)
  replies.push(r.result.content[0].text)
}
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bot, replies }) + '\n')
server.kill()
console.log(JSON.stringify({ type: 'result', result: plan[`chat:${bot}:reply`] && chat ? plan[`chat:${bot}:reply`] : `fake ${bot} finished`, is_error: false, total_cost_usd: 0.002, session_id: chat ? `sess-${bot}` : undefined }))
