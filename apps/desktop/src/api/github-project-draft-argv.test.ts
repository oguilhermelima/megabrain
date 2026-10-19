import { describe, expect, mock, test } from 'bun:test'

const calls: string[][] = []
const core = await import('@tauri-apps/api/core')
mock.module('@tauri-apps/api/core', () => ({
  ...core,
  invoke: async (_command: string, payload: { args: string[] }) => {
    calls.push(payload.args)
    return { code: 0, stdout: JSON.stringify({ item: { id: 'D1', type: 'DRAFT_ISSUE', number: null, title: 'Edited', body: '', url: null, state: null, repository: null, status: null, assignees: [], labels: [], updatedAt: '', isArchived: false, fieldValues: [] } }), stderr: '' }
  },
}))
const { createTauriApi } = await import('@/api/tauri')

describe('draft item API', () => {
  test('passes title and an empty body to the draft edit command', async () => {
    const api = createTauriApi()
    await api.githubProjectEditDraft('/repo', 7, 'D1', 'Edited', '')
    expect(calls.at(-1)).toEqual(['github', 'project-draft-edit', '/repo', '7', 'D1', '--title', 'Edited', '--body', '', '--json'])
  })
})
