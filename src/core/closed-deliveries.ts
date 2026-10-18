import type { DatabaseHandle } from "../db/db.js";
import { getDispatch, isDispatchArchived, listOutbox, supersedeClosedParentDeliveries } from "../adapters/state-db.js";
import { ok, type Result } from "./result.js";

/** Lazily settle parent mail before any verifier or supervisor can restart delivery. */
export function settleClosedParentBacklog(database: DatabaseHandle): Result<void> {
  const rows = listOutbox(database);
  if (rows.kind !== "ok") return rows;
  const checked = new Set<string>();
  for (const row of rows.value) {
    if (row.targetKind !== "parent-pointer" || row.dispatchId === null || checked.has(row.dispatchId)) continue;
    checked.add(row.dispatchId);
    const dispatch = getDispatch(database, row.dispatchId);
    if (dispatch.kind !== "ok") return dispatch;
    const archived = isDispatchArchived(database, row.dispatchId);
    if (archived.kind !== "ok") return archived;
    const closed = archived.value || dispatch.value?.state === "closed";
    if (!closed) continue;
    const settled = supersedeClosedParentDeliveries(database, row.dispatchId, archived.value ? "dispatch archived; parent delivery superseded" : "dispatch closed; parent delivery superseded");
    if (settled.kind !== "ok") return settled;
  }
  return ok(undefined);
}
