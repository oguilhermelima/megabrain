import { describe, expect, test } from 'bun:test'
import { githubAvatarUrl, githubOwner, pictureCandidates, pictureSource, projectColor, projectInitials, svgDataUrl } from '@/advanced/picture-model'

describe('pictureCandidates', () => {
  test('finds svg icons in common places, best first', () => {
    const paths = ['README.md', 'src/index.ts', 'assets/logo.svg', 'public/favicon.svg', 'docs/diagram.svg']
    expect(pictureCandidates(paths)).toEqual(['public/favicon.svg', 'assets/logo.svg'])
  })

  test('prefers an icon over a logo and a shallow file over a deep one', () => {
    const paths = ['apps/web/public/logo.svg', 'apps/web/public/favicon.svg', 'icon.svg']
    expect(pictureCandidates(paths)).toEqual(['icon.svg', 'apps/web/public/favicon.svg', 'apps/web/public/logo.svg'])
  })

  test('accepts app icon files such as a Next.js app/icon.svg', () => {
    expect(pictureCandidates(['src/app/icon.svg', 'app/icon.svg'])).toEqual(['app/icon.svg', 'src/app/icon.svg'])
  })

  test('ignores raster files, which cannot be read as text', () => {
    expect(pictureCandidates(['public/favicon.ico', 'public/apple-touch-icon.png', 'assets/logo.png'])).toEqual([])
  })

  test('ignores svg files that are not an icon or a logo', () => {
    expect(pictureCandidates(['public/arrow.svg', 'assets/illustration.svg'])).toEqual([])
  })

  test('ignores dependency and build folders', () => {
    expect(pictureCandidates(['node_modules/pkg/logo.svg', 'dist/favicon.svg', 'vendor/x/icon.svg'])).toEqual([])
  })

  test('matches names case-insensitively and with a suffix', () => {
    expect(pictureCandidates(['public/Logo-Dark.svg', 'assets/app-icon.svg'])).toEqual(['assets/app-icon.svg', 'public/Logo-Dark.svg'])
  })
})

describe('githubOwner', () => {
  test('reads the owner from an https remote', () => {
    expect(githubOwner('https://github.com/operator/canto')).toBe('operator')
    expect(githubOwner('https://github.com/operator/canto.git')).toBe('operator')
  })

  test('reads the owner from an ssh remote', () => {
    expect(githubOwner('git@github.com:Some-Org/repo.git')).toBe('Some-Org')
    expect(githubOwner('ssh://git@github.com/someone/repo')).toBe('someone')
  })

  test('is null for other hosts and no remote', () => {
    expect(githubOwner('https://gitlab.com/operator/canto')).toBeNull()
    expect(githubOwner('https://github.com.evil.example/operator/canto')).toBeNull()
    expect(githubOwner(null)).toBeNull()
    expect(githubOwner('')).toBeNull()
  })
})

describe('githubAvatarUrl', () => {
  test('builds the 64px owner avatar url', () => {
    expect(githubAvatarUrl('https://github.com/operator/canto')).toBe('https://github.com/operator.png?size=64')
  })

  test('is null without a GitHub remote', () => {
    expect(githubAvatarUrl(null)).toBeNull()
  })
})

describe('pictureSource', () => {
  test('a repository image comes first', () => {
    expect(pictureSource(['public/favicon.svg'], 'https://github.com/operator/canto')).toEqual({ kind: 'file', path: 'public/favicon.svg' })
  })

  test('the GitHub avatar when the repository has no image', () => {
    expect(pictureSource(['README.md'], 'git@github.com:operator/canto.git')).toEqual({ kind: 'avatar', url: 'https://github.com/operator.png?size=64' })
  })

  test('initials when there is neither', () => {
    expect(pictureSource([], null)).toEqual({ kind: 'initials' })
  })
})

describe('projectInitials', () => {
  test('two words give two letters', () => {
    expect(projectInitials('canto-space')).toBe('CS')
    expect(projectInitials('my_cool app')).toBe('MC')
    expect(projectInitials('juntinApp')).toBe('JA')
  })

  test('one word gives its first letter', () => {
    expect(projectInitials('megabrain')).toBe('M')
  })

  test('falls back to a question mark when there is nothing usable', () => {
    expect(projectInitials('---')).toBe('?')
    expect(projectInitials('')).toBe('?')
  })
})

describe('projectColor', () => {
  test('is stable for a name', () => {
    expect(projectColor('canto')).toBe(projectColor('canto'))
  })

  test('is a hex colour', () => {
    expect(projectColor('megabrain')).toMatch(/^#[0-9a-f]{6}$/)
  })

  test('spreads names across the palette', () => {
    const colours = new Set(['canto', 'megabrain', 'juntin', 'stack', 'moide', 'lostudio', 'canto-space', 'userscripts'].map(projectColor))
    expect(colours.size).toBeGreaterThan(3)
  })
})

describe('svgDataUrl', () => {
  test('encodes svg text into a data url', () => {
    const url = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
    expect(url).toStartWith('data:image/svg+xml;charset=utf-8,')
    expect(decodeURIComponent(url?.split(',')[1] ?? '')).toBe('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
  })

  test('is null for text that is not svg', () => {
    expect(svgDataUrl('hello')).toBeNull()
    expect(svgDataUrl('')).toBeNull()
  })

  test('is null for svg too large for a sidebar picture', () => {
    expect(svgDataUrl(`<svg>${'x'.repeat(300_000)}</svg>`)).toBeNull()
  })
})
