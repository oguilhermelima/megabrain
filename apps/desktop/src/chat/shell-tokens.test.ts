import { describe, expect, test } from 'bun:test'
import { isShellFence, shellLines, type ShellToken } from '@/chat/shell-tokens'

// Plain text runs carry the spaces between words; each word in them is listed on its own.
const kinds = (tokens: ShellToken[] | undefined) => (tokens ?? []).flatMap((token) => (token.kind === 'text' ? token.text.split(/\s+/).filter((part) => part !== '').map((part) => `text:${part}`) : [`${token.kind}:${token.text}`]))
const line = (text: string) => kinds(shellLines(text)[0])

describe('isShellFence', () => {
  test('tagged sh, bash, zsh, shell or console', () => {
    for (const language of ['sh', 'bash', 'zsh', 'shell', 'console', 'Bash']) expect(isShellFence(language, 'ls')).toBe(true)
  })

  test('other languages are not shell, whatever their text', () => {
    expect(isShellFence('ts', '$ ls')).toBe(false)
    expect(isShellFence('python', 'print(1)')).toBe(false)
  })

  test('untagged with its first line at a dollar prompt', () => {
    expect(isShellFence(null, '\n$ bun test\n12 pass')).toBe(true)
  })

  test('untagged without a prompt is not shell', () => {
    expect(isShellFence(null, 'just some text\n$ later')).toBe(false)
    expect(isShellFence(null, '$5 is the price')).toBe(false)
    expect(isShellFence(null, '')).toBe(false)
  })
})

describe('shellLines', () => {
  test('the command name, its flags and its arguments', () => {
    expect(line('git log --oneline -3 main')).toEqual(['command:git', 'text:log', 'flag:--oneline', 'flag:-3', 'text:main'])
  })

  test('quoted strings, both kinds, with an escaped quote inside', () => {
    expect(line(`echo 'one two' "say \\"hi\\""`)).toEqual(['command:echo', "string:'one two'", 'string:"say \\"hi\\""'])
  })

  test('a string left open runs to the end of the line', () => {
    expect(line('echo "open')).toEqual(['command:echo', 'string:"open'])
  })

  test('variables, braced or not, and a flag with a value', () => {
    expect(line('cp $HOME/a ${TARGET:-/tmp} --mode=$MODE')).toEqual(['command:cp', 'variable:$HOME', 'text:/a', 'variable:${TARGET:-/tmp}', 'flag:--mode=', 'variable:$MODE'])
  })

  test('the word after a pipe, and-and, or-or or semicolon is a command again', () => {
    expect(line('cat a | grep -n x && wc -l; ls || true')).toEqual(['command:cat', 'text:a', 'operator:|', 'command:grep', 'flag:-n', 'text:x', 'operator:&&', 'command:wc', 'flag:-l', 'operator:;', 'command:ls', 'operator:||', 'command:true'])
  })

  test('a redirect is an operator and the word after it is no command', () => {
    expect(line('bun test > log 2>&1')).toEqual(['command:bun', 'text:test', 'operator:>', 'text:log', 'operator:2>&1'])
  })

  test('sudo, env and assignments before the command keep the command coloured', () => {
    expect(line('sudo rm -rf build')).toEqual(['command:sudo', 'command:rm', 'flag:-rf', 'text:build'])
    expect(line('FOO=1 env BAR=2 bun run dev')).toEqual(['variable:FOO=1', 'command:env', 'variable:BAR=2', 'command:bun', 'text:run', 'text:dev'])
  })

  test('a command substitution starts a command', () => {
    expect(line('echo $(git rev-parse HEAD)')).toEqual(['command:echo', 'operator:$(', 'command:git', 'text:rev-parse', 'text:HEAD', 'operator:)'])
  })

  test('a comment runs to the end of the line, a hash inside a word does not', () => {
    expect(line('ls # list')).toEqual(['command:ls', 'comment:# list'])
    expect(line('curl a#b')).toEqual(['command:curl', 'text:a#b'])
  })

  test('a console session: prompt lines are commands, the rest output', () => {
    const lines = shellLines('$ bun test --watch\n 12 pass\n$ ls')
    expect(kinds(lines[0])).toEqual(['prompt:$ ', 'command:bun', 'text:test', 'flag:--watch'])
    expect(lines[1]).toEqual([{ kind: 'text', text: ' 12 pass' }])
    expect(kinds(lines[2])).toEqual(['prompt:$ ', 'command:ls'])
  })

  test('a line ending in a backslash goes on into the next, with no command there', () => {
    const lines = shellLines('$ docker run \\\n  --rm image\nout')
    expect(kinds(lines[1])).toEqual(['flag:--rm', 'text:image'])
    expect(kinds(lines[2])).toEqual(['text:out'])
  })

  test('a script: every line starts a command', () => {
    expect(shellLines('cd app\nbun install').map(kinds)).toEqual([['command:cd', 'text:app'], ['command:bun', 'text:install']])
  })

  test('the tokens join back into the text exactly', () => {
    const texts = ['$ git commit -m "feat: x" && echo ${A}; ls >> out # done\nout put\n', 'a=1 b|c&&d;e(f)g<h>i $ $1 $@ \\ "x', '', '\n\n', 'echo `date` \'it\'s\'']
    for (const text of texts) expect(shellLines(text).map((tokens) => tokens.map((token) => token.text).join('')).join('\n')).toBe(text)
  })
})
