import { decode, encode, type DatabaseAdapter } from "./types.js";

export type TerminalRecord = Readonly<Record<string, unknown> & { terminalId: string }>;
export type TmuxSessionRecord = Readonly<Record<string, unknown> & { tmuxSession: string }>;

type JsonValueRow = Readonly<{ value: string }>;
export function toTerminal(row: JsonValueRow): TerminalRecord { return decode<TerminalRecord>(row.value); }

export function insertTerminal(db: DatabaseAdapter, record: Readonly<Record<string, unknown>>): void {
  if (typeof record.terminalId !== "string") throw new TypeError("terminalId must be a string");
  db.run("INSERT INTO terminals (terminal_id, value) VALUES (?, ?)", [record.terminalId, encode(record)]);
}

export function getTerminal(db: DatabaseAdapter, id: string): TerminalRecord | undefined {
  const row = db.query<JsonValueRow>("SELECT value FROM terminals WHERE terminal_id = ?").get(id);
  return row === null ? undefined : toTerminal(row);
}

export function listTerminals(db: DatabaseAdapter): TerminalRecord[] {
  return db.query<JsonValueRow>("SELECT value FROM terminals ORDER BY terminal_id").all().map(toTerminal);
}

type InstallStateRow = Readonly<{ module_id: string; value: string; updated_at: string }>;
export function toInstallState(row: InstallStateRow): Readonly<{ moduleId: string; value: unknown; updatedAt: string }> {
  return { moduleId: row.module_id, value: decode(row.value), updatedAt: row.updated_at };
}

export function insertInstallState(db: DatabaseAdapter, moduleId: string, value: unknown, updatedAt = ""): void {
  db.run("INSERT INTO install_state (module_id, value, updated_at) VALUES (?, ?, ?)", [moduleId, encode(value), updatedAt]);
}

export function getInstallState(db: DatabaseAdapter, moduleId: string): unknown | undefined {
  const row = db.query<InstallStateRow>("SELECT module_id, value, updated_at FROM install_state WHERE module_id = ?").get(moduleId);
  return row === null ? undefined : toInstallState(row).value;
}

export function listInstallState(db: DatabaseAdapter): Record<string, unknown> {
  return Object.fromEntries(db.query<InstallStateRow>("SELECT module_id, value, updated_at FROM install_state ORDER BY module_id").all().map((row) => {
    const state = toInstallState(row);
    return [state.moduleId, state.value];
  }));
}

type ModelRow = Readonly<{ value: string; registry_extra: string }>;
export function toModel(row: ModelRow): Record<string, unknown> { return decode(row.value); }

export function insertModel(db: DatabaseAdapter, record: Readonly<Record<string, unknown>>, registry: Readonly<Record<string, unknown>>): void {
  if (typeof record.agent !== "string" || typeof record.model !== "string") throw new TypeError("model requires agent and model fields");
  const extra = Object.fromEntries(Object.entries(registry).filter(([key]) => key !== "models"));
  db.run("INSERT INTO models (agent, model, value, registry_extra) VALUES (?, ?, ?, ?)", [record.agent, record.model, encode(record), encode(extra)]);
}

export function getModel(db: DatabaseAdapter, agent: string, model: string): Record<string, unknown> | undefined {
  const row = db.query<{ value: string }>("SELECT value FROM models WHERE agent = ? AND model = ?").get(agent, model);
  return row === null ? undefined : decode(row.value);
}

export function listModels(db: DatabaseAdapter): Record<string, unknown> {
  const rows = db.query<ModelRow>("SELECT value, registry_extra FROM models ORDER BY rowid").all();
  if (rows.length === 0) return { version: 1, models: [] };
  const extra = decode<Record<string, unknown>>(rows[0].registry_extra);
  return { ...extra, models: rows.map(toModel) };
}

type TmuxSessionRow = Readonly<{ value: string }>;
export function toTmuxSession(row: TmuxSessionRow): TmuxSessionRecord { return decode<TmuxSessionRecord>(row.value); }

export function insertTmuxSession(db: DatabaseAdapter, record: Readonly<Record<string, unknown>>, stableSessionId: string | null = null): void {
  if (typeof record.tmuxSession !== "string") throw new TypeError("tmuxSession must be a string");
  db.run("INSERT INTO tmux_sessions (session_name, stable_session_id, value) VALUES (?, ?, ?)", [record.tmuxSession, stableSessionId, encode(record)]);
}

export function getTmuxSession(db: DatabaseAdapter, name: string): TmuxSessionRecord | undefined {
  const row = db.query<TmuxSessionRow>("SELECT value FROM tmux_sessions WHERE session_name = ?").get(name);
  return row === null ? undefined : toTmuxSession(row);
}

export function listTmuxSessions(db: DatabaseAdapter): TmuxSessionRecord[] {
  return db.query<TmuxSessionRow>("SELECT value FROM tmux_sessions ORDER BY session_name").all().map(toTmuxSession);
}
