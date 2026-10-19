import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { normalizeProjectFields, normalizeProjectViews, normalizeProjectItem } from '../../src/cli/commands/github.js'

const fields = JSON.parse(readFileSync(new URL('../fixtures/github-projects/views-fields.json', import.meta.url), 'utf8')) as { fields: { nodes: unknown[] }; views: { nodes: unknown[] } }
const items = JSON.parse(readFileSync(new URL('../fixtures/github-projects/items.json', import.meta.url), 'utf8')) as unknown[]
describe('captured GitHub Project v2 fixtures', () => {
  test('keeps real project view layouts, filters, field configurations and options', () => {
    expect(normalizeProjectViews(fields.views.nodes).length).toBeGreaterThan(0)
    expect(normalizeProjectFields(fields.fields.nodes).length).toBeGreaterThan(10)
  })
  test('normalizes captured issues and typed field values', () => {
    const normalized = items.map(normalizeProjectItem).filter(Boolean)
    expect(normalized.length).toBeGreaterThan(0)
    expect(normalized.every((item) => typeof item?.isArchived === 'boolean' && Array.isArray(item.fieldValues))).toBe(true)
  })
})
