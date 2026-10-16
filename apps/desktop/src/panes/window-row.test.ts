import { describe, expect, test } from 'bun:test'
import { windowRowJoin } from '@/panes/window-row'

const whole = { x: 0, y: 0, width: 1, height: 1 }
const left = { x: 0, y: 0, width: 0.5, height: 1 }
const right = { x: 0.5, y: 0, width: 0.5, height: 1 }
const top = { x: 0, y: 0, width: 1, height: 0.5 }
const bottom = { x: 0, y: 0.5, width: 1, height: 0.5 }
const withBar = (item: string) => item !== 'github:x'

describe('windowRowJoin', () => {
  test('nothing joins while the sidebar is shown', () => {
    expect(windowRowJoin({ collapsed: false, covered: false, panes: [{ id: 'a', item: 'native:1', rect: whole }], hasTopBar: withBar })).toBeNull()
  })

  test('a single pane joins with its top bar', () => {
    expect(windowRowJoin({ collapsed: true, covered: false, panes: [{ id: 'a', item: 'native:1', rect: whole }], hasTopBar: withBar })).toEqual({ paneId: 'a', header: 'top-bar' })
  })

  test('a single pane whose item draws no top bar leaves the lights their own row', () => {
    expect(windowRowJoin({ collapsed: true, covered: false, panes: [{ id: 'a', item: 'github:x', rect: whole }], hasTopBar: withBar })).toBeNull()
  })

  test('a page covering the panes leaves the lights their own row', () => {
    expect(windowRowJoin({ collapsed: true, covered: true, panes: [{ id: 'a', item: 'native:1', rect: whole }], hasTopBar: withBar })).toBeNull()
  })

  test('split side by side, the left pane joins with its own top bar, which is its only header', () => {
    const panes = [
      { id: 'b', item: 'github:x', rect: right },
      { id: 'a', item: 'native:1', rect: left },
    ]
    expect(windowRowJoin({ collapsed: true, covered: false, panes, hasTopBar: withBar })).toEqual({ paneId: 'a', header: 'top-bar' })
  })

  test('split, a corner pane whose item draws no top bar joins with its strip', () => {
    const panes = [
      { id: 'b', item: 'native:2', rect: right },
      { id: 'a', item: 'github:x', rect: left },
    ]
    expect(windowRowJoin({ collapsed: true, covered: false, panes, hasTopBar: withBar })).toEqual({ paneId: 'a', header: 'strip' })
  })

  test('split top and bottom, the top pane joins', () => {
    const panes = [
      { id: 'b', item: 'native:2', rect: bottom },
      { id: 'a', item: 'native:1', rect: top },
    ]
    expect(windowRowJoin({ collapsed: true, covered: false, panes, hasTopBar: withBar })).toEqual({ paneId: 'a', header: 'top-bar' })
  })

  test('no pane at all joins nothing', () => {
    expect(windowRowJoin({ collapsed: true, covered: false, panes: [], hasTopBar: withBar })).toBeNull()
  })
})
