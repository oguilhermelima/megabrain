import { z } from 'zod'

// `megabrain repo github [--owner <login>] --json`: repositories the person can clone.
export const githubRepositorySchema = z.looseObject({
  nameWithOwner: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  isPrivate: z.boolean(),
  updatedAt: z.string().nullable(),
  /** Absent from an older CLI. */
  primaryLanguage: z.looseObject({ name: z.string() }).nullable().optional(),
  stargazerCount: z.number().optional(),
})

// `megabrain repo github --orgs --json`: the signed-in account first, then its organisations.
export const githubOwnerSchema = z.looseObject({
  login: z.string(),
  kind: z.enum(['user', 'organization']),
  avatarUrl: z.string().nullable(),
})

// `megabrain repo discover [--roots <paths>] --json`: git repositories on disk that are not
// registered, newest commit first.
export const discoveredRepositorySchema = z.looseObject({
  name: z.string(),
  path: z.string(),
  /** null when HEAD is detached. */
  branch: z.string().nullable(),
  remote: z.string().nullable(),
  /** ISO 8601; null for a repository without commits. */
  lastCommitAt: z.string().nullable(),
  root: z.string(),
})

// `megabrain github prs|issues|pr|issue <repo> --json`: a repository's pull requests and issues as
// gh reports them, normalized by the CLI (lower-case states, one state per check, comment counts).
// Lists are light pages; checks, review decision and line counts come with one pull request's detail.
const githubPersonSchema = z.looseObject({ login: z.string(), name: z.string().nullable(), isBot: z.boolean() })
const githubLabelSchema = z.looseObject({ name: z.string(), color: z.string(), description: z.string() })
const githubRepositoryRefSchema = z.looseObject({ nameWithOwner: z.string(), url: z.string(), path: z.string() })

export const githubCheckSchema = z.looseObject({
  name: z.string(),
  state: z.enum(['success', 'failure', 'pending', 'skipped', 'neutral']),
})

export const githubPullRequestSchema = z.looseObject({
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  isDraft: z.boolean(),
  author: githubPersonSchema.nullable(),
  labels: z.array(githubLabelSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  url: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  comments: z.number(),
})

export const githubIssueSchema = z.looseObject({
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  author: githubPersonSchema.nullable(),
  labels: z.array(githubLabelSchema),
  assignees: z.array(z.looseObject({ login: z.string(), name: z.string().nullable() })),
  createdAt: z.string(),
  updatedAt: z.string(),
  url: z.string(),
  comments: z.number(),
  milestone: z.looseObject({ title: z.string(), dueOn: z.string().nullable() }).nullable(),
})

/** One page: `after` is the cursor it was asked from, `nextCursor` the one for the page after (null on the last). */
const githubListing = <T extends z.ZodType>(item: T) =>
  z.looseObject({
    repository: githubRepositoryRefSchema,
    state: z.string(),
    limit: z.number(),
    after: z.string().nullable(),
    fetchedAt: z.string(),
    /** Every state's total (open, closed, merged for pull requests, all), not just this page's. */
    counts: z.record(z.string(), z.number()),
    totalCount: z.number(),
    nextCursor: z.string().nullable(),
    items: z.array(item),
  })

export const githubPullRequestListSchema = githubListing(githubPullRequestSchema)
export const githubIssueListSchema = githubListing(githubIssueSchema)

// `megabrain github projects|project|project-move --json`: GitHub Projects v2 boards.
export const githubProjectStatusFieldSchema = z.looseObject({
  id: z.string(), name: z.string(), options: z.array(z.looseObject({ id: z.string(), name: z.string(), color: z.enum(['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE']) })),
})
export const githubProjectSchema = z.looseObject({
  id: z.string(), number: z.number(), title: z.string(), url: z.string(), owner: z.string(), closed: z.boolean(), statusField: githubProjectStatusFieldSchema.nullable(),
})
export const githubProjectItemSchema = z.looseObject({
  id: z.string(), type: z.enum(['ISSUE', 'PULL_REQUEST', 'DRAFT_ISSUE']), number: z.number().nullable(), title: z.string(), url: z.string().nullable(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']).nullable(), repository: z.string().nullable(), status: z.string().nullable(),
  assignees: z.array(z.looseObject({ login: z.string(), avatarUrl: z.string() })), labels: z.array(z.looseObject({ name: z.string(), color: z.string() })), updatedAt: z.string(),
})
export const githubProjectsSchema = z.looseObject({ projects: z.array(githubProjectSchema) })
export const githubProjectPageSchema = z.looseObject({ project: githubProjectSchema, items: z.array(githubProjectItemSchema), next: z.string().nullable() })
export const githubProjectMoveSchema = z.looseObject({ item: githubProjectItemSchema })
export type GithubProject = z.infer<typeof githubProjectSchema>
export type GithubProjectStatusField = z.infer<typeof githubProjectStatusFieldSchema>
export type GithubProjectColor = GithubProjectStatusField['options'][number]['color']
export type GithubProjectItem = z.infer<typeof githubProjectItemSchema>
export type GithubProjects = z.infer<typeof githubProjectsSchema>
export type GithubProjectPage = z.infer<typeof githubProjectPageSchema>

// `megabrain github runs|run --json`: workflow runs and their jobs/steps.
export const githubActionRunSchema = z.looseObject({
  id: z.number(), name: z.string(), title: z.string(), event: z.string(), branch: z.string(), sha: z.string(),
  status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']),
  conclusion: z.enum(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale']).nullable(),
  number: z.number(), attempt: z.number(), actor: z.string(), createdAt: z.string(), updatedAt: z.string(), startedAt: z.string().nullable(), url: z.string(), prNumber: z.number().nullable(),
})
export const githubActionWorkflowInputSchema = z.looseObject({
  name: z.string(), description: z.string().nullable(), required: z.boolean(), type: z.enum(['string', 'boolean', 'choice', 'number', 'environment']),
  default: z.union([z.string(), z.boolean(), z.number()]).nullable(), options: z.array(z.string()).optional(),
})
/** dispatchable when the workflow's on: includes workflow_dispatch; inputs are its dispatch inputs. */
export const githubActionWorkflowSchema = z.looseObject({ id: z.number(), name: z.string(), path: z.string(), state: z.string(), dispatchable: z.boolean(), inputs: z.array(githubActionWorkflowInputSchema) })
export const githubActionRunsSchema = z.looseObject({ runs: z.array(githubActionRunSchema), workflows: z.array(githubActionWorkflowSchema), next: z.string().nullable() })
export const githubActionStepSchema = z.looseObject({ number: z.number(), name: z.string(), status: z.string(), conclusion: z.string().nullable(), startedAt: z.string().nullable(), completedAt: z.string().nullable() })
export const githubActionJobSchema = z.looseObject({ id: z.number(), name: z.string(), status: z.string(), conclusion: z.string().nullable(), startedAt: z.string().nullable(), completedAt: z.string().nullable(), url: z.string(), steps: z.array(githubActionStepSchema) })
export const githubActionRunDetailSchema = githubActionRunSchema.extend({ jobs: z.array(githubActionJobSchema) })
export const githubActionLogSchema = z.looseObject({ log: z.string(), truncated: z.boolean() })
export type GithubActionRun = z.infer<typeof githubActionRunSchema>
export type GithubActionRunDetail = z.infer<typeof githubActionRunDetailSchema>
export type GithubActionRuns = z.infer<typeof githubActionRunsSchema>
export type GithubActionLog = z.infer<typeof githubActionLogSchema>

// `megabrain github pr|issue <repo> <number> --json`: the body (markdown) and the comments, and for a
// pull request its review decision, checks and line counts.
export const githubDetailSchema = z.looseObject({
  repository: githubRepositoryRefSchema,
  number: z.number(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  url: z.string(),
  author: githubPersonSchema.nullable(),
  createdAt: z.string().nullable(),
  body: z.string(),
  comments: z.array(z.looseObject({ author: githubPersonSchema.nullable(), body: z.string(), createdAt: z.string(), url: z.string() })),
  /** null when the repository asks for no review. */
  reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable().optional(),
  checks: z.array(githubCheckSchema).optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  /** A pull request's branch and the one it merges into, when the CLI reports them. */
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
})

// `megabrain github pr-files <repo> <number> --json`: the files a pull request changes, each with
// gh's unified patch (null when GitHub sends none, as for a binary or a very large file).
export const githubPullRequestFileSchema = z.looseObject({
  path: z.string(),
  previousPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'removed', 'renamed']),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().nullable(),
  /** Whether the viewer marked the file viewed on GitHub; absent from an older CLI. */
  viewed: z.boolean().optional(),
})

// `megabrain github pr-files <repo> <number> --page <k> --per-page <m> --no-patch --json`: one page of
// the changed files without their patches, and how many files the pull request changes in all.
// `github pr-file <repo> <number> <path> --json` then gives one file with its patch.
export const githubPullRequestFilesPageSchema = z.looseObject({
  number: z.number(),
  total: z.number(),
  page: z.number(),
  perPage: z.number(),
  files: z.array(githubPullRequestFileSchema.extend({ patch: z.string().nullable().optional() }).transform((file) => ({ ...file, patch: file.patch ?? null }))),
})

// `megabrain github threads <repo> <number> --json`: the review threads on the diff. line is null for
// a thread on the whole file; isOutdated when the line it was left on has changed since.
export const githubReviewThreadSchema = z.looseObject({
  id: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  side: z.enum(['LEFT', 'RIGHT']).catch('RIGHT'),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.array(z.looseObject({ id: z.string(), author: githubPersonSchema.nullable(), body: z.string(), createdAt: z.string() })),
})

// `megabrain github image <repo> <url> --json`: a picture a body links from a GitHub repository,
// read through gh's API so a private repository's file shows; data is the file as base64.
export const githubImageSchema = z.looseObject({
  contentType: z.string(),
  size: z.number(),
  data: z.string(),
})

/** A person or, with isTeam, a team (login org/team-slug) asked for a review or able to give one. */
export const githubReviewerSchema = githubPersonSchema.extend({ isTeam: z.boolean().optional() })

const lowered = z.string().transform((value) => value.toLowerCase())

// `megabrain github reviewers <repo> <number> --json`: who is asked to review, the reviews given, and
// what GitHub says about merging (mergeable, mergeStateStatus) and the checks the base branch requires.
export const githubReviewersSchema = z.looseObject({
  requested: z.array(githubReviewerSchema),
  reviews: z.array(z.looseObject({ author: githubPersonSchema.nullable(), state: lowered, submittedAt: z.string().nullable() })),
  /** mergeable, conflicting or unknown. */
  mergeable: lowered.nullable(),
  /** clean, blocked, behind, dirty, draft, has_hooks, unstable or unknown. */
  mergeStateStatus: lowered.nullable(),
  reviewDecision: lowered.nullable(),
  requiredChecks: z.array(z.looseObject({ name: z.string(), state: githubCheckSchema.shape.state.catch('pending') })),
})

/** The review `megabrain github review` submits: a verdict, its summary and the inline comments on the diff. */
export type GithubReviewEvent = 'approve' | 'request-changes' | 'comment'
export interface GithubReviewComment {
  path: string
  line: number
  /** LEFT comments on the old side of the diff (a removed line), RIGHT on the new side. */
  side: 'LEFT' | 'RIGHT'
  body: string
}
export interface GithubReview {
  event: GithubReviewEvent
  body: string
  comments?: GithubReviewComment[]
}
export type GithubMergeMethod = 'merge' | 'squash' | 'rebase'

export type GithubRepository = z.infer<typeof githubRepositorySchema>
export type GithubOwner = z.infer<typeof githubOwnerSchema>
export type DiscoveredRepository = z.infer<typeof discoveredRepositorySchema>
export type GithubCheck = z.infer<typeof githubCheckSchema>
export type GithubPullRequest = z.infer<typeof githubPullRequestSchema>
export type GithubIssue = z.infer<typeof githubIssueSchema>
export type GithubPullRequestList = z.infer<typeof githubPullRequestListSchema>
export type GithubIssueList = z.infer<typeof githubIssueListSchema>
export type GithubDetail = z.infer<typeof githubDetailSchema>
export type GithubPullRequestFile = z.infer<typeof githubPullRequestFileSchema>
export type GithubPullRequestFilesPage = z.infer<typeof githubPullRequestFilesPageSchema>
export type GithubReviewThread = z.infer<typeof githubReviewThreadSchema>
export type GithubReviewer = z.infer<typeof githubReviewerSchema>
export type GithubReviewers = z.infer<typeof githubReviewersSchema>
export type GithubImage = z.infer<typeof githubImageSchema>
