import { describe, expect, test } from 'bun:test'
import { createLoads, sectionKeys } from '@/settings/settings-load'

describe('settings page loads', () => {
  test('a failing loader leaves another page rendered', async () => {
    const loads = createLoads({ usage: () => Promise.reject(new Error('limits down')), models: () => Promise.resolve({ models: [1] }) })
    await Promise.all([loads.load('usage'), loads.load('models')])
    expect(loads.get('usage').status).toBe('error')
    expect(String(loads.get('usage').error)).toContain('limits down')
    expect(loads.get('models')).toEqual({ status: 'ready', value: { models: [1] }, error: null })
  })

  test('a slow loader does not hold another page', async () => {
    let release: (value: unknown) => void = () => {}
    const loads = createLoads({ usage: () => new Promise((resolve) => (release = resolve)), models: () => Promise.resolve('fast') })
    const slow = loads.load('usage')
    await loads.load('models')
    expect(loads.get('usage').status).toBe('loading')
    expect(loads.get('models').status).toBe('ready')
    release('late')
    await slow
    expect(loads.get('usage').status).toBe('ready')
  })

  test('a page loads once and is cached; Retry re-runs a failed one', async () => {
    let calls = 0
    const loads = createLoads({ chains: () => (++calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')) })
    await loads.load('chains')
    await loads.load('chains')
    expect(calls).toBe(2)
    expect(loads.get('chains').status).toBe('ready')
    await loads.load('chains')
    expect(calls).toBe(2)
  })

  test('a reload keeps the last value, also when it fails', async () => {
    let fail = false
    const loads = createLoads({ models: () => (fail ? Promise.reject(new Error('later')) : Promise.resolve('first')) })
    await loads.load('models')
    fail = true
    await loads.load('models', true)
    expect(loads.get('models')).toMatchObject({ status: 'error', value: 'first' })
  })

  test('only the pages that need a slice ask for it', () => {
    expect(sectionKeys.usage).toEqual(['limits'])
    expect(sectionKeys.shortcuts).toEqual([])
    expect(sectionKeys.supervisor).not.toContain('limits')
  })
})
