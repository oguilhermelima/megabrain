import type { PortListener, ScriptPort } from '@/api/schema'

/** What Run offers when its port is taken: stop the holder and run (Restart when it is this worktree's own run), move to a free port, or cancel. */
export interface PortConflict {
  port: number
  title: string
  body: string
  primary: 'kill' | 'restart'
  primaryLabel: string
  alternative: { port: number; command: string; label: string } | null
}

const folder = (path: string) => path.split('/').filter((part) => part !== '').pop() ?? path

/**
 * The run command moved to `port`: a port written in the command is rewritten where it stands;
 * otherwise PORT is set and the framework's own argument appended (after -- for npm). Null when a
 * package script fixes the port, which nothing outside it can change.
 */
export function commandOnPort(command: string, found: ScriptPort, port: number): string | null {
  if (found.source === 'command' && found.fragment !== null && command.includes(found.fragment)) {
    return command.replace(found.fragment, found.fragment.replace(/\d+(?=["']?$)/, String(port)))
  }
  if (found.override === null && (found.source === 'script' || found.source === 'package-json')) return null
  const args = found.override === null ? '' : ` ${/^\s*npm\s/.test(command) ? '-- ' : ''}${found.override.replaceAll('{port}', String(port))}`
  return `PORT=${port} ${command}${args}`
}

function age(startedAt: string, now: number): string | null {
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return null
  const minutes = Math.max(0, now - started) / 60_000
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${Math.floor(minutes)} min ago`
  const hours = minutes / 60
  if (hours < 24) return `${Math.floor(hours)} h ago`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** "next-server in canto · main, started 12 min ago": what holds a port, where, and since when. */
export function holderSentence(listener: PortListener, now: number): string {
  const managed = listener.managed === null ? '' : listener.managed.kind === 'proc' ? ` (megabrain proc ${listener.managed.name})` : ` (app terminal ${listener.managed.title})`
  const place = listener.place !== null ? (listener.place.branch === null ? listener.place.project : `${listener.place.project} · ${listener.place.branch}`) : listener.cwd !== null ? folder(listener.cwd) : null
  const since = listener.startedAt === null ? null : age(listener.startedAt, now)
  return `${listener.command}${managed}${place === null ? '' : ` in ${place}`}${since === null ? '' : `, started ${since}`}`
}

const inside = (path: string, root: string) => {
  const base = root.replace(/\/+$/, '')
  return path === base || path.startsWith(`${base}/`)
}

/** The choice to offer when `listeners` hold the run's port; null when nothing does. `free` is the next free port, if one was found. */
export function portConflict({ worktree, command, found, listeners, free, now }: { worktree: string; command: string; found: ScriptPort; listeners: PortListener[]; free: number | null; now: number }): PortConflict | null {
  const [first] = listeners
  if (first === undefined) return null
  const own = first.cwd !== null && inside(first.cwd, worktree)
  const others = listeners.length - 1
  const more = others === 0 ? '' : `, and ${others} more ${others === 1 ? 'process' : 'processes'}`
  const holder = holderSentence(first, now)
  const moved = free === null ? null : commandOnPort(command, found, free)
  return {
    port: found.port,
    title: `Port ${found.port} is in use`,
    body: own ? `Port ${found.port} is used by this worktree's earlier run, ${holder}${more}.` : `Port ${found.port} is used by ${holder}${more}.`,
    primary: own ? 'restart' : 'kill',
    primaryLabel: own ? 'Restart' : 'Kill it and run',
    alternative: free === null || moved === null ? null : { port: free, command: moved, label: `Use ${free}` },
  }
}

/** Whether output says the address was taken, and which port when it says. */
export function addressInUse(text: string): { port: number | null } | null {
  if (!/EADDRINUSE|address already in use|port \d+ is (?:already )?in use/i.test(text)) return null
  const port = /address already in use\s+(?:[\w.:[\]]*:)?(\d{2,5})\b/i.exec(text)?.[1] ?? /port (\d{2,5}) is (?:already )?in use/i.exec(text)?.[1] ?? /\bport (\d{2,5})\b/i.exec(text)?.[1]
  return { port: port === undefined ? null : Number(port) }
}
