import { describe, expect, test } from 'bun:test'
import { archiveDone, archiveFailed, beginArchive, beginRestore, reconcileArchives, restoreDone, restoreFailed, withoutArchived, type ArchiveMap } from '@/advanced/archive-model'

const target = { repo: '/w/canto', branch: 'feat/a', path: '/w/trees/canto-feat-a' }

const projects = [
  {
    name: 'canto',
    path: '/w/canto',
    worktrees: [
      { path: '/w/canto', branch: 'main' },
      { path: '/w/trees/canto-feat-a', branch: 'feat/a' },
      { path: '/w/trees/canto-feat-b', branch: 'feat/b' },
    ],
  },
  { name: 'infra', path: '/w/infra', worktrees: [{ path: '/w/infra', branch: 'main' }] },
]

describe('archiving a branch', () => {
  test('the row leaves at once while megabrain archives it', () => {
    const map = beginArchive({}, target)
    expect(map[target.path]?.status).toBe('archiving')
    expect(withoutArchived(projects, map)[0]?.worktrees.map((worktree) => worktree.branch)).toEqual(['main', 'feat/b'])
  })

  test('a refusal brings the row back', () => {
    const map = archiveFailed(beginArchive({}, target), target.path)
    expect(map).toEqual({})
    expect(withoutArchived(projects, map)).toBe(projects)
  })

  test('once archived the row stays away until the list no longer has it', () => {
    const archived = archiveDone(beginArchive({}, target), target.path)
    expect(archived[target.path]?.status).toBe('archived')
    expect(reconcileArchives(archived, projects)).toBe(archived)
    const caughtUp = projects.map((project) => ({ ...project, worktrees: project.worktrees.filter((worktree) => worktree.path !== target.path) }))
    expect(reconcileArchives(archived, caughtUp)).toEqual({})
  })

  test('an archive still running is kept whatever the list says', () => {
    const map = beginArchive({}, target)
    expect(reconcileArchives(map, [])).toBe(map)
  })

  test('the same branch cannot be archived twice at once', () => {
    const map = beginArchive({}, target)
    expect(beginArchive(map, target)).toBe(map)
  })

  test('nothing to hide leaves the projects untouched', () => {
    expect(withoutArchived(projects, {})).toBe(projects)
    const other: ArchiveMap = beginArchive({}, { repo: '/w/x', branch: 'y', path: '/w/x-y' })
    expect(withoutArchived(projects, other)).toBe(projects)
  })

  test('other projects keep their identity when one loses a row', () => {
    const next = withoutArchived(projects, beginArchive({}, target))
    expect(next[1]).toBe(projects[1] as (typeof projects)[number])
  })
})

describe('undo', () => {
  test('restoring keeps the row away until megabrain has recreated it', () => {
    const archived = archiveDone(beginArchive({}, target), target.path)
    const restoring = beginRestore(archived, target)
    expect(restoring[target.path]?.status).toBe('restoring')
    expect(withoutArchived(projects, restoring)[0]?.worktrees.some((worktree) => worktree.path === target.path)).toBe(false)
    expect(reconcileArchives(restoring, [])).toBe(restoring)
  })

  test('undo works after the list has already dropped the archived entry', () => {
    const restoring = beginRestore({}, target)
    expect(restoring[target.path]).toEqual({ ...target, status: 'restoring' })
  })

  test('a restore that worked frees the row to come back with the list', () => {
    expect(restoreDone(beginRestore({}, target), target.path)).toEqual({})
  })

  test('a restore that failed leaves the branch archived', () => {
    expect(restoreFailed(beginRestore({}, target), target.path)[target.path]?.status).toBe('archived')
  })
})
