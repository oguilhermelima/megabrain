import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blend, contrastRatio } from '@/lib/contrast'
import { pickerSurface, pickerText, selectedTint } from '@/chat/model-picker-look'

// The model picker's text against its own background, from the colour tokens in styles.css: every
// line a person reads there, section headers and effort labels included, must meet WCAG AA (4.5:1).
const css = readFileSync(join(import.meta.dir, '..', 'styles.css'), 'utf8')

function token(name: string): string {
  const found = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)
  if (found?.[1] === undefined) throw new Error(`no colour token ${name}`)
  return found[1]
}

/** The colour token a text class names: text-ink-300 is ink-300. */
function textToken(className: string): string {
  const found = /(?:^|\s)text-((?:ink-\d+)|accent|ok|warn|bad)(?:\s|$)/.exec(className)
  if (found?.[1] === undefined) throw new Error(`no solid text colour in "${className}"`)
  return found[1]
}

describe('contrastRatio', () => {
  test('black on white is 21, a colour on itself is 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#8a8a94', '#8a8a94')).toBeCloseTo(1, 5)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
  })

  test('blend mixes a colour over another at a share', () => {
    expect(blend('#ffffff', '#000000', 0.5)).toBe('#808080')
    expect(blend('#8e9cff', '#0a0a0c', 0)).toBe('#0a0a0c')
  })
})

describe('the model picker meets WCAG AA', () => {
  const surface = token(pickerSurface)
  const selected = blend(token(selectedTint.token), surface, selectedTint.alpha)

  test('every text on the popover surface is at least 4.5:1', () => {
    for (const [role, className] of Object.entries(pickerText)) {
      const ratio = contrastRatio(token(textToken(className)), surface)
      expect({ role, passes: ratio >= 4.5, ratio: Number(ratio.toFixed(2)) }).toMatchObject({ role, passes: true })
    }
  })

  test('the selected row keeps its name and line readable on its tint', () => {
    for (const role of ['selectedName', 'selectedHint'] as const) {
      const ratio = contrastRatio(token(textToken(pickerText[role])), selected)
      expect({ role, passes: ratio >= 4.5, ratio: Number(ratio.toFixed(2)) }).toMatchObject({ role, passes: true })
    }
  })

  test('no text the picker shows uses ink-500 or a faded colour', () => {
    for (const className of Object.values(pickerText)) {
      expect(className).not.toContain('ink-500')
      expect(className).not.toMatch(/text-[a-z0-9-]+\/\d+/)
    }
  })
})
