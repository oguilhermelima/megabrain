import type { DatabaseHandle } from "../db/db.js";
import { getDispatch, isDispatchArchived, listClosedParentOutboxDispatchIds, supersedeClosedParentDeliveries } from "../adapters/state-db.js";
import { ok, type Result } from "./result.js";

/** Lazily settle parent mail before any verifier or supervisor can restart delivery. */
export function settleClosedParentBacklog(database: DatabaseHandle): Result<void> {
  const candidates = listClosedParentOutboxDispatchIds(database);
  if (candidates.kind !== "ok") return candidates;
  for (const dispatchId of candidates.value) {
    const dispatch = getDispatch(database, dispatchId);
    if (dispatch.kind !== "ok") return dispatch;
    const archived = isDispatchArchived(database, dispatchId);
    if (archived.kind !== "ok") return archived;
    const closed = archived.value || dispatch.value?.state === "closed";
    if (!closed) continue;
    const settled = supersedeClosedParentDeliveries(database, dispatchId, archived.value ? "dispatch archived; parent delivery superseded" : "dispatch closed; parent delivery superseded");
    if (settled.kind !== "ok") return settled;
  }
  return ok(undefined);
}
