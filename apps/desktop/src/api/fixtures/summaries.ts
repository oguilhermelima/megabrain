import type { SummariesList, SummarySearch, Summary } from '@/api/schema'
import { groupSummaries } from '@/advanced/summaries-model'

// Chat summaries for the mock, shaped like `summaries list|search|show --json`: canto keeps a branch
// whose worktree is gone, and one summary belongs to the mock's native chat so its page links to it.

const root = '/Users/operator/Workspaces'
const tree = '/Users/operator/Workspaces/Worktrees'
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const entry = (id: string, minutes: number, fields: Pick<Summary, 'repo' | 'project' | 'worktree' | 'branch' | 'title' | 'text'> & Partial<Summary>): Summary => ({
  id,
  chatId: `chat-${id}`,
  agent: 'claude',
  model: 'claude-haiku-5-5',
  createdAt: ago(minutes),
  ...fields,
})

const canto = { repo: `${root}/canto`, project: 'canto' }
const megabrain = { repo: `${root}/megabrain`, project: 'megabrain' }

export const mockSummaries: Summary[] = [
  entry('sum-0001', 4, {
    ...canto,
    worktree: `${root}/canto`,
    branch: 'main',
    chatId: 'chat-0001',
    title: 'Onboarding steps tidied, tests green',
    text: 'Merged the three onboarding step components into one list driven by a config array.\n\n- Removed the duplicated progress bar.\n- Kept the skip link on the last step.\n- `pnpm test onboarding`: 14 passed.\n\nNext: the copy review the person asked for.',
  }),
  entry('sum-0002', 52, { ...canto, worktree: `${root}/canto`, branch: 'main', chatId: 'chat-0001', title: 'Mapped the onboarding flow', text: 'Read the onboarding route and its three steps; each step repeats the progress bar and the skip logic.' }),
  entry('sum-0003', 190, { ...canto, worktree: `${root}/canto`, branch: 'main', title: 'Fixed the search debounce', text: 'The search field fired a request per key; it now waits 250 ms after the last key.' }),
  entry('sum-0004', 18, { ...canto, worktree: `${tree}/fix-player-seek`, branch: 'fix/player-seek', agent: 'codex', title: 'Seek no longer resets the rate', text: 'Seeking kept the playback rate only when paused; the rate is now restored after every seek. A test covers seeking back past 0.' }),
  entry('sum-0005', 2900, { ...canto, worktree: `${tree}/feat-old-carousel`, branch: 'feat/old-carousel', title: 'Carousel prototype dropped', text: 'The carousel prototype was abandoned for the grid layout; the branch stays for reference.' }),
  entry('sum-0006', 75, { ...megabrain, worktree: `${root}/megabrain`, branch: 'main', agent: 'codex', model: 'gpt-6-luna', title: 'Summaries verbs drafted', text: 'Added summaries list, search, show and context to the CLI, each with --json.' }),
]

const gone = new Set([`${canto.repo}\nfeat/old-carousel`])
const live = (repo: string, branch: string) => !gone.has(`${repo}\n${branch}`)

export function mockSummariesList(options: { repo?: string; branch?: string; limit?: number } = {}): SummariesList {
  const entries = mockSummaries.filter((summary) => (options.repo === undefined || summary.repo === options.repo) && (options.branch === undefined || summary.branch === options.branch))
  return { projects: groupSummaries(entries, live, options.limit ?? 20) }
}

export function mockSummarySearch(text: string, options: { limit?: number } = {}): SummarySearch {
  const words = text.toLowerCase().split(/\s+/).filter((word) => word !== '')
  const scored = mockSummaries.map((summary) => {
    const haystack = `${summary.title}\n${summary.text}`.toLowerCase()
    return { ...summary, score: words.filter((word) => haystack.includes(word)).length }
  })
  return { results: scored.filter((summary) => summary.score > 0).sort((left, right) => right.score - left.score).slice(0, options.limit ?? 20) }
}
