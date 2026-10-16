import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pressedOutside } from '@/components/popover-model'

describe('pressedOutside', () => {
  const inPanel = {}
  const inTrigger = {}
  const elsewhere = {}
  const panel = { contains: (target: unknown) => target === inPanel }
  const trigger = { contains: (target: unknown) => target === inTrigger }

  test('a press inside the panel or on its trigger keeps it open', () => {
    expect(pressedOutside(inPanel, panel, trigger)).toBe(false)
    expect(pressedOutside(inTrigger, panel, trigger)).toBe(false)
  })
  test('a press anywhere else closes it', () => {
    expect(pressedOutside(elsewhere, panel, trigger)).toBe(true)
    expect(pressedOutside(elsewhere, panel, null)).toBe(true)
  })
  test('a press with no target, or before the panel mounted, closes it', () => {
    expect(pressedOutside(null, panel, trigger)).toBe(true)
    expect(pressedOutside(inPanel, null, null)).toBe(true)
  })
  test('without a trigger only the panel counts as inside', () => {
    expect(pressedOutside(inTrigger, panel, null)).toBe(true)
  })
})

describe('one popover', () => {
  const source = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')
  test.each(['components/MultiSelect.tsx', 'chat/ComposerStatus.tsx'])('%s uses the shared Popover and portals nothing itself', (path) => {
    const text = source(path)
    expect(text).toContain("from '@/components/Popover'")
    expect(text).not.toContain('createPortal')
    expect(text).not.toContain('placeMenu')
  })
})
