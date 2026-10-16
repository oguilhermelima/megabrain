import type { NativeChat, ProjectSession } from "@/api/schema";
import { sortSessions } from "@/advanced/projects-model";
import { moveProject, type Placement } from "@/advanced/project-order";
import type { AppTerminal } from "@/terminal/terminal-list";

// The rows under one worktree: native chats, terminals the app opened, and agent sessions. A
// conversation shows once: a native chat or a terminal resumed from Resume runs an agent session
// that the projects list also reports, so that session folds into the chat's or terminal's row and
// lends it its data (the compaction clock). The person can drag the rows into an order of their own,
// kept per viewer and per worktree.

export type WorktreeItem =
  | { kind: "native"; chat: NativeChat; session: ProjectSession | null }
  | { kind: "terminal"; terminal: AppTerminal; session: ProjectSession | null }
  | { kind: "session"; session: ProjectSession };

export type KeyedItem = WorktreeItem & { key: string };

export function rowKey(item: WorktreeItem): string {
  if (item.kind === "native") return `chat:${item.chat.id}`;
  if (item.kind === "terminal") return `terminal:${item.terminal.id}`;
  return `session:${item.session.sessionId}`;
}

/** A projects session id is `agent:id`; an agent's own id may come with or without that prefix. */
const sameSession = (session: ProjectSession, agent: string, id: string) =>
  session.sessionId === `${agent}:${id}` ||
  (session.sessionId === id && session.agent === agent);

/** Chats, then terminals, then the sessions neither runs (live before ended), each once. */
export function worktreeItems(
  chats: NativeChat[],
  terminals: AppTerminal[],
  sessions: ProjectSession[],
): KeyedItem[] {
  const absorbed = new Set<ProjectSession>();
  const claim = (agent: string, id: string | null | undefined) => {
    if (id === null || id === undefined) return null;
    const found =
      sessions.find((session) => sameSession(session, agent, id)) ?? null;
    if (found !== null) absorbed.add(found);
    return found;
  };
  const items: WorktreeItem[] = [
    ...chats.map((chat): WorktreeItem => ({
      kind: "native",
      chat,
      session: claim(chat.agent, chat.agentSessionId),
    })),
    ...terminals.map((terminal): WorktreeItem => ({
      kind: "terminal",
      terminal,
      session:
        terminal.launch.kind === "agent-terminal"
          ? claim(terminal.launch.agent, terminal.launch.resume)
          : null,
    })),
  ];
  for (const session of sortSessions(sessions))
    if (!absorbed.has(session)) items.push({ kind: "session", session });
  return items.map((item) => ({ ...item, key: rowKey(item) }));
}

const lastActivity = (item: WorktreeItem): string | null => {
  if (item.kind === "native") return item.chat.lastActivityAt ?? item.session?.lastActivityAt ?? null;
  return item.session?.lastActivityAt ?? null;
};

/** The row a click on its worktree opens: the most recently active, the top one on a tie or when
 * none has any activity; null for an empty worktree, which opens its launcher instead. */
export function rowToOpen<T extends WorktreeItem>(rows: T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    const at = lastActivity(row);
    const bestAt = best === null ? null : lastActivity(best);
    if (best === null || (at !== null && (bestAt === null || at > bestAt))) best = row;
  }
  return best;
}

/** Rows by the saved order; ones it does not know yet go on top in their default order, gone ids are skipped. */
export function applyRowOrder<T extends { key: string }>(
  rows: T[],
  saved: string[],
): T[] {
  const rank = new Map(saved.map((key, index) => [key, index]));
  const fresh = rows.filter((row) => !rank.has(row.key));
  const known = rows
    .filter((row) => rank.has(row.key))
    .sort(
      (left, right) => (rank.get(left.key) ?? 0) - (rank.get(right.key) ?? 0),
    );
  return [...fresh, ...known];
}

/** The order on screen with `source` moved next to `target`. */
export function moveRow(
  shown: string[],
  source: string,
  target: string,
  placement: Placement,
): string[] {
  return moveProject(shown, source, target, placement);
}

/** Each worktree's row keys, by worktree path. */
export type RowOrder = Record<string, string[]>;

const version = 1;

export function saveRowOrder(order: RowOrder): string {
  return JSON.stringify({ version, worktrees: order });
}

/** A saved order, or none when nothing usable (or another version) was saved. */
export function parseRowOrder(raw: string | null): RowOrder {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const record = value as Record<string, unknown>;
  if (
    record.version !== version ||
    typeof record.worktrees !== "object" ||
    record.worktrees === null
  )
    return {};
  const order: RowOrder = {};
  for (const [path, keys] of Object.entries(
    record.worktrees as Record<string, unknown>,
  )) {
    if (Array.isArray(keys))
      order[path] = keys.filter(
        (key): key is string => typeof key === "string",
      );
  }
  return order;
}
