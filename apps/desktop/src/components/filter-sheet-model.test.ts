import { describe, expect, test } from 'bun:test'
import { activeCount, chipLabel, clearAll, isActive, updatedWithin, type SheetField } from '@/components/filter-sheet-model'

function fields() {
  const changes: string[] = []
  const label: SheetField = { kind: 'select', label: 'Label', value: 'bug', options: [{ value: '', label: 'Any label' }, { value: 'bug', label: 'bug' }], onChange: (value) => changes.push(`label=${value}`) }
  const state: SheetField = { kind: 'select', label: 'State', value: '', options: [{ value: '', label: 'Any state' }, { value: 'OPEN', label: 'Open' }], onChange: (value) => changes.push(`state=${value}`) }
  const drafts: SheetField = { kind: 'switch', label: 'Drafts only', on: true, onChange: (on) => changes.push(`drafts=${on}`) }
  const noStatus: SheetField = { kind: 'switch', label: 'Show No status', on: true, setting: true, onChange: (on) => changes.push(`noStatus=${on}`) }
  return { changes, all: [label, state, drafts, noStatus], label, state, drafts, noStatus }
}

describe('filter sheet', () => {
  test('a select is set when it leaves its first option; a switch when on', () => {
    const { label, state, drafts } = fields()
    expect(isActive(label)).toBe(true)
    expect(isActive(state)).toBe(false)
    expect(isActive(drafts)).toBe(true)
  })

  test('a setting switch is never counted as a filter', () => {
    const { all, noStatus } = fields()
    expect(isActive(noStatus)).toBe(false)
    expect(activeCount(all)).toBe(2)
  })

  test('a chip names the filter and the option chosen', () => {
    const { label, drafts } = fields()
    expect(chipLabel(label)).toBe('Label: bug')
    expect(chipLabel(drafts)).toBe('Drafts only')
  })

  test('clearing resets only the set filters and leaves settings alone', () => {
    const { all, changes } = fields()
    clearAll(all)
    expect(changes).toEqual(['label=', 'drafts=false'])
  })

  test('updated within counts days back from now; any time lets all through', () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    expect(updatedWithin('2026-10-18T00:00:00Z', '1', now)).toBe(true)
    expect(updatedWithin('2026-10-10T00:00:00Z', '7', now)).toBe(false)
    expect(updatedWithin('2020-01-01T00:00:00Z', '', now)).toBe(true)
    expect(updatedWithin('not a date', '30', now)).toBe(false)
  })
})
