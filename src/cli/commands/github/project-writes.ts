import type { ProcessAdapter } from '../../../adapters/proc.js'
import { failed, ok, type Result } from '../../../core/result.js'
import { usageMessage, usageText } from '../../../core/usage.js'
import { graphqlCall, repositoryVariables, resolveRepository } from './client.js'
import { normalizeProject, normalizeProjectItem, PROJECT_FIELDS, CONTENT_FIELDS } from './projects.js'

type Verb = 'project-field' | 'project-clear' | 'project-add' | 'project-draft' | 'project-archive' | 'project-unarchive'
type Env = Readonly<Record<string, string | undefined>>
type Opts = { repo: string; number: number; owner?: string; item?: string; field?: string; type?: string; value?: string; title?: string; body?: string; json: boolean }
const rec = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
const METADATA = `query($owner:String!,$number:Int!){repositoryOwner(login:$owner){... on ProjectV2Owner{projectV2(number:$number){${PROJECT_FIELDS}}}}}`
const ITEM_FIELDS = `id isArchived updatedAt content{${CONTENT_FIELDS}} fieldValues(first:30){nodes{__typename ... on ProjectV2ItemFieldSingleSelectValue{name optionId field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldIterationValue{title startDate duration field{... on ProjectV2FieldCommon{name}}}}}`

function parse(verb: Verb, args: readonly string[]): Result<Opts> {
  const [repo, numberText, item, ...rest] = args
  if (!repo || !numberText || !/^\d+$/.test(numberText) || Number(numberText) < 1) return failed(usageMessage(`github-${verb}`), 2)
  const flags: Record<string, string> = {}
  let json = false
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!
    if (flag === '--json') { json = true; continue }
    if (!['--owner','--field','--type','--value','--title','--body'].includes(flag) || !rest[i + 1] || rest[i + 1]!.startsWith('--')) return failed(usageMessage(`github-${verb}`), 2)
    if (flags[flag] !== undefined) return failed(`${flag} may only be supplied once`, 2)
    flags[flag] = rest[++i]!
  }
  if (['project-archive','project-unarchive','project-field','project-clear'].includes(verb) && (!item || item.startsWith('--'))) return failed(usageMessage(`github-${verb}`), 2)
  if (verb === 'project-field' && (!flags['--field'] || !flags['--type'] || flags['--value'] === undefined)) return failed(usageMessage(`github-${verb}`), 2)
  if (verb === 'project-clear' && !flags['--field']) return failed(usageMessage(`github-${verb}`), 2)
  if (verb === 'project-draft' && !flags['--title']) return failed(usageMessage(`github-${verb}`), 2)
  if (verb === 'project-add' && (!item || item.startsWith('--'))) return failed(usageMessage(`github-${verb}`), 2)
  return ok({ repo, number: Number(numberText), ...(flags['--owner'] ? { owner: flags['--owner'] } : {}), ...(item ? { item } : {}), ...(flags['--field'] ? { field: flags['--field'] } : {}), ...(flags['--type'] ? { type: flags['--type'] } : {}), ...(flags['--value'] === undefined ? {} : { value: flags['--value'] }), ...(flags['--title'] ? { title: flags['--title'] } : {}), ...(flags['--body'] ? { body: flags['--body'] } : {}), json })
}

async function metadata(opts: Opts, env: Env, process: ProcessAdapter) {
  const repo = await resolveRepository(opts.repo, env, process)
  if (repo.kind !== 'ok') return repo
  const owner = opts.owner ?? repo.value.nameWithOwner.split('/')[0] ?? ''
  const answer = await graphqlCall(process, 'gh api graphql', METADATA, { owner, number: opts.number })
  if (answer.kind !== 'ok') return answer
  const raw = rec(rec(answer.value.data.repositoryOwner).projectV2)
  const project = normalizeProject(raw)
  return project ? ok({ project, owner, repo: repo.value.nameWithOwner }) : failed(`GitHub project ${opts.number} was not found for ${owner}`)
}

export async function executeProjectWrite(verb: Verb, args: readonly string[], env: Env, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes('-h') || args.includes('--help')) return ok(usageText(`github-${verb}`))
  const parsed = parse(verb, args)
  if (parsed.kind !== 'ok') return parsed
  const opts = parsed.value
  const data = await metadata(opts, env, process)
  if (data.kind !== 'ok') return data
  const { project, owner, repo } = data.value
  let query = '', variables: Record<string, string | number> = { projectId: project.id }, shape: 'item' | 'archive' = 'item'
  if (verb === 'project-field' || verb === 'project-clear') {
    const field = project.fields.find((entry) => entry.name.toLocaleLowerCase() === opts.field!.toLocaleLowerCase())
    if (!field) return failed(`project field ${opts.field} does not exist`)
    if (verb === 'project-clear') {
      query = `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!){clearProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId}){projectV2Item{${ITEM_FIELDS}}}}`
      variables = { projectId: project.id, itemId: opts.item!, fieldId: field.id }
    } else {
      const type = opts.type!
      const expected: Record<string, string> = { 'single-select': 'SINGLE_SELECT', number: 'NUMBER', date: 'DATE', text: 'TEXT', iteration: 'ITERATION' }
      if (expected[type] !== field.dataType) return failed(`field ${field.name} is ${field.dataType}, not ${type}`)
      let arg = '', value: string | number = opts.value!
      if (type === 'single-select') { const option = field.options.find((entry) => entry.id === opts.value || entry.name.toLocaleLowerCase() === opts.value!.toLocaleLowerCase()); if (!option) return failed(`option ${opts.value} does not belong to field ${field.name}`); arg = `singleSelectOptionId`; value = option.id }
      else if (type === 'number') { const n = Number(opts.value); if (!Number.isFinite(n)) return failed('number value must be finite'); arg = 'number'; value = n }
      else if (type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.value!) || Number.isNaN(Date.parse(opts.value!))) return failed('date must use YYYY-MM-DD'); arg = 'date' }
      else if (type === 'text') arg = 'text'
      else { if (!field.iterations.some((iteration) => iteration.id === opts.value || iteration.title.toLowerCase() === opts.value!.toLowerCase())) return failed(`iteration ${opts.value} does not belong to field ${field.name}`); const iteration = field.iterations.find((entry) => entry.id === opts.value || entry.title.toLowerCase() === opts.value!.toLowerCase())!; arg = 'iterationId'; value = iteration.id }
      query = `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:${type === 'number' ? 'Float' : 'String'}!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{${arg}:$value}}){projectV2Item{${ITEM_FIELDS}}}}`
      variables = { projectId: project.id, itemId: opts.item!, fieldId: field.id, value }
    }
  } else if (verb === 'project-add') {
    const match = opts.item!.match(/^(?:https:\/\/github\.com\/)?([^/#]+\/[^/#]+)#(\d+)$/) ?? opts.item!.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)\/?$/)
    if (!match) return failed('item must be a GitHub issue or pull request URL, or owner/repo#number')
    const name = match[1]!.replace(/\.git$/, ''), number = Number(match[3] ?? match[2]), isPr = match[2] === 'pull'
    const lookup = await graphqlCall(process, 'gh api graphql', `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){${isPr ? 'pullRequest' : 'issue'}(number:$number){id}}}`, { owner: name.split('/')[0]!, name: name.split('/')[1]!, number })
    if (lookup.kind !== 'ok') return lookup
    const contentId = rec(rec(lookup.value.data.repository)[isPr ? 'pullRequest' : 'issue']).id
    if (typeof contentId !== 'string') return failed(`GitHub item ${opts.item} was not found`)
    query = 'mutation($projectId:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id isArchived updatedAt content{__typename ... on Issue{number title url state updatedAt repository{nameWithOwner}} ... on PullRequest{number title url state updatedAt repository{nameWithOwner}}}}}}'
    variables = { projectId: project.id, contentId }
  } else if (verb === 'project-draft') {
    query = 'mutation($projectId:ID!,$title:String!,$body:String){addProjectV2DraftIssue(input:{projectId:$projectId,title:$title,body:$body}){projectV2Item{id isArchived updatedAt content{__typename ... on DraftIssue{title}}}}}'
    variables = { projectId: project.id, title: opts.title!, ...(opts.body === undefined ? {} : { body: opts.body }) }
  } else {
    shape = 'archive'
    query = `mutation($projectId:ID!,$itemId:ID!){${verb === 'project-archive' ? 'archiveProjectV2Item' : 'unarchiveProjectV2Item'}(input:{projectId:$projectId,itemId:$itemId}){item{id isArchived}}}`
    variables = { projectId: project.id, itemId: opts.item! }
  }
  const written = await graphqlCall(process, 'gh api graphql', query, variables, { retry: false })
  if (written.kind !== 'ok') return written
  let output: unknown
  if (shape === 'archive') { const payload = rec(written.value.data[verb === 'project-archive' ? 'archiveProjectV2Item' : 'unarchiveProjectV2Item']); output = { item: payload.item ?? null } }
  else {
    const key = verb === 'project-clear' || verb === 'project-field' ? verb === 'project-clear' ? 'clearProjectV2ItemFieldValue' : 'updateProjectV2ItemFieldValue' : verb === 'project-add' ? 'addProjectV2ItemById' : 'addProjectV2DraftIssue'
    const payload = rec(written.value.data[key]); const item = payload.projectV2Item ?? payload.item
    const normalized = normalizeProjectItem({ ...rec(item), content: rec(item).content ?? { __typename: 'DraftIssue', title: opts.title ?? '' } })
    output = { item: normalized ?? { id: rec(item).id ?? null } }
  }
  void owner; void repo
  return opts.json ? ok(`${JSON.stringify(output, null, 2)}\n`) : ok(`${JSON.stringify(output)}\n`)
}
