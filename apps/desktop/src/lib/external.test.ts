import { describe, expect, test } from 'bun:test'
import { httpsUrl, insideRoots, openableUrl } from '@/lib/external'

describe('httpsUrl', () => {
  test('keeps https addresses', () => {
    expect(httpsUrl('https://github.com/o/r/pull/7')).toBe('https://github.com/o/r/pull/7')
  })

  test('refuses every other scheme and anything that is not a URL', () => {
    for (const value of ['http://github.com', 'file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', '/relative', '', 'github.com']) expect(httpsUrl(value)).toBeNull()
  })
})

describe('openableUrl', () => {
  test('keeps https and mailto addresses', () => {
    expect(openableUrl('https://github.com/o/r')).toBe('https://github.com/o/r')
    expect(openableUrl(' mailto:a@b.c ')).toBe('mailto:a@b.c')
  })

  test('refuses http, other schemes and anything that is not a URL', () => {
    for (const value of ['http://github.com', 'file:///etc/passwd', 'javascript:alert(1)', '/relative', '', 'github.com']) expect(openableUrl(value)).toBeNull()
  })
})

describe('insideRoots', () => {
  const roots = ['/w/megabrain', '/w/Worktrees/fix-x/']

  test('a root or a path under it passes', () => {
    expect(insideRoots('/w/megabrain', roots)).toBe(true)
    expect(insideRoots('/w/megabrain/apps/desktop', roots)).toBe(true)
    expect(insideRoots('/w/Worktrees/fix-x', roots)).toBe(true)
  })

  test('a sibling sharing a prefix, a parent, a relative path or a climb out fails', () => {
    expect(insideRoots('/w/megabrain-old', roots)).toBe(false)
    expect(insideRoots('/w', roots)).toBe(false)
    expect(insideRoots('w/megabrain', roots)).toBe(false)
    expect(insideRoots('/w/megabrain/../secrets', roots)).toBe(false)
    expect(insideRoots('/w/megabrain', [])).toBe(false)
  })
})
