import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { api } from '@/api'
import type { GithubActionRun, GithubIssue, GithubPullRequest, NativeChat, Project, ProjectScripts } from '@/api/schema'
import { displayName, projectTint } from '@/advanced/appearance-model'
import { NewWorktreeDialog } from '@/advanced/NewWorktreeDialog'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { projectColor } from '@/advanced/picture-model'
import { changeCounts, changesUnavailable, defaultBranch, issuesNote, newestFirst, pullDetail, recentChats, scriptRows, scriptState, worktreeSummaries, type ChangeCounts, type RecentChat, type ScriptRow, type ScriptState, type PullDetail, type SummaryLoad, type WorktreeOpen, type WorktreeSummary } from '@/advanced/project-page-model'
import { useStackDetails } from '@/advanced/useStackDetails'
import { AgentIcon } from '@/components/agent-icons'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { ContextMenu, menuFrom, type MenuItem, type OpenMenu } from '@/components/ContextMenu'
import { MenuIconGlyph, type MenuIcon } from '@/components/menu-icons'
import { Bone } from '@/components/Skeleton'
import { Tooltip } from '@/components/Tooltip'
import { ErrorNote } from '@/components/ui'
import { checkSummary, githubRepository, stateColors } from '@/github/github-model'
import { formatDuration, isLive, latestRunsByBranch, runDuration, runLabels, runVisual } from '@/github/actions-model'
import { noRunFilters } from '@/github/actions-requests'
import { BranchChip, RunStatusIcon, eventName } from '@/github/actions-parts'
import { useRuns } from '@/github/useRuns'
import { issuePage, pullRequestPage } from '@/github/github-requests'
import { CommentIcon, PullRequestIcon } from '@/github/icons'
import { CheckGlyph, LabelChip, PullRequestStateIcon, ReviewChip, ago, checkTitle, openOnGithub, useNow } from '@/github/parts'
import type { GithubKind } from '@/github/useGithubCounts'
import { tildePath } from '@/import/parts'
import { mapLimited } from '@/lib/poll-model'
import { useRunControls, type RunControls } from '@/run-panel/run-context'
import { pageX } from '@/lib/page'
import { onAction } from '@/lib/app-events'

// A project's page in a pane. A hero says who it is (picture, name, and one line with the remote, the
// main checkout's branch and its path) and, on a row of its own under that, its actions: New chat as the
// one primary beside quiet buttons and a more menu, so they never squeeze the identity. Below, one
// titled group under another: its recent chats, worktrees, open pull requests and issues, and commands,
// each a card of rows of one height with their facts muted at the end. Every list comes from a
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

type Load<T> = SummaryLoad<T>

/** One read per key; a key that changes starts over from loading. */
function useLoad<T>(key: string | null, read: (refresh?: boolean) => Promise<T>, refreshOnAction = false): Load<T> {
  const [load, setLoad] = useState<{ key: string | null; value: Load<T> }>({ key, value: { state: 'loading' } })
  useEffect(() => {
    if (key === null) return
    let current = true
    setLoad({ key, value: { state: 'loading' } })
    const load = (refresh = false) => {
      setLoad({ key, value: { state: 'loading' } })
      read(refresh).then(
        (value) => current && setLoad({ key, value: { state: 'ready', value } }),
        (error: unknown) => current && setLoad({ key, value: { state: 'failed', error } }),
      )
    }
    load()
    const stop = refreshOnAction ? onAction(() => load(true)) : undefined
    return () => {
      current = false
      stop?.()
    }
  }, [key])
  return load.key === key ? load.value : { state: 'loading' }
}

/** What one pull request's detail adds to its row. */

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
  const chatsShown = recentChats(project, chats, 30)
  const name = displayName(project)
  const tint = projectTint(project) ?? projectColor(project.name)
  const home = useLoad('home', () => api.homeDir())
  const scripts = useLoad<ProjectScripts>(project.path, () => api.projectScripts(project.path))
  const rows = scriptRows(scripts.state === 'ready' ? scripts.value : null)
  const port = scripts.state === 'ready' ? scripts.value.port : null
  const runRow = rows.find((row) => row.action === 'run')
  const stacks = useStackDetails([project]).details[project.path] ?? {}

  const pulls = useLoad(repository === null ? null : project.path, (refresh) => pullRequestPage(project.path, 'open', null, undefined, { refresh }), true)
  const issues = useLoad(repository === null ? null : project.path, (refresh) => issuePage(project.path, 'open', null, undefined, { refresh }), true)
  // The latest runs, read again every 10 s while one runs; the worktree rows show their branch's newest.
  const runs = useRuns(repository === null ? null : project.path, noRunFilters, 30)
  const runsLoad: Load<{ items: GithubActionRun[] }> = runs.page !== null ? { state: 'ready', value: { items: runs.page.runs } } : runs.error !== null ? { state: 'failed', error: runs.error } : { state: 'loading' }
  const latestRuns = runs.page === null ? null : latestRunsByBranch(runs.page.runs)
  const worktreeKey = worktrees.map((worktree) => worktree.path).join('\n')
  const changed = useLoad(worktreeKey, async () => {
    const parents = new Map(project.worktrees.map((worktree) => [worktree.path, worktree.parent]))
    const counts = await mapLimited(worktrees, 3, async (worktree) => {
      try {
        const [uncommitted, branch] = await Promise.all([api.codeChanges(worktree.path), api.codeBranchChanges(worktree.path, parents.get(worktree.path) ?? null)])
        return [worktree.path, changeCounts(uncommitted, branch)] as const
      } catch {
        return [worktree.path, null] as const
      }
    })
    return Object.fromEntries(counts) as Record<string, ChangeCounts | null>
  })

  const openCount = (load: Load<{ counts: Record<string, number>; totalCount: number }>) => (load.state === 'ready' ? (load.value.counts.open ?? load.value.totalCount) : null)

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
        <header className="relative overflow-hidden rounded-[24px] border border-white/[0.07] bg-ink-900 p-6">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(80% 160% at 0% 0%, color-mix(in srgb, ${tint} 14%, transparent), transparent 60%)` }} />
          <div className="relative flex flex-col gap-5">
            <div className="flex min-w-0 items-center gap-4">
              <ProjectPicture project={project} size="hero" />
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[26px] leading-[1.2] font-semibold tracking-[-0.02em] text-ink-100">{name}</h1>
                <div className="mt-1 flex min-w-0 items-center gap-1 text-[13px] text-ink-400">
                  {repository !== null ? (
                    <Tooltip text={repository.url}>
                      {(anchor) => (
                        <button {...anchor} type="button" onClick={() => void openOnGithub(repository.url)} className={`-ml-1.5 flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 font-medium text-ink-300 hover:text-ink-100 ${hover} ${focusRing}`}>
                          <span className="truncate">{repository.nameWithOwner}</span>
                          <span className="shrink-0 text-ink-500">
                            <MenuIconGlyph icon="external" />
                          </span>
                        </button>
                      )}
                    </Tooltip>
                  ) : (
                    <span className="min-w-0 truncate select-text">{project.remote ?? 'No remote'}</span>
                  )}
                  {defaultBranch(project) !== null && (
                    <>
                      <Dot />
                      <span className="flex shrink-0 items-center gap-1.5 px-1">
                        <MenuIconGlyph icon="branch" />
                        <span className="font-mono text-[12px]">{defaultBranch(project)}</span>
                      </span>
                    </>
                  )}
                  <Dot />
                  <CopyPath path={project.path} shown={tildePath(project.path, home.state === 'ready' ? home.value : null)} />
                </div>
              </div>
            </div>
            <div role="toolbar" aria-label={`${name} actions`} className="flex flex-wrap items-center gap-1.5 @min-[560px]:pl-20">
              <button type="button" onClick={() => actions.newChat(project.path)} className={`${heroButton} bg-accent text-accent-ink hover:bg-[#a3aeff]`}>
                <MenuIconGlyph icon="chat" />
                New chat
              </button>
              <ToolButton icon="branch" label="New worktree" onClick={() => setNewWorktree(true)} />
              <ToolButton icon="code" label="Code" onClick={() => actions.code(project.path)} />
              <RunToolButton run={run} row={runRow ?? null} loading={scripts.state === 'loading'} port={port} onSetUp={editCommands} />
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-white/[0.08]" />
              {repository !== null && (
                <IconTool label="Open on GitHub" onClick={() => void openOnGithub(repository.url)}>
                  <MenuIconGlyph icon="external" />
                </IconTool>
              )}
              <IconTool label="More actions" menu onClick={openMore}>
                <span aria-hidden="true" className="-mt-1.5 text-[15px] font-bold">
                  …
                </span>
              </IconTool>
            </div>
          </div>
        </header>

        <div className="flex flex-col gap-8">
          <Section title="Recent chats" action={chatsShown.length === 0 ? undefined : { label: 'New chat', onClick: () => actions.newChat(project.path) }}>
            {chatsShown.length === 0 ? (
              <EmptyState text="No chats in this project yet." action={{ label: 'New chat', onClick: () => actions.newChat(project.path) }} />
            ) : (
              <Expandable items={chatsShown} noun="recent chats">
                {(shown) => shown.map((chat) => <ChatRow key={chat.key} chat={chat} now={now} onClick={() => actions.open(chat.open, chat.path)} />)}
              </Expandable>
            )}
          </Section>

          <Section title="Worktrees" count={worktrees.length} action={{ label: 'New worktree', onClick: () => setNewWorktree(true) }}>
            <Expandable items={worktrees} noun="worktrees">
              {(shown) =>
                shown.map((worktree) => (
                  <WorktreeRow
                    key={worktree.path}
                    worktree={worktree}
                    counts={changed.state === 'ready' ? (changed.value[worktree.path] ?? null) : undefined}
                    review={worktree.branch === null ? null : (stacks[worktree.branch]?.reviewDecision ?? null)}
                    behind={worktree.branch === null ? null : (stacks[worktree.branch]?.behindParent ?? null)}
                    run={worktree.branch === null ? null : (latestRuns?.get(worktree.branch) ?? null)}
                    now={now}
                    onOpen={() => actions.open(worktree.open, worktree.path)}
                    onNewChat={() => actions.newChat(worktree.path)}
                    onCode={() => actions.code(worktree.path)}
                    onFinish={worktree.primary ? null : () => finish(worktree)}
                  />
                ))
              }
            </Expandable>
          </Section>

          {repository !== null && (
            <Section title="Pull requests" count={openCount(pulls)} action={{ label: 'All pull requests', onClick: () => actions.github(project, 'prs') }}>
              <GithubList
                load={pulls}
                total={openCount(pulls)}
                noun="pull requests"
                onShowAll={() => actions.github(project, 'prs')}
                empty={<EmptyState text="No open pull requests." action={{ label: 'New worktree', onClick: () => setNewWorktree(true) }} />}
                render={(items: GithubPullRequest[]) =>
                  newestFirst(items, shownItems).map((item) => (
                    <GithubRow key={item.number} icon={<PullRequestStateIcon item={item} size={15} />} title={item.title} labels={item.labels} number={item.number} author={item.author?.login ?? 'unknown'} at={ago(item.updatedAt, now)} comments={item.comments} onClick={() => actions.github(project, 'prs', item.number)}>
                      <PullStatus detail={pullDetail({ checks: item.checks ?? [], reviewDecision: item.reviewDecision ?? null })} />
                    </GithubRow>
                  ))
                }
              />
            </Section>
          )}
          {/* The project's issues are listed, searched and read on the Tasks page; here, how many are open. */}
          {repository !== null && (
            <Section title="Issues" count={openCount(issues)}>
              <EmptyState text={issuesNote(issues)} action={{ label: 'Open in Tasks', onClick: () => actions.github(project, 'issues') }} />
            </Section>
          )}

          {repository !== null && (
            <Section title="Actions" action={{ label: 'All runs', onClick: () => actions.github(project, 'actions') }}>
              <GithubList
                load={runsLoad}
                total={runs.page !== null && runs.page.next !== null ? null : runs.page?.runs.length ?? null}
                noun="runs"
                onShowAll={() => actions.github(project, 'actions')}
                empty={<EmptyState text="No workflow runs yet." action={{ label: 'All runs', onClick: () => actions.github(project, 'actions') }} />}
                render={(items: GithubActionRun[]) => items.slice(0, shownItems).map((run) => <RunRow key={run.id} run={run} now={now} onClick={() => actions.github(project, 'actions', run.id)} />)}
              />
            </Section>
          )}

          <Section title="Scripts" action={{ label: 'Edit commands', onClick: editCommands }}>
            {scripts.state === 'failed' && (
              <div className="px-4 pt-3">
                <ErrorNote error={scripts.error} />
              </div>
            )}
            {scripts.state === 'ready' && rows.every((row) => row.command === null) ? (
              <EmptyState text="No commands yet. Set what Run, Build and Install do in this project." action={{ label: 'Set up commands', onClick: editCommands }} />
            ) : (
              <ul className={listClass}>
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

/** The project's folder, shown from ~ with the full path on hover, copied on a click; the label says so for a moment. */
function CopyPath({ path, shown }: { path: string; shown: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Tooltip text={path}>
      {(anchor) => (
        <button
          {...anchor}
          type="button"
          aria-label={`Copy ${path}`}
          onClick={() => navigator.clipboard.writeText(path).then(() => setCopied(true), () => {})}
          className={`group/path flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 font-mono text-[12px] text-ink-400 hover:text-ink-200 ${hover} ${focusRing}`}
        >
          <span className="truncate">{shown}</span>
          <span aria-live="polite" className={`shrink-0 font-sans text-[11.5px] ${copied ? 'text-ok' : 'text-ink-500 opacity-0 group-hover/path:opacity-100 group-focus-visible/path:opacity-100'}`}>
            {copied ? 'Copied' : <MenuIconGlyph icon="copy" />}
          </span>
        </button>
      )}
    </Tooltip>
  )
}

// The hero's buttons, in the language of a pull request's hero: a filled primary, quiet pills, icons.
const heroButton = `flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold disabled:opacity-50 ${hover} ${focusRing}`

function ToolButton({ icon, label, onClick, tone, disabled = false }: { icon: MenuIcon; label: string; onClick: () => void; tone?: 'live'; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${heroButton} border border-white/[0.10] bg-white/[0.05] hover:bg-white/[0.10] disabled:hover:bg-white/[0.05] ${tone === 'live' ? 'text-ok' : 'text-ink-100'}`}>
      <MenuIconGlyph icon={icon} />
      {label}
    </button>
  )
}

function IconTool({ label, onClick, menu = false, children }: { label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void; menu?: boolean; children: ReactNode }) {
  return (
    <Tooltip text={label}>
      {(anchor) => (
        <button {...anchor} type="button" aria-label={label} aria-haspopup={menu ? 'menu' : undefined} onClick={onClick} className={`grid size-9 shrink-0 place-items-center rounded-full text-ink-300 hover:bg-white/[0.08] hover:text-ink-100 ${hover} ${focusRing}`}>
          {children}
        </button>
      )}
    </Tooltip>
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

/** A titled group: its name, a quiet count and one action above a card of rows. */
function Section({ title, count, action, children }: { title: string; count?: number | null; action?: { label: string; onClick: () => void }; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2.5">
      <header className="flex h-8 items-center gap-2 px-1">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink-100">{title}</h2>
        {count !== undefined && count !== null && <span className="text-[13px] font-medium text-ink-500 tabular-nums">{count}</span>}
        {action !== undefined && (
          <button type="button" onClick={action.onClick} className={`-mr-1 ml-auto h-7 rounded-full px-2.5 text-[12.5px] font-semibold text-ink-400 hover:bg-white/[0.06] hover:text-ink-100 ${hover} ${focusRing}`}>
            {action.label}
          </button>
        )}
      </header>
      <div className="overflow-hidden rounded-[18px] border border-white/[0.07] bg-ink-900/70">{children}</div>
    </section>
  )
}

const listClass = 'divide-y divide-white/[0.05]'

/** The last line of a long list: shows the rest, here or on the page that holds them all. */
function MoreRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex h-10 w-full items-center gap-1.5 border-t border-white/[0.05] px-4 text-left text-[12.5px] font-semibold text-ink-400 hover:bg-row-hover hover:text-ink-100 ${hover} ${insetFocus}`}>
      {label}
    </button>
  )
}

/** The first few rows, and the rest on asking. */
function Expandable<T>({ items, noun, children }: { items: readonly T[]; noun: string; children: (shown: readonly T[]) => ReactNode }) {
  const [all, setAll] = useState(false)
  const long = items.length > shownItems
  return (
    <>
      <ul className={listClass}>{children(all || !long ? items : items.slice(0, shownItems))}</ul>
      {long && <MoreRow label={all ? 'Show fewer' : `Show all ${items.length} ${noun}`} onClick={() => setAll(!all)} />}
    </>
  )
}

function EmptyState({ text, action }: { text: string; action: { label: string; onClick: () => void } }) {
  return (
    <div className="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
      <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-400">{text}</p>
      <button type="button" onClick={action.onClick} className={`h-8 shrink-0 rounded-full border border-white/[0.10] bg-white/[0.05] px-3.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.10] ${hover} ${focusRing}`}>
        {action.label}
      </button>
    </div>
  )
}

// Rows sit inside a card that clips, so their focus ring is drawn inside them.
const insetFocus = 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent'

const rowClass = `flex h-[52px] w-full min-w-0 items-center gap-3 px-4 text-left hover:bg-row-hover ${hover} ${insetFocus}`

/** The muted facts at a row's end. */
const rowMeta = 'flex shrink-0 items-center gap-3 text-[12px] text-ink-400 tabular-nums'

/** The time column, as wide in every row so the times line up. */
const When = ({ at }: { at: string | null }) => <span className="w-14 shrink-0 text-right text-[12px] text-ink-500 tabular-nums">{at ?? ''}</span>

/** The 28 px tile every row starts with. */
const Tile = ({ children, className = 'text-ink-300' }: { children: ReactNode; className?: string }) => <span className={`grid size-7 shrink-0 place-items-center rounded-[9px] bg-white/[0.05] ${className}`}>{children}</span>

const reviewStates = ['approved', 'changes_requested', 'review_required'] as const

const prChipLabel = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' } as const

function WorktreeRow({
  worktree,
  counts,
  review,
  behind,
  run,
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
  /** The newest workflow run of its branch; null when there is none or it is not known yet. */
  run: GithubActionRun | null
  now: number
  onOpen: () => void
  onNewChat: () => void
  onCode: () => void
  onFinish: (() => void) | null
}) {
  const pullRequest = worktree.pullRequest
  const color = pullRequest?.state === null || pullRequest === null ? null : stateColors[pullRequest.state]
  const reviewDecision = reviewStates.find((state) => state === review?.toLowerCase()) ?? null
  const chats = worktree.chatCount === 0 ? 'No chats yet' : `${worktree.chatCount} ${worktree.chatCount === 1 ? 'chat' : 'chats'}`
  return (
    <li className="group relative">
      <button type="button" onClick={onOpen} aria-label={`${worktree.name}: open its latest chat`} className={rowClass}>
        <Tile className={worktree.primary ? 'text-accent' : 'text-ink-300'}>
          <MenuIconGlyph icon="branch" />
        </Tile>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-mono text-[13px] font-medium text-ink-100">{worktree.name}</span>
          {worktree.primary && <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-px text-[11px] font-semibold text-ink-300">Main checkout</span>}
          {pullRequest !== null && (
            <span className="flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-[11px] font-semibold" style={color === null ? undefined : { color, backgroundColor: `${color}1f` }}>
              <PullRequestIcon size={11} />#{pullRequest.number}
              {pullRequest.state !== null && <span className="font-medium opacity-80">{prChipLabel[pullRequest.state]}</span>}
            </span>
          )}
          {reviewDecision !== null && <ReviewChip decision={reviewDecision} />}
          {run !== null && <RunStatusIcon item={run} size={13} tip label={`${run.name} #${run.number}: ${runLabels[runVisual(run)].toLowerCase()}`} />}
        </span>
        {/* The facts sit where the actions show, so a hover or keyboard focus trades one for the other. */}
        <span className={`${rowMeta} gap-4 transition-opacity duration-[var(--motion-enter)] group-focus-within:opacity-0 group-hover:opacity-0`}>
          {worktree.working > 0 && (
            <span className="flex items-center gap-1.5 font-medium text-ok">
              <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-ok motion-reduce:animate-none" />
              {worktree.working} working
            </span>
          )}
          {behind !== null && behind > 0 && <span className="font-medium text-warn">{behind} behind</span>}
          <span className="hidden @min-[720px]:inline">{chats}</span>
          <Changes counts={counts} />
          <When at={worktree.lastActivityAt === null ? null : ago(worktree.lastActivityAt, now)} />
        </span>
      </button>
      <span className="absolute inset-y-0 right-3 flex items-center gap-0.5 opacity-0 transition-opacity duration-[var(--motion-enter)] group-focus-within:opacity-100 group-hover:opacity-100">
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
  if (counts === null) return <span className="text-[12px] text-bad">{changesUnavailable}</span>
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

function GithubList<T>({ load, total, noun, onShowAll, empty, render }: { load: Load<{ items: T[] }>; total: number | null; noun: string; onShowAll: () => void; empty: ReactNode; render: (items: T[]) => ReactNode }) {
  if (load.state === 'loading')
    return (
      <ul role="status" aria-busy="true" aria-label="Loading" className={listClass}>
        {[0, 1, 2].map((index) => (
          <li key={index} aria-hidden="true" className="flex h-[52px] items-center gap-3 px-4">
            <span className="size-7 shrink-0 animate-pulse rounded-[9px] bg-white/[0.05] motion-reduce:animate-none" />
            <span className="min-w-0 flex-1">
              <Bone width={['w-[48%]', 'w-[36%]', 'w-[42%]'][index] ?? 'w-1/2'} />
            </span>
            <Bone width="w-24" className="h-2.5" />
          </li>
        ))}
      </ul>
    )
  if (load.state === 'failed')
    return (
      <div className="px-4 py-3">
        <ErrorNote error={load.error} />
      </div>
    )
  if (load.value.items.length === 0) return empty
  const count = total ?? load.value.items.length
  return (
    <>
      <ul className={listClass}>{render(load.value.items)}</ul>
      {(total === null || count > shownItems) && <MoreRow label={total === null ? `Show all ${noun}` : `Show all ${count} ${noun}`} onClick={onShowAll} />}
    </>
  )
}

const shownLabels = 2

function GithubRow({ icon, title, labels, number, author, at, comments, onClick, children }: { icon: ReactNode; title: string; labels: GithubIssue['labels']; number: number; author: string; at: string; comments: number; onClick: () => void; children?: ReactNode }) {
  const extra = labels.length - shownLabels
  return (
    <li>
      <button type="button" onClick={onClick} className={rowClass}>
        <Tile>{icon}</Tile>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink-100">{title}</span>
          {labels.length > 0 && (
            <span className="hidden shrink-0 items-center gap-1 @min-[820px]:flex">
              {labels.slice(0, shownLabels).map((label) => (
                <LabelChip key={label.name} name={label.name} color={label.color} />
              ))}
              {extra > 0 && <span className="inline-flex h-[20px] items-center rounded-full bg-white/[0.06] px-2 text-[11.5px] font-semibold text-ink-400">+{extra}</span>}
            </span>
          )}
        </span>
        {children}
        <span className={rowMeta}>
          {comments > 0 && (
            <span className="flex items-center gap-1" aria-label={`${comments} comments`}>
              <CommentIcon size={12} />
              {comments}
            </span>
          )}
          <span className="text-ink-500">#{number}</span>
          <span className="hidden max-w-[10rem] truncate @min-[640px]:inline">{author}</span>
          <When at={at} />
        </span>
      </button>
    </li>
  )
}

/** A pull request's review decision and checks; a pulse while its detail is read, a note when it could not be. */
function PullStatus({ detail }: { detail: PullDetail | 'unavailable' | undefined }) {
  if (detail === undefined) return <Bone width="w-20" className="h-3" />
  if (detail === 'unavailable') return <span className="shrink-0 text-[11.5px] font-semibold text-bad">Checks unavailable</span>
  const summary = checkSummary(detail.checks)
  const review = reviewStates.find((state) => state === detail.review) ?? null
  const tone = summary.state === 'failing' ? 'text-bad' : summary.state === 'pending' ? 'text-warn' : 'text-ok'
  return (
    <span className="flex shrink-0 items-center gap-2">
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

/** A workflow run in the project's list: its state, title, workflow, branch, trigger, duration and age. */
function RunRow({ run, now, onClick }: { run: GithubActionRun; now: number; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className={rowClass}>
        <Tile>
          <RunStatusIcon item={run} size={15} />
        </Tile>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink-100">{run.title}</span>
          <span className="hidden shrink-0 text-[12px] font-semibold text-ink-400 @min-[720px]:inline">{run.name}</span>
        </span>
        <span className={rowMeta}>
          <BranchChip branch={run.branch} className="hidden max-w-[12rem] @min-[820px]:inline-flex" />
          <span className="hidden @min-[640px]:inline">{eventName(run.event)}</span>
          <span className="text-ink-500">#{run.number}</span>
          <span className={`w-14 text-right ${isLive(run) ? 'text-warn' : ''}`}>{formatDuration(runDuration(run, now))}</span>
          <When at={ago(run.createdAt, now)} />
        </span>
      </button>
    </li>
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
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink-100">{chat.title}</span>
          {status !== undefined && <span className={`shrink-0 text-[12px] font-medium ${status.className}`}>{status.label}</span>}
        </span>
        <span className={rowMeta}>
          <span className="flex min-w-0 items-center gap-1">
            <span className="shrink-0 text-ink-500">
              <MenuIconGlyph icon="branch" />
            </span>
            <span className="max-w-[14rem] truncate font-mono text-[11.5px]">{chat.worktree}</span>
          </span>
          <When at={chat.at === null ? null : ago(chat.at, now)} />
        </span>
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
    <li className="flex h-[52px] min-w-0 items-center gap-3 px-4">
      <Tile className={live ? 'text-ok' : state.kind === 'failed' ? 'text-bad' : 'text-ink-300'}>
        <MenuIconGlyph icon={scriptIcons[row.action]} />
      </Tile>
      <span className="w-14 shrink-0 text-[13.5px] font-medium text-ink-100">{row.label}</span>
      {loading ? (
        <span className="min-w-0 flex-1">
          <Bone width="w-40" className="h-2.5" />
        </span>
      ) : (
        <code className={`min-w-0 flex-1 truncate font-mono text-[12px] select-text ${command === null ? 'text-ink-500' : 'text-ink-300'}`}>{command ?? 'Not set'}</code>
      )}
      {chip !== null && (
        <span className={`flex h-[20px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold ${chip.className}`}>
          {live && <span aria-hidden="true" className={`size-1.5 rounded-full ${state.kind === 'running' ? 'animate-pulse bg-ok motion-reduce:animate-none' : 'bg-accent'}`} />}
          {state.kind === 'failed' && state.code !== null ? `${chip.label} · exit ${state.code}` : chip.label}
        </span>
      )}
      {row.detected && <span className="shrink-0 text-[12px] text-ink-500">detected</span>}
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
