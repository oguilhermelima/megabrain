import { describe, expect, test } from 'bun:test'
import { fixtureRoadmap, fixtureRoadmapItems } from '@/api/fixtures/github-projects'
import { filterGithubProjectItems } from '@/api/project-filter'

describe('GitHub Project filter API', () => {
  test('uses view field option names and returns original items plus unsupported qualifier warnings', () => {
    const result = filterGithubProjectItems(fixtureRoadmap, fixtureRoadmapItems, 'status:"In Review"')
    expect(result.items.map((item) => item.id)).toEqual(['PVTI_02', 'PVTI_11'])
    const unknown = filterGithubProjectItems(fixtureRoadmap, fixtureRoadmapItems, 'unknown:value')
    expect(unknown.items).toHaveLength(fixtureRoadmapItems.length)
    expect(unknown.warnings).toEqual(['unknown:value'])
  })
})

describe('single-select fields other than Status', () => {
  test('match by option name', () => {
    const priority = { id: 'F_p', name: 'Priority', dataType: 'SINGLE_SELECT', options: [{ id: 'p0', name: 'P0', color: 'RED', description: '' }], iterations: [] }
    const project = { ...fixtureRoadmap, fields: [...fixtureRoadmap.fields, priority] }
    const items = fixtureRoadmapItems.slice(0, 2).map((item, index) => ({ ...item, fieldValues: index === 0 ? [{ kind: 'singleSelect' as const, field: 'Priority', value: { optionId: 'p0', name: 'P0' } }] : [] }))
    expect(filterGithubProjectItems(project, items, 'priority:P0').items.map((item) => item.id)).toEqual([items[0]!.id])
  })
})
