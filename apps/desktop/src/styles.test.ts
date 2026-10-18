import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The body sets user-select: none and WebKit inherits it into every field, which then takes no caret
// on click and selects nothing; the opt-back-in rule must name each kind of editable element.
const css = readFileSync(join(import.meta.dir, 'styles.css'), 'utf8')

function selectableSelectors(): string[] {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  return rules
    .filter((rule) => /(^|;|\s)user-select:\s*text/.test(rule[2] ?? ''))
    .flatMap((rule) => (rule[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((selector) => selector.trim()))
}

describe('text selection', () => {
  test('the body turns selection off', () => {
    expect(css).toMatch(/body\s*\{[^}]*user-select:\s*none/)
  })

  test('text fields, text areas and contenteditables opt back in', () => {
    const selectors = selectableSelectors()
    expect(selectors).toContain('input')
    expect(selectors).toContain('textarea')
    expect(selectors).toContain("[contenteditable='true']")
    expect(selectors).toContain("[contenteditable='plaintext-only']")
  })
})
