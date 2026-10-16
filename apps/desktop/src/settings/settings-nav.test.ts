import { describe, expect, test } from 'bun:test'
import { adjacentKey, initialKey, navGroups, navKeys, projectKey, sectionInfo, settingsSections } from '@/settings/settings-nav'

const project = (name: string, path: string, appearance?: { name?: string }) => ({ name, path, worktrees: [{ path }], ...(appearance === undefined ? {} : { appearance }) })

const projects = [
  project('megabrain', '/w/megabrain'),
  project('canto', '/w/canto', { name: 'Zebra' }),
  project('Infra', '/w/infra'),
  project('alpha', '/w/alpha'),
  { ...project('juntin', '/w/juntin'), worktrees: [{ path: '/w/juntin' }, { path: '/w/trees/juntin-feat' }] },
]

describe('settings navigation', () => {
  test('every fixed section is reachable exactly once; projects are no longer a section', () => {
    const keys = settingsSections.map((section) => section.key)
    expect([...keys].sort()).toEqual(['chains', 'limits', 'models', 'supervisor', 'terminal', 'usage'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('General, Agents and System come first, then Projects as the last group', () => {
    expect(navGroups(projects).map((group) => group.label)).toEqual(['General', 'Agents', 'System', 'Projects'])
  })

  test('without projects there is no Projects group, and no group is empty', () => {
    const groups = navGroups([])
    expect(groups.map((group) => group.label)).toEqual(['General', 'Agents', 'System'])
    expect(groups.every((group) => group.items.length > 0)).toBe(true)
  })

  test('projects list by display name, alphabetically and ignoring case', () => {
    const group = navGroups(projects).at(-1)
    expect(group?.items.map((item) => item.label)).toEqual(['alpha', 'Infra', 'juntin', 'megabrain', 'Zebra'])
    expect(group?.items.map((item) => item.key)).toEqual(['/w/alpha', '/w/infra', '/w/juntin', '/w/megabrain', '/w/canto'].map(projectKey))
  })

  test('a project item carries its project, a section item carries none', () => {
    const groups = navGroups(projects)
    expect(groups[0]?.items.every((item) => item.project === null)).toBe(true)
    expect(groups.at(-1)?.items.every((item) => item.project !== null)).toBe(true)
  })

  test('the keyboard walks sections then projects, in the order shown', () => {
    expect(navKeys(projects)).toEqual(navGroups(projects).flatMap((group) => group.items.map((item) => item.key)))
  })

  test('every section has a title, a one-line description and an icon', () => {
    for (const section of settingsSections) {
      expect(section.label.length).toBeGreaterThan(0)
      expect(section.description.length).toBeGreaterThan(0)
      expect(section.description.includes('\n')).toBe(false)
      expect(section.icon.length).toBeGreaterThan(0)
    }
  })

  test('opens on usage, or on the focused project, also when focus names one of its worktrees', () => {
    expect(initialKey(null, projects)).toBe('usage')
    expect(initialKey('/w/canto', projects)).toBe(projectKey('/w/canto'))
    expect(initialKey('/w/trees/juntin-feat', projects)).toBe(projectKey('/w/juntin'))
  })

  test('a focus that is not listed opens on that path until the list says otherwise', () => {
    expect(initialKey('/w/elsewhere', [])).toBe(projectKey('/w/elsewhere'))
  })

  test('arrow keys walk every item and wrap at both ends', () => {
    const keys = navKeys(projects)
    const first = keys[0] ?? 'usage'
    const last = keys.at(-1) ?? 'usage'
    expect(adjacentKey(keys, first, 1)).toBe(keys[1] ?? 'usage')
    expect(adjacentKey(keys, first, -1)).toBe(last)
    expect(adjacentKey(keys, last, 1)).toBe(first)
  })

  test('sectionInfo finds a section by key', () => {
    expect(sectionInfo('terminal').label).toBe('Terminal')
  })
})
