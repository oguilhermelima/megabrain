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
  test('announces what the agent does, but not the elapsed time that changes every second', () => {
    const since = new Date(Date.now() - 75_000).toISOString()
    const html = renderToStaticMarkup(createElement(WorkingIndicator, { agent: 'claude', status: { label: 'Reading files', since } }))
    expect(html).toContain('1m 15s')
    const regions = liveRegions(html)
    expect(regions.length).toBeGreaterThan(0)
    expect(regions.some((region) => region.includes('Reading files'))).toBe(true)
    expect(regions.some((region) => region.includes('1m 15s'))).toBe(false)
  })
})
