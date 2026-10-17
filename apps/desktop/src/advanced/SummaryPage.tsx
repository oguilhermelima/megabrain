import { useEffect, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { NativeChat, Project, Summary } from '@/api/schema'
import { BranchIcon } from '@/advanced/chrome'
import { relativeAge } from '@/advanced/projects-model'
import { neighbours } from '@/advanced/summaries-model'
import { SummaryPicture } from '@/advanced/SummariesSection'
import { MarkdownText } from '@/chat/markdown'
import { AgentIcon } from '@/components/agent-icons'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { useNow } from '@/github/parts'

// One chat summary in a pane: where it was made (project, branch, the chat it summarises), who
// wrote it and when, its text, and the newer and older summaries of the same branch.

/** How far back the page looks for a summary's neighbours in its branch. */
const branchWindow = 100

type Loaded = { state: 'loading' } | { state: 'failed'; error: unknown } | { state: 'ready'; summary: Summary; branch: Summary[] }

function useSummary(id: string): Loaded {
  const [load, setLoad] = useState<{ id: string; value: Loaded }>({ id, value: { state: 'loading' } })
  useEffect(() => {
    let current = true
    api
      .summary(id)
      .then(async (summary) => {
        // The neighbours are a convenience; a failed list still shows the summary.
        const list = await api.summaries({ repo: summary.repo, branch: summary.branch, limit: branchWindow }).catch(() => null)
        const branch = list?.projects.find((project) => project.repo === summary.repo)?.branches.find((entry) => entry.branch === summary.branch)?.summaries ?? []
        if (current) setLoad({ id, value: { state: 'ready', summary, branch } })
      })
      .catch((error: unknown) => {
        if (current) setLoad({ id, value: { state: 'failed', error } })
      })
    return () => {
      current = false
    }
  }, [id])
  return load.id === id ? load.value : { state: 'loading' }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-center gap-1.5 text-[13.5px] text-ink-200">{children}</dd>
    </div>
  )
}

function Neighbour({ summary, direction, onOpen, now }: { summary: Summary | null; direction: 'newer' | 'older'; onOpen: (summary: Summary) => void; now: number }) {
  const label = direction === 'newer' ? 'Newer' : 'Older'
  if (summary === null) return <div className="flex-1 rounded-[14px] border border-dashed border-white/[0.08] px-4 py-3 text-[12.5px] text-ink-500">{direction === 'newer' ? 'This is the latest summary' : 'This is the first summary kept'}</div>
  return (
    <button type="button" onClick={() => onOpen(summary)} className={`min-w-0 flex-1 rounded-[14px] border border-white/[0.08] bg-white/[0.03] px-4 py-3 transition-colors hover:bg-white/[0.07] ${direction === 'older' ? 'text-right' : 'text-left'}`}>
      <span className="block text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">
        {direction === 'newer' ? `← ${label}` : `${label} →`} · {relativeAge(summary.createdAt, now)}
      </span>
      <span className="mt-1 block truncate text-[13.5px] text-ink-100">{summary.title}</span>
    </button>
  )
}

export function SummaryPage({ id, projects, chats, onOpen, onOpenChat }: { id: string; projects: Project[]; chats: NativeChat[]; onOpen: (summary: Summary) => void; onOpenChat: (chat: NativeChat) => void }) {
  const now = useNow(30_000)
  const load = useSummary(id)
  if (load.state === 'loading') {
    return (
      <div className="mx-auto w-full max-w-[760px] px-8 py-10">
        <TextSkeleton lines={6} />
      </div>
    )
  }
  if (load.state === 'failed') {
    return (
      <div className="mx-auto w-full max-w-[760px] px-8 py-10">
        <ErrorNote error={load.error} />
      </div>
    )
  }
  const { summary, branch } = load
  const project = projects.find((entry) => entry.path === summary.repo)
  const chat = chats.find((entry) => entry.id === summary.chatId) ?? null
  const live = project?.worktrees.some((worktree) => worktree.path === summary.worktree) ?? false
  const { newer, older } = neighbours(branch, summary.id)
  return (
    <article className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] space-y-8 px-8 py-10">
        <header className="space-y-5">
          <div className="flex items-center gap-2.5 text-[13px] text-ink-300">
            <SummaryPicture project={project} name={summary.project} />
            <span className="font-semibold text-ink-200">{summary.project}</span>
            <span className="text-ink-500">/</span>
            <span className={`flex min-w-0 items-center gap-1.5 ${live ? '' : 'opacity-70'}`} title={live ? summary.worktree : `${summary.worktree}\nIts worktree is gone`}>
              <BranchIcon />
              <span className="truncate">{summary.branch}</span>
            </span>
          </div>
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink-100">{summary.title}</h1>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-[18px] border border-white/[0.07] bg-white/[0.02] px-5 py-4 sm:grid-cols-3">
            <Fact label="Chat">
              <AgentIcon agent={summary.agent} className="shrink-0 text-ink-300" />
              {chat === null ? (
                <span className="truncate text-ink-400" title="The chat is no longer listed">
                  {summary.chatId}
                </span>
              ) : (
                <button type="button" onClick={() => onOpenChat(chat)} className="truncate font-medium text-accent hover:underline">
                  {chat.title ?? 'Open the chat'}
                </button>
              )}
            </Fact>
            <Fact label="Written by">
              <span className="truncate">{summary.model}</span>
            </Fact>
            <Fact label="When">
              <span title={summary.createdAt}>
                {new Date(summary.createdAt).toLocaleString()} · {relativeAge(summary.createdAt, now)}
              </span>
            </Fact>
          </dl>
        </header>
        <MarkdownText text={summary.text} className="text-[14.5px] leading-relaxed text-ink-200" />
        <nav aria-label={`Other summaries of ${summary.branch}`} className="flex gap-3 border-t border-white/[0.07] pt-6">
          <Neighbour summary={newer} direction="newer" onOpen={onOpen} now={now} />
          <Neighbour summary={older} direction="older" onOpen={onOpen} now={now} />
        </nav>
      </div>
    </article>
  )
}
