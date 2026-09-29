import { type Result } from "../../core/result.js";
import { decode, encode } from "../../db/queries/types.js";
import { insertModel, listInstallState as queryInstallState, listModels as queryModels, listTerminals as queryTerminals, type TerminalRecord, type TmuxSessionRecord } from "../../db/queries/aux-state.js";
import type { DatabaseHandle } from "../../db/db.js";
import { read, write } from "./shared.js";

export type InstallState = Readonly<Record<string, unknown>>;
export type ModelRegistry = Readonly<Record<string, unknown> & { models: readonly Readonly<Record<string, unknown>>[] }>;

export function getTerminal(handle: DatabaseHandle, terminalId: string): Result<TerminalRecord | undefined> {
  return read(handle, ({ db }) => {
    const row = db.query<{ value: string }>("SELECT value FROM terminals WHERE terminal_id = ?").get(terminalId);
    return row === null ? undefined : decode<TerminalRecord>(row.value);
  });
}

export function listTerminals(handle: DatabaseHandle): Result<TerminalRecord[]> {
  return read(handle, ({ db }) => queryTerminals(db));
}

export function putTerminal(handle: DatabaseHandle, record: Readonly<Record<string, unknown>>): Result<TerminalRecord> {
  return write(handle, ({ db }) => {
    if (typeof record.terminalId !== "string") throw new TypeError("terminalId must be a string");
    db.run("INSERT INTO terminals (terminal_id, value) VALUES (?, ?) ON CONFLICT(terminal_id) DO UPDATE SET value = excluded.value", [record.terminalId, encode(record)]);
    return record as TerminalRecord;
  });
}

export function deleteTerminal(handle: DatabaseHandle, terminalId: string): Result<boolean> {
  return write(handle, ({ db }) => db.run("DELETE FROM terminals WHERE terminal_id = ?", [terminalId]).changes > 0);
}

export function getInstallState(handle: DatabaseHandle): Result<InstallState> {
  return read(handle, ({ db }) => queryInstallState(db));
}

export function putInstallModule(handle: DatabaseHandle, moduleId: string, value: unknown): Result<void> {
  return write(handle, ({ db }) => {
    const updatedAt = typeof value === "object" && value !== null && "updatedAt" in value && typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString();
    db.run("INSERT INTO install_state (module_id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(module_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [moduleId, encode(value), updatedAt]);
  });
}

export function loadModels(handle: DatabaseHandle): Result<ModelRegistry> {
  return read(handle, ({ db }) => queryModels(db) as ModelRegistry);
}

export function saveModels(handle: DatabaseHandle, registry: ModelRegistry): Result<ModelRegistry> {
  return write(handle, ({ db }) => {
    if (!Array.isArray(registry.models)) throw new TypeError("model registry requires a models array");
    db.run("DELETE FROM models");
    for (const entry of registry.models) insertModel(db, entry, registry);
    return registry;
  });
}

export function getTmuxSession(handle: DatabaseHandle, name: string): Result<TmuxSessionRecord | undefined> {
  return read(handle, ({ db }) => {
    const row = db.query<{ value: string }>("SELECT value FROM tmux_sessions WHERE session_name = ?").get(name);
    return row === null ? undefined : decode<TmuxSessionRecord>(row.value);
  });
}

export function getTmuxSessionByStableId(handle: DatabaseHandle, stableSessionId: string): Result<TmuxSessionRecord | undefined> {
  return read(handle, ({ db }) => {
    const row = db.query<{ value: string }>("SELECT value FROM tmux_sessions WHERE stable_session_id = ?").get(stableSessionId);
    return row === null ? undefined : decode<TmuxSessionRecord>(row.value);
  });
}

export function putTmuxSession(handle: DatabaseHandle, record: Readonly<Record<string, unknown>>, stableSessionId: string | null): Result<TmuxSessionRecord> {
  return write(handle, ({ db }) => {
    if (typeof record.tmuxSession !== "string") throw new TypeError("tmuxSession must be a string");
    db.run("INSERT INTO tmux_sessions (session_name, stable_session_id, value) VALUES (?, ?, ?) ON CONFLICT(session_name) DO UPDATE SET stable_session_id = excluded.stable_session_id, value = excluded.value", [record.tmuxSession, stableSessionId, encode(record)]);
    return record as TmuxSessionRecord;
  });
}
