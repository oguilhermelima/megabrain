import { describe, expect, test } from 'bun:test'
import { paneList, singlePane } from '@/panes/pane-model'
import { layoutOf } from '@/panes/split-groups'
import { applyAppControl } from '@/panes/app-control'

const start = () => layoutOf(singlePane('chat:a', 'p1'), 'g0')
const ids = { pane: () => 'p2', group: () => 'g1', launcher: () => 'launcher:new' }

describe('desktop app layout control', () => {
  test('opens beside the focused pane using the right split action', () => {
    const layout = applyAppControl(start(), { action: 'open', target: 'chat:b', split: 'right' }, ids)
    expect(paneList(layout.groups[0]!.panes.root).map((pane) => pane.item)).toEqual(['chat:a', 'native:b'])
  })

  test('opens below the focused pane using the down split action', () => {
    const layout = applyAppControl(start(), { action: 'open', target: 'chat:b', split: 'down' }, ids)
    const root = layout.groups[0]!.panes.root
    expect(root.type === 'split' && root.direction).toBe('column')
  })

  test('splits the focused pane empty or with a requested target', () => {
    expect(paneList(applyAppControl(start(), { action: 'split', direction: 'right' }, ids).groups[0]!.panes.root)).toHaveLength(2)
    expect(paneList(applyAppControl(start(), { action: 'split', direction: 'down', target: 'terminal:t1' }, ids).groups[0]!.panes.root).map((pane) => pane.item)).toContain('terminal:t1')
  })

  test('reports an already joined pair without changing its group and closes a named pane', () => {
    const pair = applyAppControl(start(), { action: 'open', target: 'chat:b', split: 'right' }, ids)
    const joined = applyAppControl(pair, { action: 'join', pane: 'p2', with: 'p1' }, ids)
    expect(joined).toMatchObject({ status: 'already-joined' })
    expect(joined).toMatchObject({ layout: pair })
    expect(paneList(applyAppControl(pair, { action: 'close-pane', pane: 'p2' }, ids).single.root)).toHaveLength(1)
  })

  test('lists each pane target and the focused pane', () => {
    const result = applyAppControl(start(), { action: 'layout' }, ids)
    expect(result).toMatchObject({ panes: [{ id: 'p1', target: 'chat:a', focused: true }] })
  })

  test('refuses unknown targets without changing the layout', () => {
    expect(() => applyAppControl(start(), { action: 'open', target: 'unknown:x' }, ids)).toThrow(/unknown target/)
  })
})
