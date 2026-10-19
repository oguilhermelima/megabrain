import type { GithubProject, GithubProjectItem } from '@/api/schema'
import { evaluateProjectFilter } from '../../../../src/cli/commands/github/project-filter.js'

/** Evaluates the exact filter stored on a GitHub view against its project page items. */
export function filterGithubProjectItems(project: GithubProject, items: readonly GithubProjectItem[], filter: string, options: { today?: string; me?: string } = {}) {
  const status = project.fields.find((field) => field.name.toLocaleLowerCase() === 'status')
  const normalized = items.map((item) => {
    const fields: Record<string, unknown> = {}
    for (const entry of item.fieldValues ?? []) {
      const optionId = entry.value && typeof entry.value === 'object' && 'optionId' in entry.value ? entry.value.optionId : entry.value
      const option = entry.kind === 'singleSelect' ? status?.options.find((candidate) => candidate.id === optionId) : undefined
      fields[entry.field] = option?.name ?? (entry.value && typeof entry.value === 'object' && 'title' in entry.value ? entry.value.title : entry.value)
    }
    for (const field of project.fields) if (field.name.toLocaleLowerCase() === 'status' && item.status) fields[field.name] = status?.options.find((option) => option.id === item.status)?.name ?? item.status
    return { id: item.id, title: item.title, type: item.type, state: item.state, repository: item.repository, status: status?.options.find((option) => option.id === item.status)?.name ?? item.status, assignees: item.assignees, labels: item.labels, fields }
  })
  const result = evaluateProjectFilter(filter, normalized, options)
  const byId = new Map(items.map((item) => [item.id, item]))
  return { items: result.items.flatMap((item) => { const original = byId.get(item.id); return original ? [original] : [] }), warnings: result.warnings }
}
