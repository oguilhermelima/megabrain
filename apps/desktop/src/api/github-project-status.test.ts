import { describe, expect, test } from 'bun:test'
import { createMockApi } from '@/api/mock'

const apiMethods = (api: object) => api as Record<string, (...args: unknown[]) => Promise<unknown>>

describe('GitHub Project status and workflow API', () => {
  test('lists status updates and creates one in the mock', async () => {
    const api = apiMethods(createMockApi())
    const before = await api.githubProjectStatus!('/repo', 3) as { updates: { id: string }[] }
    expect(before.updates.length).toBeGreaterThan(0)
    const created = await api.githubProjectStatusCreate!('/repo', 3, 'AT_RISK', 'Dependencies need attention', '2026-10-01', '2026-10-31') as { id: string; status: string }
    expect(created).toMatchObject({ status: 'AT_RISK' })
    const after = await api.githubProjectStatus!('/repo', 3) as { updates: { id: string }[] }
    expect(after.updates[0]?.id).toBe(created.id)
  })

  test('lists workflows in the mock', async () => {
    const api = apiMethods(createMockApi())
    const result = await api.githubProjectWorkflows!('/repo', 3) as { workflows: { id: string; name: string; number: number; enabled: boolean }[] }
    expect(result.workflows).toContainEqual({ id: 'PWF_auto_close', name: 'Auto-close issue', number: 9, enabled: true })
  })
})
