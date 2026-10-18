import { describe, expect, test } from 'bun:test'
import { pendingTasksTarget, takeTasksTarget, targetTasks } from '@/tasks/tasks-target'

describe('a request to show a project’s issues on the Tasks page', () => {
  test('waits until taken, then applies no more', () => {
    takeTasksTarget()
    expect(pendingTasksTarget()).toBeNull()
    targetTasks('/work/canto', 12)
    expect(pendingTasksTarget()).toEqual({ repo: '/work/canto', issue: 12 })
    takeTasksTarget()
    expect(pendingTasksTarget()).toBeNull()
  })

  test('the newest request wins over one not yet taken', () => {
    targetTasks('/work/canto', 12)
    targetTasks('/work/juntin', null)
    expect(pendingTasksTarget()).toEqual({ repo: '/work/juntin', issue: null })
    takeTasksTarget()
  })
})
