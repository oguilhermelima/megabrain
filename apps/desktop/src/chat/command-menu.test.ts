import { describe, expect, test } from 'bun:test'
import type { SlashCommand } from '@/api/schema'
import { commandKey, commandSections, fuzzyMatch, rememberPick } from '@/chat/command-menu'

function command(name: string, source: SlashCommand['source'], description: string | null = null): SlashCommand {
  return { name, source, description }
}

const commands: SlashCommand[] = [
  command('model', 'builtin', 'Switch the model'),
  command('compact', 'builtin', 'Compact the conversation'),
  command('review', 'user', 'Review the current diff'),
  command('deploy', 'project', 'Ship to staging'),
  command('megabrain', 'skill', 'Delegate work to other agents'),
  command('motion-design', 'skill', 'Animation principles'),
  command('caveman:caveman-commit', 'plugin', 'Terse commit messages'),
]

const names = (sections: ReturnType<typeof commandSections>) => sections.map((section) => [section.id, section.items.map((item) => item.command.name)])

describe('fuzzyMatch', () => {
  test('an empty query matches everything with no highlight', () => {
    expect(fuzzyMatch('', 'model', null)).toEqual({ score: 0, field: 'name', ranges: [] })
  })

  test('exact name beats prefix, which beats substring, which beats a scattered match', () => {
    const exact = fuzzyMatch('mod', 'mod', null)
    const prefix = fuzzyMatch('mod', 'model', null)
    const substring = fuzzyMatch('mod', 'remodel', null)
    const scattered = fuzzyMatch('mod', 'motion-design', null)
    expect(exact?.score).toBeLessThan(prefix?.score ?? Infinity)
    expect(prefix?.score).toBeLessThan(substring?.score ?? Infinity)
    expect(substring?.score).toBeLessThan(scattered?.score ?? Infinity)
  })

  test('highlight ranges cover the matched letters, contiguous ones merged, end exclusive', () => {
    expect(fuzzyMatch('mod', 'model', null)?.ranges).toEqual([[0, 3]])
    expect(fuzzyMatch('mod', 'remodel', null)?.ranges).toEqual([[2, 5]])
    expect(fuzzyMatch('mdn', 'motion-design', null)?.ranges).toEqual([
      [0, 1],
      [7, 8],
      [12, 13],
    ])
  })

  test('matching ignores case and keeps the name as written', () => {
    expect(fuzzyMatch('CAV', 'caveman:caveman-commit', null)?.ranges).toEqual([[0, 3]])
  })

  test('a query only the description holds matches there, after every name match', () => {
    const description = fuzzyMatch('staging', 'deploy', 'Ship to staging')
    expect(description).toEqual({ score: expect.any(Number), field: 'description', ranges: [[8, 15]] })
    expect(description?.score).toBeGreaterThan(fuzzyMatch('dpy', 'deploy', null)?.score ?? Infinity)
  })

  test('letters out of order, or missing, do not match', () => {
    expect(fuzzyMatch('ledom', 'model', 'Switch')).toBeNull()
    expect(fuzzyMatch('xyz', 'model', 'Switch the model')).toBeNull()
  })
})

describe('commandSections', () => {
  test('sections in a fixed order, Skills, Plugins, Commands, Built-in, each by name with its count', () => {
    const sections = commandSections(commands, '', [])
    expect(names(sections)).toEqual([
      ['skills', ['megabrain', 'motion-design']],
      ['plugins', ['caveman:caveman-commit']],
      ['commands', ['deploy', 'review']],
      ['builtin', ['compact', 'model']],
    ])
    expect(sections.map((section) => [section.label, section.count])).toEqual([
      ['Skills', 2],
      ['Plugins', 1],
      ['Commands', 2],
      ['Built-in', 2],
    ])
  })

  test('recent picks come first in a Recent section, newest first, while nothing is typed', () => {
    const recent = [commandKey(commands[2] as SlashCommand), commandKey(commands[0] as SlashCommand), 'skill:gone']
    const sections = commandSections(commands, '', recent)
    expect(names(sections)[0]).toEqual(['recent', ['review', 'model']])
    expect(sections[0]?.label).toBe('Recent')
  })

  test('the Recent section keeps at most five', () => {
    const many = Array.from({ length: 8 }, (_, index) => command(`skill-${index}`, 'skill'))
    const sections = commandSections(many, '', many.map(commandKey))
    expect(sections[0]?.items).toHaveLength(5)
  })

  test('a search drops the Recent section, keeps matching items only and puts the best section first', () => {
    const sections = commandSections(commands, 'model', [commandKey(commands[2] as SlashCommand)])
    expect(names(sections)[0]).toEqual(['builtin', ['model']])
    expect(sections.some((section) => section.id === 'recent')).toBe(false)
    expect(sections.every((section) => section.count === section.items.length && section.count > 0)).toBe(true)
  })

  test('within a section the better match comes first, then the more recent pick', () => {
    const list = [command('commit', 'skill'), command('commit-push', 'skill'), command('compact-commit', 'skill')]
    expect(names(commandSections(list, 'commit', []))).toEqual([['skills', ['commit', 'commit-push', 'compact-commit']]])
    const tied = [command('alpha', 'skill', 'release notes'), command('beta', 'skill', 'release notes')]
    expect(names(commandSections(tied, 'release', [commandKey(tied[1] as SlashCommand)]))).toEqual([['skills', ['beta', 'alpha']]])
  })

  test('a source filter keeps only those sections', () => {
    expect(commandSections(commands, '', [], { sources: ['skill', 'plugin'] }).map((section) => section.id)).toEqual(['skills', 'plugins'])
  })

  test('nothing matches yields no sections, for the empty state', () => {
    expect(commandSections(commands, 'qqqq', [])).toEqual([])
  })
})

describe('rememberPick', () => {
  test('the pick moves to the front once, and the list keeps a limit', () => {
    expect(rememberPick(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(rememberPick(['a', 'b'], 'c', 2)).toEqual(['c', 'a'])
  })
})
