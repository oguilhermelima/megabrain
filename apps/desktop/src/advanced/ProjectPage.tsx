import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { api } from '@/api'
import type { GithubCheck, GithubDetail, GithubIssue, GithubPullRequest, NativeChat, Project, ProjectScripts } from '@/api/schema'
import { displayName, projectTint } from '@/advanced/appearance-model'
import { NewWorktreeDialog } from '@/advanced/NewWorktreeDialog'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { projectColor } from '@/advanced/picture-model'
import { changeCounts, defaultBranch, heroFacts, newestFirst, recentChats, scriptRows, scriptState, worktreeSummaries, type ChangeCounts, type RecentChat, type ScriptRow, type ScriptState, type WorktreeOpen, type WorktreeSummary } from '@/advanced/project-page-model'
import { useStackDetails } from '@/advanced/useStackDetails'
import { AgentIcon } from '@/components/agent-icons'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { ContextMenu, menuFrom, type MenuItem, type OpenMenu } from '@/components/ContextMenu'
import { MenuIconGlyph, type MenuIcon } from '@/components/menu-icons'
import { Bone } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { checkSummary, githubRepository, stateColors } from '@/github/github-model'
import { issuePage, pullRequestPage } from '@/github/github-requests'
import { CommentIcon, PullRequestIcon } from '@/github/icons'
import { CheckGlyph, IssueStateIcon, LabelChip, PullRequestStateIcon, ReviewChip, ago, checkTitle, openOnGithub, useNow } from '@/github/parts'
import type { GithubKind } from '@/github/useGithubCounts'
import { mapLimited } from '@/lib/poll-model'
import { useRunControls, type RunControls } from '@/run-panel/run-context'
import { pageX } from '@/lib/page'

// A project's page in a pane. A hero says who it is (picture, name, remote, the main checkout's
// branch, its path) and what is live in it, with New chat as the one primary action and the rest in a
// compact toolbar and a more menu. Below, sections for its worktrees (across the page), its open pull
// requests and issues, recent chats and commands, two columns from 1200 px. Every list comes from a
// call the app already makes; each section shows its skeleton until its call answers.

const shownItems = 5

export interface ProjectPageActions {
  /** A launcher in the worktree at `path`, or in the project when null. */
  newChat: (path: string | null) => void
  createWorktree: (project: Project, branch: string, base: string) => void
  /** Branches being created in this project, which the new worktree dialog refuses. */
  creating: readonly string[]
  code: (root: string) => void
  github: (project: Project, kind: GithubKind, focus?: number) => void
  /** A worktree's latest chat, or its launcher. */
  open: (open: WorktreeOpen, path: string) => void
}

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed'; error: unknown }

/** One read per key; a key that changes starts over from loading. */
function useLoad<T>(key: string | null, read: () => Promise<T>): Load<T> {
  const [load, setLoad] = useState<{ key: string | null; value: Load<T> }>({ key, value: { state: 'loading' } })
  useEffect(() => {
    if (key === null) return
    let current = true
    setLoad({ key, value: { state: 'loading' } })
    read().then(
      (value) => current && setLoad({ key, value: { state: 'ready', value } }),
      (error: unknown) => current && setLoad({ key, value: { state: 'failed', error } }),
    )
    return () => {
      current = false
    }
  }, [key])
  return load.key === key ? load.value : { state: 'loading' }
}

/** What one pull request's detail adds to its row. */
interface PullDetail {
  checks: GithubCheck[]
  review: GithubDetail['reviewDecision'] | null
}

const hover = 'transition-colors duration-[var(--motion-enter)] ease-[var(--motion-ease-out)]'
const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export function ProjectPage({ project, chats, actions }: { project: Project; chats: Record<string, NativeChat[]>; actions: ProjectPageActions }) {
  const now = useNow(30_000)
  const repository = githubRepository(project.remote)
  const run = useRunControls()
  const [newWorktree, setNewWorktree] = useState(false)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const worktrees = worktreeSummaries(project, chats)
  const chatsShown = recentChats(project, chats, 6)
  const name = displayName(project)
  const tint = projectTint(project) ?? projectColor(project.name)
  const scripts = useLoad<ProjectScripts>(project.path, () => api.projectScripts(project.path))
  const rows = scriptRows(scripts.state === 'ready' ? scripts.value : null)
  const port = scripts.state === 'ready' ? scripts.value.port : null
  const runRow = rows.find((row) => row.action === 'run')
  const stacks = useStackDetails([project]).details[project.path] ?? {}

  const pulls = useLoad(repository === null ? null : project.path, () => pullRequestPage(project.path, 'open', null))
  const issues = useLoad(repository === null ? null : project.path, () => issuePage(project.path, 'open', null))
  const topPulls = pulls.state === 'ready' ? newestFirst(pulls.value.items, shownItems) : []
  // Checks and the review decision come with one pull request's detail only, so just the few shown are read.
  const details = useLoad(topPulls.length === 0 ? null : `${project.path}\n${topPulls.map((item) => item.number).join(',')}`, async () =>
    Object.fromEntries(
      await mapLimited(topPulls, 2, async (item) => {
        const detail = await api.githubPullRequest(project.path, item.number).catch(() => null)
        return [item.number, { checks: detail?.checks ?? [], review: detail?.reviewDecision ?? null } satisfies PullDetail] as const
      }),
    ),
  )
  const worktreeKey = worktrees.map((worktree) => worktree.path).join('\n')
  const changed = useLoad(worktreeKey, async () => {
    const parents = new Map(project.worktrees.map((worktree) => [worktree.path, worktree.parent]))
    const counts = await mapLimited(worktrees, 3, async (worktree) => {
      try {
        const [uncommitted, branch] = await Promise.all([api.codeChanges(worktree.path), api.codeBranchChanges(worktree.path, parents.get(worktree.path) ?? null).catch(() => null)])
        return [worktree.path, changeCounts(uncommitted, branch)] as const
      } catch {
        return [worktree.path, null] as const
      }
    })
    return Object.fromEntries(counts) as Record<string, ChangeCounts | null>
  })

  const openCount = (load: Load<{ counts: Record<string, number>; totalCount: number }>) => (load.state === 'ready' ? (load.value.counts.open ?? load.value.totalCount) : null)
  const facts = heroFacts({ worktrees: worktrees.length, working: worktrees.reduce((sum, worktree) => sum + worktree.working, 0), pulls: openCount(pulls), issues: openCount(issues) })

  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {})
  const editCommands = () => run?.editCommands(project.path)
  const openMore = (event: MouseEvent<HTMLButtonElement>) => {
    const items: MenuItem[] = [
      { label: 'Reveal in Finder', icon: 'reveal', group: 'open', onSelect: () => void api.revealPath(project.path).catch(() => {}) },
      { label: 'Copy path', icon: 'copy', group: 'copy', onSelect: () => copy(project.path) },
      ...(repository === null ? [] : [{ label: 'Copy repository address', icon: 'link', group: 'copy', onSelect: () => copy(repository.url) } satisfies MenuItem]),
      { label: 'Project settings', icon: 'rename', group: 'organise', onSelect: editCommands },
    ]
    setMenu(menuFrom(event, items))
  }
  const finish = (worktree: WorktreeSummary) =>
    setConfirm({
      title: `Finish ${worktree.name}?`,
      body: `This deletes the folder ${worktree.path} and the branch ${worktree.branch ?? '(detached)'} from ${name}. megabrain refuses when the branch has work that is not merged, and nothing is deleted then.`,
      action: 'Finish worktree',
      run: () => api.removeWorktree(worktree.path),
    })

  return (
    <div className="@container min-h-0 flex-1 overflow-y-auto">
      <div className={`mx-auto flex max-w-[1320px] flex-col gap-6 pt-6 pb-14 @min-[720px]:pt-8 ${pageX}`}>
        <header className="relative overflow-hidden rounded-[32px] border border-white/[0.07] bg-ink-900 px-6 py-6 @min-[720px]:px-8 @min-[720px]:py-7">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(90% 140% at 0% 0%, color-mix(in srgb, ${tint} 16%, transparent), transparent 62%)` }} />
          <div className="relative flex flex-col gap-6 @min-[900px]:flex-row @min-[900px]:items-end">
            <div className="flex min-w-0 flex-1 items-start gap-5">
              <ProjectPicture project={project} size="hero" />
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[30px] leading-[1.15] font-semibold tracking-[-0.025em] text-ink-100">{name}</h1>
                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-[13px] text-ink-400">
                  {repository !== null ? (
                    <button type="button" onClick={() => void openOnGithub(repository.url)} className={`-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 font-medium text-ink-300 hover:text-ink-100 ${hover} ${focusRing}`}>
                      <span className="truncate">{repository.nameWithOwner}</span>
                      <span className="shrink-0 text-ink-500">
                        <MenuIconGlyph icon="external" />
                      </span>
                    </button>
                  ) : (
                    <span className="truncate select-text">{project.remote ?? 'No remote'}</span>
                  )}
                  {defaultBranch(project) !== null && (
                    <>
                      <Dot />
                      <span className="flex items-center gap-1.5 px-1">
                        <MenuIconGlyph icon="branch" />
                        <span className="font-mono text-[12px]">{defaultBranch(project)}</span>
                      </span>
                    </>
                  )}
                  <Dot />
                  <CopyPath path={project.path} />
                </div>
                <ul aria-label="At a glance" className="mt-4 flex flex-wrap gap-1.5">
                  {facts.map((fact) => (
                    <li key={fact.key} className={`flex h-7 items-center gap-2 rounded-full px-3 text-[12.5px] font-medium tabular-nums ${fact.live === true ? 'bg-ok/[0.1] text-ok' : 'bg-white/[0.05] text-ink-300'}`}>
                      {fact.live === true && <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-ok motion-reduce:animate-none" />}
                      {fact.text}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 @min-[900px]:flex-col @min-[900px]:items-end">
              <button type="button" onClick={() => actions.newChat(project.path)} className={`flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-[14px] font-semibold text-accent-ink hover:bg-[#a3aeff] ${hover} ${focusRing}`}>
                <MenuIconGlyph icon="chat" />
                New chat
              </button>
              <div role="toolbar" aria-label={`${name} actions`} className="flex items-center gap-0.5 rounded-full border border-white/[0.08] bg-white/[0.04] p-1">
                <ToolButton icon="branch" label="New worktree" onClick={() => setNewWorktree(true)} />
                <ToolButton icon="code" label="Code" onClick={() => actions.code(project.path)} />
                <RunToolButton run={run} row={runRow ?? null} loading={scripts.state === 'loading'} port={port} onSetUp={editCommands} />
                {repository !== null && <ToolButton icon="external" label="GitHub" onClick={() => void openOnGithub(repository.url)} />}
                <button type="button" aria-label="More actions" aria-haspopup="menu" onClick={openMore} className={`grid h-8 w-8 place-items-center rounded-full text-[15px] font-bold text-ink-300 hover:bg-white/[0.08] hover:text-ink-100 ${hover} ${focusRing}`}>
                  <span aria-hidden="true" className="-mt-1.5">
                    …
                  </span>
                </button>
              </div>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 @min-[1200px]:grid-cols-[repeat(2,minmax(0,1fr))]">
          <Section title="Worktrees" count={worktrees.length} action={{ label: 'New worktree', onClick: () => setNewWorktree(true) }} className="@min-[1200px]:col-span-2">
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5 @min-[1200px]:grid-cols-[repeat(2,minmax(0,1fr))] @min-[1200px]:gap-x-2">
              {worktrees.map((worktree) => (
                <WorktreeRow
                  key={worktree.path}
                  worktree={worktree}
                  counts={changed.state === 'ready' ? (changed.value[worktree.path] ?? null) : undefined}
                  review={worktree.branch === null ? null : (stacks[worktree.branch]?.reviewDecision ?? null)}
                  behind={worktree.branch === null ? null : (stacks[worktree.branch]?.behindParent ?? null)}
                  now={now}
                  onOpen={() => actions.open(worktree.open, worktree.path)}
                  onNewChat={() => actions.newChat(worktree.path)}
                  onCode={() => actions.code(worktree.path)}
                  onFinish={worktree.primary ? null : () => finish(worktree)}
                />
              ))}
            </ul>
          </Section>

          {repository !== null && (
            <Section title="Pull requests" count={openCount(pulls)} action={{ label: 'All pull requests', onClick: () => actions.github(project, 'prs') }}>
              <GithubList
                load={pulls}
                empty={<EmptyState text="No open pull requests." action={{ label: 'New worktree', onClick: () => setNewWorktree(true) }} />}
                render={(items: GithubPullRequest[]) =>
                  newestFirst(items, shownItems).map((item) => (
                    <GithubRow key={item.number} icon={<PullRequestStateIcon item={item} size={15} />} title={item.title} labels={item.labels} meta={`#${item.number} · ${item.author?.login ?? 'unknown'} · ${ago(item.updatedAt, now)}`} comments={item.comments} onClick={() => actions.github(project, 'prs', item.number)}>
                      <PullStatus detail={details.state === 'ready' ? details.value[item.number] : details.state === 'failed' ? null : undefined} />
                    </GithubRow>
                  ))
                }
              />
            </Section>
          )}
          {repository !== null && (
            <Section title="Issues" count={openCount(issues)} action={{ label: 'All issues', onClick: () => actions.github(project, 'issues') }}>
              <GithubList
                load={issues}
                empty={<EmptyState text="No open issues." action={{ label: 'All issues', onClick: () => actions.github(project, 'issues') }} />}
                render={(items: GithubIssue[]) =>
                  newestFirst(items, shownItems).map((item) => (
                    <GithubRow key={item.number} icon={<IssueStateIcon state={item.state} size={15} />} title={item.title} labels={item.labels} meta={`#${item.number} · ${item.author?.login ?? 'unknown'} · ${ago(item.updatedAt, now)}`} comments={item.comments} onClick={() => actions.github(project, 'issues', item.number)} />
                  ))
                }
              />
            </Section>
          )}

          <Section title="Recent chats" action={chatsShown.length === 0 ? undefined : { label: 'New chat', onClick: () => actions.newChat(project.path) }}>
            {chatsShown.length === 0 ? (
              <EmptyState text="No chats in this project yet." action={{ label: 'New chat', onClick: () => actions.newChat(project.path) }} />
            ) : (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
                {chatsShown.map((chat) => (
                  <ChatRow key={chat.key} chat={chat} now={now} onClick={() => actions.open(chat.open, chat.path)} />
                ))}
              </ul>
            )}
          </Section>

          <Section title="Scripts" action={{ label: 'Edit commands', onClick: editCommands }}>
            {scripts.state === 'failed' && (
              <div className="px-3 pb-2">
                <ErrorNote error={scripts.error} />
              </div>
            )}
            {scripts.state === 'ready' && rows.every((row) => row.command === null) ? (
              <EmptyState text="No commands yet. Set what Run, Build and Install do in this project." action={{ label: 'Set up commands', onClick: editCommands }} />
            ) : (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
                {rows.map((row) => (
                  <ScriptLine key={row.action} row={row} loading={scripts.state === 'loading'} state={scriptState(run?.panel ?? null, row.action)} run={run} port={row.action === 'run' ? port : null} onSetUp={editCommands} />
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
      <NewWorktreeDialog
        request={newWorktree ? { project } : null}
        taken={actions.creating}
        onCreate={(target, branch, base) => {
          setNewWorktree(false)
          actions.createWorktree(target, branch, base)
        }}
        onClose={() => setNewWorktree(false)}
      />
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  )
}

const Dot = () => (
  <span aria-hidden="true" className="px-0.5 text-ink-500">
    ·
  </span>
)

/** The project's folder, copied on a click; the label says so for a moment. */
function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      aria-label={`Copy ${path}`}
      onClick={() => navigator.clipboard.writeText(path).then(() => setCopied(true), () => {})}
      className={`group/path flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 font-mono text-[12px] text-ink-400 hover:text-ink-200 ${hover} ${focusRing}`}
    >
      <span className="truncate">{path}</span>
      <span aria-live="polite" className={`shrink-0 font-sans text-[11.5px] ${copied ? 'text-ok' : 'text-ink-500 opacity-0 group-hover/path:opacity-100 group-focus-visible/path:opacity-100'}`}>
        {copied ? 'Copied' : <MenuIconGlyph icon="copy" />}
      </span>
    </button>
  )
}

function ToolButton({ icon, label, onClick, tone, disabled = false }: { icon: MenuIcon; label: string; onClick: () => void; tone?: 'live'; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold hover:bg-white/[0.08] disabled:opacity-50 disabled:hover:bg-transparent ${tone === 'live' ? 'text-ok' : 'text-ink-200 hover:text-ink-100'} ${hover} ${focusRing}`}>
      <MenuIconGlyph icon={icon} />
      {label}
    </button>
  )
}

/** Run in the toolbar: runs the project's run command, stops it while it runs, or sets one up. */
function RunToolButton({ run, row, loading, port, onSetUp }: { run: RunControls | null; row: ScriptRow | null; loading: boolean; port: ProjectScripts['port'] | null; onSetUp: () => void }) {
  if (run === null) return null
  const state = scriptState(run.panel, 'run')
  if (state.kind === 'running' || state.kind === 'starting') return <ToolButton icon="stop" label="Stop" tone="live" onClick={() => run.stop('run')} />
  if (loading) return <ToolButton icon="terminal" label="Run" onClick={() => {}} disabled />
  const command = row?.command ?? null
  if (command === null) return <ToolButton icon="terminal" label="Set up Run" onClick={onSetUp} />
  return <ToolButton icon="terminal" label="Run" onClick={() => run.run('run', command, port)} />
}

function Section({ title, count, action, className = '', children }: { title: string; count?: number | null; action?: { label: string; onClick: () => void }; className?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className={`flex min-w-0 flex-col rounded-[24px] border border-white/[0.07] bg-ink-900/80 ${className}`}>
      <header className="flex min-h-12 items-center gap-2 px-5 pt-3.5 pb-1.5">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink-100">{title}</h2>
        {count !== undefined && count !== null && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-white/[0.07] px-1.5 text-[11.5px] font-semibold text-ink-300 tabular-nums">{count}</span>}
        {action !== undefined && (
          <button type="button" onClick={action.onClick} className={`-mr-2 ml-auto h-7 rounded-full px-2.5 text-[12.5px] font-semibold text-ink-400 hover:bg-white/[0.06] hover:text-ink-100 ${hover} ${focusRing}`}>
            {action.label}
          </button>
        )}
      </header>
      <div className="flex-1 px-2 pb-2">{children}</div>
    </section>
  )
}

function EmptyState({ text, action }: { text: string; action: { label: string; onClick: () => void } }) {
  return (
    <div className="flex flex-col items-start gap-3 px-3 pt-1 pb-3">
      <p className="text-[13px] leading-relaxed text-ink-400">{text}</p>
      <button type="button" onClick={action.onClick} className={`h-8 rounded-full border border-white/[0.10] bg-white/[0.05] px-3.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.10] ${hover} ${focusRing}`}>
        {action.label}
      </button>
    </div>
  )
}

const rowClass = `flex w-full min-w-0 items-center gap-3 rounded-[14px] px-3 py-2.5 text-left hover:bg-row-hover ${hover} ${focusRing}`

/** The 28 px tile every row starts with. */
const Tile = ({ children, className = 'text-ink-300' }: { children: ReactNode; className?: string }) => <span className={`grid size-7 shrink-0 place-items-center rounded-[9px] bg-white/[0.05] ${className}`}>{children}</span>

const reviewStates = ['approved', 'changes_requested', 'review_required'] as const

const prChipLabel = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' } as const

function WorktreeRow({
  worktree,
  counts,
  review,
  behind,
  now,
  onOpen,
  onNewChat,
  onCode,
  onFinish,
}: {
  worktree: WorktreeSummary
  /** undefined while read, null when git could not tell. */
  counts: ChangeCounts | null | undefined
  review: string | null
  behind: number | null
  now: number
  onOpen: () => void
  onNewChat: () => void
  onCode: () => void
  onFinish: (() => void) | null
}) {
  const pullRequest = worktree.pullRequest
  const color = pullRequest?.state === null || pullRequest === null ? null : stateColors[pullRequest.state]
  const reviewDecision = reviewStates.find((state) => state === review?.toLowerCase()) ?? null
  const meta = [worktree.chatCount === 0 ? 'No chats yet' : `${worktree.chatCount} ${worktree.chatCount === 1 ? 'chat' : 'chats'}`, worktree.lastActivityAt === null ? null : ago(worktree.lastActivityAt, now)].filter((part) => part !== null && part !== '')
  return (
    <li className="group relative">
      <button type="button" onClick={onOpen} aria-label={`${worktree.name}: open its latest chat`} className={`${rowClass} pr-[7.5rem]`}>
        <Tile className={worktree.primary ? 'text-accent' : 'text-ink-300'}>
          <MenuIconGlyph icon="branch" />
        </Tile>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-[13px] font-medium text-ink-100">{worktree.name}</span>
            {worktree.primary && <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-px text-[11px] font-semibold text-ink-300">Main checkout</span>}
            {pullRequest !== null && (
              <span className="flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-[11px] font-semibold" style={color === null ? undefined : { color, backgroundColor: `${color}1f` }}>
                <PullRequestIcon size={11} />#{pullRequest.number}
                {pullRequest.state !== null && <span className="font-medium opacity-80">{prChipLabel[pullRequest.state]}</span>}
              </span>
            )}
            {reviewDecision !== null && <ReviewChip decision={reviewDecision} />}
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[12px] text-ink-400">
            {worktree.working > 0 && (
              <span className="flex items-center gap-1.5 font-medium text-ok">
                <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-ok motion-reduce:animate-none" />
                {worktree.working} working
              </span>
            )}
            <span>{meta.join(' · ')}</span>
            {behind !== null && behind > 0 && <span className="font-medium text-warn">{behind} behind its parent</span>}
          </span>
        </span>
      </button>
      {/* The facts sit where the actions show, so a hover or keyboard focus trades one for the other. */}
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center transition-opacity duration-[var(--motion-enter)] group-focus-within:opacity-0 group-hover:opacity-0">
        <Changes counts={counts} />
      </span>
      <span className="absolute inset-y-0 right-2 flex items-center gap-0.5 opacity-0 transition-opacity duration-[var(--motion-enter)] group-focus-within:opacity-100 group-hover:opacity-100">
        <RowAction icon="chat" label={`New chat in ${worktree.name}`} onClick={onNewChat} />
        <RowAction icon="code" label={`Open ${worktree.name} in Code`} onClick={onCode} />
        {onFinish !== null && <RowAction icon="trash" label={`Finish ${worktree.name}`} onClick={onFinish} danger />}
      </span>
    </li>
  )
}

function RowAction({ icon, label, onClick, danger = false }: { icon: MenuIcon; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className={`grid size-8 place-items-center rounded-full text-ink-300 hover:bg-white/[0.08] ${danger ? 'hover:text-bad' : 'hover:text-ink-100'} ${hover} ${focusRing}`}>
      <MenuIconGlyph icon={icon} />
    </button>
  )
}

/** Changed files by kind; a pulse while read, a quiet "Clean" when there are none. */
function Changes({ counts }: { counts: ChangeCounts | null | undefined }) {
  if (counts === undefined) return <Bone width="w-16" />
  if (counts === null) return null
  const total = counts.added + counts.modified + counts.deleted
  if (total === 0) return <span className="text-[12px] text-ink-500">Clean</span>
  const parts = [
    { key: 'added', value: counts.added, sign: '+', className: 'text-ok', word: 'added' },
    { key: 'modified', value: counts.modified, sign: '~', className: 'text-warn', word: 'modified' },
    { key: 'deleted', value: counts.deleted, sign: '−', className: 'text-bad', word: 'deleted' },
  ].filter((part) => part.value > 0)
  return (
    <span aria-label={`${parts.map((part) => `${part.value} ${part.word}`).join(', ')}${counts.uncommitted > 0 ? `, ${counts.uncommitted} not committed` : ''}`} className="flex items-center gap-2 font-mono text-[12px] font-medium tabular-nums">
      {parts.map((part) => (
        <span key={part.key} className={part.className}>
          {part.sign}
          {part.value}
        </span>
      ))}
      {counts.uncommitted > 0 && <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />}
    </span>
  )
}

function GithubList<T>({ load, empty, render }: { load: Load<{ items: T[] }>; empty: ReactNode; render: (items: T[]) => ReactNode }) {
  if (load.state === 'loading')
    return (
      <ul role="status" aria-busy="true" aria-label="Loading" className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
        {[0, 1, 2].map((index) => (
          <li key={index} aria-hidden="true" className="flex items-center gap-3 px-3 py-2.5">
            <span className="size-7 shrink-0 animate-pulse rounded-[9px] bg-white/[0.05] motion-reduce:animate-none" />
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <Bone width={['w-[68%]', 'w-[52%]', 'w-[60%]'][index] ?? 'w-1/2'} />
              <Bone width="w-[32%]" className="h-2.5" />
            </span>
          </li>
        ))}
      </ul>
    )
  if (load.state === 'failed')
    return (
      <div className="px-3 pb-2">
        <ErrorNote error={load.error} />
      </div>
    )
  if (load.value.items.length === 0) return empty
  return <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">{render(load.value.items)}</ul>
}

const shownLabels = 3

function GithubRow({ icon, title, labels, meta, comments, onClick, children }: { icon: ReactNode; title: string; labels: GithubIssue['labels']; meta: string; comments: number; onClick: () => void; children?: ReactNode }) {
  const extra = labels.length - shownLabels
  return (
    <li>
      <button type="button" onClick={onClick} className={`${rowClass} items-start`}>
        <Tile>{icon}</Tile>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] leading-[1.35] font-medium text-ink-100">{title}</span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-400">
            <span className="truncate">{meta}</span>
            {comments > 0 && (
              <span className="flex items-center gap-1" aria-label={`${comments} comments`}>
                <CommentIcon size={12} />
                <span className="tabular-nums">{comments}</span>
              </span>
            )}
          </span>
          {labels.length > 0 && (
            <span className="mt-1.5 flex min-w-0 flex-wrap gap-1">
              {labels.slice(0, shownLabels).map((label) => (
                <LabelChip key={label.name} name={label.name} color={label.color} />
              ))}
              {extra > 0 && <span className="inline-flex h-[20px] items-center rounded-full bg-white/[0.06] px-2 text-[11.5px] font-semibold text-ink-400">+{extra}</span>}
            </span>
          )}
        </span>
        {children}
      </button>
    </li>
  )
}

/** A pull request's review decision and checks; a pulse while its detail is read, nothing when unknown. */
function PullStatus({ detail }: { detail: PullDetail | null | undefined }) {
  if (detail === undefined) return <Bone width="w-20" className="mt-1.5 h-3" />
  if (detail === null) return null
  const summary = checkSummary(detail.checks)
  const review = reviewStates.find((state) => state === detail.review) ?? null
  const tone = summary.state === 'failing' ? 'text-bad' : summary.state === 'pending' ? 'text-warn' : 'text-ok'
  return (
    <span className="mt-0.5 flex shrink-0 items-center gap-2">
      <ReviewChip decision={review} />
      {summary.state !== 'none' && (
        <span aria-label={checkTitle(summary)} className={`flex items-center gap-1 text-[11.5px] font-semibold tabular-nums ${tone}`}>
          <CheckGlyph state={summary.state} size={13} />
          {summary.passed}/{summary.total - summary.skipped}
        </span>
      )}
    </span>
  )
}

const chatStatus: Partial<Record<RecentChat['status'], { label: string; className: string }>> = {
  working: { label: 'Working', className: 'text-ok' },
  waiting: { label: 'Needs you', className: 'text-warn' },
}

function ChatRow({ chat, now, onClick }: { chat: RecentChat; now: number; onClick: () => void }) {
  const status = chatStatus[chat.status]
  return (
    <li>
      <button type="button" onClick={onClick} className={rowClass}>
        <Tile>
          <AgentIcon agent={chat.agent} size={15} activity={chat.status === 'working' ? 'working' : chat.status === 'waiting' ? 'waiting' : 'idle'} />
        </Tile>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-ink-100">{chat.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px] text-ink-400">
            {status !== undefined && <span className={`shrink-0 font-medium ${status.className}`}>{status.label}</span>}
            <span className="flex min-w-0 items-center gap-1">
              <span className="shrink-0 text-ink-500">
                <MenuIconGlyph icon="branch" />
              </span>
              <span className="truncate font-mono text-[11.5px]">{chat.worktree}</span>
            </span>
          </span>
        </span>
        {chat.at !== null && <span className="shrink-0 text-[12px] text-ink-500 tabular-nums">{ago(chat.at, now)}</span>}
      </button>
    </li>
  )
}

const scriptChips: Record<ScriptState['kind'], { label: string; className: string } | null> = {
  idle: null,
  stopped: { label: 'Stopped', className: 'bg-white/[0.06] text-ink-400' },
  starting: { label: 'Starting', className: 'bg-accent/[0.12] text-accent' },
  running: { label: 'Running', className: 'bg-ok/[0.12] text-ok' },
  failed: { label: 'Failed', className: 'bg-bad/[0.12] text-bad' },
}

const scriptIcons: Record<ScriptRow['action'], MenuIcon> = { run: 'terminal', build: 'stack', install: 'import' }

function ScriptLine({ row, loading, state, run, port, onSetUp }: { row: ScriptRow; loading: boolean; state: ScriptState; run: RunControls | null; port: ProjectScripts['port'] | null; onSetUp: () => void }) {
  const chip = scriptChips[state.kind]
  const live = state.kind === 'running' || state.kind === 'starting'
  const command = row.command
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-[14px] px-3 py-2.5">
      <Tile className={live ? 'text-ok' : state.kind === 'failed' ? 'text-bad' : 'text-ink-300'}>
        <MenuIconGlyph icon={scriptIcons[row.action]} />
      </Tile>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium text-ink-100">{row.label}</span>
          {chip !== null && (
            <span className={`flex h-[20px] items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold ${chip.className}`}>
              {live && <span aria-hidden="true" className={`size-1.5 rounded-full ${state.kind === 'running' ? 'animate-pulse bg-ok motion-reduce:animate-none' : 'bg-accent'}`} />}
              {state.kind === 'failed' && state.code !== null ? `${chip.label} · exit ${state.code}` : chip.label}
            </span>
          )}
          {row.detected && <span className="text-[11px] text-ink-500">detected</span>}
        </span>
        {loading ? <Bone width="w-40" className="mt-1.5 h-2.5" /> : <code className={`mt-0.5 block truncate font-mono text-[12px] select-text ${command === null ? 'text-ink-500' : 'text-ink-300'}`}>{command ?? 'Not set'}</code>}
      </span>
      {!loading &&
        run !== null &&
        (live ? (
          <ScriptButton label="Stop" icon="stop" onClick={() => run.stop(row.action)} />
        ) : command === null ? (
          <ScriptButton label="Set up" onClick={onSetUp} quiet />
        ) : (
          <ScriptButton label={row.label} icon={scriptIcons[row.action]} onClick={() => run.run(row.action, command, port)} />
        ))}
    </li>
  )
}

function ScriptButton({ label, icon, onClick, quiet = false }: { label: string; icon?: MenuIcon; onClick: () => void; quiet?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold ${quiet ? 'text-ink-400 hover:bg-white/[0.06] hover:text-ink-100' : 'border border-white/[0.10] bg-white/[0.05] text-ink-100 hover:bg-white/[0.10]'} ${hover} ${focusRing}`}
    >
      {icon !== undefined && <MenuIconGlyph icon={icon} />}
      {label}
    </button>
  )
}
