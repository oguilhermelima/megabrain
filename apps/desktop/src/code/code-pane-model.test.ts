import { describe, expect, test } from 'bun:test'
import type { Project } from '@/api/schema'
import { mockProjects } from '@/api/fixtures/mock'
import { codeTargetFor, codeTargetForRoot, expiredServers, frameFadeMs, frameHolders, frameRevealDelay, idleServers, serverGraceMs } from '@/code/code-pane-model'

const canto = mockProjects.find((project) => project.name === 'canto') as Project
const megabrain = mockProjects.find((project) => project.name === 'megabrain') as Project
const seek = canto.worktrees.find((worktree) => worktree.branch === 'fix/player-seek')
if (seek === undefined) throw new Error('fixture: fix/player-seek missing')

describe('frame holders', () => {
  test('each root shown in Code is held by the one pane showing it', () => {
    expect(frameHolders({}, [{ item: 'native:a', root: '/wt/a' }, { item: 'native:b', root: '/wt/b' }])).toEqual({ '/wt/a': 'native:a', '/wt/b': 'native:b' })
  })

  test('a root shown in two panes is held by the first in reading order', () => {
    expect(frameHolders({}, [{ item: 'native:a', root: '/wt/a' }, { item: 'session:b', root: '/wt/a' }])).toEqual({ '/wt/a': 'native:a' })
  })

  test('the pane that held a root keeps it while it still shows it, wherever it moved', () => {
    const shown = [{ item: 'session:b', root: '/wt/a' }, { item: 'native:a', root: '/wt/a' }]
    expect(frameHolders({ '/wt/a': 'native:a' }, shown)).toEqual({ '/wt/a': 'native:a' })
  })

  test('when the holder leaves Code the other pane showing the root takes the frame', () => {
    expect(frameHolders({ '/wt/a': 'native:a' }, [{ item: 'session:b', root: '/wt/a' }])).toEqual({ '/wt/a': 'session:b' })
  })

  test('a root no pane shows in Code has no holder', () => {
    expect(frameHolders({ '/wt/a': 'native:a' }, [])).toEqual({})
  })

  test('an unchanged assignment keeps its identity', () => {
    const previous = { '/wt/a': 'native:a' }
    expect(frameHolders(previous, [{ item: 'native:a', root: '/wt/a' }])).toBe(previous)
  })
})

describe('server lifetime', () => {
  test('the grace is ten minutes', () => {
    expect(serverGraceMs).toBe(10 * 60_000)
  })

  test('a running root that nothing in the panes uses starts its grace now', () => {
    expect(idleServers({}, ['/wt/a', '/wt/b'], new Set(['/wt/b']), 1000)).toEqual({ '/wt/a': 1000 })
  })

  test('a root already idle keeps the time it went idle', () => {
    expect(idleServers({ '/wt/a': 1000 }, ['/wt/a'], new Set(), 5000)).toEqual({ '/wt/a': 1000 })
  })

  test('a root used again leaves the idle list', () => {
    expect(idleServers({ '/wt/a': 1000 }, ['/wt/a'], new Set(['/wt/a']), 5000)).toEqual({})
  })

  test('a root no longer running leaves the idle list', () => {
    expect(idleServers({ '/wt/a': 1000 }, [], new Set(), 5000)).toEqual({})
  })

  test('an unchanged idle list keeps its identity', () => {
    const previous = { '/wt/a': 1000 }
    expect(idleServers(previous, ['/wt/a'], new Set(), 5000)).toBe(previous)
  })

  test('a server stops once its grace has passed, not before', () => {
    const idle = { '/wt/a': 0, '/wt/b': 60_000 }
    expect(expiredServers(idle, serverGraceMs - 1)).toEqual([])
    expect(expiredServers(idle, serverGraceMs)).toEqual(['/wt/a'])
    expect(expiredServers(idle, serverGraceMs + 60_000)).toEqual(['/wt/a', '/wt/b'])
  })
})

describe('code targets', () => {
  test('a project opens its own folder under its name', () => {
    expect(codeTargetFor(canto)).toEqual({ root: canto.path, title: 'canto' })
  })

  test('the primary worktree is the project', () => {
    const primary = canto.worktrees.find((worktree) => worktree.primary)
    expect(primary).toBeDefined()
    if (primary !== undefined) expect(codeTargetFor(canto, primary)).toEqual({ root: canto.path, title: 'canto' })
  })

  test('a worktree is named by its project and branch', () => {
    expect(codeTargetFor(canto, seek)).toEqual({ root: seek.path, title: 'canto · fix/player-seek' })
  })

  test('a root no project holds is named by its folder', () => {
    expect(codeTargetForRoot([megabrain], '/somewhere/gone-tree')).toEqual({ root: '/somewhere/gone-tree', title: 'gone-tree' })
    expect(codeTargetForRoot(mockProjects, seek.path)).toEqual({ root: seek.path, title: 'canto · fix/player-seek' })
  })
})

describe('frameRevealDelay', () => {
  test('a root painting for the first time this session waits longest', () => {
    expect(frameRevealDelay(new Set(), canto.path)).toBe(700)
  })

  test('a root that painted before in this session waits briefly', () => {
    expect(frameRevealDelay(new Set([canto.path]), canto.path)).toBe(150)
  })

  test('another root having painted does not shorten the first open', () => {
    expect(frameRevealDelay(new Set([megabrain.path]), canto.path)).toBe(700)
  })

  test('the frame fades in over 150 ms', () => {
    expect(frameFadeMs).toBe(150)
  })
})
