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
