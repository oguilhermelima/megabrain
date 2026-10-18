import type { ProcessAdapter } from '../../../adapters/proc.js'
import { failed, ok, type Result } from '../../../core/result.js'
import { usageMessage, usageText } from '../../../core/usage.js'
import { graphqlCall, repositoryVariables, resolveRepository } from './client.js'
import { CONTENT_FIELDS, normalizeProject, normalizeProjectItem, PROJECT_FIELDS } from './projects.js'
import { record } from './views.js'

type Environment = Readonly<Record<string, string | undefined>>

export const PROJECT_METADATA_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { ${PROJECT_FIELDS} } } }
}`

export const PROJECT_MOVE_QUERY = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) {
    projectV2Item { id fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId } } content { ${CONTENT_FIELDS} } }
  }
}`

type Options = { selector: string; number: number; itemId: string; status: string; owner?: string; json: boolean }
function parse(args: readonly string[]): Result<Options> {
  const [selector, numberText, itemId, ...flags] = args
  if (selector === undefined || numberText === undefined || !/^\d+$/.test(numberText) || Number(numberText) < 1 || itemId === undefined || itemId.startsWith('--')) return failed(usageMessage('github-project-move'), 2)
  const values: Record<string, string> = {}
  let json = false
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i]
    if (flag === '--json') { json = true; continue }
    if ((flag === '--owner' || flag === '--status') && flags[i + 1] !== undefined && !flags[i + 1]!.startsWith('--')) {
      if (values[flag] !== undefined) return failed(`${flag} may only be supplied once`, 2)
      values[flag] = flags[++i]!
      continue
    }
    return failed(usageMessage('github-project-move'), 2)
  }
  if (values['--status'] === undefined) return failed('--status needs a project status option id', 2)
  return ok({ selector, number: Number(numberText), itemId, status: values['--status'], ...(values['--owner'] === undefined ? {} : { owner: values['--owner'] }), json })
}

export async function executeProjectMove(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes('-h') || args.includes('--help')) return ok(usageText('github-project-move'))
  const parsed = parse(args)
  if (parsed.kind !== 'ok') return parsed
  const options = parsed.value
  const resolved = await resolveRepository(options.selector, environment, process)
  if (resolved.kind !== 'ok') return resolved
  const owner = options.owner ?? resolved.value.nameWithOwner.split('/')[0] ?? ''
  const variables = { ...repositoryVariables(resolved.value.nameWithOwner), owner, number: options.number }
  const metadata = await graphqlCall(process, 'gh api graphql', PROJECT_METADATA_QUERY, variables)
  if (metadata.kind !== 'ok') return metadata
  const rawProject = record(metadata.value.data.repositoryOwner)?.projectV2
  const project = normalizeProject(rawProject)
  if (project === null) return failed(`GitHub project ${options.number} was not found for ${owner}`)
  const field = project.statusField
  if (field === null) return failed(`GitHub project ${options.number} has no Status single-select field`)
  if (!field.options.some((option) => option.id === options.status)) return failed(`status option ${options.status} does not belong to project ${options.number}`)
  const moved = await graphqlCall(process, 'gh api graphql', PROJECT_MOVE_QUERY, {
    projectId: project.id, itemId: options.itemId, fieldId: field.id, optionId: options.status,
  }, { retry: false })
  if (moved.kind !== 'ok') return moved
  const payload = record(moved.value.data.updateProjectV2ItemFieldValue)
  const item = normalizeProjectItem(payload?.projectV2Item)
  if (item === null) return failed('GitHub project move returned an unexpected answer')
  const output = { item: { ...item, status: options.status } }
  return options.json ? ok(`${JSON.stringify(output, null, 2)}\n`) : ok(`${output.item.id}\t${output.item.status}\n`)
}
