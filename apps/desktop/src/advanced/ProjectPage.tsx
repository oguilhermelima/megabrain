import { useEffect, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { GithubCheck, GithubIssue, GithubPullRequest, NativeChat, Project, ProjectScripts } from '@/api/schema'
import { displayName, projectTint } from '@/advanced/appearance-model'
import { NewWorktreeDialog } from '@/advanced/NewWorktreeDialog'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { defaultBranch, newestFirst, recentChats, scriptRows, worktreeSummaries, type WorktreeOpen } from '@/advanced/project-page-model'
import { changedFileCount } from '@/chat/action-bar-model'
import { AgentIcon } from '@/components/agent-icons'
import { MenuIconGlyph, type MenuIcon } from '@/components/menu-icons'
import { ErrorNote } from '@/components/ui'
import { checkSummary, githubRepository, stateColors } from '@/github/github-model'
import { issuePage, pullRequestPage } from '@/github/github-requests'
import { PullRequestIcon } from '@/github/icons'
import { CheckGlyph, IssueStateIcon, PullRequestStateIcon, ago, checkTitle, openOnGithub, useNow } from '@/github/parts'
import type { GithubKind } from '@/github/useGithubCounts'
import { mapLimited } from '@/lib/poll-model'
import { useRunControls } from '@/run-panel/run-context'

// A project's page in a pane: who it is (picture, name, colour, remote, the main checkout's branch),
// an action bar for everything the sidebar row used to carry, and cards for its worktrees, open
// pull requests and issues, recent chats and commands. Every list comes from a call the app already
// makes; each card shows its skeleton until its call answers.

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

export function ProjectPage({ project, chats, actions }: { project: Project; chats: Record<string, NativeChat[]>; actions: ProjectPageActions }) {
  const now = useNow(30_000)
  const repository = githubRepository(project.remote)
  const run = useRunControls()
  const [newWorktree, setNewWorktree] = useState(false)
  const worktrees = worktreeSummaries(project, chats)
  const chatsShown = recentChats(project, chats, 6)
  const name = displayName(project)
  const tint = projectTint(project)
  const scripts = useLoad<ProjectScripts>(project.path, () => api.projectScripts(project.path))
  const rows = scriptRows(scripts.state === 'ready' ? scripts.value : null)
  const runCommand = rows.find((row) => row.action === 'run')?.command ?? null

  const pulls = useLoad(repository === null ? null : project.path, () => pullRequestPage(project.path, 'open', null))
  const issues = useLoad(repository === null ? null : project.path, () => issuePage(project.path, 'open', null))
  const topPulls = pulls.state === 'ready' ? newestFirst(pulls.value.items, shownItems) : []
  // Checks come with one pull request's detail only, so just the few shown are read.
  const checks = useLoad(topPulls.length === 0 ? null : `${project.path}\n${topPulls.map((item) => item.number).join(',')}`, async () =>
    Object.fromEntries(await mapLimited(topPulls, 2, async (item) => [item.number, (await api.githubPullRequest(project.path, item.number).catch(() => null))?.checks ?? []] as const)),
  )
  const worktreeKey = worktrees.map((worktree) => worktree.path).join('\n')
  const changed = useLoad(worktreeKey, async () => {
    const parents = new Map(project.worktrees.map((worktree) => [worktree.path, worktree.parent]))
    const counts = await mapLimited(worktrees, 3, async (worktree) => {
      try {
        const [uncommitted, branch] = await Promise.all([api.codeChanges(worktree.path), api.codeBranchChanges(worktree.path, parents.get(worktree.path) ?? null).catch(() => null)])
        return [worktree.path, changedFileCount(uncommitted, branch)] as const
      } catch {
        return [worktree.path, null] as const
      }
    })
    return Object.fromEntries(counts) as Record<string, number | null>
  })

  const buttons: { label: string; icon: MenuIcon; onClick: () => void; primary?: boolean; disabled?: string }[] = [
    { label: 'New chat', icon: 'chat', primary: true, onClick: () => actions.newChat(project.path) },
    { label: 'New worktree', icon: 'branch', onClick: () => setNewWorktree(true) },
    { label: 'Open in Code', icon: 'code', onClick: () => actions.code(project.path) },
    {
      label: 'Run',
      icon: 'terminal',
      onClick: () => run !== null && runCommand !== null && run.run('run', runCommand, scripts.state === 'ready' ? scripts.value.port : null),
      ...(runCommand === null ? { disabled: scripts.state === 'loading' ? 'Reading the commands' : 'No run command; set one in Settings' } : {}),
    },
    ...(repository === null ? [] : [{ label: 'Open on GitHub', icon: 'external' as const, onClick: () => void openOnGithub(repository.url) }]),
    { label: 'Settings', icon: 'rename', onClick: () => run?.editCommands(project.path) },
  ]

  return (
    <div className="@container min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1080px] flex-col gap-5 px-6 pt-7 pb-10 @3xl:px-10">
        <header className="flex flex-col gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <ProjectPicture project={project} size="large" />
            <div className="min-w-0 flex-1">
              <h1 className="flex min-w-0 items-center gap-2.5 text-[24px] font-semibold tracking-[-0.02em] text-ink-50">
                <span className="truncate">{name}</span>
                {tint !== null && <span aria-label={`Colour ${tint}`} title={tint} style={{ backgroundColor: tint }} className="size-2.5 shrink-0 rounded-full" />}
              </h1>
              <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-400">
                {repository !== null ? (
                  <button type="button" onClick={() => void openOnGithub(repository.url)} title={repository.url} className="truncate font-medium text-ink-300 hover:text-accent hover:underline">
                    {repository.nameWithOwner}
                  </button>
                ) : (
                  <span className="truncate select-text">{project.remote ?? 'No remote'}</span>
                )}
                {defaultBranch(project) !== null && (
                  <span className="flex items-center gap-1" title="The main checkout's branch">
                    <MenuIconGlyph icon="branch" />
                    {defaultBranch(project)}
                  </span>
                )}
                <span className="truncate font-mono text-[11.5px] select-text" title={project.path}>
                  {project.path}
                </span>
              </p>
            </div>
          </div>
          <div role="toolbar" aria-label={`${name} actions`} className="flex flex-wrap gap-2">
            {buttons.map((button) => (
              <button
                key={button.label}
                type="button"
                onClick={button.onClick}
                disabled={button.disabled !== undefined}
                title={button.disabled ?? button.label}
                className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${button.primary === true ? 'bg-accent text-accent-ink hover:bg-[#a3aeff]' : 'border border-white/[0.10] bg-white/[0.05] text-ink-100 hover:bg-white/[0.10]'}`}
              >
                <MenuIconGlyph icon={button.icon} />
                {button.label}
              </button>
            ))}
          </div>
        </header>

        <Section title="Worktrees" aside={`${worktrees.length}`}>
          <ul className="divide-y divide-white/[0.05]">
            {worktrees.map((worktree) => {
              const count = changed.state === 'ready' ? (changed.value[worktree.path] ?? null) : undefined
              return (
                <li key={worktree.path}>
                  <button type="button" onClick={() => actions.open(worktree.open, worktree.path)} title={worktree.path} className="flex w-full min-w-0 items-center gap-3 rounded-[12px] px-3 py-2.5 text-left hover:bg-white/[0.04]">
                    <span className="shrink-0 text-ink-400">
                      <MenuIconGlyph icon="branch" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13.5px] font-medium text-ink-100">{worktree.name}</span>
                        {worktree.primary && <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-px text-[10.5px] font-semibold text-ink-400">main checkout</span>}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[11.5px] text-ink-400">
                        {worktree.pullRequest !== null && (
                          <span className="flex items-center gap-1" title={worktree.pullRequest.title ?? undefined} style={worktree.pullRequest.state === null ? undefined : { color: stateColors[worktree.pullRequest.state] }}>
                            <PullRequestIcon size={12} />#{worktree.pullRequest.number}
                            {worktree.pullRequest.state !== null && <span className="text-ink-400">{worktree.pullRequest.state}</span>}
                          </span>
                        )}
                        <span>{worktree.chatCount === 0 ? 'No chats' : `${worktree.chatCount} ${worktree.chatCount === 1 ? 'chat' : 'chats'}`}</span>
                        {worktree.lastActivityAt !== null && <span>{ago(worktree.lastActivityAt, now)}</span>}
                      </span>
                    </span>
                    {count === undefined ? (
                      <span className="h-3 w-14 shrink-0 animate-pulse rounded-full bg-white/[0.06]" />
                    ) : (
                      count !== null && count > 0 && <span className="shrink-0 text-[11.5px] font-medium text-warn tabular-nums">{`${count} changed`}</span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </Section>

        <div className="grid gap-5 @3xl:grid-cols-2">
          {repository !== null && (
            <Section title="Pull requests" aside={pulls.state === 'ready' ? `${pulls.value.counts.open ?? pulls.value.totalCount} open` : null} link={{ label: 'All pull requests', onClick: () => actions.github(project, 'prs') }}>
              <GithubList
                load={pulls}
                empty="No open pull requests."
                render={(items: GithubPullRequest[]) =>
                  newestFirst(items, shownItems).map((item) => (
                    <GithubRow key={item.number} icon={<PullRequestStateIcon item={item} size={14} />} title={item.title} meta={`#${item.number} · ${item.author?.login ?? 'unknown'} · ${ago(item.updatedAt, now)}`} onClick={() => actions.github(project, 'prs', item.number)}>
                      <ChecksMark checks={checks.state === 'ready' ? checks.value[item.number] : undefined} />
                    </GithubRow>
                  ))
                }
              />
            </Section>
          )}
          {repository !== null && (
            <Section title="Issues" aside={issues.state === 'ready' ? `${issues.value.counts.open ?? issues.value.totalCount} open` : null} link={{ label: 'All issues', onClick: () => actions.github(project, 'issues') }}>
              <GithubList
                load={issues}
                empty="No open issues."
                render={(items: GithubIssue[]) =>
                  newestFirst(items, shownItems).map((item) => (
                    <GithubRow key={item.number} icon={<IssueStateIcon state={item.state} size={14} />} title={item.title} meta={`#${item.number} · ${item.author?.login ?? 'unknown'} · ${ago(item.updatedAt, now)}`} onClick={() => actions.github(project, 'issues', item.number)} />
                  ))
                }
              />
            </Section>
          )}

          <Section title="Recent chats" link={{ label: 'New chat', onClick: () => actions.newChat(project.path) }}>
            {chatsShown.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-ink-400">No chats in this project yet.</p>
            ) : (
              <ul>
                {chatsShown.map((chat) => (
                  <li key={chat.key}>
                    <button type="button" onClick={() => actions.open(chat.open, chat.path)} className="flex w-full min-w-0 items-center gap-3 rounded-[12px] px-3 py-2 text-left hover:bg-white/[0.04]">
                      <AgentIcon agent={chat.agent} activity={chat.status === 'working' ? 'working' : chat.status === 'waiting' ? 'waiting' : 'idle'} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-100">{chat.title}</span>
                      <span className="max-w-[40%] shrink-0 truncate text-[11.5px] text-ink-400">{chat.worktree}</span>
                      {chat.at !== null && <span className="shrink-0 text-[11.5px] text-ink-500 tabular-nums">{ago(chat.at, now)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Scripts" link={{ label: 'Edit', onClick: () => run?.editCommands(project.path) }}>
            {scripts.state === 'failed' && <ErrorNote error={scripts.error} />}
            <ul>
              {rows.map((row) => (
                <li key={row.action} className="flex min-w-0 items-center gap-3 px-3 py-2">
                  <span className="w-14 shrink-0 text-[12.5px] font-semibold text-ink-300">{row.label}</span>
                  {scripts.state === 'loading' ? (
                    <span className="h-3 w-40 animate-pulse rounded-full bg-white/[0.06]" />
                  ) : (
                    <code className={`min-w-0 flex-1 truncate font-mono text-[12px] select-text ${row.command === null ? 'text-ink-500' : 'text-ink-100'}`} title={row.command ?? undefined}>
                      {row.command ?? 'Not set'}
                    </code>
                  )}
                  {row.detected && <span className="shrink-0 text-[10.5px] text-ink-500">detected</span>}
                  <button
                    type="button"
                    disabled={run === null || row.command === null}
                    onClick={() => row.command !== null && run?.run(row.action, row.command, row.action === 'run' && scripts.state === 'ready' ? scripts.value.port : null)}
                    className="ml-auto shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold text-ink-200 hover:bg-white/[0.08] disabled:opacity-40"
                  >
                    {row.label}
                  </button>
                </li>
              ))}
            </ul>
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
    </div>
  )
}

function Section({ title, aside, link, children }: { title: string; aside?: string | null; link?: { label: string; onClick: () => void }; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0 rounded-[20px] border border-white/[0.07] bg-ink-900/70 p-2">
      <header className="flex items-center gap-2 px-3 pt-2 pb-1.5">
        <h2 className="text-[12px] font-semibold tracking-[0.06em] text-ink-400 uppercase">{title}</h2>
        {aside !== undefined && aside !== null && <span className="text-[12px] font-medium text-ink-500 tabular-nums">{aside}</span>}
        {link !== undefined && (
          <button type="button" onClick={link.onClick} className="ml-auto rounded-full px-2 py-0.5 text-[12px] font-semibold text-accent hover:bg-accent/[0.1]">
            {link.label}
          </button>
        )}
      </header>
      {children}
    </section>
  )
}

function GithubList<T>({ load, empty, render }: { load: Load<{ items: T[] }>; empty: string; render: (items: T[]) => ReactNode }) {
  if (load.state === 'loading')
    return (
      <ul aria-label="Loading" className="space-y-1">
        {[0, 1, 2].map((index) => (
          <li key={index} className="flex items-center gap-3 px-3 py-2.5">
            <span className="size-3.5 shrink-0 animate-pulse rounded-full bg-white/[0.08]" />
            <span className="h-3 animate-pulse rounded-full bg-white/[0.08]" style={{ width: `${50 + index * 12}%` }} />
          </li>
        ))}
      </ul>
    )
  if (load.state === 'failed')
    return (
      <div className="px-3 py-2">
        <ErrorNote error={load.error} />
      </div>
    )
  if (load.value.items.length === 0) return <p className="px-3 py-2 text-[13px] text-ink-400">{empty}</p>
  return <ul>{render(load.value.items)}</ul>
}

function GithubRow({ icon, title, meta, onClick, children }: { icon: ReactNode; title: string; meta: string; onClick: () => void; children?: ReactNode }) {
  return (
    <li>
      <button type="button" onClick={onClick} className="flex w-full min-w-0 items-start gap-3 rounded-[12px] px-3 py-2 text-left hover:bg-white/[0.04]">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink-100">{title}</span>
          <span className="block truncate text-[11.5px] text-ink-400">{meta}</span>
        </span>
        {children}
      </button>
    </li>
  )
}

/** The verdict of a pull request's checks; a pulse while they are read, nothing when it has none. */
function ChecksMark({ checks }: { checks: GithubCheck[] | undefined }) {
  if (checks === undefined) return <span className="mt-1 size-3 shrink-0 animate-pulse rounded-full bg-white/[0.08]" />
  const summary = checkSummary(checks)
  if (summary.state === 'none') return null
  return (
    <span className="mt-0.5 shrink-0" title={checkTitle(summary)}>
      <CheckGlyph state={summary.state} size={13} />
    </span>
  )
}

