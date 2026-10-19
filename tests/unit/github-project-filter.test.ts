import { describe, expect, test } from 'bun:test'
import { evaluateProjectFilter } from '../../src/cli/commands/github/project-filter.js'

const items = [
  { id: 'I1', title: 'Café polish', type: 'ISSUE', state: 'OPEN', repository: 'cantospace/app', status: 'Ready', assignees: [{ login: 'me' }], labels: [{ name: 'Bug' }], fields: { Estimate: 5, Updated: '2026-10-18' } },
  { id: 'I2', title: 'Docs', type: 'PULL_REQUEST', state: 'MERGED', repository: 'other/repo', status: 'Blocked', assignees: [], labels: [{ name: 'bug' }], fields: { Estimate: 2, Updated: '2026-10-01' } },
  { id: 'I3', title: 'Draft task', type: 'DRAFT_ISSUE', state: null, repository: null, status: null, assignees: [], labels: [], fields: {} },
] as const

describe('GitHub project filters', () => {
  test('matches case insensitive fields, OR values, negation, and accents', () => {
    expect(evaluateProjectFilter('status:ready,blocked', items).items.map((i) => i.id)).toEqual(['I1', 'I2'])
    expect(evaluateProjectFilter('-status:blocked', items).items.map((i) => i.id)).toEqual(['I1', 'I3'])
    expect(evaluateProjectFilter('title:"café polish"', items).items.map((i) => i.id)).toEqual(['I1'])
  })
  test('handles presence, content kind, assignee, label, repository and title text', () => {
    expect(evaluateProjectFilter('no:status', items).items.map((i) => i.id)).toEqual(['I3'])
    expect(evaluateProjectFilter('has:assignee is:open assignee:@me', items).items.map((i) => i.id)).toEqual(['I1'])
    expect(evaluateProjectFilter('is:pr repo:other/repo label:bug docs', items).items.map((i) => i.id)).toEqual(['I2'])
    expect(evaluateProjectFilter('is:draft', items).items.map((i) => i.id)).toEqual(['I3'])
  })
  test('handles numeric and relative date comparisons and preserves unknown qualifiers as warnings', () => {
    expect(evaluateProjectFilter('estimate:>3', items).items.map((i) => i.id)).toEqual(['I1'])
    expect(evaluateProjectFilter('updated:>@today-7d', items, { today: '2026-10-19' }).items.map((i) => i.id)).toEqual(['I1'])
    expect(evaluateProjectFilter('bogus:value', items).warnings).toContain('bogus:value')
  })
})
