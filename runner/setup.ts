// Seeds the crew store with the starter bots and default policy.
//   node runner/setup.ts    create ~/.claude/bots with the starter crew (keeps existing bots)
import { DEFAULT_CONFIG } from './core.ts'
import type { Bot, Config } from './core.ts'
import { nodeFs, openStore, ROOT } from './node.ts'

export const STARTER_CREW: Bot[] = [
  {
    slug: 'manager',
    name: 'Manager',
    job: 'Take requests, split them into tasks, assign each to the right bot, combine the results and report back',
    model: 'sonnet',
    tools: [],
    canHandTo: ['inbox', 'calendar', 'bug-fixer'],
    isManager: true,
  },
  {
    slug: 'inbox',
    name: 'Inbox',
    job: 'Triage Gmail, draft replies, never send without asking',
    model: 'haiku',
    tools: ['Gmail'],
    canHandTo: ['calendar'],
  },
  {
    slug: 'calendar',
    name: 'Calendar',
    job: 'Find meeting times, send invites with approval, morning brief',
    model: 'sonnet',
    tools: ['Calendar', 'Gmail'],
    canHandTo: ['inbox'],
  },
  {
    slug: 'bug-fixer',
    name: 'Bug fixer',
    job: 'Fix failing tests in my repos and open PRs',
    model: 'opus',
    tools: ['Code', 'Jira'],
    canHandTo: ['inbox'],
    workdir: '~/workspaces',
    instructions: 'Work in a new git branch, run the tests before and after your change, and open a PR with gh. Never push to main.',
  },
]

export async function seed(root: string = ROOT): Promise<string[]> {
  const s = openStore(root)
  const made: string[] = []
  for (const bot of STARTER_CREW) {
    if (await s.bot(bot.slug)) continue
    await s.saveBot(bot)
    made.push(bot.name)
  }
  if ((await nodeFs.read(s.path('config.json'))) === undefined) {
    const cfg: Config = { ...DEFAULT_CONFIG, delegation: 'manager', approvals: 'auto' }
    await s.saveConfig(cfg)
  }
  if ((await nodeFs.read(s.path('routines.json'))) === undefined) await s.saveRoutines([])
  return made
}

if (import.meta.main) {
  const made = await seed()
  console.log(made.length ? `Created bots: ${made.join(', ')}` : 'Bots already exist; left them as they are.')
  console.log(`Crew store: ${ROOT}`)
}
