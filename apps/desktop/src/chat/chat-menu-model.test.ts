import { describe, expect, test } from 'bun:test'
import { chatMenu, composerMenu, insertBlock, quoteText, toolCommand, type ChatMenuTarget } from '@/chat/chat-menu-model'

const none: ChatMenuTarget = { selection: '', message: null, code: null, tool: null, image: null, link: null, linkOpensFile: false, canCompose: true }
const actions = (entries: ReturnType<typeof chatMenu>) => entries.map((entry) => ('separator' in entry ? '-' : entry.action))

describe('chatMenu', () => {
  test('empty space offers only scrolling to the bottom', () => {
    expect(actions(chatMenu(none))).toEqual(['scroll-bottom'])
  })

  test('a message copies, copies as plain text, quotes and selects', () => {
    const entries = chatMenu({ ...none, message: { markdown: '**hi**' } })
    expect(actions(entries)).toEqual(['copy', 'copy-plain', 'quote', 'select-message', '-', 'scroll-bottom'])
    expect(entries[0]).toMatchObject({ label: 'Copy' })
  })

  test('with no selection Copy has no shortcut, since the key copies only a selection', () => {
    const [copy] = chatMenu({ ...none, message: { markdown: 'hi' } })
    expect(copy).not.toHaveProperty('shortcut')
  })

  test('a selection inside a message makes Copy copy it, with the copy shortcut', () => {
    const [copy] = chatMenu({ ...none, selection: 'part', message: { markdown: 'a part of it' } })
    expect(copy).toMatchObject({ action: 'copy', label: 'Copy', shortcut: 'mod+c' })
  })

  test('a selection outside any message copies and quotes it', () => {
    expect(actions(chatMenu({ ...none, selection: 'output line' }))).toEqual(['copy', 'quote', '-', 'scroll-bottom'])
  })

  test('without a composer to write into, quoting is not offered', () => {
    expect(actions(chatMenu({ ...none, canCompose: false, message: { markdown: 'hi' } }))).toEqual(['copy', 'copy-plain', 'select-message', '-', 'scroll-bottom'])
  })

  test('a code block copies its code or inserts it, above the message actions', () => {
    expect(actions(chatMenu({ ...none, code: 'ls -la', message: { markdown: '```\nls -la\n```' } }))).toEqual([
      'copy-code',
      'insert-code',
      '-',
      'copy',
      'copy-plain',
      'quote',
      'select-message',
      '-',
      'scroll-bottom',
    ])
  })

  test('a code block cannot be inserted without a composer', () => {
    expect(actions(chatMenu({ ...none, canCompose: false, code: 'x' }))).toEqual(['copy-code', '-', 'scroll-bottom'])
  })

  test('a shell tool call copies its command and its output', () => {
    const entries = chatMenu({ ...none, tool: { command: 'git status', input: '{"command":"git status"}', output: 'clean' } })
    expect(actions(entries)).toEqual(['copy-input', 'copy-output', '-', 'scroll-bottom'])
    expect(entries[0]).toMatchObject({ label: 'Copy command' })
  })

  test('another tool call copies its input', () => {
    const [input] = chatMenu({ ...none, tool: { command: null, input: '{"path":"a.ts"}', output: null } })
    expect(input).toMatchObject({ action: 'copy-input', label: 'Copy input' })
  })

  test('a tool call still running has no output to copy', () => {
    expect(actions(chatMenu({ ...none, tool: { command: null, input: '{}', output: null } }))).toEqual(['copy-input', '-', 'scroll-bottom'])
  })

  test('an image copies, saves and opens in the viewer', () => {
    const entries = chatMenu({ ...none, image: { viewer: true }, message: { markdown: '[Image #1]' } })
    expect(actions(entries)).toEqual(['copy-image', 'save-image', 'open-image', '-', 'copy', 'copy-plain', 'quote', 'select-message', '-', 'scroll-bottom'])
    expect(entries[1]).toMatchObject({ label: 'Save image as…' })
  })

  test('an image with no viewer is not offered one', () => {
    expect(actions(chatMenu({ ...none, image: { viewer: false } }))).toEqual(['copy-image', 'save-image', '-', 'scroll-bottom'])
  })

  test('a web link opens and copies, before everything else', () => {
    expect(actions(chatMenu({ ...none, link: 'https://example.com', message: { markdown: 'see [it](https://example.com)' } }))).toEqual([
      'open-link',
      'copy-link',
      '-',
      'copy',
      'copy-plain',
      'quote',
      'select-message',
      '-',
      'scroll-bottom',
    ])
  })

  test('a link the system cannot open is only copied', () => {
    expect(actions(chatMenu({ ...none, link: 'javascript:alert(1)' }))).toEqual(['copy-link', '-', 'scroll-bottom'])
    expect(actions(chatMenu({ ...none, link: 'mailto:a@b.c' }))).toEqual(['open-link', 'copy-link', '-', 'scroll-bottom'])
  })

  test('a link to a local file Code can open is offered in Code, then copied', () => {
    const menu = chatMenu({ ...none, link: '/Users/operator/project/report.csv', linkOpensFile: true })
    expect(actions(menu)).toEqual(['open-file', 'copy-link', '-', 'scroll-bottom'])
    expect(menu[0]).toEqual({ action: 'open-file', label: 'Open in Code' })
  })
})

describe('composerMenu', () => {
  const actionsOf = (entries: ReturnType<typeof composerMenu>) => entries.map((entry) => ('separator' in entry ? '-' : entry.action))
  const find = (entries: ReturnType<typeof composerMenu>, action: string) => entries.find((entry) => !('separator' in entry) && entry.action === action)

  test('lists the edit actions, then attaching and clearing', () => {
    expect(actionsOf(composerMenu({ hasSelection: true, empty: false, disabled: false }))).toEqual(['cut', 'copy', 'paste', 'paste-plain', 'select-all', '-', 'attach', 'clear'])
  })

  test('each edit action shows its shortcut', () => {
    const entries = composerMenu({ hasSelection: true, empty: false, disabled: false })
    expect(find(entries, 'cut')).toMatchObject({ label: 'Cut', shortcut: 'mod+x' })
    expect(find(entries, 'copy')).toMatchObject({ label: 'Copy', shortcut: 'mod+c' })
    expect(find(entries, 'paste')).toMatchObject({ label: 'Paste', shortcut: 'mod+v' })
    expect(find(entries, 'paste-plain')).toMatchObject({ label: 'Paste as plain text', shortcut: 'mod+shift+alt+v' })
    expect(find(entries, 'select-all')).toMatchObject({ label: 'Select all', shortcut: 'mod+a' })
    expect(find(entries, 'attach')).toMatchObject({ label: 'Attach file…' })
  })

  test('cut and copy need a selection', () => {
    const entries = composerMenu({ hasSelection: false, empty: false, disabled: false })
    expect(find(entries, 'cut')).toMatchObject({ disabled: true })
    expect(find(entries, 'copy')).toMatchObject({ disabled: true })
    expect(find(entries, 'paste')).toMatchObject({ disabled: false })
  })

  test('an empty box has nothing to select or clear', () => {
    const entries = composerMenu({ hasSelection: false, empty: true, disabled: false })
    expect(find(entries, 'select-all')).toMatchObject({ disabled: true })
    expect(find(entries, 'clear')).toMatchObject({ disabled: true })
  })

  test('a disabled box only copies what is selected', () => {
    const entries = composerMenu({ hasSelection: true, empty: false, disabled: true })
    expect(find(entries, 'copy')).toMatchObject({ disabled: false })
    for (const action of ['cut', 'paste', 'paste-plain', 'attach', 'clear']) expect(find(entries, action)).toMatchObject({ disabled: true })
  })
})

describe('quoteText', () => {
  test('prefixes every line and ends with a blank line to write under', () => {
    expect(quoteText('one\ntwo')).toBe('> one\n> two\n\n')
  })

  test('keeps blank lines inside the quote as bare markers', () => {
    expect(quoteText('one\n\ntwo')).toBe('> one\n>\n> two\n\n')
  })

  test('drops the blank lines around the text and normalises line endings', () => {
    expect(quoteText('\n\r\none\r\ntwo  \n\n')).toBe('> one\n> two\n\n')
  })

  test('nothing to quote gives nothing', () => {
    expect(quoteText('  \n ')).toBe('')
  })
})

describe('insertBlock', () => {
  test('goes in as it is at the start of the box or after a blank line', () => {
    expect(insertBlock('', '> a\n\n')).toBe('> a\n\n')
    expect(insertBlock('text\n\n', '> a\n\n')).toBe('> a\n\n')
  })

  test('starts on a fresh paragraph after text', () => {
    expect(insertBlock('text', '> a\n\n')).toBe('\n\n> a\n\n')
    expect(insertBlock('text\n', '> a\n\n')).toBe('\n> a\n\n')
  })
})

describe('toolCommand', () => {
  test('reads the command of a shell call', () => {
    expect(toolCommand('{"command":"git status","description":"x"}')).toBe('git status')
  })

  test('other input has no command', () => {
    expect(toolCommand('{"path":"a.ts"}')).toBeNull()
    expect(toolCommand('not json')).toBeNull()
    expect(toolCommand('{"command":3}')).toBeNull()
    expect(toolCommand(undefined)).toBeNull()
  })
})
