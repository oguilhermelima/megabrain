import { describe, expect, test } from 'bun:test'
import { buildTree, languageForPath, matchingPaths, statusLetter } from '@/code/code-model'
import type { CodeEntry } from '@/api/schema'

const entries: CodeEntry[] = [
  { path: 'apps', kind: 'dir', size: null },
  { path: 'apps/tv', kind: 'dir', size: null },
  { path: 'apps/tv/player.ts', kind: 'file', size: 100 },
  { path: 'apps/web.ts', kind: 'file', size: 50 },
  { path: 'README.md', kind: 'file', size: 10 },
]

describe('buildTree', () => {
  test('puts directories before files, both alphabetical', () => {
    const tree = buildTree(entries)
    expect(tree.map((node) => node.path)).toEqual(['apps', 'README.md'])
  })

  test('nests files and directories under their parent', () => {
    const tree = buildTree(entries)
    const apps = tree[0]
    if (apps?.kind !== 'dir') throw new Error('expected apps to be a dir')
    expect(apps.children.map((node) => node.path)).toEqual(['apps/tv', 'apps/web.ts'])
    const tv = apps.children[0]
    if (tv?.kind !== 'dir') throw new Error('expected apps/tv to be a dir')
    expect(tv.children.map((node) => node.path)).toEqual(['apps/tv/player.ts'])
  })

  test('creates an implicit directory for a nested file with no explicit dir entry', () => {
    const tree = buildTree([{ path: 'src/deep/file.ts', kind: 'file', size: 5 }])
    expect(tree).toEqual([
      {
        kind: 'dir',
        path: 'src',
        name: 'src',
        children: [
          {
            kind: 'dir',
            path: 'src/deep',
            name: 'deep',
            children: [{ kind: 'file', path: 'src/deep/file.ts', name: 'file.ts', size: 5 }],
          },
        ],
      },
    ])
  })

  test('an empty entry list produces an empty tree', () => {
    expect(buildTree([])).toEqual([])
  })
})

describe('matchingPaths', () => {
  test('an empty query matches nothing', () => {
    expect(matchingPaths(entries, '')).toEqual(new Set())
    expect(matchingPaths(entries, '   ')).toEqual(new Set())
  })

  test('matches a path substring case-insensitively and keeps its ancestors', () => {
    const result = matchingPaths(entries, 'PLAYER')
    expect(result).toEqual(new Set(['apps/tv/player.ts', 'apps/tv', 'apps']))
  })

  test('a query matching nothing returns an empty set', () => {
    expect(matchingPaths(entries, 'zzz')).toEqual(new Set())
  })

  test('matches several entries at once, each with its own ancestors', () => {
    const result = matchingPaths(entries, '.ts')
    expect(result).toEqual(new Set(['apps/tv/player.ts', 'apps/tv', 'apps', 'apps/web.ts']))
  })
})

describe('languageForPath', () => {
  test.each([
    ['index.ts', 'typescript'],
    ['component.tsx', 'typescript'],
    ['script.js', 'javascript'],
    ['data.json', 'json'],
    ['README.md', 'markdown'],
    ['main.rs', 'rust'],
    ['style.css', 'css'],
    ['page.html', 'html'],
    ['tool.py', 'python'],
    ['run.sh', 'shell'],
  ])('maps %s to %s', (path, language) => {
    expect(languageForPath(path)).toBe(language)
  })

  test('an unknown extension falls back to text', () => {
    expect(languageForPath('image.png')).toBe('text')
  })

  test('a file with no extension falls back to text', () => {
    expect(languageForPath('Makefile')).toBe('text')
  })
})

describe('statusLetter', () => {
  test.each([
    ['modified', 'M'],
    ['added', 'A'],
    ['deleted', 'D'],
    ['renamed', 'R'],
    ['untracked', 'U'],
  ] as const)('maps %s to %s', (status, letter) => {
    expect(statusLetter(status)).toBe(letter)
  })
})
