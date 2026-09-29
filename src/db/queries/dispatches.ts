import { dispatchStates, type DispatchStateValue } from "../../core/dispatch-states.js";
import { decode, encode, object, type DatabaseAdapter, type SqlValue } from "./types.js";

export type DispatchRecord = Readonly<Record<string, unknown> & { dispatchId: string; state: DispatchStateValue }>;
export type DispatchRow = Readonly<{
  id: string; state: string; owner_session_id: string | null; parent_host: string | null; parent_terminal_id: string | null;
  agent: string | null; model: string | null; effort: string | null; worktree_path: string | null; branch: string | null;
  runtime: string | null; child_host: string | null; tmux_session_id: string | null; tmux_session: string | null;
  tmux_pane: string | null; terminal_id: string | null; agent_thread_id: string | null; created_at: string | null;
  updated_at: string | null; archived_at: string | null; version: number; extra: string;
}>;

const promoted: Readonly<Record<string, keyof DispatchRow>> = {
  parentSessionId: "owner_session_id", parentHost: "parent_host", parentTerminalId: "parent_terminal_id", agent: "agent",
  model: "model", effort: "effort", worktreePath: "worktree_path", branch: "branch", runtime: "runtime",
  childHost: "child_host", tmuxSessionId: "tmux_session_id", tmuxSession: "tmux_session", tmuxPane: "tmux_pane",
  terminalId: "terminal_id", agentThreadId: "agent_thread_id", createdAt: "created_at", updatedAt: "updated_at",
};

function columnValue(row: DispatchRow, column: keyof DispatchRow): unknown {
  return row[column];
}

export function toMeta(row: DispatchRow): DispatchRecord {
  const extra = object(decode<unknown>(row.extra));
  const present = new Set(Array.isArray(extra.$present) ? extra.$present.filter((field): field is string => typeof field === "string") : []);
  delete extra.$present;
  const result: Record<string, unknown> = { ...extra };
  if (present.has("dispatchId")) result.dispatchId = row.id;
  if (present.has("state")) result.state = row.state;
  for (const [field, column] of Object.entries(promoted)) if (present.has(field)) result[field] = columnValue(row, column);
  return result as DispatchRecord;
}

function values(meta: Readonly<Record<string, unknown>>): { columns: SqlValue[]; extra: string } {
  const present = ["dispatchId", "state", ...Object.keys(promoted)].filter((field) => Object.hasOwn(meta, field));
  const rest = Object.fromEntries(Object.entries(meta).filter(([field]) => !present.includes(field)));
  const extra = encode({ ...rest, $present: present });
  const value = (field: string): SqlValue => {
    const raw = meta[field];
    return typeof raw === "string" || typeof raw === "number" ? raw : raw === null ? null : null;
  };
  const columns: SqlValue[] = [
    value("dispatchId"), value("state"), value("parentSessionId"), value("parentHost"), value("parentTerminalId"),
    value("agent"), value("model"), value("effort"), value("worktreePath"), value("branch"), value("runtime"),
    value("childHost"), value("tmuxSessionId"), value("tmuxSession"), value("tmuxPane"), value("terminalId"),
    value("agentThreadId"), value("createdAt"), value("updatedAt"), value("archivedAt"), extra,
  ];
  return { columns, extra };
}

function isState(value: unknown): value is DispatchStateValue {
  return typeof value === "string" && (dispatchStates as readonly string[]).includes(value);
}

export function insertDispatch(db: DatabaseAdapter, meta: Readonly<Record<string, unknown>>, archivedAt: string | null = null): { kind: "inserted" | "exists" } {
  const id = meta.dispatchId;
  if (typeof id !== "string" || id === "") throw new TypeError("dispatchId must be a non-empty string");
  if (!isState(meta.state)) throw new TypeError(`invalid dispatch state: ${String(meta.state)}`);
  const data = values(meta);
  data.columns[1] = meta.state;
  data.columns[19] = archivedAt;
  db.run(`INSERT INTO dispatches (id, state, owner_session_id, parent_host, parent_terminal_id, agent, model, effort, worktree_path, branch, runtime, child_host, tmux_session_id, tmux_session, tmux_pane, terminal_id, agent_thread_id, created_at, updated_at, archived_at, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, data.columns);
  return { kind: "inserted" };
}

function readDispatch(db: DatabaseAdapter, id: string): DispatchRow | null {
  return db.query<DispatchRow>("SELECT * FROM dispatches WHERE id = ?").get(id);
}

export function getDispatch(db: DatabaseAdapter, id: string): DispatchRecord | undefined {
  const row = readDispatch(db, id);
  return row === null ? undefined : toMeta(row);
}

export function listDispatches(db: DatabaseAdapter, options: Readonly<{ includeArchived?: boolean }> = {}): DispatchRecord[] {
  const rows = options.includeArchived === true
    ? db.query<DispatchRow>("SELECT * FROM dispatches ORDER BY created_at, id").all()
    : db.query<DispatchRow>("SELECT * FROM dispatches WHERE archived_at IS NULL ORDER BY created_at, id").all();
  return rows.map(toMeta);
}

export function listDispatchesByOwner(db: DatabaseAdapter, ownerSessionId: string, options: Readonly<{ includeArchived?: boolean }> = {}): DispatchRecord[] {
  const rows = options.includeArchived === true
    ? db.query<DispatchRow>("SELECT * FROM dispatches WHERE owner_session_id = ? ORDER BY created_at, id").all(ownerSessionId)
    : db.query<DispatchRow>("SELECT * FROM dispatches WHERE owner_session_id = ? AND archived_at IS NULL ORDER BY created_at, id").all(ownerSessionId);
  return rows.map(toMeta);
}

export function findDispatchByTmuxIdentity(db: DatabaseAdapter, sessionId: string, pane: string): DispatchRecord[] {
  return db.query<DispatchRow>("SELECT * FROM dispatches WHERE tmux_session_id = ? AND tmux_pane = ? ORDER BY id").all(sessionId, pane).map(toMeta);
}

export function findDispatchesByTerminal(db: DatabaseAdapter, terminalId: string): DispatchRecord[] {
  return db.query<DispatchRow>("SELECT * FROM dispatches WHERE terminal_id = ? ORDER BY id").all(terminalId).map(toMeta);
}

export type DispatchUpdateResult =
  | Readonly<{ kind: "updated"; version: number; record: DispatchRecord }>
  | Readonly<{ kind: "conflict"; currentVersion: number }>
  | Readonly<{ kind: "not_found" }>;

export function updateDispatch(db: DatabaseAdapter, id: string, expectedVersion: number, patch: Readonly<Record<string, unknown>>): DispatchUpdateResult {
  const row = readDispatch(db, id);
  if (row === null) return { kind: "not_found" };
  if (row.version !== expectedVersion) return { kind: "conflict", currentVersion: row.version };
  const current = toMeta(row);
  const next = { ...current, ...patch, dispatchId: id };
  if (!isState(next.state)) throw new TypeError(`invalid dispatch state: ${String(next.state)}`);
  const data = values(next);
  const changed = db.run(`UPDATE dispatches SET state = ?, owner_session_id = ?, parent_host = ?, parent_terminal_id = ?, agent = ?, model = ?, effort = ?, worktree_path = ?, branch = ?, runtime = ?, child_host = ?, tmux_session_id = ?, tmux_session = ?, tmux_pane = ?, terminal_id = ?, agent_thread_id = ?, created_at = ?, updated_at = ?, extra = ?, version = version + 1 WHERE id = ? AND version = ?`, [
    data.columns[1], ...data.columns.slice(2, 19), data.extra, id, expectedVersion,
  ]);
  if (changed.changes === 0) {
    const moved = readDispatch(db, id);
    return moved === null ? { kind: "not_found" } : { kind: "conflict", currentVersion: moved.version };
  }
  const updated = readDispatch(db, id);
  if (updated === null) return { kind: "not_found" };
  return { kind: "updated", version: updated.version, record: toMeta(updated) };
}
