import { describe, expect, test } from 'bun:test'
import type { GithubActionRun } from '@/api/schema'
import {
  dispatchInputs,
  dispatchValues,
  elapsedMs,
  firstErrorLine,
  formatDuration,
  isLive,
  jobSummary,
  joinRuns,
  latestRunsByBranch,
  logLine,
  logLines,
  runActions,
  runDuration,
  runFilterOptions,
  runVisual,
  searchLog,
  type DispatchInput,
  type RunsPage,
} from '@/github/actions-model'

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 17, 12, minutes)).toISOString()
const now = Date.parse(at(30))

function run(id: number, patch: Partial<GithubActionRun> = {}): GithubActionRun {
  return {
    id,
    name: 'CI',
    title: `Run ${id}`,
    event: 'push',
    branch: 'main',
    sha: 'abc1234',
    status: 'completed',
    conclusion: 'success',
    number: id,
    attempt: 1,
    actor: 'operator',
    createdAt: at(0),
    updatedAt: at(5),
    startedAt: at(1),
    url: `https://github.com/operator/megabrain/actions/runs/${id}`,
    prNumber: null,
    ...patch,
  }
}

const page = (runs: GithubActionRun[], next: string | null, fetchedAt = at(0)): RunsPage => ({ runs, workflows: [], next, fetchedAt })

describe('runVisual', () => {
  test.each([
    ['in_progress', null, 'running'],
    ['queued', null, 'queued'],
    ['requested', null, 'queued'],
    ['pending', null, 'queued'],
    ['waiting', null, 'waiting'],
    ['completed', 'success', 'success'],
    ['completed', 'failure', 'failure'],
    ['completed', 'timed_out', 'failure'],
    ['completed', 'startup_failure', 'failure'],
    ['completed', 'cancelled', 'cancelled'],
    ['completed', 'skipped', 'skipped'],
    ['completed', 'stale', 'skipped'],
    ['completed', 'action_required', 'waiting'],
    ['completed', 'neutral', 'neutral'],
    ['completed', null, 'neutral'],
  ] as const)('%s with %s draws as %s', (status, conclusion, visual) => {
    expect(runVisual({ status, conclusion })).toBe(visual)
  })

  test('an unknown status that has not finished is queued, and an unknown conclusion neutral', () => {
    expect(runVisual({ status: 'something_new', conclusion: null })).toBe('queued')
    expect(runVisual({ status: 'completed', conclusion: 'something_new' })).toBe('neutral')
  })
})

describe('isLive', () => {
  test('only a run that has not completed is live', () => {
    expect(isLive({ status: 'in_progress' })).toBe(true)
    expect(isLive({ status: 'queued' })).toBe(true)
    expect(isLive({ status: 'waiting' })).toBe(true)
    expect(isLive({ status: 'completed' })).toBe(false)
  })
})

describe('durations', () => {
  test('elapsedMs measures start to end, or start to now when not ended', () => {
    expect(elapsedMs(at(1), at(4), now)).toBe(3 * 60_000)
    expect(elapsedMs(at(10), null, now)).toBe(20 * 60_000)
  })

  test('elapsedMs is null without a start or with a date it cannot read, and never negative', () => {
    expect(elapsedMs(null, at(4), now)).toBeNull()
    expect(elapsedMs('not a date', at(4), now)).toBeNull()
    expect(elapsedMs(at(5), at(4), now)).toBe(0)
  })

  test('a finished run lasts from its start to its last update', () => {
    expect(runDuration(run(1, { startedAt: at(1), updatedAt: at(6) }), now)).toBe(5 * 60_000)
  })

  test('a run without a start time counts from its creation', () => {
    expect(runDuration(run(1, { startedAt: null, createdAt: at(0), updatedAt: at(2) }), now)).toBe(2 * 60_000)
  })

  test('a live run lasts until now, whatever its last update says', () => {
    expect(runDuration(run(1, { status: 'in_progress', conclusion: null, startedAt: at(20), updatedAt: at(21) }), now)).toBe(10 * 60_000)
  })

  test.each([
    [null, ''],
    [0, '0s'],
    [400, '0s'],
    [12_000, '12s'],
    [59_999, '59s'],
    [60_000, '1m'],
    [192_000, '3m 12s'],
    [3_600_000, '1h'],
    [3_840_000, '1h 4m'],
    [3_845_000, '1h 4m'],
    [90_000_000, '25h'],
  ] as const)('formatDuration(%p) is %p', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })
})

describe('jobSummary', () => {
  test('counts the jobs by how they draw, and a total', () => {
    const summary = jobSummary([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
      { status: 'completed', conclusion: 'failure' },
      { status: 'in_progress', conclusion: null },
      { status: 'completed', conclusion: 'skipped' },
    ])
    expect(summary.total).toBe(5)
    expect(summary.counts).toEqual({ success: 1, failure: 2, running: 1, skipped: 1 })
  })

  test('no jobs is an empty summary', () => {
    expect(jobSummary([])).toEqual({ total: 0, counts: {} })
  })
})

describe('latestRunsByBranch', () => {
  test('keeps the newest run of each branch by creation time, whatever the order', () => {
    const latest = latestRunsByBranch([
      run(1, { branch: 'main', createdAt: at(1) }),
      run(2, { branch: 'feat/a', createdAt: at(3) }),
      run(3, { branch: 'main', createdAt: at(9) }),
      run(4, { branch: 'feat/a', createdAt: at(2) }),
    ])
    expect(latest.get('main')?.id).toBe(3)
    expect(latest.get('feat/a')?.id).toBe(2)
    expect(latest.size).toBe(2)
  })

  test('a re-run keeps its creation time, so the newer attempt of the same run does not beat a newer run', () => {
    const latest = latestRunsByBranch([run(1, { createdAt: at(1), updatedAt: at(29), attempt: 2 }), run(2, { createdAt: at(5), updatedAt: at(6) })])
    expect(latest.get('main')?.id).toBe(2)
  })
})

describe('runFilterOptions', () => {
  test('lists every workflow once (the listed ones first, sorted) and every branch the runs touch, sorted', () => {
    const options = runFilterOptions([run(1, { name: 'Release', branch: 'main' }), run(2, { name: 'CI', branch: 'feat/b' }), run(3, { name: 'Docs', branch: 'feat/a' })], [
      { id: 2, name: 'Release', path: '.github/workflows/release.yml', state: 'active', dispatchable: true, inputs: [] },
      { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active', dispatchable: false, inputs: [] },
    ])
    expect(options.workflows).toEqual(['CI', 'Release', 'Docs'])
    expect(options.branches).toEqual(['feat/a', 'feat/b', 'main'])
  })
})

describe('joinRuns', () => {
  test('more appends the next page below, without the runs already listed, and carries its cursor', () => {
    const joined = joinRuns(page([run(3), run(2)], '30'), page([run(2), run(1)], null), 'more')
    expect(joined.runs.map((item) => item.id)).toEqual([3, 2, 1])
    expect(joined.next).toBeNull()
  })

  test('a refresh puts the first page on top with its fresh copies and keeps the pages below and their cursor', () => {
    const loaded = page([run(3, { status: 'in_progress', conclusion: null }), run(2), run(1)], '60', at(0))
    const joined = joinRuns(loaded, page([run(4), run(3)], '30', at(9)), 'refresh')
    expect(joined.runs.map((item) => item.id)).toEqual([4, 3, 2, 1])
    expect(joined.runs[1]?.status).toBe('completed')
    expect(joined.next).toBe('60')
    expect(joined.fetchedAt).toBe(at(9))
  })

  test('the first read is the page itself', () => {
    const first = page([run(1)], null)
    expect(joinRuns(null, first, 'refresh')).toEqual(first)
  })

  test('two runs that share a run number in different workflows both stay', () => {
    const joined = joinRuns(page([run(10, { number: 5, name: 'CI' })], '30'), page([run(11, { number: 5, name: 'Docs' })], null), 'more')
    expect(joined.runs).toHaveLength(2)
  })
})

describe('runActions', () => {
  test('a live run can only be cancelled', () => {
    expect(runActions(run(1, { status: 'in_progress', conclusion: null }))).toEqual({ rerun: false, rerunFailed: false, cancel: true })
  })

  test('a failed run can run again, all of it or only its failed jobs', () => {
    expect(runActions(run(1, { conclusion: 'failure' }))).toEqual({ rerun: true, rerunFailed: true, cancel: false })
    expect(runActions(run(1, { conclusion: 'timed_out' }))).toEqual({ rerun: true, rerunFailed: true, cancel: false })
  })

  test('a run that passed or was cancelled can only run again in full', () => {
    expect(runActions(run(1, { conclusion: 'success' }))).toEqual({ rerun: true, rerunFailed: false, cancel: false })
    expect(runActions(run(1, { conclusion: 'cancelled' }))).toEqual({ rerun: true, rerunFailed: false, cancel: false })
  })
})

describe('logLines', () => {
  test('splits on any line ending and drops the empty line after the last newline', () => {
    expect(logLines('one\r\ntwo\nthree\n')).toEqual(['one', 'two', 'three'])
  })

  test('strips ANSI colours and GitHub timestamps at the start of a line', () => {
    expect(logLines('2026-10-17T12:00:01.1234567Z \u001b[31mfailed\u001b[0m\n2026-10-17T12:00:02.0000000Z ok')).toEqual(['failed', 'ok'])
  })

  test('keeps a timestamp that is not at the start of the line', () => {
    expect(logLines('built at 2026-10-17T12:00:01Z')).toEqual(['built at 2026-10-17T12:00:01Z'])
  })

  test('an empty log has no lines', () => {
    expect(logLines('')).toEqual([])
  })
})

describe('logLine', () => {
  test.each([
    ['##[error]Process completed with exit code 1.', 'error', 'Process completed with exit code 1.'],
    ['##[warning]Node 16 is deprecated', 'warning', 'Node 16 is deprecated'],
    ['##[group]Run bun test', 'group', 'Run bun test'],
    ['##[endgroup]', 'muted', ''],
    ['[command]/usr/bin/git checkout', 'command', '/usr/bin/git checkout'],
    ['plain output', 'plain', 'plain output'],
  ] as const)('%p is %s', (line, tone, text) => {
    expect(logLine(line)).toEqual({ tone, text })
  })
})

describe('firstErrorLine', () => {
  test('a GitHub error annotation wins over an earlier line that only mentions an error', () => {
    expect(firstErrorLine(['Run tests', 'error: something odd', 'more', '##[error]Process completed with exit code 1.'])).toBe(3)
  })

  test('without an annotation, the first line that reads like a failure', () => {
    expect(firstErrorLine(['Run tests', '42 pass', '(fail) adds two numbers', 'Error: expected 2'])).toBe(2)
    expect(firstErrorLine(['ok', 'Process exited with exit code 2'])).toBe(1)
    expect(firstErrorLine(['ok', 'npm ERR! missing script'])).toBe(1)
  })

  test('counts of zero errors and words that only contain error are not failures', () => {
    expect(firstErrorLine(['0 errors, 0 warnings', 'stderr redirected', 'terrorform plan', 'exit code 0', '0 fail'])).toBeNull()
  })

  test('a clean log has none', () => {
    expect(firstErrorLine(['all good'])).toBeNull()
    expect(firstErrorLine([])).toBeNull()
  })
})

describe('searchLog', () => {
  test('finds every line that contains the query, ignoring case', () => {
    expect(searchLog(['Install', 'run TESTS', 'tests passed', 'done'], 'tests')).toEqual([1, 2])
  })

  test('an empty or blank query finds nothing', () => {
    expect(searchLog(['a', 'b'], '')).toEqual([])
    expect(searchLog(['a', 'b'], '   ')).toEqual([])
  })
})

describe('workflow dispatch inputs', () => {
  const inputs: DispatchInput[] = [
    { name: 'suite', description: 'Which tests', required: true, type: 'string', default: 'smoke' },
    { name: 'browser', description: null, required: false, type: 'choice', default: null, options: ['chromium', 'webkit'] },
    { name: 'debug', description: null, required: false, type: 'boolean', default: false },
    { name: 'retries', description: null, required: false, type: 'number', default: 1 },
    { name: 'note', description: null, required: false, type: 'string', default: null },
    { name: 'target', description: null, required: true, type: 'environment', default: null },
  ]

  test('the form starts from each default; a choice without one takes its first option, a boolean false', () => {
    expect(dispatchValues(inputs)).toEqual({ suite: 'smoke', browser: 'chromium', debug: 'false', retries: '1', note: '', target: '' })
  })

  test('sends every filled value as text and leaves out empty optional ones', () => {
    const result = dispatchInputs(inputs, { ...dispatchValues(inputs), debug: 'true', target: 'staging' })
    expect(result).toEqual({ ok: true, inputs: { suite: 'smoke', browser: 'chromium', debug: 'true', retries: '1', target: 'staging' } })
  })

  test('a required input left empty, or only spaces, is named and nothing is sent', () => {
    expect(dispatchInputs(inputs, { ...dispatchValues(inputs), suite: '  ' })).toEqual({ ok: false, missing: ['suite', 'target'] })
  })

  test('a number input that is not a number is refused', () => {
    expect(dispatchInputs(inputs, { ...dispatchValues(inputs), target: 'prod', retries: 'two' })).toEqual({ ok: false, invalid: ['retries'] })
  })

  test('a workflow without inputs sends none', () => {
    expect(dispatchValues([])).toEqual({})
    expect(dispatchInputs([], {})).toEqual({ ok: true, inputs: {} })
  })
})
