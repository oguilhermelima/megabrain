import type { GithubActionRun, GithubActionRunDetail, GithubActionRuns } from '@/api/schema'

// What the Actions pages compute from `megabrain github runs|run|run-log --json`: how a run, job or
// step draws, how long it took, the newest run of each branch, the filters, how pages of runs join,
// what can be done to a run, and a job log as readable lines with its first error.

export type GithubActionJob = GithubActionRunDetail['jobs'][number]
export type GithubActionStep = GithubActionJob['steps'][number]
export type GithubActionWorkflow = GithubActionRuns['workflows'][number]
export type DispatchInput = GithubActionWorkflow['inputs'][number]

/** One icon and colour per state: green, red, amber while running or waiting, grey otherwise. */
export type RunVisual = 'success' | 'failure' | 'running' | 'queued' | 'waiting' | 'cancelled' | 'skipped' | 'neutral'

const finished: Record<string, RunVisual> = {
  success: 'success',
  failure: 'failure',
  timed_out: 'failure',
  startup_failure: 'failure',
  cancelled: 'cancelled',
  skipped: 'skipped',
  stale: 'skipped',
  action_required: 'waiting',
  neutral: 'neutral',
}

/** A run, job or step by its status and conclusion; a status GitHub adds later reads as queued. */
export function runVisual(item: { status: string; conclusion: string | null }): RunVisual {
  if (item.status === 'in_progress') return 'running'
  if (item.status === 'waiting') return 'waiting'
  if (item.status !== 'completed') return 'queued'
  return finished[item.conclusion ?? ''] ?? 'neutral'
}

export const runLabels: Record<RunVisual, string> = {
  success: 'Success',
  failure: 'Failed',
  running: 'In progress',
  queued: 'Queued',
  waiting: 'Waiting',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  neutral: 'Neutral',
}

export function isLive(item: { status: string }): boolean {
  return item.status !== 'completed'
}

/** Milliseconds from start to end, or to now while it runs; null without a readable start. */
export function elapsedMs(startedAt: string | null, endedAt: string | null, now: number): number | null {
  if (startedAt === null) return null
  const start = Date.parse(startedAt)
  const end = endedAt === null ? now : Date.parse(endedAt)
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return Math.max(0, end - start)
}

/** A run lasts from its start (its creation before it starts) to its last update, or to now while live. */
export function runDuration(run: GithubActionRun, now: number): number | null {
  return elapsedMs(run.startedAt ?? run.createdAt, isLive(run) ? null : run.updatedAt, now)
}

export function jobDuration(job: Pick<GithubActionJob, 'status' | 'startedAt' | 'completedAt'>, now: number): number | null {
  return elapsedMs(job.startedAt, isLive(job) ? null : job.completedAt, now)
}

/** 12s, 3m 12s, 1h 4m: the two largest units, a zero second part left out. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
}

export interface JobSummary {
  total: number
  counts: Partial<Record<RunVisual, number>>
}

export function jobSummary(jobs: { status: string; conclusion: string | null }[]): JobSummary {
  const counts: Partial<Record<RunVisual, number>> = {}
  for (const job of jobs) {
    const visual = runVisual(job)
    counts[visual] = (counts[visual] ?? 0) + 1
  }
  return { total: jobs.length, counts }
}

/** The newest run of each branch by creation time, so a re-run of an old run does not win. */
export function latestRunsByBranch(runs: GithubActionRun[]): Map<string, GithubActionRun> {
  const latest = new Map<string, GithubActionRun>()
  for (const run of runs) {
    const known = latest.get(run.branch)
    if (known === undefined || Date.parse(run.createdAt) > Date.parse(known.createdAt)) latest.set(run.branch, run)
  }
  return latest
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort((left, right) => left.localeCompare(right))

/** The workflows to filter by (the repository's, then any others the runs name) and the branches the runs touch. */
export function runFilterOptions(runs: GithubActionRun[], workflows: GithubActionWorkflow[]): { workflows: string[]; branches: string[] } {
  const listed = sorted(workflows.map((workflow) => workflow.name))
  const others = sorted(runs.map((run) => run.name).filter((name) => !listed.includes(name)))
  return { workflows: [...listed, ...others], branches: sorted(runs.map((run) => run.branch)) }
}

/** The loaded runs, the cursor after them, the repository's workflows and when the first page was read. */
export interface RunsPage {
  runs: GithubActionRun[]
  workflows: GithubActionWorkflow[]
  next: string | null
  fetchedAt: string
}

function mergeRuns(front: GithubActionRun[], back: GithubActionRun[]): GithubActionRun[] {
  const listed = new Set(front.map((run) => run.id))
  return [...front, ...back.filter((run) => !listed.has(run.id))]
}

/**
 * More appends the next page below and carries its cursor; a refresh puts the first page on top,
 * replacing the old copies of its runs, and keeps the pages below and their cursor. A run is one id
 * (run numbers repeat across workflows).
 */
export function joinRuns(loaded: RunsPage | null, page: RunsPage, how: 'refresh' | 'more'): RunsPage {
  if (loaded === null) return page
  if (how === 'more') return { ...loaded, runs: mergeRuns(loaded.runs, page.runs), next: page.next }
  return { runs: mergeRuns(page.runs, loaded.runs), workflows: page.workflows, next: loaded.next, fetchedAt: page.fetchedAt }
}

/** A live run can be cancelled; a finished one runs again, a failed one also only its failed jobs. */
export function runActions(run: Pick<GithubActionRun, 'status' | 'conclusion'>): { rerun: boolean; rerunFailed: boolean; cancel: boolean } {
  if (isLive(run)) return { rerun: false, rerunFailed: false, cancel: true }
  return { rerun: true, rerunFailed: runVisual(run) === 'failure', cancel: false }
}

const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /

/** A job log as lines without colours or the timestamp GitHub puts before each. */
export function logLines(text: string): string[] {
  if (text === '') return []
  const lines = text.replace(ansi, '').split(/\r\n|\n|\r/)
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line) => line.replace(timestamp, ''))
}

export type LogTone = 'error' | 'warning' | 'group' | 'command' | 'muted' | 'plain'

const markers: [string, LogTone][] = [
  ['##[error]', 'error'],
  ['##[warning]', 'warning'],
  ['##[group]', 'group'],
  ['##[endgroup]', 'muted'],
  ['[command]', 'command'],
]

/** A line's tone from GitHub's workflow markers, with the marker taken off. */
export function logLine(line: string): { tone: LogTone; text: string } {
  for (const [marker, tone] of markers) if (line.startsWith(marker)) return { tone, text: line.slice(marker.length) }
  return { tone: 'plain', text: line }
}

// A word that says something failed, unless a zero counts it ("0 errors", "0 fail"), and a non-zero exit.
const failure = /(?<!\b0 )\b(?:error|errors|failed|fail|failure)\b|\bERR!|\bexit code [1-9]/i

/** The line to jump to: GitHub's first error annotation, else the first line that reads like a failure. */
export function firstErrorLine(lines: string[]): number | null {
  const annotated = lines.findIndex((line) => line.startsWith('##[error]'))
  if (annotated !== -1) return annotated
  const found = lines.findIndex((line) => failure.test(line))
  return found === -1 ? null : found
}

export function searchLog(lines: string[], query: string): number[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  return lines.flatMap((line, index) => (line.toLowerCase().includes(needle) ? [index] : []))
}

/** The Run workflow form's first values: each input's default; a choice without one its first option, a boolean false. */
export function dispatchValues(inputs: DispatchInput[]): Record<string, string> {
  return Object.fromEntries(
    inputs.map((input) => {
      if (input.default !== null) return [input.name, String(input.default)]
      if (input.type === 'boolean') return [input.name, 'false']
      return [input.name, input.type === 'choice' ? (input.options?.[0] ?? '') : '']
    }),
  )
}

export type DispatchResult = { ok: true; inputs: Record<string, string> } | { ok: false; missing: string[] } | { ok: false; invalid: string[] }

/** What `workflow-dispatch --inputs` gets: every filled value as text; refused while a required one is empty or a number is not one. */
export function dispatchInputs(inputs: DispatchInput[], values: Record<string, string>): DispatchResult {
  const value = (input: DispatchInput) => (values[input.name] ?? '').trim()
  const missing = inputs.filter((input) => input.required && value(input) === '').map((input) => input.name)
  if (missing.length > 0) return { ok: false, missing }
  const invalid = inputs.filter((input) => input.type === 'number' && value(input) !== '' && !Number.isFinite(Number(value(input)))).map((input) => input.name)
  if (invalid.length > 0) return { ok: false, invalid }
  return { ok: true, inputs: Object.fromEntries(inputs.filter((input) => value(input) !== '').map((input) => [input.name, value(input)])) }
}
