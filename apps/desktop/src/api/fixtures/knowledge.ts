import type { KnowledgeChat, KnowledgeList, KnowledgeSearch, KnowledgeTopic, KnowledgeTopicSummary, KnowledgeTranscript } from '@/api/schema'
import { searchTopics } from '@/advanced/knowledge-model'

// The knowledge base for the mock, shaped like `knowledge list|search|show|transcript --json`: canto
// has topics of every kind, linked by shared chats, files and refs so its map has edges; megabrain has
// a few; atlas has sixty, generated, to see a crowded map; notes has one; stack has its summaries off
// in the mock's Settings, so it lists no topics.

const root = '/Users/operator/Workspaces'
const tree = `${root}/Worktrees`
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const canto = `${root}/canto`
const megabrain = `${root}/megabrain`
const atlas = `${root}/atlas`
const notes = `${root}/notes`

const chat = (id: string, minutes: number, fields: Pick<KnowledgeChat, 'title' | 'summary' | 'branch' | 'worktree' | 'topics'> & Partial<KnowledgeChat>): KnowledgeChat => ({
  id,
  agent: 'claude',
  model: 'claude-opus-5-5',
  startedAt: ago(minutes),
  endedAt: ago(minutes - 40),
  refs: [],
  lastMessages: [],
  ...fields,
})

export const mockKnowledgeChats: KnowledgeChat[] = [
  chat('chat-seek-1', 300, {
    title: 'Seek keeps the playback rate',
    summary: 'In this session the TV player stopped resetting the playback rate on seek: use-player-seek.ts now restores the rate after every seek, and seeking back past 0 clamps instead of crashing. PR #412 carries both, with 4 new tests.',
    branch: 'fix/player-seek',
    worktree: `${tree}/fix-player-seek`,
    topics: ['player-seek'],
    refs: [{ kind: 'pr', id: '412' }],
    lastMessages: [
      { role: 'person', text: 'Seeking back past 0 still crashes on the Apple TV simulator.', at: ago(270) },
      { role: 'agent', text: 'Clamped the target to 0 before handing it to the player; the crash test now passes. bun test: 412 pass, 0 fail.', at: ago(262) },
    ],
  }),
  chat('chat-seek-2', 220, {
    title: 'Seek tests in parallel lanes',
    summary: 'This session split the seek work into two worker lanes: one wrote the rate tests, the other the clamp. Both merged into fix/player-seek.',
    branch: 'fix/player-seek',
    worktree: `${tree}/fix-player-seek`,
    topics: ['player-seek'],
    lastMessages: [
      { role: 'person', text: 'Merge both lanes and run the whole suite once.', at: ago(190) },
      { role: 'agent', text: 'Merged; the suite is green on the branch.', at: ago(185) },
    ],
  }),
  chat('chat-seek-2-w1', 210, {
    title: 'Rate tests for seek',
    summary: 'A worker lane wrote four tests for the playback rate around seeks.',
    agent: 'codex',
    model: 'gpt-6-luna',
    branch: 'fix/player-seek',
    worktree: `${tree}/fix-player-seek`,
    topics: ['player-seek'],
    parent: 'chat-seek-2',
    lastMessages: [{ role: 'agent', text: 'Four tests added in use-player-seek.test.ts; all fail before the fix, as asked.', at: ago(200) }],
  }),
  chat('chat-seek-2-w2', 205, {
    title: 'Clamp seeks at zero',
    summary: 'A worker lane clamped negative seek targets.',
    agent: 'codex',
    model: 'gpt-6-luna',
    branch: 'fix/player-seek',
    worktree: `${tree}/fix-player-seek`,
    topics: ['player-seek'],
    parent: 'chat-seek-2',
    lastMessages: [{ role: 'agent', text: 'Clamp added in seek-model.ts; typecheck clean.', at: ago(198) }],
  }),
  chat('chat-0001', 90, {
    title: 'Onboarding steps become one list',
    summary: 'In this session the three onboarding step components became one list driven by a config array; the duplicated progress bar is gone and the skip link stays on the last step.',
    branch: 'main',
    worktree: canto,
    topics: ['onboarding', 'player-seek'],
    lastMessages: [
      { role: 'person', text: 'Keep the skip link on the last step, the copy review comes later.', at: ago(70) },
      { role: 'agent', text: 'Kept. pnpm test onboarding: 14 passed.', at: ago(66) },
    ],
  }),
  chat('chat-carousel', 6000, {
    title: 'Carousel prototype',
    summary: 'This session prototyped a carousel for the home rails and dropped it for the grid layout.',
    branch: 'feat/old-carousel',
    worktree: `${tree}/feat-old-carousel`,
    topics: ['home-carousel', 'home-grid'],
  }),
  chat('chat-grid', 4300, {
    title: 'Home grid layout',
    summary: 'In this session the home screen moved to a responsive grid of rails, measured at three widths.',
    branch: 'feat/home-grid',
    worktree: `${tree}/feat-home-grid`,
    topics: ['home-grid'],
  }),
  chat('chat-search', 2600, {
    title: 'Search debounce',
    summary: 'The search field now waits 250 ms after the last key before it asks the server.',
    branch: 'main',
    worktree: canto,
    topics: ['search-debounce'],
  }),
  chat('chat-trpc', 1500, {
    title: 'Why the web app 500s after the hook merge',
    summary: 'This session traced the 500 on every route to two createTRPCReact calls, which make two React contexts; the merge was reverted.',
    branch: 'main',
    worktree: canto,
    topics: ['trpc-contexts'],
  }),
  chat('chat-knowledge', 40, {
    title: 'Knowledge base design',
    summary: 'In this session the per-chat summaries gave way to topics: a curator files each summary under a topic, with sections, decisions and refs.',
    agent: 'claude',
    model: 'claude-opus-5-5',
    branch: 'main',
    worktree: megabrain,
    topics: ['topic-knowledge', 'chat-summaries'],
    refs: [{ kind: 'issue', id: '121' }],
    endedAt: null,
    lastMessages: [
      { role: 'person', text: 'Approved. Lanes: CLI, app, artifacts.', at: ago(12) },
      { role: 'agent', text: 'Dispatched three lanes; the app lane builds on fixtures until the CLI lands.', at: ago(10) },
    ],
  }),
  chat('chat-summaries', 900, {
    title: 'Summaries as a wiki page',
    summary: 'This session turned the Summaries section into a wiki page: projects, branches and summaries on the left, the picked summary on the right.',
    branch: 'feat/summaries-wiki',
    worktree: `${tree}/feat-summaries-wiki`,
    topics: ['chat-summaries'],
  }),
]

const topic = (id: string, project: string, minutes: number, fields: Pick<KnowledgeTopic, 'title' | 'kind' | 'status' | 'overview' | 'sections'> & Partial<KnowledgeTopic>): KnowledgeTopic => {
  const records = mockKnowledgeChats.filter((entry) => entry.topics.includes(id))
  const keyMessages = fields.keyMessages ?? []
  return {
    id,
    project,
    createdAt: ago(minutes + 2000),
    updatedAt: ago(minutes),
    aliases: [],
    chats: records.map((entry) => entry.id),
    refs: [],
    decisions: [],
    keyMessages,
    chatRecords: records,
    activity: records.length + keyMessages.length,
    ...fields,
  }
}

export const mockKnowledgeTopics: KnowledgeTopic[] = [
  topic('player-seek', canto, 185, {
    title: 'Player seek',
    kind: 'fix',
    status: 'shipped',
    overview: 'Seeking in the TV player keeps the playback rate and never goes below zero.',
    aliases: ['Seek resets the rate'],
    sections: {
      overview: 'Seeking in the TV player, forward or back, through `use-player-seek.ts` and the seek bar. A seek restores the playback rate the person chose and clamps its target to the media’s bounds.',
      state: 'Shipped in **PR #412**. Both defects are covered by tests in `use-player-seek.test.ts`; the clamp lives in `seek-model.ts`.',
      pitfalls: '- The Apple TV simulator reports the duration late; a seek before `loadedmetadata` used to read `NaN`.\n- The rate must be restored *after* the `seeked` event, not when the seek starts.',
      open: '- Seeking while buffering still flashes the spinner for a frame.',
    },
    refs: [
      { kind: 'pr', id: '412', title: 'Keep the rate on seek', url: 'https://github.com/operator/canto/pull/412' },
      { kind: 'issue', id: '398', title: 'Seek resets playback speed', url: 'https://github.com/operator/canto/issues/398' },
      { kind: 'commit', id: '9f2c4e1a7b3d5e6f8a9b0c1d2e3f4a5b6c7d8e9f', title: 'fix(player): restore the rate after seeking' },
      { kind: 'branch', id: 'fix/player-seek' },
      { kind: 'file', id: 'apps/tv/player/use-player-seek.ts' },
      { kind: 'file', id: 'apps/tv/player/seek-model.ts' },
    ],
    decisions: [
      { id: 'd1', text: 'Restore the rate on every seek in the hook.', why: 'Only the hook sees both the old rate and the seek’s end.', at: ago(290), chatId: 'chat-seek-1', supersededBy: 'd3' },
      { id: 'd2', text: 'Clamp seek targets to 0 and the duration.', why: 'The player crashes on a negative time and nothing upstream checks it.', at: ago(268), chatId: 'chat-seek-1' },
      { id: 'd3', text: 'Restore the rate after the `seeked` event, in the seek model.', why: 'Restoring it when the seek starts raced the player, which resets the rate when the seek lands.', at: ago(212), chatId: 'chat-seek-2' },
    ],
    keyMessages: [
      { chatId: 'chat-seek-1', eventCursor: '12', at: ago(296), role: 'person', text: 'Tests first. Seeking forward 10s resets the rate, and seeking back past 0 crashes.', why: 'Set the scope: two defects, tests before the fix.' },
      { chatId: 'chat-seek-1', eventCursor: '48', at: ago(270), role: 'person', text: 'Seeking back past 0 still crashes on the Apple TV simulator.', why: 'Found the clamp was missing on tvOS.' },
      { chatId: 'chat-seek-2', eventCursor: '7', at: ago(215), role: 'agent', text: 'The rate resets when the seek lands, so it has to be restored after seeked.', why: 'Changed where the rate is restored.' },
    ],
  }),
  topic('onboarding', canto, 66, {
    title: 'Onboarding steps',
    kind: 'refactor',
    status: 'active',
    overview: 'The onboarding flow as one list of steps driven by a config array.',
    sections: {
      overview: 'The onboarding route shows its steps from one config array; each step is a component with a title, body and optional skip.',
      state: 'Merged on main. The copy review is next.',
      pitfalls: '- The skip link must stay on the last step: the store review asked for it.',
      open: '- Copy review of all three steps.',
    },
    refs: [{ kind: 'file', id: 'apps/tv/player/use-player-seek.ts' }, { kind: 'file', id: 'apps/web/src/onboarding/steps.tsx' }],
    decisions: [{ id: 'd1', text: 'One config array drives every step.', why: 'Three components repeated the progress bar and skip logic.', at: ago(80), chatId: 'chat-0001' }],
  }),
  topic('home-carousel', canto, 5900, {
    title: 'Home carousel',
    kind: 'feat',
    status: 'dropped',
    overview: 'A carousel for the home rails, prototyped and dropped for the grid.',
    sections: { overview: 'A horizontally scrolling carousel per home rail.', state: 'Dropped for the grid layout; the branch stays for reference.', pitfalls: '', open: '' },
    refs: [{ kind: 'branch', id: 'feat/old-carousel' }],
  }),
  topic('home-grid', canto, 4200, {
    title: 'Home grid',
    kind: 'feat',
    status: 'shipped',
    overview: 'The home screen as a responsive grid of rails.',
    sections: { overview: 'Home rails laid out as a responsive grid, measured at three widths.', state: 'Shipped.', pitfalls: '- Rails mount on scroll; measure after scrolling the whole page.', open: '' },
    refs: [{ kind: 'pr', id: '371', title: 'Home grid', url: 'https://github.com/operator/canto/pull/371' }],
  }),
  topic('search-debounce', canto, 2500, {
    title: 'Search debounce',
    kind: 'fix',
    status: 'shipped',
    overview: 'The search field waits 250 ms after the last key.',
    sections: { overview: 'Debounced search requests.', state: 'Shipped on main.', pitfalls: '', open: '' },
    refs: [{ kind: 'pr', id: '371' }],
  }),
  topic('trpc-contexts', canto, 1400, {
    title: 'One tRPC React context',
    kind: 'investigation',
    status: 'shipped',
    overview: 'Why two createTRPCReact calls take the web app down.',
    sections: { overview: 'Two createTRPCReact calls are two React contexts; a hook from one cannot see the provider of the other.', state: 'Understood; the merge that caused it was reverted.', pitfalls: '- No static gate sees it: typecheck, lint and both bundles pass.', open: '' },
  }),
  topic('tv-first', canto, 3000, {
    title: 'TV before phone',
    kind: 'decision',
    status: 'active',
    overview: 'New player work lands on the TV app first.',
    sections: { overview: 'The TV app gets player changes first; the phone follows.', state: 'In force.', pitfalls: '', open: '' },
    refs: [{ kind: 'file', id: 'apps/tv/player/seek-model.ts' }],
    decisions: [{ id: 'd1', text: 'Player work lands on TV first.', why: 'Most playback happens on TV.', at: ago(3100), chatId: 'chat-grid' }],
  }),
  topic('topic-knowledge', megabrain, 10, {
    title: 'Knowledge base',
    kind: 'feat',
    status: 'active',
    overview: 'Topics a curator builds from every chat’s summaries.',
    aliases: ['Summaries by topic'],
    sections: {
      overview: 'Chats are summarised as they go; a curator files each summary under a topic with sections, decisions, refs and key messages. Agents read the topic for their branch instead of raw summaries.',
      state: 'Design approved; three lanes running: CLI, app and artifacts.',
      pitfalls: '- A disabled project is never scanned and its sessions never reach the summary model.',
      open: '- Backfill the existing summaries through the curator, oldest first.\n- Artifacts strip on the topic page.',
    },
    refs: [{ kind: 'issue', id: '121', title: 'Knowledge base', url: 'https://github.com/oguilhermelima/megabrain/issues/121' }, { kind: 'branch', id: 'feat/knowledge-app' }, { kind: 'file', id: 'src/chat/summaries.ts' }],
    decisions: [
      { id: 'd1', text: 'The topic is the unit worth keeping, not the chat.', why: 'Per-chat summaries pile up by the hundred and nobody rereads them.', at: ago(60), chatId: 'chat-knowledge' },
      { id: 'd2', text: 'State lives in JSON files under the state directory, with no database migration.', why: 'Revisions are append-only and cheap to audit.', at: ago(50), chatId: 'chat-knowledge' },
    ],
    keyMessages: [{ chatId: 'chat-knowledge', eventCursor: '30', at: ago(12), role: 'person', text: 'Approved. Lanes: CLI, app, artifacts.', why: 'Approved the design and the split.' }],
  }),
  topic('chat-summaries', megabrain, 880, {
    title: 'Chat summaries',
    kind: 'feat',
    status: 'shipped',
    overview: 'A short summary of each chat as it goes, by a small model.',
    aliases: ['Summaries wiki', 'Summaries by branch'],
    sections: { overview: 'Every few messages or minutes a small model summarises the chat.', state: 'Shipped; the knowledge base now builds on it.', pitfalls: '', open: '' },
    refs: [{ kind: 'file', id: 'src/chat/summaries.ts' }, { kind: 'branch', id: 'feat/summaries-wiki' }],
  }),
  topic('notes-capture', notes, 300, {
    title: 'Quick capture',
    kind: 'feat',
    status: 'active',
    overview: 'A note from anywhere with one shortcut.',
    sections: { overview: 'A global shortcut opens a capture field over any app.', state: 'Prototype on a branch.', pitfalls: '', open: '- Where the note lands when no notebook is open.' },
  }),
  ...atlasTopics(),
]

/** Sixty topics for atlas, the same on every load: every kind, unevenly, sharing chats, files and PRs. */
function atlasTopics(): KnowledgeTopic[] {
  let seed = 11
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  const kinds: KnowledgeTopic['kind'][] = ['feat', 'feat', 'feat', 'fix', 'fix', 'refactor', 'decision', 'investigation']
  const subjects = ['Player', 'Search', 'Onboarding', 'Home rails', 'Sidebar', 'Dispatch queue', 'Worktree cards', 'Settings', 'Sync engine', 'Offline cache', 'Release notes', 'Auth tokens', 'Image pipeline', 'Push alerts', 'Usage meter']
  const aspects = ['layout', 'keyboard focus', 'loading states', 'error copy', 'retry policy', 'cold start', 'accessibility pass', 'dark theme', 'telemetry', 'empty state', 'drag and drop', 'migration to the new store']
  const pick = <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T
  return Array.from({ length: 60 }, (_, n) => {
    const kind = pick(kinds)
    const chats = Array.from({ length: Math.floor(next() * 3) }, () => `atlas-chat-${Math.floor(next() * 45)}`)
    const files = Array.from({ length: Math.floor(next() * 3) }, () => ({ kind: 'file' as const, id: `src/${pick(['app', 'core', 'ui'])}/module-${Math.floor(next() * 35)}.ts` }))
    const prs = next() < 0.25 ? [{ kind: 'pr' as const, id: String(500 + Math.floor(next() * 14)) }] : []
    const status = next() < 0.55 ? 'shipped' : next() < 0.8 ? 'active' : 'dropped'
    const title = `${pick(subjects)} ${pick(aspects)}`
    const minutes = Math.floor(next() * 20_000)
    const made = topic(`atlas-${n}`, atlas, minutes, { title, kind, status, overview: `${title}, as the atlas team left it.`, sections: { overview: `${title}.`, state: status === 'shipped' ? 'Shipped.' : status === 'active' ? 'In progress.' : 'Dropped.', pitfalls: '', open: '' }, refs: [...files, ...prs] })
    return { ...made, chats, activity: Math.floor(next() * next() * 40) }
  })
}

const summaryOf = ({ sections: _sections, decisions: _decisions, keyMessages: _keyMessages, chatRecords: _chatRecords, ...summary }: KnowledgeTopic): KnowledgeTopicSummary => summary

/** Each project's topics; a project whose summaries are off (`enabled`) lists none. */
export function mockKnowledgeList(repo: string | undefined, enabled: (repo: string) => boolean): KnowledgeList {
  const projects = [
    { repo: megabrain, project: 'megabrain' },
    { repo: canto, project: 'canto' },
    { repo: atlas, project: 'atlas' },
    { repo: notes, project: 'notes' },
    { repo: `${root}/local/stack`, project: 'stack' },
  ]
  return {
    projects: projects
      .filter((project) => repo === undefined || project.repo === repo)
      .map((project) => ({ ...project, enabled: enabled(project.repo), topics: !enabled(project.repo) ? [] : mockKnowledgeTopics.filter((entry) => entry.project === project.repo).map(summaryOf) })),
  }
}

export function mockKnowledgeSearch(text: string, repo?: string): KnowledgeSearch {
  const topics = mockKnowledgeTopics.filter((entry) => repo === undefined || entry.project === repo).map(summaryOf)
  return { results: searchTopics(topics, text).map((entry, index) => ({ ...entry, score: 1 / (index + 1) })) }
}

export function mockKnowledgeTranscript(chatId: string): KnowledgeTranscript | null {
  const record = mockKnowledgeChats.find((entry) => entry.id === chatId)
  if (record === undefined) return null
  const start = Date.parse(record.startedAt)
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString()
  const events: KnowledgeTranscript['events'] = [
    { cursor: '1', at: at(0), role: 'person', text: `${record.title}. Tests first, then the fix; report the numbers.` },
    { cursor: '2', at: at(1), role: 'agent', text: 'Reading the code before touching anything.' },
    { cursor: '3', at: at(1), role: 'tool', text: 'read apps/tv/player/use-player-seek.ts' },
    { cursor: '4', at: at(2), role: 'tool', text: 'ran rg "playbackRate" apps/tv: 6 matches' },
    { cursor: '5', at: at(3), role: 'agent', text: 'The rate is set once when the player mounts, and a seek reloads the source, which resets it to 1.\n\nI will restore it after `seeked`, and clamp the seek target to `[0, duration]`.' },
    { cursor: '6', at: at(9), role: 'tool', text: 'edited apps/tv/player/use-player-seek.ts' },
    { cursor: '7', at: at(10), role: 'tool', text: 'ran bun test apps/tv: 412 pass, 0 fail' },
    ...record.lastMessages.map((message, index) => ({ cursor: String(8 + index), at: message.at, role: message.role === 'person' ? ('person' as const) : ('agent' as const), text: message.text })),
  ]
  return { chat: record, events }
}
