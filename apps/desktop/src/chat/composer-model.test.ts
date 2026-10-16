import { describe, expect, test } from 'bun:test'
import type { QueuedMessage, SlashCommand } from '@/api/schema'
import { attachmentKind, filterSlashCommands, groupSkills, insertSlashCommand, skillInvocation, slashQuery } from '@/chat/composer-model'
import { initialQueueState, queueReducer, type QueueState } from '@/chat/queue-model'

function command(name: string, fields: Partial<SlashCommand> = {}): SlashCommand {
  return { name, description: null, source: 'builtin', ...fields }
}

function queued(id: string, createdAt: string, fields: Partial<QueuedMessage> = {}): QueuedMessage {
  return { id, dispatch: 'd1', type: 'reply', createdAt, state: 'outstanding', text: `text of ${id}`, ...fields }
}

describe('slashQuery', () => {
  test('is the word after a leading slash while no space has been typed', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/com')).toBe('com')
  })

  test('is null once the command has an argument, or without a leading slash', () => {
    expect(slashQuery('/compact now')).toBeNull()
    expect(slashQuery('hello /compact')).toBeNull()
    expect(slashQuery(' /compact')).toBeNull()
    expect(slashQuery('')).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  const commands = [
    command('review', { description: 'Review a pull request' }),
    command('compact', { description: 'Clear history but keep a summary' }),
    command('model', { description: 'Set the AI model' }),
    command('deploy', { description: 'Deploy this project', source: 'project' }),
    command('megabrain', { description: 'Delegate work to other agents', source: 'skill' }),
  ]

  test('an empty query lists every command by name', () => {
    expect(filterSlashCommands(commands, '').map((item) => item.name)).toEqual(['compact', 'deploy', 'megabrain', 'model', 'review'])
  })

  test('name prefix beats name substring, which beats a description match', () => {
    const list = [command('xmod'), command('modal'), command('other', { description: 'changes the mode' }), command('unrelated')]
    expect(filterSlashCommands(list, 'mod').map((item) => item.name)).toEqual(['modal', 'xmod', 'other'])
  })

  test('an exact name comes first and matching ignores case', () => {
    const list = [command('models'), command('Model')]
    expect(filterSlashCommands(list, 'MODEL').map((item) => item.name)).toEqual(['Model', 'models'])
  })

  test('nothing matches yields an empty list', () => {
    expect(filterSlashCommands(commands, 'zzz')).toEqual([])
  })
})

describe('insertSlashCommand', () => {
  test('inserts the command followed by a space', () => {
    expect(insertSlashCommand('compact')).toBe('/compact ')
  })
})

describe('attachmentKind', () => {
  test('images and PDFs are accepted with their extension; other files are not', () => {
    expect(attachmentKind('image/png', 'shot.png')).toEqual({ kind: 'image', extension: 'png' })
    expect(attachmentKind('image/jpeg', 'photo.JPG')).toEqual({ kind: 'image', extension: 'jpg' })
    expect(attachmentKind('image/png', '')).toEqual({ kind: 'image', extension: 'png' })
    expect(attachmentKind('application/pdf', 'spec.pdf')).toEqual({ kind: 'pdf', extension: 'pdf' })
    expect(attachmentKind('text/plain', 'notes.txt')).toBeNull()
  })
})

describe('queueReducer', () => {
  const state = (fields: Partial<QueueState>): QueueState => ({ ...initialQueueState, ...fields })

  test('a refresh keeps only messages still waiting', () => {
    const next = queueReducer(initialQueueState, { type: 'refresh', items: [queued('q1', '2026-10-15T10:00:00Z'), queued('q2', '2026-10-15T10:01:00Z', { state: 'superseded' })] })
    expect(next.pending.map((item) => item.id)).toEqual(['q1'])
  })

  test('Esc in an empty composer takes the newest pending message back', () => {
    const before = state({ pending: [queued('old', '2026-10-15T10:00:00Z'), queued('new', '2026-10-15T10:05:00Z')] })
    const next = queueReducer(before, { type: 'escape', text: '' })
    expect(next.taking).toBe('new')
    expect(next.pending.map((item) => item.id)).toEqual(['old'])
  })

  test('Esc with text in the composer does nothing', () => {
    const before = state({ pending: [queued('q1', '2026-10-15T10:00:00Z')] })
    expect(queueReducer(before, { type: 'escape', text: 'draft' })).toEqual(before)
  })

  test('Esc while a message is being taken back does nothing more', () => {
    const before = state({ pending: [queued('q1', '2026-10-15T10:00:00Z')], taking: 'q2' })
    expect(queueReducer(before, { type: 'escape', text: '' })).toEqual(before)
  })

  test('Esc with nothing queued restores nothing and explains why', () => {
    const next = queueReducer(initialQueueState, { type: 'escape', text: '' })
    expect(next.taking).toBeNull()
    expect(next.restored).toBeNull()
    expect(next.hint).toContain('delivered')
  })

  test('a taken-back message is handed to the composer', () => {
    const next = queueReducer(state({ taking: 'q1' }), { type: 'restored', id: 'q1', text: 'edit me' })
    expect(next.taking).toBeNull()
    expect(next.restored).toEqual({ id: 'q1', text: 'edit me' })
  })

  test('a message delivered before it could be taken back says so', () => {
    const next = queueReducer(state({ taking: 'q1' }), { type: 'restore-failed', id: 'q1' })
    expect(next.taking).toBeNull()
    expect(next.restored).toBeNull()
    expect(next.hint).toContain('already delivered')
  })

  test('a refresh during a take-back does not show the message being taken', () => {
    const next = queueReducer(state({ taking: 'q1' }), { type: 'refresh', items: [queued('q1', '2026-10-15T10:00:00Z'), queued('q2', '2026-10-15T10:01:00Z')] })
    expect(next.pending.map((item) => item.id)).toEqual(['q2'])
  })

  test('typing clears the hint', () => {
    const next = queueReducer(state({ hint: 'something' }), { type: 'typed' })
    expect(next.hint).toBeNull()
  })
})

describe('groupSkills', () => {
  const commands = [
    command('compact', { description: 'Clear history but keep a summary' }),
    command('deploy', { description: 'Deploy this project', source: 'project' }),
    command('notes', { description: 'Personal notes', source: 'user' }),
    command('megabrain', { description: 'Delegate work to other agents', source: 'skill' }),
    command('docx', { description: 'Write Word documents', source: 'skill' }),
    command('caveman', { description: 'Terse replies', source: 'plugin' }),
    command('review-pr', { description: 'Review the current branch', source: 'plugin' }),
  ]

  test('lists only skills and plugin skills, skills first, each group by name', () => {
    expect(groupSkills(commands, '').map((group) => [group.source, group.items.map((item) => item.name)])).toEqual([
      ['skill', ['docx', 'megabrain']],
      ['plugin', ['caveman', 'review-pr']],
    ])
  })

  test('each group has a label', () => {
    expect(groupSkills(commands, '').map((group) => group.label)).toEqual(['Skills', 'Plugins'])
  })

  test('the search matches names and descriptions, best match first, and drops empty groups', () => {
    expect(groupSkills(commands, 'review').map((group) => [group.source, group.items.map((item) => item.name)])).toEqual([['plugin', ['review-pr']]])
    expect(groupSkills(commands, 'agents').map((group) => group.items.map((item) => item.name))).toEqual([['megabrain']])
    expect(groupSkills(commands, 'MEGA').map((group) => group.items.map((item) => item.name))).toEqual([['megabrain']])
  })

  test('no skills, or nothing matching, is no groups', () => {
    expect(groupSkills([command('compact')], '')).toEqual([])
    expect(groupSkills(commands, 'zzz')).toEqual([])
  })
})

describe('skillInvocation', () => {
  test('Claude and the others take a slash command and a space for the argument', () => {
    expect(skillInvocation('claude', 'megabrain')).toBe('/megabrain ')
    expect(skillInvocation('grok', 'megabrain')).toBe('/megabrain ')
  })

  test('Codex mentions a skill with a dollar sign', () => {
    expect(skillInvocation('codex', 'megabrain')).toBe('$megabrain ')
  })
})
