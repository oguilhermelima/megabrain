import { failed, ok, type Result } from '../../../core/result.js'
import { usageMessage, usageText } from '../../../core/usage.js'
import type { ProcessAdapter } from '../../../adapters/proc.js'
import { graphqlCall, repositoryVariables, resolveRepository } from './client.js'
import { list, nullableText, record, text } from './views.js'

const LABELS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, after: $after) { nodes { name color description } pageInfo { hasNextPage endCursor } }
  }
}`

type Environment = Readonly<Record<string, string | undefined>>

export async function executeGithubLabels(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes('-h') || args.includes('--help')) return ok(usageText('github-labels'))
  let selector: string | undefined
  let json = false
  for (const argument of args) {
    if (argument === '--json') json = true
    else if (argument.startsWith('--') || selector !== undefined) return failed(usageMessage('github-labels'), 2)
    else selector = argument
  }
  if (selector === undefined) return failed(usageMessage('github-labels'), 2)
  const resolved = await resolveRepository(selector, environment, process)
  if (resolved.kind !== 'ok') return resolved

  const labels: { name: string; color: string; description: string }[] = []
  const seenCursors = new Set<string>()
  let after: string | null = null
  for (;;) {
    const answer = await graphqlCall(process, 'gh api graphql', LABELS_QUERY, { ...repositoryVariables(resolved.value.nameWithOwner), ...(after === null ? {} : { after }) })
    if (answer.kind !== 'ok') return answer
    if (answer.value.error !== undefined) return failed(`gh api graphql failed: ${answer.value.error}`)
    const connection = record(record(answer.value.data.repository)?.labels)
    if (connection === undefined) return failed('gh api graphql failed: the labels answer has an unexpected shape')
    labels.push(...list(connection.nodes).flatMap((label) => typeof label.name === 'string'
      ? [{ name: text(label.name), color: text(label.color), description: text(label.description) }]
      : []))
    const info = record(connection.pageInfo)
    if (info?.hasNextPage !== true) break
    const cursor = nullableText(info.endCursor)
    if (cursor === null || seenCursors.has(cursor)) return failed('gh api graphql failed: GitHub returned an invalid labels cursor')
    seenCursors.add(cursor)
    after = cursor
  }
  const output = { labels }
  return json ? ok(`${JSON.stringify(output, null, 2)}\n`) : ok(labels.map((label) => `${label.name}\t${label.color}\t${label.description}\n`).join(''))
}
