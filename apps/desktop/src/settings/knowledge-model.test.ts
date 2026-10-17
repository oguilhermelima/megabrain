import { describe, expect, test } from 'bun:test'
import { allOn, effectiveToggles, inEffect, inherited, parseKnowledgeSettings, resetProjectToggle, serialiseKnowledgeSettings, toggleKeys, withDefault, withProjectToggle, type KnowledgeSettings } from '@/settings/knowledge-model'

const saved = (projects: KnowledgeSettings['projects'] = {}, defaults: Partial<KnowledgeSettings['defaults']> = {}): KnowledgeSettings => ({ defaults: { ...allOn, ...defaults }, projects })

describe('the toggles', () => {
  test('are summaries, retitle, topics, sessions and context, in that order', () => {
    expect(toggleKeys).toEqual(['summaries', 'retitle', 'topics', 'sessions', 'context'])
  })
})

describe('parseKnowledgeSettings', () => {
  test('saved defaults and projects are read as they are; a missing default is on', () => {
    const parsed = parseKnowledgeSettings({ defaults: { summaries: true, retitle: false }, projects: { '/work/canto': { topics: false }, '/work/juntin': { summaries: false } } }, null)
    expect(parsed).toEqual({ defaults: { ...allOn, retitle: false }, projects: { '/work/canto': { topics: false }, '/work/juntin': { summaries: false } } })
  })

  test('a project value that is not a boolean, or a key it does not know, is dropped', () => {
    const parsed = parseKnowledgeSettings({ defaults: {}, projects: { '/work/canto': { topics: 'no', retitle: false, colour: true }, '/work/bad': 3 } }, null)
    expect(parsed.projects).toEqual({ '/work/canto': { retitle: false } })
  })

  test('nothing saved and no chat summaries is everything on', () => {
    expect(parseKnowledgeSettings(null, null)).toEqual(saved())
    expect(parseKnowledgeSettings([], 'x')).toEqual(saved())
  })
})

describe('the one-time migration from chat summaries', () => {
  test('without saved defaults, chat summaries enabled becomes summaries and its retitle becomes retitle', () => {
    expect(parseKnowledgeSettings(null, { enabled: false, retitle: false, model: 'gemini-3.8-flash' }).defaults).toEqual({ ...allOn, summaries: false, retitle: false })
    expect(parseKnowledgeSettings({ projects: { '/work/canto': { topics: false } } }, { enabled: true, retitle: true }).defaults).toEqual(allOn)
  })

  test('saved projects survive the migration', () => {
    expect(parseKnowledgeSettings({ projects: { '/work/canto': { topics: false } } }, { enabled: false }).projects).toEqual({ '/work/canto': { topics: false } })
  })

  test('once defaults are saved, chat summaries is ignored', () => {
    expect(parseKnowledgeSettings({ defaults: { summaries: true, retitle: true }, projects: {} }, { enabled: false, retitle: false }).defaults).toEqual(allOn)
  })

  test('what is saved after reading holds the migrated defaults, so it happens once', () => {
    const migrated = parseKnowledgeSettings(null, { enabled: false, retitle: true })
    const again = parseKnowledgeSettings(JSON.parse(serialiseKnowledgeSettings(migrated)), { enabled: true, retitle: false })
    expect(again.defaults).toEqual({ ...allOn, summaries: false })
  })
})

describe('effectiveToggles', () => {
  test("a project's own value wins, else the default", () => {
    const settings = saved({ '/work/canto': { topics: false } }, { retitle: false })
    expect(effectiveToggles(settings, '/work/canto')).toEqual({ ...allOn, retitle: false, topics: false })
    expect(effectiveToggles(settings, '/work/never-saved')).toEqual({ ...allOn, retitle: false })
  })

  test('a project can turn on what the default leaves off', () => {
    expect(effectiveToggles(saved({ '/work/canto': { summaries: true } }, { summaries: false }), '/work/canto').summaries).toBe(true)
  })
})

describe('inEffect', () => {
  test('retitle, topics, sessions and context need summaries', () => {
    const off = { ...allOn, summaries: false }
    for (const key of ['retitle', 'topics', 'sessions', 'context'] as const) expect(inEffect(off, key)).toBe(false)
    expect(inEffect(off, 'summaries')).toBe(false)
  })

  test('with summaries on, each toggle is what it says', () => {
    expect(inEffect(allOn, 'topics')).toBe(true)
    expect(inEffect({ ...allOn, topics: false }, 'topics')).toBe(false)
  })
})

describe('inherited', () => {
  test('a value the project has not set is inherited from the defaults', () => {
    const settings = saved({ '/work/canto': { topics: false } })
    expect(inherited(settings, '/work/canto', 'topics')).toBe(false)
    expect(inherited(settings, '/work/canto', 'retitle')).toBe(true)
    expect(inherited(settings, '/work/juntin', 'topics')).toBe(true)
  })
})

describe('changing the settings', () => {
  test('a project toggle is saved under its repository path, leaving the rest alone', () => {
    const before = saved({ '/work/juntin': { context: false } })
    const after = withProjectToggle(before, '/work/canto', 'topics', false)
    expect(after.projects).toEqual({ '/work/juntin': { context: false }, '/work/canto': { topics: false } })
    expect(before.projects['/work/canto']).toBeUndefined()
  })

  test('resetting a project toggle inherits the default again, and a project with nothing set is dropped', () => {
    const settings = saved({ '/work/canto': { topics: false, retitle: false } })
    expect(resetProjectToggle(settings, '/work/canto', 'topics').projects).toEqual({ '/work/canto': { retitle: false } })
    expect(resetProjectToggle(resetProjectToggle(settings, '/work/canto', 'topics'), '/work/canto', 'retitle').projects).toEqual({})
  })

  test('a default changes for every project that inherits it', () => {
    const settings = withDefault(saved({ '/work/canto': { topics: true } }), 'topics', false)
    expect(effectiveToggles(settings, '/work/juntin').topics).toBe(false)
    expect(effectiveToggles(settings, '/work/canto').topics).toBe(true)
  })

  test('saves the shape settings key knowledge holds: defaults and projects', () => {
    const json = JSON.parse(serialiseKnowledgeSettings(withProjectToggle(saved(), '/work/canto', 'summaries', false))) as unknown
    expect(json).toEqual({ defaults: allOn, projects: { '/work/canto': { summaries: false } } })
  })
})
