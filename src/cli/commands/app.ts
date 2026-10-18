import { failed, ok, type Result } from '../../core/result.js'
import { usageText } from '../../core/usage.js'
import { callChatd } from '../../chat/daemon/client.js'
import { resolveStateDirectory } from '../../core/state.js'
import type { ProcessAdapter } from '../../adapters/proc.js'
import type { Environment } from './context.js'

export type ParsedAppTarget =
  | { kind: 'chat'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'terminal'; id: string }
  | { kind: 'worktree'; path: string }
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'url'; url: string }
  | { kind: 'page'; page: 'tasks' | 'knowledge' | 'artifacts' | 'settings'; sub?: string }

export function parseAppTarget(value: string): ParsedAppTarget {
  const colon = value.indexOf(':')
  const kind = colon === -1 ? '' : value.slice(0, colon)
  const raw = colon === -1 ? '' : value.slice(colon + 1)
  if (!raw) throw new Error(`invalid app target: ${value}`)
  if (kind === 'chat' || kind === 'terminal') return { kind, id: raw }
  if (kind === 'session') {
    const split = raw.indexOf(':')
    if (split <= 0 || split === raw.length - 1) throw new Error(`session target must be session:<agent>:<id>`)
    return { kind, id: raw }
  }
  if (kind === 'worktree') {
    if (!raw.startsWith('/')) throw new Error('worktree targets must be absolute paths')
    return { kind, path: raw }
  }
  if (kind === 'file') {
    const match = /^(.*):(\d+)$/.exec(raw)
    const path = match?.[1] ?? raw
    if (!path.startsWith('/')) throw new Error('file targets must use an absolute path')
    if (match !== null && match !== undefined) {
      const line = Number(match[2])
      if (!Number.isSafeInteger(line) || line < 1) throw new Error('file line must be a positive integer')
      return { kind, path, line }
    }
    return { kind, path }
  }
  if (kind === 'url') {
    let url: URL
    try { url = new URL(raw) } catch { throw new Error(`invalid URL target: ${raw}`) }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL targets must use http or https')
    return { kind, url: raw }
  }
  if (kind === 'page') {
    const [page, ...rest] = raw.split('/')
    if (!['tasks', 'knowledge', 'artifacts', 'settings'].includes(page ?? '') || rest.length > 1 || rest[0] === '') throw new Error(`unknown target: ${value}`)
    return { kind, page: page as 'tasks' | 'knowledge' | 'artifacts' | 'settings', ...(rest[0] === undefined ? {} : { sub: rest[0] }) }
  }
  throw new Error(`unknown target: ${value}`)
}

export function parsePaneTarget(value: string): string {
  if (value.trim() === '') throw new Error('pane target cannot be empty')
  return value
}

function targetRequest(target: string): ParsedAppTarget {
  return parseAppTarget(target)
}

function argsError(): Result<string> { return failed(usageText('app').trimEnd(), 2) }

export async function executeApp(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes('-h') || args.includes('--help')) return ok(usageText('app'))
  const [verb, ...rest] = args
  let request: Record<string, unknown>
  let json = false
  const options = rest.filter((part) => part === '--json')
  if (options.length > 1) return argsError()
  json = options.length === 1
  const values = rest.filter((part) => part !== '--json')
  if (verb === 'status' && values.length === 0) {
    const result = await callChatd(resolveStateDirectory(environment), { operation: 'app-status' }, environment, processAdapter) as Record<string, unknown>
    return ok(`${JSON.stringify(result, null, 2)}\n`)
  }
  if (verb === 'layout' && values.length === 0) request = { action: 'layout' }
  else if (verb === 'open' && values.length >= 1) {
    const target = values[0]!
    targetRequest(target)
    let split: 'right' | 'down' | undefined
    let beside: string | undefined
    let focus = false
    for (let index = 1; index < values.length; index += 1) {
      const option = values[index]
      if (option === '--split' && (values[index + 1] === 'right' || values[index + 1] === 'down')) split = values[++index] as 'right' | 'down'
      else if (option === '--beside' && values[index + 1] !== undefined) beside = parsePaneTarget(values[++index]!)
      else if (option === '--focus') focus = true
      else return argsError()
    }
    request = { action: 'open', target, ...(split === undefined ? {} : { split }), ...(beside === undefined ? {} : { beside }), ...(focus ? { focus } : {}) }
  } else if (verb === 'split' && (values[0] === 'right' || values[0] === 'down')) {
    let target: string | undefined
    if (values.length === 3 && values[1] === '--target') { target = values[2]; targetRequest(target!); }
    else if (values.length !== 1) return argsError()
    request = { action: 'split', direction: values[0], ...(target === undefined ? {} : { target }) }
  } else if (verb === 'join' && values.length === 3 && values[1] === '--with') request = { action: 'join', pane: parsePaneTarget(values[0]!), with: parsePaneTarget(values[2]!) }
  else if (verb === 'close-pane' && values.length === 1) request = { action: 'close-pane', pane: parsePaneTarget(values[0]!) }
  else return argsError()

  const result = await callChatd(resolveStateDirectory(environment), { operation: 'app-control', request }, environment, processAdapter)
  const alreadyJoined = typeof result === 'object' && result !== null && 'status' in result && result.status === 'already-joined'
  return ok(json ? `${JSON.stringify(result, null, 2)}\n` : alreadyJoined ? 'Panes are already joined\n' : `${verb === 'layout' ? 'Read' : 'Updated'} app layout\n`)
}
