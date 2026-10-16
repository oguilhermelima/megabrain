import { describe, expect, test } from 'bun:test'
import { menuFocusStep, menuGroups, menuSections, type MenuGroup } from '@/components/menu-model'

const item = (label: string, group: MenuGroup) => ({ label, group })

describe('menuSections', () => {
  test('the groups run open, git, copy, organise, then destructive', () => {
    expect(menuGroups).toEqual(['open', 'git', 'copy', 'organise', 'danger'])
  })

  test('sorts items into their groups in the fixed order, keeping order within a group', () => {
    const items = [
      item('Remove worktree…', 'danger'),
      item('Hide', 'organise'),
      item('New terminal', 'open'),
      item('Sync stack…', 'git'),
      item('Copy path', 'copy'),
      item('New stacked branch…', 'git'),
      item('Open in VS Code', 'open'),
      item('Show on GitHub', 'open'),
    ]
    expect(menuSections(items).map((section) => section.map((entry) => entry.label))).toEqual([
      ['New terminal', 'Open in VS Code', 'Show on GitHub'],
      ['Sync stack…', 'New stacked branch…'],
      ['Copy path'],
      ['Hide'],
      ['Remove worktree…'],
    ])
  })

  test('leaves out empty groups, and an empty menu has no sections', () => {
    expect(menuSections([item('Rename…', 'organise'), item('Close terminal', 'danger')]).map((section) => section.length)).toEqual([1, 1])
    expect(menuSections([])).toEqual([])
  })
})

describe('menuFocusStep', () => {
  test('arrows move one item and wrap at either end', () => {
    expect(menuFocusStep(3, 0, 'ArrowDown')).toBe(1)
    expect(menuFocusStep(3, 2, 'ArrowDown')).toBe(0)
    expect(menuFocusStep(3, 0, 'ArrowUp')).toBe(2)
  })

  test('with nothing focused, down starts at the top and up at the bottom', () => {
    expect(menuFocusStep(3, null, 'ArrowDown')).toBe(0)
    expect(menuFocusStep(3, null, 'ArrowUp')).toBe(2)
  })

  test('Home and End jump to the ends; other keys and empty menus move nothing', () => {
    expect(menuFocusStep(4, 2, 'Home')).toBe(0)
    expect(menuFocusStep(4, 1, 'End')).toBe(3)
    expect(menuFocusStep(4, 1, 'Enter')).toBeNull()
    expect(menuFocusStep(0, null, 'ArrowDown')).toBeNull()
  })
})
