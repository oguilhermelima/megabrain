import { describe, expect, test } from 'bun:test'
import { filterGroups, optionCount, selectionSummary, toggledValue, withUnknown, type PickGroup } from '@/components/multi-select-model'

const groups: PickGroup[] = [
  {
    label: 'claude',
    options: [
      { value: 'claude-opus-5-5', label: 'Opus 5.5', detail: 'claude-opus-5-5' },
      { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', detail: 'claude-sonnet-5-5' },
    ],
    older: [{ value: 'claude-opus-4-8', label: 'Opus 4.8', detail: 'claude-opus-4-8' }],
  },
  { label: 'codex', options: [{ value: 'gpt-6-luna', label: 'GPT-6 Luna', detail: 'gpt-6-luna' }] },
]
const models = 'models'

describe('selectionSummary', () => {
  test('nothing chosen reads as the any text', () => {
    expect(selectionSummary([], groups, models)).toBe('Any')
    expect(selectionSummary([], groups, models, 'Any model')).toBe('Any model')
  })

  test('one or two chosen read by name, in the order chosen', () => {
    expect(selectionSummary(['gpt-6-luna'], groups, models)).toBe('GPT-6 Luna')
    expect(selectionSummary(['claude-sonnet-5-5', 'claude-opus-5-5'], groups, models)).toBe('Sonnet 5.5, Opus 5.5')
  })

  test('a folded older option is named too', () => {
    expect(selectionSummary(['claude-opus-4-8'], groups, models)).toBe('Opus 4.8')
  })

  test('three or more read as a count', () => {
    expect(selectionSummary(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-luna'], groups, models)).toBe('3 models')
  })

  test('a value no group lists reads as itself', () => {
    expect(selectionSummary(['gpt-4'], groups, models)).toBe('gpt-4')
  })
})

describe('withUnknown', () => {
  test('keeps the groups as they are when every chosen value is listed', () => {
    expect(withUnknown(groups, ['claude-opus-4-8', 'gpt-6-luna'])).toBe(groups)
  })

  test('adds the unlisted chosen values in a group of their own', () => {
    const next = withUnknown(groups, ['gpt-6-luna', 'gpt-4', 'o3'])
    expect(next).toHaveLength(3)
    expect(next[2]).toEqual({ label: 'Not in the registry', options: [{ value: 'gpt-4', label: 'gpt-4' }, { value: 'o3', label: 'o3' }] })
  })
})

describe('filterGroups', () => {
  test('an empty or blank query keeps everything, folds included', () => {
    expect(filterGroups(groups, '')).toBe(groups)
    expect(filterGroups(groups, '   ')).toBe(groups)
  })

  test('matches the label in any case and opens the older options', () => {
    expect(filterGroups(groups, 'OPUS')).toEqual([
      {
        label: 'claude',
        options: [
          { value: 'claude-opus-5-5', label: 'Opus 5.5', detail: 'claude-opus-5-5' },
          { value: 'claude-opus-4-8', label: 'Opus 4.8', detail: 'claude-opus-4-8' },
        ],
      },
    ])
  })

  test('matches the id and drops groups left empty', () => {
    expect(filterGroups(groups, 'gpt-6')).toEqual([{ label: 'codex', options: [{ value: 'gpt-6-luna', label: 'GPT-6 Luna', detail: 'gpt-6-luna' }] }])
  })

  test('nothing matching leaves no groups', () => {
    expect(filterGroups(groups, 'grok')).toEqual([])
  })
})

test('optionCount counts folded options', () => {
  expect(optionCount(groups)).toBe(4)
})

test('toggledValue turns a value on at the end or off in place', () => {
  expect(toggledValue(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
  expect(toggledValue(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
})
