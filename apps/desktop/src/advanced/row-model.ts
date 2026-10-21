import type { NativeChat, ProjectSession } from "@/api/schema";
import { sortSessions } from "@/advanced/projects-model";
import { moveProject, type Placement } from "@/advanced/project-order";
import { terminalRuns, type AppTerminal } from "@/terminal/terminal-list";

// The rows under one worktree: one per conversation the app owns. Native chats first, then the
// terminals the app opened, then the conversations neither holds (an ended terminal conversation that
// resumes on click). The projects list names each conversation's owner and aliases, so a chat claims
// its conversation by chat id (or agent session id), a terminal by the tmux session or process it runs,
// and the conversation lends the row its data (the compaction clock). A dispatch worker (a lane) is a
// session row under the worktree it runs in, once per session and dispatch; sessions other apps run
// never get a row. The person can drag the rows into an order of their own, kept per
// viewer and per worktree.

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

/** Only conversations megabrain runs are rows, lanes included; a foreign session is its app's. */
const ours = (session: ProjectSession) => session.conversationOwner !== 'foreign';

/** Each session once, by session id and by dispatch id: a lane can be listed under both. */
const once = (sessions: ProjectSession[]) => {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    const ids = [`session:${session.sessionId}`, ...(session.dispatchId === null ? [] : [`dispatch:${session.dispatchId}`])];
    if (ids.some((id) => seen.has(id))) return false;
    for (const id of ids) seen.add(id);
    return true;
  });
};

/** Chats, then terminals, then the conversations neither runs (live before ended), each once. */
export function worktreeItems(
  chats: NativeChat[],
  terminals: AppTerminal[],
  listed: ProjectSession[],
): KeyedItem[] {
  const sessions = once(listed.filter(ours));
  const absorbed = new Set<ProjectSession>();
  const take = (found: ProjectSession | undefined) => {
    if (found === undefined) return null;
    absorbed.add(found);
    return found;
  };
  const claim = (agent: string, id: string | null | undefined) =>
    id === null || id === undefined
      ? null
      : take(sessions.find((session) => sameSession(session, agent, id)));
  const claimChat = (chat: NativeChat) =>
    take(sessions.find((session) => session.chatId === chat.id)) ??
    claim(chat.agent, chat.agentSessionId);
  const claimRun = (terminal: AppTerminal) => {
    const found =
      sessions.find((session) => !absorbed.has(session) && terminalRuns(terminal, session)) ?? null;
    if (found !== null) absorbed.add(found);
    return found;
  };
  const items: WorktreeItem[] = [
    ...chats.map((chat): WorktreeItem => ({
      kind: "native",
      chat,
      session: claimChat(chat),
    })),
    ...terminals.map((terminal): WorktreeItem => ({
      kind: "terminal",
      terminal,
      session:
        (terminal.launch.kind === "agent-terminal"
          ? claim(terminal.launch.agent, terminal.launch.resume)
          : null) ?? claimRun(terminal),
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

const ENDED_AFTER = 7 * 86_400_000;

/** Whether the row still runs something: a chat's agent, a terminal's process, a live session. */
const running = (item: WorktreeItem): boolean => {
  if (item.kind === 'native') return item.chat.state !== 'suspended' && item.chat.state !== 'stopped' && item.chat.state !== 'error';
  if (item.kind === 'terminal') return item.terminal.status === 'live' || item.terminal.status === 'starting';
  return item.session.status !== 'ended';
};

/**
 * Conversations of ours that ended more than 7 days ago go under the worktree's Ended group; every
 * other row stays in the list. Both keep the order they came in.
 */
export function endedRows<T extends WorktreeItem>(rows: T[], now: number): { shown: T[]; ended: T[] } {
  const shown: T[] = [];
  const ended: T[] = [];
  for (const row of rows) {
    const at = lastActivity(row);
    const old = at !== null && now - Date.parse(at) > ENDED_AFTER;
    (old && !running(row) ? ended : shown).push(row);
  }
  return { shown, ended };
}

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
