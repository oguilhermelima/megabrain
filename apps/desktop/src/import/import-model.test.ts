import { describe, expect, test } from 'bun:test'
import type { DiscoveredRepository, GithubRepository, Project, ProjectScripts } from '@/api/schema'
import {
  cloneTarget,
  defaultDestination,
  githubName,
  isImportedGithub,
  moveFocus,
  parseGithubSource,
  previewFromPath,
  previewPatch,
  remoteLabel,
  scriptLines,
  settleImports,
  toggleChoice,
  visibleGithub,
  visibleSuggestions,
} from '@/import/import-model'

const home = '/Users/operator'

function found(name: string, extra: Partial<DiscoveredRepository> = {}): DiscoveredRepository {
  return { name, path: `${home}/Workspaces/${name}`, branch: 'main', remote: null, lastCommitAt: '2026-10-01T00:00:00.000Z', root: `${home}/Workspaces`, ...extra }
}

function github(nameWithOwner: string, extra: Partial<GithubRepository> = {}): GithubRepository {
  return { nameWithOwner, url: `https://github.com/${nameWithOwner}`, description: null, isPrivate: false, updatedAt: '2026-10-01T00:00:00Z', ...extra }
}

const project = (path: string, remote: string | null = null) => ({ name: path.split('/').at(-1) ?? path, path, remote }) as Project

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
  test('is the parent folder of a project under ~/Workspaces', () => {
    const projects = [project('/srv/elsewhere/api'), project(`${home}/Workspaces/clients/canto`)]
    expect(defaultDestination(projects, home)).toBe(`${home}/Workspaces/clients`)
  })

  test('is ~/Workspaces when no project lives there', () => {
    expect(defaultDestination([project('/srv/elsewhere/api')], home)).toBe(`${home}/Workspaces`)
    expect(defaultDestination([], home)).toBe(`${home}/Workspaces`)
  })

  test('is not fooled by a folder that only starts with Workspaces', () => {
    expect(defaultDestination([project(`${home}/WorkspacesOld/api`)], home)).toBe(`${home}/Workspaces`)
  })
})

describe('visibleSuggestions', () => {
  test('drops repositories registered since the scan', () => {
    const list = [found('api'), found('web')]
    expect(visibleSuggestions(list, [`${home}/Workspaces/api`], '').map((entry) => entry.name)).toEqual(['web'])
  })

  test('matches the query on name, path or remote, ignoring case', () => {
    const list = [found('api'), found('web', { remote: 'git@github.com:acme/storefront.git' }), found('tools', { path: '/opt/Clients/tools' })]
    expect(visibleSuggestions(list, [], 'API').map((entry) => entry.name)).toEqual(['api'])
    expect(visibleSuggestions(list, [], 'storefront').map((entry) => entry.name)).toEqual(['web'])
    expect(visibleSuggestions(list, [], 'clients').map((entry) => entry.name)).toEqual(['tools'])
  })

  test('keeps the order the scan gave', () => {
    const list = [found('b'), found('a'), found('c')]
    expect(visibleSuggestions(list, [], '  ').map((entry) => entry.name)).toEqual(['b', 'a', 'c'])
  })
})

describe('remoteLabel and githubName', () => {
  test('a GitHub remote reads as owner/name in any URL form', () => {
    expect(remoteLabel('git@github.com:acme/api.git')).toBe('acme/api')
    expect(remoteLabel('https://github.com/acme/api')).toBe('acme/api')
    expect(remoteLabel('ssh://git@github.com/acme/api.git')).toBe('acme/api')
  })

  test('another host keeps its host and path, and no remote is null', () => {
    expect(remoteLabel('https://gitlab.com/acme/api.git')).toBe('gitlab.com/acme/api')
    expect(remoteLabel('git@gitlab.com:acme/api.git')).toBe('gitlab.com/acme/api')
    expect(remoteLabel(null)).toBeNull()
  })

  test('githubName is null for a host other than github.com', () => {
    expect(githubName('https://github.com/Acme/API.git')).toBe('acme/api')
    expect(githubName('https://gitlab.com/acme/api')).toBeNull()
  })
})

describe('toggleChoice', () => {
  test('adds a path once and removes it on the second toggle', () => {
    const once = toggleChoice([], '/a')
    expect(once).toEqual(['/a'])
    expect(toggleChoice(once, '/b')).toEqual(['/a', '/b'])
    expect(toggleChoice(['/a', '/b'], '/a')).toEqual(['/b'])
  })
})

describe('moveFocus', () => {
  test('moves within the list and stops at both ends', () => {
    expect(moveFocus(0, 1, 3)).toBe(1)
    expect(moveFocus(2, 1, 3)).toBe(2)
    expect(moveFocus(0, -1, 3)).toBe(0)
  })

  test('starts at the first row from nothing focused, and is -1 for an empty list', () => {
    expect(moveFocus(-1, 1, 3)).toBe(0)
    expect(moveFocus(-1, -1, 3)).toBe(0)
    expect(moveFocus(1, 1, 0)).toBe(-1)
  })

  test('a list that shrank pulls the focus back inside it', () => {
    expect(moveFocus(5, 0, 2)).toBe(1)
  })
})

describe('previewFromPath', () => {
  test('takes what the scan knew about the folder', () => {
    const entry = found('canto', { remote: 'git@github.com:operator/canto.git', branch: 'develop' })
    expect(previewFromPath(entry.path, [entry])).toEqual({ path: entry.path, folderName: 'canto', name: 'canto', color: null, picture: null, remote: 'git@github.com:operator/canto.git', branch: 'develop' })
  })

  test('a chosen folder the scan never saw starts from its folder name', () => {
    expect(previewFromPath('/tmp/new-project/', [])).toEqual({ path: '/tmp/new-project', folderName: 'new-project', name: 'new-project', color: null, picture: null, remote: null, branch: null })
  })
})

describe('previewPatch', () => {
  const base = previewFromPath('/w/canto', [])

  test('is null when nothing was dressed', () => {
    expect(previewPatch(base)).toBeNull()
    expect(previewPatch({ ...base, name: '  canto ' })).toBeNull()
  })

  test('carries a new name, a colour and a picture', () => {
    expect(previewPatch({ ...base, name: ' Canto ', color: '#22c55e', picture: '/tmp/logo.png' })).toEqual({ name: 'Canto', color: '#22c55e', picture: '/tmp/logo.png' })
  })

  test('never hands on a colour that is not #rrggbb, nor an empty name', () => {
    expect(previewPatch({ ...base, name: '', color: 'red' })).toBeNull()
  })
})

describe('scriptLines', () => {
  test('lists the commands found, in run, build, install order', () => {
    const scripts: ProjectScripts = { repo: '/w/canto', scripts: { run: { command: 'bun run dev', source: 'detected' }, build: null, install: { command: 'bun install', source: 'saved' } } }
    expect(scriptLines(scripts)).toEqual([
      { name: 'run', command: 'bun run dev', source: 'detected' },
      { name: 'install', command: 'bun install', source: 'saved' },
    ])
  })

  test('is empty without scripts', () => {
    expect(scriptLines(null)).toEqual([])
  })
})

describe('settleImports', () => {
  test('splits what was imported from what failed, keeping each reason', () => {
    const results: PromiseSettledResult<unknown>[] = [{ status: 'fulfilled', value: {} }, { status: 'rejected', reason: new Error('not a git repository: /b') }, { status: 'rejected', reason: 'boom' }]
    expect(settleImports(['/a', '/b', '/c'], results)).toEqual({ imported: ['/a'], failed: [{ path: '/b', error: 'not a git repository: /b' }, { path: '/c', error: 'boom' }] })
  })
})

describe('visibleGithub', () => {
  const list = [
    github('operator/old', { updatedAt: '2025-01-01T00:00:00Z' }),
    github('acme/web', { description: 'Storefront', primaryLanguage: { name: 'TypeScript' } }),
    github('operator/new', { updatedAt: '2026-10-10T00:00:00Z' }),
    github('acme/never', { updatedAt: null }),
  ]

  test('lists the most recently updated first, never-updated last', () => {
    expect(visibleGithub(list, '', null).map((entry) => entry.nameWithOwner)).toEqual(['operator/new', 'acme/web', 'operator/old', 'acme/never'])
  })

  test('keeps one owner when one is chosen', () => {
    expect(visibleGithub(list, '', 'acme').map((entry) => entry.nameWithOwner)).toEqual(['acme/web', 'acme/never'])
  })

  test('matches the query on name, description or language', () => {
    expect(visibleGithub(list, 'store', null).map((entry) => entry.nameWithOwner)).toEqual(['acme/web'])
    expect(visibleGithub(list, 'typescript', null).map((entry) => entry.nameWithOwner)).toEqual(['acme/web'])
    expect(visibleGithub(list, 'OPERATOR/N', null).map((entry) => entry.nameWithOwner)).toEqual(['operator/new'])
  })
})

describe('isImportedGithub', () => {
  test('is true when a project already has this repository as its remote, in any URL form', () => {
    const projects = [project('/w/canto', 'git@github.com:Operator/canto.git')]
    expect(isImportedGithub(github('operator/canto'), projects)).toBe(true)
    expect(isImportedGithub(github('operator/other'), projects)).toBe(false)
  })
})

describe('cloneTarget', () => {
  test('is the destination folder plus the repository name', () => {
    expect(cloneTarget(`${home}/Workspaces/`, 'https://github.com/operator/canto')).toBe(`${home}/Workspaces/canto`)
    expect(cloneTarget(`${home}/Workspaces`, 'https://github.com/operator/canto.git')).toBe(`${home}/Workspaces/canto`)
  })
})
