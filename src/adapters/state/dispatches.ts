import { failed, ok, type Result } from "../../core/result.js";
import { insertDispatch, toMeta, updateDispatch, type DispatchRecord, type DispatchRow } from "../../db/queries/dispatches.js";
import type { DatabaseHandle } from "../../db/db.js";
import { read, write } from "./shared.js";

export type DispatchFilters = Readonly<{
  includeArchived?: boolean;
  ownerSessionId?: string;
  tmuxSessionId?: string;
  tmuxPane?: string;
  terminalId?: string;
}>;

export type NoDispatchChange = Readonly<{ kind: "no_change" }>;
export const noDispatchChange: NoDispatchChange = Object.freeze({ kind: "no_change" });
export type DispatchMutation = Readonly<Record<string, unknown>> | NoDispatchChange;
export type DispatchMutator = (current: DispatchRecord) => DispatchMutation;
const MAX_MUTATE_ATTEMPTS = 5;

export function createDispatch(handle: DatabaseHandle, record: Readonly<Record<string, unknown>>): Result<DispatchRecord> {
  return write(handle, ({ db }) => {
    insertDispatch(db, record);
    return record as DispatchRecord;
  });
}

export function getDispatch(handle: DatabaseHandle, id: string): Result<DispatchRecord | undefined> {
  return read(handle, ({ db }) => {
    const row = db.query<DispatchRow>("SELECT * FROM dispatches WHERE id = ?").get(id);
    return row === null ? undefined : toMeta(row);
  });
}

export function listDispatches(handle: DatabaseHandle, filters: DispatchFilters = {}): Result<DispatchRecord[]> {
  return read(handle, ({ db }) => {
    const where: string[] = [];
    const parameters: (string | number | null)[] = [];
    if (filters.includeArchived !== true) where.push("archived_at IS NULL");
    if (filters.ownerSessionId !== undefined) { where.push("owner_session_id = ?"); parameters.push(filters.ownerSessionId); }
    if (filters.tmuxSessionId !== undefined) { where.push("tmux_session_id = ?"); parameters.push(filters.tmuxSessionId); }
    if (filters.tmuxPane !== undefined) { where.push("tmux_pane = ?"); parameters.push(filters.tmuxPane); }
    if (filters.terminalId !== undefined) { where.push("terminal_id = ?"); parameters.push(filters.terminalId); }
    const sql = `SELECT * FROM dispatches${where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`} ORDER BY created_at, id`;
    return db.query<DispatchRow>(sql).all(...parameters).map(toMeta);
  });
}

export function mutateDispatch(handle: DatabaseHandle, id: string, mutate: DispatchMutator): Result<DispatchRecord> {
  for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
    const outcome = write(handle, ({ db }) => {
      const row = db.query<DispatchRow>("SELECT * FROM dispatches WHERE id = ?").get(id);
      if (row === null) return { kind: "not_found" as const };
      const current = toMeta(row);
      const patch = mutate(current);
      if (patch.kind === "no_change") return { kind: "unchanged" as const, record: current };
      const updated = updateDispatch(db, id, row.version, patch);
      if (updated.kind === "conflict") return { kind: "conflict" as const };
      if (updated.kind === "not_found") return { kind: "not_found" as const };
      return { kind: "updated" as const, record: updated.record };
    });
    if (outcome.kind !== "ok") return outcome;
    if (outcome.value.kind === "not_found") return failed(`dispatch not found: ${id}`);
    if (outcome.value.kind === "updated" || outcome.value.kind === "unchanged") return ok(outcome.value.record);
  }
  return failed(`dispatch ${id} changed during ${MAX_MUTATE_ATTEMPTS} consecutive mutation attempts`);
}

export function archiveDispatch(handle: DatabaseHandle, id: string, archivedAt = new Date().toISOString()): Result<boolean> {
  return write(handle, ({ db }) => db.run("UPDATE dispatches SET archived_at = COALESCE(archived_at, ?) WHERE id = ?", [archivedAt, id]).changes > 0);
}

export function deleteDispatch(handle: DatabaseHandle, id: string): Result<boolean> {
  return write(handle, ({ db }) => db.run("DELETE FROM dispatches WHERE id = ?", [id]).changes > 0);
}
