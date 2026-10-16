import { CliError, type DesktopApi } from '@/api/adapter'
import { mockPullRequestFiles } from '@/api/fixtures/mock'
import type { GithubPullRequestFile, GithubReviewer, GithubReviewers, GithubReviewThread } from '@/api/schema'

// The review side of the mock GitHub: changed files in pages and one at a time, review threads,
// reviewers, readiness and viewed marks, each write kept for the session. Pull request 105 is the
// large one: 600 files, one of them 20000 lines, to show the Files tab staying responsive.

export const mockLargePullRequest = 105
const largeFileCount = 600
const hugeFileIndex = 7

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const person = (login: string, name: string | null = null): GithubReviewer => ({ login, name, isBot: false })

const people: GithubReviewer[] = [
  person('operator', 'Operator'),
  person('fake-contributor', 'Fake Contributor'),
  person('octo-reviewer', 'Octo Reviewer'),
  person('lin-ops', 'Lin Ops'),
  person('rafa-dev', 'Rafa Dev'),
  { login: 'operator/core', name: 'Core team', isBot: false, isTeam: true },
]

const extensions = ['ts', 'tsx', 'css', 'json', 'md', 'py', 'rs']
const folders = ['apps/web/src', 'apps/api/src', 'packages/ui/src', 'packages/db/src', 'docs', 'scripts', 'services/worker']

/** A cheap deterministic number from an index, so every load lists the same files. */
const spread = (index: number, modulo: number) => ((index * 2654435761) >>> 0) % modulo

function largeFiles(): GithubPullRequestFile[] {
  return Array.from({ length: largeFileCount }, (_, index) => {
    if (index === hugeFileIndex) return { path: 'packages/db/src/seed/catalog.ts', status: 'added', additions: 20000, deletions: 0, patch: null }
    const extension = extensions[spread(index, extensions.length)] ?? 'ts'
    const folder = folders[spread(index + 3, folders.length)] ?? 'src'
    const added = spread(index, 5) !== 0
    const size = 4 + spread(index + 11, 140)
    return {
      path: `${folder}/module-${String(index).padStart(3, '0')}/index.${extension}`,
      status: added ? 'added' : 'modified',
      additions: size,
      deletions: added ? 0 : 1 + spread(index, 6),
      patch: null,
    }
  })
}

function sourceLine(extension: string, number: number): string {
  switch (extension) {
    case 'css':
      return `.item-${number} { display: grid; gap: ${number % 12}px; color: #${(number * 4099).toString(16).slice(0, 6).padEnd(6, '0')}; }`
    case 'json':
      return `  "key${number}": { "id": ${number}, "enabled": ${number % 2 === 0}, "label": "entry ${number}" },`
    case 'md':
      return `- Step ${number}: run the **seed** for \`module ${number}\` and check the output.`
    case 'py':
      return `def handler_${number}(event, context):  # seeded\n`.trimEnd()
    case 'rs':
      return `pub fn value_${number}() -> u32 { ${number} * 2 }`
    default:
      return `export const item${number} = { id: ${number}, name: 'item ${number}', tags: ['seed', 'stack'], weight: ${number % 97} } // generated`
  }
}

function generatedPatch(file: GithubPullRequestFile): string {
  const extension = file.path.split('.').at(-1) ?? 'ts'
  if (file.status === 'added') {
    const lines = [`@@ -0,0 +1,${file.additions} @@`]
    for (let number = 1; number <= file.additions; number++) lines.push(`+${sourceLine(extension, number)}`)
    return lines.join('\n')
  }
  const lines = [`@@ -1,${file.deletions + 6} +1,${file.additions + 6} @@`]
  for (let number = 1; number <= 3; number++) lines.push(` ${sourceLine(extension, number)}`)
  for (let number = 0; number < file.deletions; number++) lines.push(`-${sourceLine(extension, 1000 + number)}`)
  for (let number = 0; number < file.additions; number++) lines.push(`+${sourceLine(extension, 2000 + number)}`)
  for (let number = 4; number <= 6; number++) lines.push(` ${sourceLine(extension, number)}`)
  return lines.join('\n')
}

const comment = (id: string, login: string, body: string, minutesAgo: number) => ({ id, author: { login, name: null, isBot: false }, body, createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() })

function initialThreads(number: number, files: GithubPullRequestFile[]): GithubReviewThread[] {
  if (number === mockLargePullRequest) {
    const first = files[0]?.path ?? ''
    const modified = files.find((file) => file.status === 'modified')?.path ?? ''
    return [
      { id: 'T_large_1', path: first, line: 3, side: 'RIGHT', isResolved: false, isOutdated: false, comments: [comment('C1', 'fake-contributor', 'Should this weight be configurable?', 40), comment('C2', 'operator', 'Later, it is fixed for the seed.', 30)] },
      { id: 'T_large_2', path: modified, line: 2, side: 'LEFT', isResolved: false, isOutdated: false, comments: [comment('C3', 'octo-reviewer', 'This line was the only caller.', 25)] },
      { id: 'T_large_3', path: files[1]?.path ?? '', line: 9, side: 'RIGHT', isResolved: false, isOutdated: true, comments: [comment('C4', 'octo-reviewer', 'Typo in the label.', 300)] },
      { id: 'T_large_4', path: 'packages/db/src/seed/catalog.ts', line: 15000, side: 'RIGHT', isResolved: true, isOutdated: false, comments: [comment('C5', 'lin-ops', 'Duplicate id here?', 90), comment('C6', 'operator', 'Fixed.', 80)] },
    ]
  }
  if (number === 112) {
    return [
      { id: 'T_112_1', path: 'apps/desktop/src/github/github-requests.ts', line: 6, side: 'RIGHT', isResolved: false, isOutdated: false, comments: [comment('C7', 'fake-contributor', 'Is one shared instance enough for both lists?', 60)] },
      { id: 'T_112_2', path: 'src/cli/commands/github-review.ts', line: 4, side: 'RIGHT', isResolved: true, isOutdated: false, comments: [comment('C8', 'octo-reviewer', 'Needs --json here.', 120)] },
    ]
  }
  return []
}

function initialReviewers(number: number): GithubReviewers {
  const base: GithubReviewers = { requested: [], reviews: [], mergeable: 'mergeable', mergeStateStatus: 'clean', reviewDecision: 'approved', requiredChecks: [{ name: 'typecheck', state: 'success' }, { name: 'unit', state: 'success' }] }
  switch (number) {
    case mockLargePullRequest:
      return { ...base, requested: [person('fake-contributor', 'Fake Contributor')], mergeStateStatus: 'blocked', reviewDecision: 'review_required' }
    case 112:
      return { ...base, reviews: [{ author: person('fake-contributor'), state: 'commented', submittedAt: new Date(Date.now() - 3_600_000).toISOString() }], mergeStateStatus: 'blocked', reviewDecision: 'review_required', requiredChecks: [{ name: 'typecheck', state: 'success' }, { name: 'unit', state: 'pending' }] }
    case 111:
      return { ...base, reviews: [{ author: person('octo-reviewer'), state: 'changes_requested', submittedAt: new Date(Date.now() - 7_200_000).toISOString() }], mergeStateStatus: 'blocked', reviewDecision: 'changes_requested', requiredChecks: [{ name: 'typecheck', state: 'success' }, { name: 'unit', state: 'failure' }] }
    case 110:
      return { ...base, reviews: [{ author: person('fake-contributor'), state: 'approved', submittedAt: new Date(Date.now() - 5_400_000).toISOString() }] }
    case 109:
      return { ...base, mergeStateStatus: 'draft', reviewDecision: null, requiredChecks: [] }
    case 108:
      return { ...base, mergeable: 'conflicting', mergeStateStatus: 'dirty', reviewDecision: null }
    default:
      return base
  }
}

type ReviewApi = Pick<DesktopApi, 'prFilesPage' | 'prFile' | 'prThreads' | 'replyThread' | 'resolveThread' | 'prReviewers' | 'githubImage' | 'assignableReviewers' | 'requestReview' | 'setPrReady' | 'setAutoMerge' | 'rerunChecks' | 'setFileViewed'>

/** The review calls with their own session state; draftOf reports a pull request turned into or out of a draft. */
export function createMockReviewApi(): ReviewApi & { draftOf: (number: number) => boolean | undefined } {
  const lists = new Map<number, GithubPullRequestFile[]>()
  const viewed = new Map<string, boolean>()
  const threads = new Map<number, GithubReviewThread[]>()
  const reviewers = new Map<number, GithubReviewers>()
  const drafts = new Map<number, boolean>()

  const filesOf = (number: number) => {
    let list = lists.get(number)
    if (list === undefined) {
      list = number === mockLargePullRequest ? largeFiles() : mockPullRequestFiles(number)
      lists.set(number, list)
    }
    return list
  }
  const threadsOf = (number: number) => {
    let list = threads.get(number)
    if (list === undefined) {
      list = initialThreads(number, filesOf(number))
      threads.set(number, list)
    }
    return list
  }
  const reviewersOf = (number: number) => {
    let value = reviewers.get(number)
    if (value === undefined) {
      value = initialReviewers(number)
      reviewers.set(number, value)
    }
    return value
  }
  const thread = (number: number, id: string) => {
    const found = threadsOf(number).find((entry) => entry.id === id)
    if (found === undefined) throw new CliError(`gh: Could not resolve to a node with the global id of '${id}'.`, 1)
    return found
  }

  return {
    draftOf: (number) => drafts.get(number),
    prFilesPage: async (_root, number, page, perPage) => {
      await wait(250)
      const list = filesOf(number)
      const files = list.slice((page - 1) * perPage, page * perPage).map(({ patch: _patch, ...file }) => ({ ...file, patch: null, viewed: viewed.get(`${number}:${file.path}`) ?? false }))
      return { number, total: list.length, page, perPage, files }
    },
    prFile: async (_root, number, path) => {
      await wait(number === mockLargePullRequest ? 120 : 200)
      const file = filesOf(number).find((entry) => entry.path === path)
      if (file === undefined) throw new CliError(`gh: no file ${path} in pull request #${number}`, 1)
      const patch = number === mockLargePullRequest ? generatedPatch(file) : file.patch
      return { ...file, patch, viewed: viewed.get(`${number}:${path}`) ?? false }
    },
    prThreads: async (_root, number) => {
      await wait(300)
      return threadsOf(number)
    },
    replyThread: async (_root, number, threadId, body) => {
      await wait(400)
      const found = thread(number, threadId)
      threads.set(number, threadsOf(number).map((entry) => (entry === found ? { ...entry, comments: [...entry.comments, comment(`C${Date.now()}`, 'operator', body, 0)] } : entry)))
    },
    resolveThread: async (_root, number, threadId, resolved) => {
      await wait(350)
      const found = thread(number, threadId)
      threads.set(number, threadsOf(number).map((entry) => (entry === found ? { ...entry, isResolved: resolved } : entry)))
    },
    prReviewers: async (_root, number) => {
      await wait(280)
      const value = reviewersOf(number)
      const draft = drafts.get(number)
      if (draft === true) return { ...value, mergeStateStatus: 'draft' }
      if (draft === false && value.mergeStateStatus === 'draft') return { ...value, mergeStateStatus: 'blocked', reviewDecision: 'review_required' }
      return value
    },
    // Any repository file link answers with the same small picture; a name with "missing" fails as a 404 would.
    githubImage: async (_root, url) => {
      await wait(250)
      if (url.includes('missing')) throw new CliError('gh api contents failed: HTTP 404: Not Found', 1)
      return { contentType: 'image/png', size: 107, data: 'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAYCAIAAABBUIs9AAAAMklEQVR4nGNIzv8PQcptZhCEKcJAUAWQzUBQBUgRQRUIRfhdxkBQBcLho74b9d0g8x0A/EqDEB71bMEAAAAASUVORK5CYII=' }
    },
    assignableReviewers: async (_root, query) => {
      await wait(200)
      const text = query.trim().toLowerCase()
      return people.filter((entry) => text === '' || `${entry.login} ${entry.name ?? ''}`.toLowerCase().includes(text))
    },
    requestReview: async (_root, number, logins, remove) => {
      await wait(450)
      if (logins.includes('operator') && !remove) throw new CliError('gh: Review cannot be requested from pull request author. (HTTP 422)', 1)
      const value = reviewersOf(number)
      const requested = remove
        ? value.requested.filter((entry) => !logins.includes(entry.login))
        : [...value.requested, ...logins.filter((login) => !value.requested.some((entry) => entry.login === login)).map((login) => people.find((entry) => entry.login === login) ?? person(login))]
      reviewers.set(number, { ...value, requested })
    },
    setPrReady: async (_root, number, ready) => {
      await wait(500)
      drafts.set(number, !ready)
    },
    setAutoMerge: async (_root, number, method) => {
      await wait(500)
      if (number === 108 && method !== null) throw new CliError('gh: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)', 1)
    },
    rerunChecks: async () => {
      await wait(600)
    },
    setFileViewed: async (_root, number, path, value) => {
      await wait(180)
      viewed.set(`${number}:${path}`, value)
    },
  }
}
