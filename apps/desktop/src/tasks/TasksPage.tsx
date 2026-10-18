import { useEffect, useMemo, useState } from 'react'
import type { Project } from '@/api/schema'
import { TasksIcon } from '@/advanced/chrome'
import { BarSearch, WikiShell } from '@/advanced/WikiShell'
import { Blank, ProjectSwitcher } from '@/advanced/WikiParts'
import { wikiPanels } from '@/advanced/wiki-shell-model'
import { byDisplayName } from '@/advanced/appearance-model'
import { SegmentedTabs } from '@/components/SegmentedTabs'
import { githubRepository } from '@/github/github-model'
import type { GithubItemKind } from '@/github/review-model'
import { TasksBoard } from '@/tasks/TasksBoard'
import { TasksList } from '@/tasks/TasksList'
import { takeTasksTarget, useTasksTarget } from '@/tasks/tasks-target'
import { readTasksMemory, shownRepo, writeTasksMemory, type TasksMemory, type TasksView } from '@/tasks/tasks-model'

// The Tasks page, in the Knowledge and Artifacts pages' shell (WikiShell) with no side panel: one
// GitHub repository at a time, picked in the bar's project switcher, as a list of its issues or as a
// GitHub Projects board (TasksList, TasksBoard), switched in the bar. It remembers the view, the
// repository and each repository's board per viewer (tasks-model.ts).

const browserStorage = () => localStorage

const views = [
  { view: 'list', label: 'List', enabled: true, title: 'The repository’s issues', badge: null },
  { view: 'board', label: 'Board', enabled: true, title: 'A GitHub Projects board', badge: null },
] as const

export function TasksPage({
  projects,
  onOpenGithub,
}: {
  /** The listed projects; those with a GitHub remote are offered. */
  projects: Project[]
  /** Opens an issue or a pull request in the app's own view. */
  onOpenGithub: (root: string, kind: GithubItemKind, number: number) => void
}) {
  const [memory, setMemory] = useState<TasksMemory>(() => readTasksMemory(browserStorage))
  const remember = (next: TasksMemory) => setMemory(writeTasksMemory(browserStorage, next))
  // The list's search, in the bar, and the issue it shows beside the list; another repository starts both afresh.
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  // Asked from elsewhere to show a project's issues, on one of them: the list of that project, once.
  const target = useTasksTarget()
  useEffect(() => {
    if (target === null) return
    takeTasksTarget()
    setQuery('')
    setSelected(target.issue)
    setMemory((current) => writeTasksMemory(browserStorage, { ...current, view: 'list', repo: target.repo }))
  }, [target])
  const offered = useMemo(() => byDisplayName(projects.filter((project) => githubRepository(project.remote) !== null), (project) => project), [projects])
  const repoPath = shownRepo(offered.map((project) => project.path), memory.repo)
  const project = offered.find((entry) => entry.path === repoPath) ?? null
  const repository = githubRepository(project?.remote ?? null)
  const pickRepo = (repo: string) => {
    setQuery('')
    setSelected(null)
    remember({ ...memory, repo })
  }

  const crumb =
    project === null ? (
      <span className="flex min-w-0 items-center gap-2 text-ink-300">
        <span className="grid size-6 shrink-0 place-items-center">
          <TasksIcon />
        </span>
        <h1 className="truncate text-[14px] leading-5 font-semibold tracking-[-0.01em] text-ink-100">Tasks</h1>
      </span>
    ) : (
      <>
        <ProjectSwitcher current={{ name: project.name, path: project.path, listed: project }} options={offered.map((entry) => ({ name: entry.name, path: entry.path, listed: entry, onSelect: () => pickRepo(entry.path) }))} />
        <SegmentedTabs<TasksView> label="Tasks view" segments={views} shown={memory.view} onSelect={(view) => remember({ ...memory, view })} />
      </>
    )

  return (
    <WikiShell keys={wikiPanels.tasks} crumb={crumb} tools={project !== null && memory.view === 'list' && <BarSearch value={query} onChange={setQuery} label="Search issues" />} panelLabel={null} panel={null}>
      {project === null ? (
        <Blank title="No GitHub repositories">Tasks reads issues and GitHub Projects boards from a project’s github.com remote. Add a project with one to see its tasks here.</Blank>
      ) : memory.view === 'list' ? (
        <TasksList project={project} query={query} onClearQuery={() => setQuery('')} selected={selected} onSelect={setSelected} onMaximise={(number) => onOpenGithub(project.path, 'issue', number)} />
      ) : (
        <TasksBoard
          root={project.path}
          repo={repository?.nameWithOwner ?? project.name}
          remembered={memory.boards[project.path]}
          onPick={(number) => remember({ ...memory, boards: { ...memory.boards, [project.path]: number } })}
          onOpenGithub={(kind, number) => onOpenGithub(project.path, kind, number)}
        />
      )}
    </WikiShell>
  )
}
