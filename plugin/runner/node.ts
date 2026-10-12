// Node-side helpers shared by the runner, the crew MCP server and setup:
// the file adapter, paths, headless `claude` runs and Mac notifications.
import { execFile, spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { connectorLabel, Store } from './core.ts'
import type { Connector, Fs, TokenUsage } from './core.ts'

export const ROOT = process.env.BOTS_ROOT ?? join(homedir(), '.claude', 'bots')
export const CLAUDE = process.env.BOTS_CLAUDE ?? 'claude'
export const RUNNER_DIR = dirname(new URL(import.meta.url).pathname)

export const nodeFs: Fs = {
  async read(path) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  },
  async write(path, text) {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, text)
    await rename(tmp, path)
  },
  async list(dir) {
    try {
      return await readdir(dir)
    } catch {
      return []
    }
  },
  async remove(path) {
    await rm(path, { force: true })
  },
}

export function openStore(root: string = ROOT): Store {
  return new Store(root, nodeFs)
}

export const nowIso = (): string => new Date().toISOString()

/** Local calendar day, used to bucket spend. */
export function today(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function notify(title: string, text: string): void {
  if (process.env.BOTS_QUIET) return
  const q = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 200) + '"'
  execFile('osascript', ['-e', `display notification ${q(text)} with title ${q(title)}`], () => {})
}

export type ClaudeResult = {
  code: number
  json?: {
    result?: string
    is_error?: boolean
    total_cost_usd?: number
    session_id?: string
    subtype?: string
    num_turns?: number
    modelUsage?: Record<string, unknown>
    usage?: TokenUsage
  }
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Runs one headless `claude -p`, reading its stream-json output as it arrives:
 * `onEvent` sees every event (the rate-limit windows among them) and the final
 * `result` event becomes `json`.
 */
export function runClaude(
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutMs: number; onSpawn?: (kill: () => void) => void; onEvent?: (e: Record<string, unknown>) => void },
): Promise<ClaudeResult> {
  return new Promise(resolve => {
    const child = spawn(process.env.BOTS_CLAUDE ?? CLAUDE, ['-p', '--output-format', 'stream-json', '--verbose', ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let pending = ''
    let timedOut = false
    let json: ClaudeResult['json']
    const kill = () => child.kill('SIGTERM')
    opts.onSpawn?.(kill)
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs)
    const take = (line: string) => {
      if (!line.startsWith('{')) return
      let e: Record<string, unknown>
      try {
        e = JSON.parse(line)
      } catch {
        return
      }
      if (e.type === 'result') json = e as ClaudeResult['json']
      try {
        opts.onEvent?.(e)
      } catch {}
    }
    child.stdout.on('data', d => {
      stdout += d
      pending += d
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const l of lines) take(l.trim())
    })
    child.stderr.on('data', d => (stderr += d))
    child.on('error', err => {
      stderr += String(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      take(pending.trim())
      resolve({ code: code ?? 1, json, stdout: stdout.slice(-20_000), stderr, timedOut })
    })
  })
}

/**
 * The MCP tool prefixes (`mcp__claude_ai_Gmail`, ...) a headless run would
 * load. Read from the CLI's startup event, then the process is stopped before
 * it asks a model anything.
 */
export function discoverConnectors(cwd: string): Promise<{ prefixes: string[]; servers: Connector[] } | undefined> {
  return new Promise(resolve => {
    const child = spawn(process.env.BOTS_CLAUDE ?? CLAUDE, ['-p', '--tools', '', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', 'x'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let buf = ''
    let done = false
    const finish = (v: { prefixes: string[]; servers: Connector[] } | undefined) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(v)
    }
    const timer = setTimeout(() => finish(undefined), 60_000)
    child.stdout.on('data', d => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.includes('"subtype":"init"')) continue
        try {
          // Servers are listed whether or not they finished connecting; tools only once they have.
          const init = JSON.parse(line) as { tools?: string[]; mcp_servers?: { name: string; status?: string }[] }
          const prefixes = new Set((init.tools ?? []).filter(t => t.startsWith('mcp__')).map(t => t.split('__').slice(0, 2).join('__')))
          const servers: Connector[] = (init.mcp_servers ?? []).map(sv => ({
            prefix: 'mcp__' + sv.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
            name: sv.name,
            label: connectorLabel(sv.name),
            status: sv.status ?? 'unknown',
          }))
          for (const sv of servers) prefixes.add(sv.prefix)
          return finish({ prefixes: [...prefixes].sort(), servers: servers.sort((a, b) => a.label.localeCompare(b.label)) })
        } catch {
          return finish(undefined)
        }
      }
    })
    child.on('close', () => finish(undefined))
    child.on('error', () => finish(undefined))
  })
}

export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}
