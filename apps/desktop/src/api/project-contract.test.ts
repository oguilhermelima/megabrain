import { describe, expect, test } from 'bun:test'
import { fixtureRoadmap, fixtureRoadmapItems } from '@/api/fixtures/github-projects'
import { githubProjectItemSchema, githubProjectSchema } from '@/api/schema'

describe('GitHub Projects v2 API schemas', () => {
  test('accepts view configuration and field metadata from the project fixture', () => {
    const project = githubProjectSchema.safeParse(fixtureRoadmap)
    expect(project.success).toBe(true)
    if (project.success) expect(project.data.views[0]).toMatchObject({ layout: 'BOARD_LAYOUT', filter: '', visibleFields: [{ name: 'Status' }] })
  })
  test('validates typed values and archive state while retaining older cached items', () => {
    const item = fixtureRoadmapItems[0]!
    expect(githubProjectItemSchema.safeParse({ ...item, isArchived: false, fieldValues: [
      { kind: 'singleSelect', field: 'Status', value: { optionId: 'opt_todo', name: 'Todo' } },
      { kind: 'number', field: 'Estimate', value: 3 },
    ] }).success).toBe(true)
    expect(githubProjectItemSchema.safeParse({ ...item, fieldValues: [{ kind: 'unknown', field: 'Status', value: 'x' }] }).success).toBe(false)
    expect(githubProjectItemSchema.safeParse(item).success).toBe(true)
  })
})
