// Colours for shell commands in a message's code block. Only what a reader scans for: the command run,
// its flags, quoted strings, variables, operators and comments. Each line is cut into tokens whose
// texts join back into the line exactly, so the block reads and copies as it was written.

export type ShellTokenKind = 'prompt' | 'command' | 'flag' | 'string' | 'variable' | 'operator' | 'comment' | 'text'

export interface ShellToken {
  kind: ShellTokenKind
  text: string
}

const shellLanguages = new Set(['sh', 'bash', 'zsh', 'shell', 'console'])
const prompt = /^\$ /
// Words that run the next word as the command: it is coloured as the command too.
const prefixes = new Set(['sudo', 'env', 'time', 'exec', 'nohup', 'command', 'builtin', 'xargs'])
// After these the next word is a command again.
const separators = new Set(['|', '||', '&&', ';', '&', '(', '$(', '|&'])
const operator = /^(?:\$\(|\|\||\|&|&&|>>|&>|\d?>&?\d?|[|;&()<>])/
const variable = /^\$(?:\{[^}]*\}?|[A-Za-z_]\w*|[0-9@*#?$!-])/
const word = /^[^\s'"`|;&()<>$]+/

/**
 * Whether a fence is shell: tagged sh, bash, zsh, shell or console, or untagged with its first line at a
 * dollar prompt.
 */
export function isShellFence(language: string | null, text: string): boolean {
  if (language !== null) return shellLanguages.has(language.toLowerCase())
  const first = text.split('\n').find((line) => line.trim() !== '')
  return first !== undefined && prompt.test(first)
}

/** One line's tokens. `command` says whether the line starts where a command name goes. */
function lineTokens(line: string, command: boolean): ShellToken[] {
  const tokens: ShellToken[] = []
  let expect = command
  let rest = line
  const push = (kind: ShellTokenKind, text: string) => {
    const last = tokens.at(-1)
    if (last !== undefined && last.kind === kind && kind === 'text') last.text += text
    else tokens.push({ kind, text })
    rest = rest.slice(text.length)
  }
  while (rest !== '') {
    const space = /^\s+/.exec(rest)?.[0]
    if (space !== undefined) {
      push('text', space)
      continue
    }
    const atWordStart = tokens.length === 0 || /\s$/.test(tokens.at(-1)?.text ?? '')
    if (rest.startsWith('#') && atWordStart) {
      push('comment', rest)
      continue
    }
    const head = rest[0] ?? ''
    if (head === '\\') {
      push('text', rest.slice(0, 2))
      continue
    }
    if (head === "'" || head === '"' || head === '`') {
      let end = 1
      while (end < rest.length && rest[end] !== head) end += head !== "'" && rest[end] === '\\' ? 2 : 1
      push('string', rest.slice(0, Math.min(end + 1, rest.length)))
      expect = false
      continue
    }
    const op = operator.exec(rest)?.[0]
    if (op !== undefined && !(head === '$' && op !== '$(')) {
      push('operator', op)
      expect = separators.has(op)
      continue
    }
    const name = variable.exec(rest)?.[0]
    if (name !== undefined) {
      push('variable', name)
      expect = false
      continue
    }
    const found = word.exec(rest)?.[0] ?? head
    if (expect && /^[A-Za-z_]\w*=/.test(found)) push('variable', found)
    else if (expect) {
      push('command', found)
      expect = prefixes.has(found)
    } else push(found.startsWith('-') && found.length > 1 ? 'flag' : 'text', found)
  }
  return tokens
}

/**
 * Each line of a shell block as tokens. When any line starts at a dollar prompt the block is a console
 * session: prompt lines are commands, the others their output. Otherwise every line is script. A line
 * ending in a backslash goes on into the next, whose first word is no command.
 */
export function shellLines(text: string): ShellToken[][] {
  const lines = text.split('\n')
  const session = lines.some((line) => prompt.test(line))
  let continued = false
  return lines.map((line) => {
    const goesOn = continued
    continued = /\\$/.test(line)
    if (session && !goesOn) {
      if (!prompt.test(line)) {
        continued = false
        return line === '' ? [] : [{ kind: 'text', text: line }]
      }
      return [{ kind: 'prompt', text: '$ ' }, ...lineTokens(line.slice(2), true)]
    }
    return lineTokens(line, !goesOn)
  })
}
