import { describe, expect, test } from 'bun:test'
import type { SlashCommand } from '@/api/schema'
import { createCommandSource, menuNotice, mergeInitCommands, type CommandList } from '@/chat/slash-commands'

function command(name: string, source: SlashCommand['source'], description: string | null = null): SlashCommand {
  return { name, source, description }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('slash commands before a chat starts', () => {
  test('loads the agent and folder list without any chat event', async () => {
    const calls: string[] = []
    const source = createCommandSource(async (agent, cwd) => {
      calls.push(`${agent} ${cwd}`)
      return [command('compact', 'builtin')]
    })
    expect(await source.load('claude', '/Users/operator/project')).toEqual([command('compact', 'builtin')])
    expect(calls).toEqual(['claude /Users/operator/project'])
  })

  test('shares one call while it runs and keeps a good list', async () => {
    let calls = 0
    const source = createCommandSource(async () => {
      calls += 1
      return [command('model', 'builtin')]
    })
    await Promise.all([source.load('codex', '/p'), source.load('codex', '/p')])
    await source.load('codex', '/p')
    expect(calls).toBe(1)
    expect(source.peek('codex', '/p')).toEqual([command('model', 'builtin')])
  })

  test('a failed call is not remembered: the next load asks again', async () => {
    let calls = 0
    const source = createCommandSource(async () => {
      calls += 1
      if (calls === 1) throw new Error('megabrain commands exited 1')
      return [command('help', 'builtin')]
    })
    await expect(source.load('claude', '/p')).rejects.toThrow('megabrain commands exited 1')
    expect(await source.load('claude', '/p')).toEqual([command('help', 'builtin')])
    expect(calls).toBe(2)
  })

  test('an empty answer is not remembered either', async () => {
    let calls = 0
    const source = createCommandSource(async () => {
      calls += 1
      return calls === 1 ? [] : [command('help', 'builtin')]
    })
    expect(await source.load('grok', '/p')).toEqual([])
    expect(await source.load('grok', '/p')).toEqual([command('help', 'builtin')])
  })

  test('a call that never answers fails after the timeout instead of hanging the menu', async () => {
    const source = createCommandSource(() => new Promise<SlashCommand[]>(() => {}), { timeoutMs: 20 })
    await expect(source.load('claude', '/p')).rejects.toThrow(/did not answer/)
  })

  test('refresh asks again even with a good list, and keeps the old list until the new one lands', async () => {
    const answers = [deferred<SlashCommand[]>(), deferred<SlashCommand[]>()]
    let calls = 0
    const source = createCommandSource(() => (answers[calls++] ?? deferred<SlashCommand[]>()).promise)
    const first = source.load('claude', '/p')
    answers[0]?.resolve([command('old', 'builtin')])
    await first
    const second = source.load('claude', '/p', { refresh: true })
    expect(source.peek('claude', '/p')).toEqual([command('old', 'builtin')])
    answers[1]?.resolve([command('new', 'builtin')])
    expect(await second).toEqual([command('new', 'builtin')])
    expect(source.peek('claude', '/p')).toEqual([command('new', 'builtin')])
  })

  test('agents and folders do not share a list', async () => {
    const source = createCommandSource(async (agent, cwd) => [command(`${agent}${cwd}`, 'builtin')])
    await source.load('claude', '/a')
    await source.load('codex', '/a')
    expect(source.peek('claude', '/a')).toEqual([command('claude/a', 'builtin')])
    expect(source.peek('codex', '/a')).toEqual([command('codex/a', 'builtin')])
    expect(source.peek('claude', '/b')).toBeUndefined()
  })
})

describe('merging the chat init list', () => {
  test('adds the names only the running agent reported, once', () => {
    const discovered = [command('compact', 'builtin', 'Compact'), command('review', 'skill', 'Review changes')]
    expect(mergeInitCommands(discovered, ['compact', 'review', 'add-dir', 'add-dir'])).toEqual([...discovered, command('add-dir', 'builtin')])
  })

  test('keeps the discovered list as it is without an init list', () => {
    const discovered = [command('compact', 'builtin')]
    expect(mergeInitCommands(discovered, undefined)).toBe(discovered)
    expect(mergeInitCommands(discovered, [])).toBe(discovered)
  })

  test('an init list alone still fills the menu when discovery failed', () => {
    expect(mergeInitCommands([], ['compact'])).toEqual([command('compact', 'builtin')])
  })
})

describe('what the menu says when it has no rows', () => {
  const list = (status: CommandList['status'], commands: SlashCommand[] = [], error: string | null = null): CommandList => ({ status, commands, error })

  test('a loading row while the first list is read', () => {
    expect(menuNotice(list('loading'), 'claude')).toEqual({ tone: 'loading', text: 'Loading commands…' })
  })

  test('an error row with the real failure text', () => {
    expect(menuNotice(list('error', [], 'megabrain commands exited 2'), 'claude')).toEqual({ tone: 'error', text: 'Could not load commands: megabrain commands exited 2' })
  })

  test('says the agent has none when the answer is empty', () => {
    expect(menuNotice(list('ready'), 'agy')).toEqual({ tone: 'empty', text: 'No commands for agy' })
  })

  test('nothing to say once commands are listed, even while a refresh runs or after it failed', () => {
    expect(menuNotice(list('ready', [command('help', 'builtin')]), 'claude')).toBeNull()
    expect(menuNotice(list('loading', [command('help', 'builtin')]), 'claude')).toBeNull()
    expect(menuNotice(list('error', [command('help', 'builtin')], 'boom'), 'claude')).toBeNull()
  })
})
