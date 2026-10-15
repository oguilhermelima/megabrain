import type { SlashCommand } from '@/api/schema'

// Pure logic for the composer: which slash commands match what is typed, and how they are inserted.

/** The command word being typed after a leading slash, or null once there is none or a space follows. */
export function slashQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text)
  return match === null ? null : (match[1] ?? '')
}

/** Rank 0 exact name, 1 name prefix, 2 name substring, 3 description substring; null for no match. */
function rank(command: SlashCommand, query: string): number | null {
  const name = command.name.toLowerCase()
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  if ((command.description ?? '').toLowerCase().includes(query)) return 3
  return null
}

/** The commands matching a query, best match first and by name within the same rank. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const needle = query.toLowerCase()
  return commands
    .map((command) => ({ command, rank: rank(command, needle) }))
    .filter((entry): entry is { command: SlashCommand; rank: number } => entry.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.command.name.localeCompare(right.command.name))
    .map((entry) => entry.command)
}

/** What the composer holds after a command is picked: the command and a space for its argument. */
export function insertSlashCommand(name: string): string {
  return `/${name} `
}

/**
 * The message with each attachment's path on its own line after the text: Claude Code and Codex
 * take an image or a PDF from a terminal as its path.
 */
export function appendAttachmentPaths(text: string, paths: string[]): string {
  return [text.trim(), ...paths].filter((line) => line !== '').join('\n')
}

export interface AttachmentKind {
  kind: 'image' | 'pdf'
  extension: string
}

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tiff'])
const mimeExtensions: Record<string, string> = { jpeg: 'jpg', 'svg+xml': 'svg', tiff: 'tiff' }

/** Whether a file can go with a message, by its MIME type or else its name: images and PDFs only. */
export function attachmentKind(mime: string, name: string): AttachmentKind | null {
  const dot = name.lastIndexOf('.')
  const fromName = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (mime === 'application/pdf' || (mime === '' && fromName === 'pdf')) return { kind: 'pdf', extension: 'pdf' }
  if (mime.startsWith('image/')) {
    const subtype = mime.slice('image/'.length)
    return { kind: 'image', extension: fromName === '' ? (mimeExtensions[subtype] ?? subtype) : fromName }
  }
  if (mime === '' && imageExtensions.has(fromName)) return { kind: 'image', extension: fromName }
  return null
}
