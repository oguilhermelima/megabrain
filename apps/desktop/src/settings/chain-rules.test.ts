import { describe, expect, test } from 'bun:test'
import type { ChainStep } from '@/api/schema'
import {
  builderFromRule,
  effortsFor,
  emptyCondition,
  modelGroups,
  moveStepTo,
  parseRuleJson,
  ruleFromBuilder,
  ruleSummary,
  stepEdit,
  stepWithAgent,
  stepWithModel,
  validateRule,
  type Rule,
} from '@/settings/chain-rules'
import type { ModelInfo } from '@/settings/settings-model'

const models: ModelInfo[] = [
  { agent: 'claude', model: 'claude-opus-5-5', name: 'Opus 5.5', reasoning: { levels: ['low', 'medium', 'high'] } },
  { agent: 'claude', model: 'claude-sonnet-5', name: 'Sonnet 5', reasoning: { levels: ['low', 'medium', 'high'] } },
  { agent: 'codex', model: 'gpt-6-astra', name: 'astra 6', reasoning: { levels: ['low', 'medium', 'high', 'xhigh'] } },
  { agent: 'codex', model: 'gpt-6-luna', name: 'luna 6', reasoning: { levels: ['low', 'medium', 'high', 'xhigh'] } },
  { agent: 'agy', model: 'gemini-3.1-pro-high', reasoning: { levels: [] } },
]

const twoParents: Rule = {
  any: [
    { parentAgent: 'claude', parentModel: 'claude-opus-5-5', parentEffort: ['low', 'medium', 'high'] },
    { parentAgent: 'codex', parentModel: 'gpt-6-astra', parentEffort: ['medium', 'high'] },
  ],
}

describe('ruleSummary', () => {
  test('reads the contract example in one plain line', () => {
    expect(ruleSummary(twoParents, models)).toBe('When the parent is Claude Opus 5.5 (low, medium, high) or Codex astra 6 (medium, high), on any repo')
  })
  test('an old-style rule reads as before, with the repo scope', () => {
    expect(ruleSummary({ parentAgent: 'claude' }, models)).toBe('When the parent is Claude, on any repo')
  })
  test('an empty rule always applies', () => {
    expect(ruleSummary({}, models)).toBe('Always')
  })
  test('several agents read as alternatives', () => {
    expect(ruleSummary({ parentAgent: ['claude', 'codex'] }, models)).toBe('When the parent is Claude or Codex, on any repo')
  })
  test('a model missing from the registry shows its id', () => {
    expect(ruleSummary({ parentModel: 'gpt-7' }, models)).toBe('When the parent is gpt-7, on any repo')
  })
  test('repo, branch and label replace the any-repo scope', () => {
    expect(ruleSummary({ parentAgent: 'claude', repo: 'megabrain', branch: 'feat/*', label: 'docs*' }, models)).toBe(
      'When the parent is Claude, on repo megabrain, on branch feat/*, labelled docs*',
    )
  })
  test('usage and time read in words', () => {
    const rule: Rule = { all: [{ usage: { provider: 'codex', window: '5h', below: 95 } }, { time: { days: ['mon', 'fri'], from: '09:00', to: '18:00' } }] }
    expect(ruleSummary(rule, models)).toBe('When codex 5h usage is below 95% and on Mon, Fri from 09:00 to 18:00, on any repo')
  })
  test('usage between two bounds', () => {
    expect(ruleSummary({ usage: { provider: 'claude', window: 'weekly', above: 20, below: 80 } }, models)).toBe('When claude weekly usage is between 20% and 80%, on any repo')
  })
  test('not and nested groups are bracketed', () => {
    const rule: Rule = { all: [{ parentAgent: 'claude' }, { not: { any: [{ branch: 'main' }, { branch: 'release/*' }] } }] }
    expect(ruleSummary(rule, models)).toBe('When the parent is Claude and not (on branch main or on branch release/*), on any repo')
  })
})

describe('rule builder round trip', () => {
  const roundTrip = (rule: Rule) => ruleFromBuilder(builderFromRule(rule))
  const rules: Array<[string, Rule]> = [
    ['an empty rule', {}],
    ['an old-style single agent', { parentAgent: 'claude' }],
    ['an old-style rule with several fields', { parentAgent: 'codex', parentModel: 'gpt-6-luna', parentEffort: 'high' }],
    ['the contract example', twoParents],
    ['all of conditions', { all: [{ parentAgent: 'claude' }, { repo: ['megabrain', '~/Workspaces/*'], branch: 'feat/*' }] }],
    ['usage and time', { any: [{ usage: { provider: 'codex', window: 'weekly', above: 90 } }, { time: { days: ['sat', 'sun'] } }] }],
    ['one nested group', { all: [{ label: 'ui*' }, { any: [{ parentAgent: 'claude' }, { parentAgent: 'codex', parentEffort: ['medium', 'high'] }] }] }],
    ['a not at the top', { not: { parentAgent: 'agy' } }],
    ['deeper nesting kept as written', { any: [{ all: [{ parentAgent: 'claude' }, { any: [{ branch: 'a' }, { branch: 'b' }] }] }, { parentAgent: 'grok' }] }],
  ]
  for (const [name, rule] of rules) {
    test(`${name} survives builder and back`, () => {
      expect(roundTrip(rule)).toEqual(rule)
    })
  }

  test('an old-style rule opens as one group of one condition', () => {
    const builder = builderFromRule({ parentAgent: 'claude' })
    expect(builder.join).toBe('all')
    expect(builder.groups).toHaveLength(1)
    const group = builder.groups[0]
    expect(group?.kind).toBe('condition')
    if (group?.kind === 'condition') expect(group.condition.parentAgent).toEqual(['claude'])
  })
  test('the contract example opens as two condition groups joined by any', () => {
    const builder = builderFromRule(twoParents)
    expect(builder.join).toBe('any')
    expect(builder.groups.map((group) => group.kind)).toEqual(['condition', 'condition'])
  })
  test('one level of nesting is editable; deeper or not is read-only', () => {
    expect(builderFromRule({ all: [{ label: 'x' }, { any: [{ branch: 'a' }, { branch: 'b' }] }] }).groups.map((group) => group.kind)).toEqual(['condition', 'nested'])
    expect(builderFromRule({ any: [{ not: { branch: 'a' } }, { parentAgent: 'claude' }] }).groups.map((group) => group.kind)).toEqual(['raw', 'condition'])
    expect(builderFromRule({ any: [{ all: [{ any: [{ branch: 'a' }] }] }] }).groups.map((group) => group.kind)).toEqual(['raw'])
  })
  test('a condition with a field the app does not know stays read-only and intact', () => {
    const rule = { any: [{ parentAgent: 'claude', futureField: 'x' }, { parentAgent: 'codex' }] } as unknown as Rule
    expect(builderFromRule(rule).groups[0]?.kind).toBe('raw')
    expect(roundTrip(rule)).toEqual(rule)
  })
  test('emptied lists and blank fields drop out of the JSON', () => {
    const condition = { ...emptyCondition(), parentAgent: ['claude'], parentModel: [], repo: [''] }
    expect(ruleFromBuilder({ join: 'all', groups: [{ kind: 'condition', condition }] })).toEqual({ parentAgent: 'claude' })
  })
  test('an empty builder is the always rule', () => {
    expect(ruleFromBuilder({ join: 'any', groups: [] })).toEqual({})
  })
  test('a single group under any keeps the any', () => {
    expect(ruleFromBuilder({ join: 'any', groups: [{ kind: 'condition', condition: { ...emptyCondition(), parentAgent: ['claude'] } }] })).toEqual({ any: [{ parentAgent: 'claude' }] })
  })
})

describe('validateRule', () => {
  test('a valid rule has no issues', () => {
    expect(validateRule(twoParents, models)).toEqual([])
    expect(validateRule({}, models)).toEqual([])
  })
  test('an unknown effort names its path and model', () => {
    const rule = { any: [{ parentAgent: 'claude' }, { parentAgent: 'codex', parentModel: 'gpt-6-astra', parentEffort: ['high', 'ultra'] }] }
    expect(validateRule(rule, models)).toEqual([{ path: 'when.any[1].parentEffort', message: 'unknown effort "ultra" for gpt-6-astra' }])
  })
  test('an unknown field is reported', () => {
    expect(validateRule({ parentAgnt: 'claude' }, models)).toEqual([{ path: 'when.parentAgnt', message: 'unknown field' }])
  })
  test('a group must be a list', () => {
    expect(validateRule({ any: { parentAgent: 'claude' } }, models)).toEqual([{ path: 'when.any', message: 'expected a list of rules' }])
  })
  test('a group key cannot share an object with a condition', () => {
    expect(validateRule({ any: [], parentAgent: 'claude' }, models)).toEqual([{ path: 'when', message: 'all, any and not stand alone in their object' }])
  })
  test('usage and time fields are checked', () => {
    expect(validateRule({ usage: { provider: 'codex', window: 'daily', below: 120 }, time: { days: ['funday'], from: '9am' } }, models)).toEqual([
      { path: 'when.usage.window', message: 'expected "5h" or "weekly"' },
      { path: 'when.usage.below', message: 'expected a percent from 0 to 100' },
      { path: 'when.time.days', message: 'unknown day "funday"' },
      { path: 'when.time.from', message: 'expected HH:MM' },
    ])
  })
  test('a value must be a string or a list of strings', () => {
    expect(validateRule({ branch: 3 }, models)).toEqual([{ path: 'when.branch', message: 'expected a string or a list of strings' }])
  })
  test('parseRuleJson reports broken JSON instead of throwing', () => {
    const parsed = parseRuleJson('{"any": [')
    expect('issues' in parsed && parsed.issues[0]?.path).toBe('when')
    expect(parseRuleJson('{"parentAgent":"claude"}')).toEqual({ rule: { parentAgent: 'claude' } })
  })
})

describe('step editing', () => {
  const luna: ChainStep = { agent: 'codex', model: 'gpt-6-luna', effort: 'medium', until: { usedPercent: 95, window: '5h' } }

  test('changing the agent picks its first model and that model first effort', () => {
    expect(stepWithAgent(luna, 'claude', models)).toEqual({ agent: 'claude', model: 'claude-opus-5-5', effort: 'low', until: { usedPercent: 95, window: '5h' } })
  })
  test('changing the model keeps an effort it still offers', () => {
    expect(stepWithModel(luna, 'gpt-6-astra', models).effort).toBe('medium')
  })
  test('changing to a model without that effort takes its first one, or none', () => {
    expect(stepWithModel({ agent: 'codex', model: 'gpt-6-luna', effort: 'xhigh' }, 'gpt-6-astra', models).effort).toBe('xhigh')
    expect(stepWithAgent(luna, 'agy', models)).toEqual({ agent: 'agy', model: 'gemini-3.1-pro-high', until: { usedPercent: 95, window: '5h' } })
  })
  test('an unchanged step has nothing to send', () => {
    expect(stepEdit(luna, { ...luna })).toEqual({ kind: 'none' })
  })
  test('the patch carries only what changed', () => {
    expect(stepEdit(luna, { ...luna, effort: 'high' })).toEqual({ kind: 'patch', patch: { effort: 'high' } })
    expect(stepEdit(luna, { ...luna, agent: 'claude', model: 'claude-sonnet-5' })).toEqual({ kind: 'patch', patch: { agent: 'claude', model: 'claude-sonnet-5' } })
  })
  test('removing until or when sends null; adding them sends the value', () => {
    const { until: _until, ...withoutUntil } = luna
    expect(stepEdit(luna, withoutUntil)).toEqual({ kind: 'patch', patch: { until: null } })
    expect(stepEdit(luna, { ...luna, when: { usage: { provider: 'codex', window: '5h', below: 90 } } })).toEqual({
      kind: 'patch',
      patch: { when: { usage: { provider: 'codex', window: '5h', below: 90 } } },
    })
    expect(stepEdit({ ...luna, when: { parentAgent: 'claude' } }, luna)).toEqual({ kind: 'patch', patch: { when: null } })
  })
  test('clearing the effort has no flag, so the whole chain is saved', () => {
    const { effort: _effort, ...withoutEffort } = luna
    expect(stepEdit(luna, withoutEffort)).toEqual({ kind: 'replace' })
  })
  test('moveStepTo drops a step at a new position', () => {
    const steps: ChainStep[] = [{ agent: 'a' }, { agent: 'b' }, { agent: 'c' }]
    expect(moveStepTo(steps, 0, 2).map((step) => step.agent)).toEqual(['b', 'c', 'a'])
    expect(moveStepTo(steps, 2, 0).map((step) => step.agent)).toEqual(['c', 'a', 'b'])
    expect(moveStepTo(steps, 1, 1)).toBe(steps)
    expect(moveStepTo(steps, 0, 9)).toBe(steps)
  })
})

describe('condition dropdowns', () => {
  const registry: ModelInfo[] = [
    { agent: 'claude', model: 'claude-opus-5-5', name: 'Opus 5.5', reasoning: { levels: ['low', 'medium', 'high', 'max'] } },
    { agent: 'claude', model: 'claude-opus-4-8', name: 'Opus 4.8', reasoning: { levels: ['low', 'medium', 'high'] } },
    { agent: 'claude', model: 'claude-sonnet-5-5', name: 'Sonnet 5.5', reasoning: { levels: ['low', 'medium', 'high'] } },
    { agent: 'codex', model: 'gpt-5.5', name: 'GPT-5.5', reasoning: { levels: ['low', 'medium'] } },
    { agent: 'codex', model: 'gpt-6-luna', name: 'GPT-6 Luna', reasoning: { levels: ['medium', 'high', 'xhigh'] } },
  ]

  test('models group by agent in registry order, current first and older folded', () => {
    expect(modelGroups(registry, [])).toEqual([
      {
        label: 'claude',
        options: [
          { value: 'claude-opus-5-5', label: 'Opus 5.5', detail: 'claude-opus-5-5' },
          { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', detail: 'claude-sonnet-5-5' },
        ],
        older: [{ value: 'claude-opus-4-8', label: 'Opus 4.8', detail: 'claude-opus-4-8' }],
      },
      // No current flag: the newest version of the family is current.
      { label: 'codex', options: [{ value: 'gpt-6-luna', label: 'GPT-6 Luna', detail: 'gpt-6-luna' }], older: [{ value: 'gpt-5.5', label: 'GPT-5.5', detail: 'gpt-5.5' }] },
    ])
  })

  test('chosen agents keep only their groups', () => {
    expect(modelGroups(registry, ['codex']).map((group) => group.label)).toEqual(['codex'])
    expect(modelGroups(registry, ['grok'])).toEqual([])
  })

  test('effort lists the levels of the chosen models, else of the chosen agents', () => {
    expect(effortsFor(registry, [], ['claude-sonnet-5-5'])).toEqual(['low', 'medium', 'high'])
    expect(effortsFor(registry, [], ['claude-sonnet-5-5', 'gpt-6-luna'])).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortsFor(registry, ['codex'], [])).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortsFor(registry, [], [])).toEqual(['low', 'medium', 'high', 'max', 'xhigh'])
  })

  test('an id two agents list shows once, under the first agent', () => {
    const shared: ModelInfo[] = [
      { agent: 'agy', model: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', status: 'deprecated', reasoning: { levels: [] } },
      { agent: 'agy', model: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', reasoning: { levels: ['low', 'medium', 'high'] } },
      { agent: 'claude', model: 'claude-sonnet-4-6', reasoning: { levels: ['low', 'high'] } },
      { agent: 'claude', model: 'claude-sonnet-5-5', name: 'Sonnet 5.5', reasoning: { levels: ['low', 'high'] } },
    ]
    const ids = modelGroups(shared, []).flatMap((group) => [...group.options, ...(group.older ?? [])].map((option) => option.value))
    expect(ids).toEqual(['gemini-3.8-flash', 'claude-sonnet-4-6', 'claude-sonnet-5-5'])
    // Chosen alone, an agent still lists the shared id.
    expect(modelGroups(shared, ['claude'])[0]?.older).toEqual([{ value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', detail: 'claude-sonnet-4-6' }])
  })

  test('every model reads as family and version, the id beside it', () => {
    const named: ModelInfo[] = [
      { agent: 'grok', model: 'grok-4.7', name: '4.7', reasoning: { levels: [] } },
      { agent: 'claude', model: 'claude-opus-5-5', reasoning: { levels: [] } },
      { agent: 'codex', model: 'gpt-6-luna', name: 'gpt-6-luna', reasoning: { levels: [] } },
    ]
    expect(modelGroups(named, []).map((group) => group.options[0])).toEqual([
      { value: 'grok-4.7', label: 'Grok 4.7', detail: 'grok-4.7' },
      { value: 'claude-opus-5-5', label: 'Opus 5.5', detail: 'claude-opus-5-5' },
      { value: 'gpt-6-luna', label: 'GPT-6 Luna', detail: 'gpt-6-luna' },
    ])
    expect(ruleSummary({ parentModel: ['grok-4.7', 'claude-opus-5-5'] }, named)).toBe('When the parent is Grok 4.7 or Claude Opus 5.5, on any repo')
  })
})
