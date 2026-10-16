import { describe, expect, test } from 'bun:test'
import { adjacentSection, initialSection, navGroups, sectionInfo, settingsSections } from '@/settings/settings-nav'

describe('settings navigation', () => {
  test('every existing section is reachable exactly once', () => {
    const keys = settingsSections.map((section) => section.key)
    expect([...keys].sort()).toEqual(['chains', 'limits', 'models', 'projects', 'supervisor', 'terminal', 'usage'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('groups list the sections in navigation order, none empty', () => {
    const groups = navGroups()
    expect(groups.map((group) => group.label)).toEqual(['General', 'Agents', 'System'])
    expect(groups.every((group) => group.sections.length > 0)).toBe(true)
    expect(groups.flatMap((group) => group.sections.map((section) => section.key))).toEqual(settingsSections.map((section) => section.key))
  })

  test('every section has a title, a one-line description and an icon', () => {
    for (const section of settingsSections) {
      expect(section.label.length).toBeGreaterThan(0)
      expect(section.description.length).toBeGreaterThan(0)
      expect(section.description.includes('\n')).toBe(false)
      expect(section.icon.length).toBeGreaterThan(0)
    }
  })

  test('opens on usage, or on projects when a project is in focus', () => {
    expect(initialSection(null)).toBe('usage')
    expect(initialSection('/repo')).toBe('projects')
  })

  test('arrow keys walk the sections and wrap at both ends', () => {
    const keys = settingsSections.map((section) => section.key)
    const first = keys[0] as (typeof keys)[number]
    const last = keys[keys.length - 1] as (typeof keys)[number]
    expect(adjacentSection(first, 1)).toBe(keys[1] as (typeof keys)[number])
    expect(adjacentSection(first, -1)).toBe(last)
    expect(adjacentSection(last, 1)).toBe(first)
  })

  test('sectionInfo finds a section by key', () => {
    expect(sectionInfo('terminal').label).toBe('Terminal')
  })
})
