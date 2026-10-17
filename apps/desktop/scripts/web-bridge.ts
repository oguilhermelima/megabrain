import { randomBytes } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

type BridgeOptions = { host?: string; webOrigin?: string; cliPath: string; cliRoot: string; path?: string; allowedRoots?: string[]; stateDir?: string }
type CliOutput = { code: number | null; stdout: string; stderr: string }
type Stream = { child: ChildProcess; clients: Set<ReadableStreamDefaultController<Uint8Array>>; lines: Set<(line: string) => void>; history?: string[] }
const encoder = new TextEncoder()
const skipped = new Set(['.git', 'node_modules', 'target', 'dist', '.build', '.next', '.turbo', 'coverage'])
const maxFileSize = 1024 * 1024
const identityEnv = ['MEGABRAIN_DISPATCH_ID','MEGABRAIN_SESSION_ID','MEGABRAIN_SESSION_HOST','AI_AGENT','CLAUDE_CODE_SESSION_ID','CODEX_SESSION_ID','CODEX_THREAD_ID','GROK_AGENT','GROK_LEADER_SOCKET','GROK_SESSION_ID','ANTIGRAVITY_AGENT','ANTIGRAVITY_CONVERSATION_ID','ANTIGRAVITY_CSRF_TOKEN','ANTIGRAVITY_LS_ADDRESS','ANTIGRAVITY_LS_VERSION','ORCA_AGENT_SESSION_SPAWN_TOKEN','ORCA_STRUCTURED_SESSION','ORCA_TERMINAL_HANDLE','SUPERSET_AGENT_EFFORT','SUPERSET_AGENT_ID','SUPERSET_AGENT_MODEL','SUPERSET_TERMINAL_ID','SUPERSET_WORKSPACE_ID','TMUX','TMUX_PANE']

function command(options: BridgeOptions, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, MEGABRAIN_ROOT: options.cliRoot, PATH: options.path ?? process.env.PATH ?? '' }
  if (options.stateDir) env.MEGABRAIN_STATE_DIR = options.stateDir
  for (const key of identityEnv) delete env[key]
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT' || ['CLAUDE_CODE_', 'ORCA_', 'SUPERSET_', 'CODEX_', 'GROK_', 'ANTIGRAVITY_', 'MEGABRAIN_DISPATCH', 'MEGABRAIN_SESSION', 'MEGABRAIN_PARENT', 'MEGABRAIN_CHILD'].some((prefix) => key.startsWith(prefix))) {
      if (!['CLAUDE_CODE_USE_', 'CLAUDE_CODE_OAUTH_', 'CLAUDE_CODE_API_KEY', 'CLAUDE_CODE_DISABLE_', 'CLAUDE_CODE_MAX_'].some((prefix) => key.startsWith(prefix))) delete env[key]
    }
  }
  return spawn(options.cliPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
}

function output(child: ChildProcess): Promise<CliOutput> {
  return new Promise((resolveOutput, reject) => {
    let stdout = ''; let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (data: string) => { stdout += data })
    child.stderr?.setEncoding('utf8').on('data', (data: string) => { stderr += data })
    child.once('error', (error) => reject(`could not run megabrain: ${error.message}`))
    child.once('close', (code) => resolveOutput({ code, stdout, stderr }))
  })
}

function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.killed) return
  try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch { child.kill('SIGTERM') }
  setTimeout(() => { if (child.exitCode === null) { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* already exited */ } } }, 1000).unref()
}

function isSkipped(path: string) { return path.split(/[\\/]/).some((part) => skipped.has(part)) }
function basenamePath(path: string) { return path.split('/').at(-1) ?? path }
function checkRelative(path: string) {
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) throw 'file path must be a non-empty relative path without traversal'
  if (isSkipped(path)) throw 'file path is inside a skipped directory'
  return path
}
async function safeRoot(root: string, allowedRoots: string[]) {
  let canonical: string
  try { canonical = await realpath(root) } catch (error) { throw `could not resolve repository root: ${String(error)}` }
  for (const allowed of allowedRoots) { try { if (await realpath(allowed) === canonical) return canonical } catch { /* stale worktree */ } }
  throw 'repository root is not a registered megabrain worktree or checkout'
}
async function safeFile(root: string, path: string) {
  checkRelative(path)
  const candidate = resolve(root, path)
  try { const canonical = await realpath(candidate); if (canonical !== root && !canonical.startsWith(root + sep)) throw 'file path resolves outside the repository root'; return canonical }
  catch (error) {
    if (typeof error === 'string') throw error
    try { if ((await lstat(candidate)).isSymbolicLink()) throw 'file symlink cannot be resolved safely' } catch (inner) { if (typeof inner === 'string') throw inner }
    let parent: string
    try { parent = await realpath(dirname(candidate)) } catch (inner) { throw `could not resolve file path: ${String(inner)}` }
    if (parent !== root && !parent.startsWith(root + sep)) throw 'file path resolves outside the repository root'
    return candidate
  }
}
async function git(root: string, args: string[]) {
  const child = spawn('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  const result = await output(child)
  if (result.code !== 0) throw result.stderr.trim()
  return result.stdout
}
async function contents(path: string): Promise<Buffer | null> {
  let metadata
  try { metadata = await stat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw `could not read file metadata: ${String(error)}` }
  if (!metadata.isFile()) throw 'path is not a regular file'
  if (metadata.size > maxFileSize) return Buffer.alloc(maxFileSize + 1)
  const bytes = await readFile(path)
  return bytes.length > maxFileSize ? Buffer.alloc(maxFileSize + 1) : bytes
}
function binary(bytes: Buffer) { return bytes.subarray(0, 8192).includes(0) }
function text(bytes: Buffer) { return new TextDecoder('utf-8', { fatal: false }).decode(bytes) }
async function codeCommand(name: string, data: any, allowedRoots: string[]) {
  const root = await safeRoot(String(data.root ?? ''), allowedRoots)
  if (name === 'code_tree') {
    const paths = (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    const dirs = new Set<string>(); const files: Array<{ path: string; size: number }> = []
    for (const path of paths) {
      if (isSkipped(path)) continue
      let info; try { info = await lstat(join(root, path)) } catch { continue }
      if (!info.isFile() && !info.isSymbolicLink()) continue
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
      files.push({ path, size: info.size })
    }
    const entries: Array<{ path: string; kind: 'dir' | 'file'; size: number | null }> = []
    const dirsByParent = new Map<string, string[]>()
    const filesByParent = new Map<string, Array<{ path: string; size: number }>>()
    for (const path of dirs) {
      const parent = dirname(path) === '.' ? '' : dirname(path)
      dirsByParent.set(parent, [...(dirsByParent.get(parent) ?? []), path])
    }
    for (const file of files) {
      const parent = dirname(file.path) === '.' ? '' : dirname(file.path)
      filesByParent.set(parent, [...(filesByParent.get(parent) ?? []), file])
    }
    const sorted = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
    const walk = (prefix: string) => {
      for (const path of (dirsByParent.get(prefix) ?? []).sort((a, b) => sorted(basenamePath(a), basenamePath(b)))) { entries.push({ path, kind: 'dir', size: null }); walk(path) }
      for (const file of (filesByParent.get(prefix) ?? []).sort((a, b) => sorted(basenamePath(a.path), basenamePath(b.path)))) entries.push({ path: file.path, kind: 'file', size: file.size })
    }
    walk('')
    return entries.slice(0, 20000)
  }
  if (name === 'code_read') {
    const path = String(data.path ?? ''); const absolute = await safeFile(root, path); const bytes = await contents(absolute)
    if (bytes === null) return { path, text: null, binary: false, tooLarge: false }
    if (bytes.length > maxFileSize) return { path, text: null, binary: false, tooLarge: true }
    if (binary(bytes)) return { path, text: null, binary: true, tooLarge: false }
    return { path, text: text(bytes), binary: false, tooLarge: false }
  }
  if (name === 'code_changes') {
    const bytes = await git(root, ['status', '--porcelain=v1', '-z']); const fields = bytes.split('\0').filter(Boolean); const changes = []
    for (let i = 0; i < fields.length; i++) {
      const record = fields[i]!; if (record.length < 4) continue
      const status = record.slice(0, 2); const path = record.slice(3)
      const kind = status === '??' ? 'untracked' : /[RC]/.test(status) ? (i++, 'renamed') : status.includes('D') ? 'deleted' : status.includes('A') ? 'added' : 'modified'
      changes.push({ path, status: kind })
    }
    return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  }
  if (name === 'code_diff') {
    const path = String(data.path ?? ''); const absolute = await safeFile(root, path)
    return diff(path, await gitFile(root, 'HEAD', path), await contents(absolute))
  }
  if (name === 'code_branch_changes') {
    const parent = typeof data.parent === 'string' ? data.parent : null
    let base: string | null = null
    if (parent && parent.length > 0 && !parent.startsWith('-')) { try { await git(root, ['rev-parse', '--verify', '--quiet', `${parent}^{commit}`]); base = parent } catch { /* use origin default */ } }
    if (!base) { try { const candidate = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim(); await git(root, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]); if (candidate) base = candidate } catch { /* no default */ } }
    let mergeBase: string | null = null
    if (base) { try { mergeBase = (await git(root, ['merge-base', 'HEAD', base])).trim() || null } catch { /* unrelated history */ } }
    if (!mergeBase) return { base, mergeBase: null, changes: [] }
    const fields = (await git(root, ['diff', '--name-status', '--no-renames', '-z', mergeBase, 'HEAD', '--'])).split('\0').filter(Boolean); const changes = []
    for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ path: fields[i + 1], status: fields[i]!.startsWith('A') ? 'added' : fields[i]!.startsWith('D') ? 'deleted' : 'modified' })
    return { base, mergeBase, changes: changes.sort((a, b) => a.path! < b.path! ? -1 : a.path! > b.path! ? 1 : 0) }
  }
  const mergeBase = String(data.mergeBase ?? ''); const path = String(data.path ?? '')
  if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(mergeBase)) throw 'merge base must be a full commit id'
  checkRelative(path)
  return diff(path, await gitFile(root, mergeBase, path), await gitFile(root, 'HEAD', path))
}
async function gitFile(root: string, rev: string, path: string): Promise<Buffer | null> {
  const spec = `${rev}:${path}`
  let size: string
  try { size = (await git(root, ['cat-file', '-s', spec])).trim() } catch { return null }
  if (Number(size) > maxFileSize) return Buffer.alloc(maxFileSize + 1)
  const result = await git(root, ['show', spec]); const bytes = Buffer.from(result)
  return bytes.length > maxFileSize ? Buffer.alloc(maxFileSize + 1) : bytes
}
function diff(path: string, original: Buffer | null, modified: Buffer | null) {
  const tooLarge = (original?.length ?? 0) > maxFileSize || (modified?.length ?? 0) > maxFileSize
  if (tooLarge) return { path, original: '', modified: '', binary: false, tooLarge: true }
  original ??= Buffer.alloc(0); modified ??= Buffer.alloc(0)
  if (binary(original) || binary(modified)) return { path, original: '', modified: '', binary: true, tooLarge: false }
  return { path, original: text(original), modified: text(modified), binary: false, tooLarge: false }
}

export async function startWebBridge(input: Partial<BridgeOptions> & { host?: string }) {
  const options: BridgeOptions = { cliPath: input.cliPath ?? '', cliRoot: input.cliRoot ?? '', ...input }
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1') throw 'web bridge must bind to 127.0.0.1'
  const token = randomBytes(32).toString('hex')
  const streams = new Map<string, Stream>()
  const listeners = new Set<(event: string, payload: unknown) => void>()
  const codeRoots = new Set<string>()
  let allowedRoots = options.allowedRoots
  let allowedRootsAt = 0
  const getAllowedRoots = async () => {
    if (allowedRoots !== undefined && (options.allowedRoots !== undefined || Date.now() - allowedRootsAt < 30_000)) return allowedRoots
    allowedRoots = await discoverRoots(options)
    allowedRootsAt = Date.now()
    return allowedRoots
  }
  const server = Bun.serve({
    hostname: host, port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const origin = request.headers.get('origin')
      if (origin && origin !== options.webOrigin) return new Response('Forbidden origin', { status: 403 })
      const corsHeaders: Record<string, string> = origin ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, x-megabrain-token', vary: 'Origin' } : {}
      if (request.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: { ...corsHeaders, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '600' } })
      if (request.headers.get('x-megabrain-token') !== token && url.searchParams.get('token') !== token) return new Response('Unauthorized', { status: 401 })
      const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', ...corsHeaders } })
      if (url.pathname === '/events' && request.method === 'GET') {
        let listener: ((event: string, payload: unknown) => void) | undefined
        const body = new ReadableStream<Uint8Array>({ start(controller) { listener = (event, payload) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)); listeners.add(listener); controller.enqueue(encoder.encode(': connected\n\n')) }, cancel() { if (listener) listeners.delete(listener) } })
        return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...corsHeaders } })
      }
      if (url.pathname.startsWith('/events/')) {
        const id = url.pathname.slice('/events/'.length); const stream = streams.get(id)
        if (!stream) return new Response('Not found', { status: 404 })
        let client: ReadableStreamDefaultController<Uint8Array>
        const body = new ReadableStream<Uint8Array>({ start(controller) { client = controller; stream.clients.add(controller); for (const line of stream.history ?? []) controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`)) }, cancel() { stream.clients.delete(client!) } })
        return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...corsHeaders } })
      }
      if (url.pathname === '/stream' && request.method === 'POST') {
        let body: any
        try { body = await request.json() } catch { return Response.json({ error: 'invalid JSON body' }, { status: 400 }) }
        if (body?.command !== 'cli_stream') return Response.json({ error: 'unknown command' }, { status: 400 })
        const id = randomBytes(12).toString('hex'); const child = command(options, strings(body.args)); const stream: Stream = { child, clients: new Set(), lines: new Set(), history: [] }
        streams.set(id, stream)
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { let pending = (stream as any).pending ?? ''; pending += chunk; let newline; while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1); stream.history!.push(line); for (const client of stream.clients) client.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`)) }; (stream as any).pending = pending })
        child.once('close', () => { const pending = (stream as any).pending as string | undefined; if (pending) for (const client of stream.clients) client.enqueue(encoder.encode(`data: ${JSON.stringify(pending)}\n\n`)); for (const client of stream.clients) { client.enqueue(encoder.encode('event: done\ndata: {}\n\n')); client.close() }; streams.delete(id) })
        return json({ streamId: id })
      }
      if (url.pathname.startsWith('/stream/') && url.pathname.endsWith('/stop') && request.method === 'POST') {
        const id = url.pathname.split('/')[2]!; const stream = streams.get(id); if (stream) stopChild(stream.child); return json(null)
      }
      if (url.pathname === '/invoke' && request.method === 'POST') {
        let body: any
        try { body = await request.json() } catch { return json({ error: 'invalid JSON body' }, 400) }
        const name = body?.command
        try {
          if (name === 'run_cli') {
            const args = strings(body.args)
            const result = await output(command(options, args))
            if (args[0] === 'code' && result.code === 0) {
              if ((args[1] === 'open' || args[1] === 'goto') && args[2]) codeRoots.add(args[2])
              if (args[1] === 'stop' && args[2]) codeRoots.delete(args[2])
            }
            return json(result)
          }
          if (name === 'stream_cli') {
            const id = randomBytes(12).toString('hex'); const child = command(options, strings(body.args)); const stream: Stream = { child, clients: new Set(), lines: new Set() }
            streams.set(id, stream)
            let stdout = ''; let stderr = ''
            child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; let newline; while ((newline = stdout.indexOf('\n')) >= 0) { const line = stdout.slice(0, newline).replace(/\r$/, ''); stdout = stdout.slice(newline + 1); for (const send of [...stream.lines]) send(line); for (const client of stream.clients) client.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`)); for (const listener of listeners) listener('cli-line', { id: body.id, line }) } })
            child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
            child.once('close', (code) => { if (stdout) { const line = stdout.replace(/\r$/, ''); for (const client of stream.clients) client.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`)); for (const listener of listeners) listener('cli-line', { id: body.id, line }) }; for (const client of stream.clients) client.close(); streams.delete(id); for (const listener of listeners) listener('stream-done', { streamId: id, code, stderr }) })
            return json({ streamId: id })
          }
          if (name === 'cli_stream_stop') { const stream = streams.get(String(body.streamId)); if (stream) stopChild(stream.child); return json(null) }
          if (typeof name === 'string' && name.startsWith('code_')) return json(await codeCommand(name, body, await getAllowedRoots()))
          if (name === 'save_attachment') return json(await saveAttachment(options, String(body.base64), String(body.extension)))
          if (name === 'save_image') {
            const path = String(body.path); const encoded = String(body.base64)
            if (!isAbsolute(path)) throw 'the save path must be absolute'
            if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw 'image is not valid base64'
            const bytes = Buffer.from(encoded, 'base64'); if (bytes.length > 20 * 1024 * 1024) throw 'image exceeds the 20 MB limit'
            await writeFile(path, bytes); return json(null)
          }
          if (name === 'switch_trace_log' || name === 'chat_start_trace_log') { await appendTrace(options, name, body.record); return json(null) }
          if (name === 'terminal_open' || name === 'terminal_write' || name === 'terminal_resize' || name === 'terminal_close' || name === 'terminal_listen' || name === 'terminal_unlisten') throw 'Terminals need the desktop app.'
          if (name === 'path_link_state') {
            const linkPath = join(homedir(), '.local', 'bin', 'megabrain')
            return json({ linkPath, kind: 'missing', pointsTo: null, bundled: options.cliPath, dirOnPath: (options.path ?? process.env.PATH ?? '').split(sep).includes(dirname(linkPath)), resolvesTo: null })
          }
          if (name === 'link_cli') throw 'Linking the CLI needs the desktop app.'
          if (name === 'pill_geometry') return json({ x: 0, y: 0, width: 0, height: 0 })
          if (['set_tray_summary', 'set_pill_expanded', 'open_main'].includes(name)) return json(null)
          throw new UnknownCommand()
        } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof UnknownCommand ? 400 : 400) }
      }
      return new Response('Not found', { status: 404 })
    },
  })
  return { url: `http://${host}:${server.port}`, token, headers: { 'x-megabrain-token': token, 'content-type': 'application/json' }, stop: async () => {
    for (const stream of streams.values()) stopChild(stream.child)
    streams.clear(); listeners.clear()
    await Promise.all([...codeRoots].map(async (root) => { try { await output(command(options, ['code', 'stop', root])) } catch { /* best-effort shutdown, like closing the desktop app */ } }))
    codeRoots.clear()
    await server.stop(true)
  } }
}

class UnknownCommand extends Error {}
function strings(args: unknown) { if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw 'args must be an array of strings'; return args }
async function discoverRoots(options: BridgeOptions) {
  const result = await output(command(options, ['worktree', 'list', '--json']))
  if (result.code !== 0) throw `could not list registered worktrees: ${result.stderr.trim()}`
  let records: any[]
  try { records = JSON.parse(result.stdout) } catch { throw 'invalid worktree list' }
  return [...new Set(records.flatMap((record) => [record?.path, record?.repository?.path]).filter((path): path is string => typeof path === 'string'))]
}
async function stateDir(options: BridgeOptions) { return options.stateDir ?? process.env.MEGABRAIN_STATE_DIR ?? join(homedir(), '.megabrain') }
async function saveAttachment(options: BridgeOptions, encoded: string, extension: string) {
  const ext = extension.toLowerCase(); if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'].includes(ext)) throw 'unsupported attachment extension'
  if (encoded.length > 27_962_028) throw 'attachment exceeds the 20 MB limit'
  const bytes = Buffer.from(encoded, 'base64'); if (bytes.length > 20 * 1024 * 1024) throw 'attachment exceeds the 20 MB limit'
  const directory = join(await stateDir(options), 'attachments'); await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw 'attachment directory must be a real directory'
  const path = join(directory, `${crypto.randomUUID()}.${ext}`); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); return await realpath(path)
}
async function appendTrace(options: BridgeOptions, name: string, record: unknown) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw 'a trace record must be a JSON object'
  const path = join(await stateDir(options), 'logs', name === 'switch_trace_log' ? 'desktop-switch.log' : 'desktop-chat-start.log')
  await mkdir(dirname(path), { recursive: true }); await appendFile(path, `${JSON.stringify(record)}\n`)
}

