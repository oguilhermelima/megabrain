import { describe, expect, test } from 'bun:test'
import type { Project } from '@/api/schema'
import { defaultDestination, parseGithubSource } from '@/import/import-model'

describe('parseGithubSource', () => {
  test('accepts owner/name', () => {
    expect(parseGithubSource('operator/canto')).toEqual({ ok: true, url: 'https://github.com/operator/canto' })
  })

  test('accepts a github.com URL, with or without .git', () => {
    expect(parseGithubSource('https://github.com/operator/canto')).toEqual({ ok: true, url: 'https://github.com/operator/canto' })
    expect(parseGithubSource('https://github.com/operator/canto.git')).toEqual({ ok: true, url: 'https://github.com/operator/canto' })
  })

  test('rejects an empty value', () => {
    expect(parseGithubSource('  ')).toEqual({ ok: false, error: 'Enter a URL or owner/name.' })
  })

  test('rejects a non-github URL', () => {
    expect(parseGithubSource('https://gitlab.com/operator/canto').ok).toBe(false)
  })

  test('rejects a shorthand missing the name', () => {
    expect(parseGithubSource('operator').ok).toBe(false)
  })
})

describe('defaultDestination', () => {
  test('is the parent folder of the first project', () => {
    const projects = [{ path: '/Users/operator/Workspaces/canto' }] as Project[]
    expect(defaultDestination(projects)).toBe('/Users/operator/Workspaces')
  })

  test('is null when there are no projects', () => {
    expect(defaultDestination([])).toBeNull()
  })
})
