import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkingIndicator } from '@/native-chat/WorkingIndicator'

/** The markup inside each live region (role=status or aria-live), as rendered. */
function liveRegions(html: string): string[] {
  const regions: string[] = []
  const open = /<(\w+)[^>]*(?:role="status"|aria-live="[a-z]+")[^>]*>/g
  for (let match = open.exec(html); match !== null; match = open.exec(html)) {
    const tag = match[1] ?? ''
    let depth = 1
    const at = open.lastIndex
    const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g')
    tags.lastIndex = at
    for (let next = tags.exec(html); next !== null; next = tags.exec(html)) {
      depth += next[1] === '/' ? -1 : 1
      if (depth === 0) {
        regions.push(html.slice(at, next.index))
        break
      }
    }
  }
  return regions
}

describe('the working indicator', () => {
  test('announces that the agent works and what it does, but shows no elapsed time: the turn header counts it', () => {
    const since = new Date(Date.now() - 75_000).toISOString()
    const html = renderToStaticMarkup(createElement(WorkingIndicator, { status: { label: 'Reading files', since } }))
    expect(html).not.toContain('1m 15s')
    const status = /<span role="status"[^>]*>([\s\S]*?)<\/span><\/div>/.exec(html)?.[1] ?? ''
    expect(status).toContain('Working…')
    expect(status).toContain('Reading files')
  })

  test('the token count that changes every second sits outside any announced region', () => {
    const html = renderToStaticMarkup(createElement(WorkingIndicator, { status: { label: 'Thinking', since: null }, progress: () => ({ tokens: 1200, receiving: true, waiting: false, notice: null, thinking: null }) }))
    expect(html).toContain('1.2k')
    const announced = /<span role="status"[^>]*>([\s\S]*?)<\/span><\/div>/.exec(html)?.[1] ?? ''
    expect(announced).not.toContain('1.2k')
  })
})
