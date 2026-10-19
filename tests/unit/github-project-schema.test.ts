import { describe, expect, test } from 'bun:test'
import { normalizeProjectItem, normalizeProjectViews, normalizeProjectFields } from '../../src/cli/commands/github/projects.js'

describe('GitHub project view and field normalization', () => {
  test('normalizes view configuration including grouping, sorting and visible fields', () => {
    expect(normalizeProjectViews([{ id: 'V1', number: 1, name: 'Board', layout: 'BOARD_LAYOUT', filter: 'status:Ready', groupByFields: { nodes: [{ id: 'F1', name: 'Status' }] }, verticalGroupByFields: { nodes: [] }, sortByFields: { nodes: [{ direction: 'ASC', field: { id: 'F1', name: 'Status' } }] }, configuration: { visibleFields: { nodes: [{ id: 'F1', name: 'Status' }] } } }])).toMatchObject([{ id: 'V1', groupByFields: [{ id: 'F1', name: 'Status' }], visibleFields: [{ id: 'F1', name: 'Status' }] }])
  })
  test('normalizes field options, iterations, and typed item field values', () => {
    expect(normalizeProjectFields([{ __typename: 'ProjectV2SingleSelectField', id: 'F1', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'O1', name: 'Ready', color: 'GREEN', description: '' }] }, { __typename: 'ProjectV2IterationField', id: 'F2', name: 'Sprint', dataType: 'ITERATION', configuration: { iterations: [{ id: 'I1', title: 'Sprint 1', startDate: '2026-10-01', duration: 14 }] } }])).toHaveLength(2)
    expect(normalizeProjectItem({ id: 'I1', isArchived: true, updatedAt: '2026-10-01', content: { __typename: 'DraftIssue', title: 'Draft' }, fieldValues: { nodes: [{ __typename: 'ProjectV2ItemFieldNumberValue', number: 3, field: { name: 'Estimate' } }] } })).toMatchObject({ isArchived: true, fieldValues: [{ kind: 'number', field: 'Estimate', value: 3 }] })
  })
})
