import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWebBridge } from './web-bridge'

const servers: Array<Awaited<ReturnType<typeof startWebBridge>>> = []
const scratch: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function tempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(path)
  return path
}

async function fixtureRepo() {
  const parent = await tempDir('web-bridge-repo-')
  const root = join(parent, 'repo')
  await mkdir(root)
  const git = async (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: root })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  await git('init', '-q')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
  await writeFile(join(root, 'tracked.txt'), 'before\n')
  await git('add', 'tracked.txt')
  await git('commit', '-qm', 'initial')
  return { root, git }
}

async function bridge(options: Parameters<typeof startWebBridge>[0] = {}) {
  const server = await startWebBridge({
    cliPath: '/bin/echo',
    cliRoot: '/tmp',
    allowedRoots: [],
    ...options,
  })
  servers.push(server)
  return server
}

describe('web bridge trust boundary', () => {
  test('binds only to IPv4 loopback and requires the generated token', async () => {
    const server = await bridge()
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const missing = await fetch(`${server.url}/invoke`, { method: 'POST', body: JSON.stringify({ command: 'unknown' }) })
    expect(missing.status).toBe(401)
    const wrong = await fetch(`${server.url}/invoke?token=wrong`, { method: 'POST', body: '{}' })
    expect(wrong.status).toBe(401)
  })

  test('refuses non-loopback bind requests', async () => {
    await expect(startWebBridge({ host: '0.0.0.0', cliPath: '/bin/echo', cliRoot: '/tmp' })).rejects.toThrow(/127\.0\.0\.1/)
  })

  test('refuses unknown commands', async () => {
    const server = await bridge()
    const response = await fetch(`${server.url}/invoke`, {
      method: 'POST', headers: server.headers, body: JSON.stringify({ command: 'not_a_command' }),
    })
    expect(response.status).toBe(400)
  })

  test('run_cli returns the native code/stdout/stderr shape', async () => {
    const server = await bridge({ cliPath: '/bin/sh' })
    const response = await fetch(`${server.url}/invoke`, {
      method: 'POST', headers: server.headers,
      body: JSON.stringify({ command: 'run_cli', args: ['-c', 'printf out; printf err >&2; exit 7'] }),
    })
    expect(await response.json()).toEqual({ code: 7, stdout: 'out', stderr: 'err' })
  })

  test('streams stdout lines and can stop a running CLI stream', async () => {
    const server = await bridge({ cliPath: '/bin/sh' })
    const started = await fetch(`${server.url}/stream`, {
      method: 'POST', headers: server.headers,
      body: JSON.stringify({ command: 'cli_stream', args: ['-c', 'printf "one\\ntwo\\n"; sleep 10'] }),
    })
    const { streamId } = await started.json() as { streamId: string }
    const response = await fetch(`${server.url}/events/${streamId}`, { headers: server.headers })
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('one')
    expect(new TextDecoder().decode(first.value)).toContain('two')
    await fetch(`${server.url}/stream/${streamId}/stop`, { method: 'POST', headers: server.headers })
    await reader.cancel()
  })
})

describe('web bridge code commands', () => {
  test('matches Rust code tree, read, change, and diff output on a fixture repo', async () => {
    const { root, git } = await fixtureRepo()
    await mkdir(join(root, 'alpha', 'inner'), { recursive: true })
    await writeFile(join(root, 'alpha', 'inner', 'b.txt'), 'bb')
    await writeFile(join(root, 'alpha', 'a.txt'), 'a')
    await writeFile(join(root, '.gitignore'), 'ignored.txt\nnode_modules/\n')
    await writeFile(join(root, 'ignored.txt'), 'ignored')
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'ignored')
    const server = await bridge({ allowedRoots: [root] })
    const call = async (command: string, args: Record<string, unknown>) => {
      const response = await fetch(`${server.url}/invoke`, {
        method: 'POST', headers: server.headers, body: JSON.stringify({ command, ...args }),
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    const tree = await call('code_tree', { root }) as Array<{ path: string; kind: string; size: number | null }>
    expect(tree.map((entry) => entry.path)).toEqual(['alpha', 'alpha/inner', 'alpha/inner/b.txt', 'alpha/a.txt', '.gitignore', 'tracked.txt'])
    expect(await call('code_read', { root, path: 'alpha/a.txt' })).toEqual({ path: 'alpha/a.txt', text: 'a', binary: false, tooLarge: false })
    await writeFile(join(root, 'tracked.txt'), 'after\n')
    const changes = await call('code_changes', { root }) as Array<{ path: string; status: string }>
    expect(changes).toContainEqual({ path: 'tracked.txt', status: 'modified' })
    expect(await call('code_diff', { root, path: 'tracked.txt' })).toEqual({ path: 'tracked.txt', original: 'before\n', modified: 'after\n', binary: false, tooLarge: false })
    await git('add', 'tracked.txt')
    await git('commit', '-qm', 'change')
    const branch = await call('code_branch_changes', { root, parent: 'HEAD~1' }) as { base: string; mergeBase: string; changes: unknown[] }
    expect(branch.base).toBe('HEAD~1')
    expect(branch.mergeBase).toBeTruthy()
    expect(branch.changes).toContainEqual({ path: 'tracked.txt', status: 'modified' })
    expect(await call('code_branch_diff', { root, mergeBase: branch.mergeBase, path: 'tracked.txt' })).toEqual({ path: 'tracked.txt', original: 'before\n', modified: 'after\n', binary: false, tooLarge: false })
  })

  test('refuses roots outside the registered worktree allowlist and path traversal', async () => {
    const { root } = await fixtureRepo()
    const server = await bridge({ allowedRoots: [] })
    const call = (args: object) => fetch(`${server.url}/invoke`, {
      method: 'POST', headers: server.headers, body: JSON.stringify(args),
    })
    expect((await call({ command: 'code_tree', root })).status).toBe(400)
    const allowed = await bridge({ allowedRoots: [root] })
    const traversal = await fetch(`${allowed.url}/invoke`, {
      method: 'POST', headers: allowed.headers, body: JSON.stringify({ command: 'code_read', root, path: '../outside' }),
    })
    expect(traversal.status).toBe(400)
  })
})
