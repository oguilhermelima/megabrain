import type { DatabaseHandle } from "../db/db.js";
import { getDispatch, isDispatchArchived, listOutboxPage, supersedeClosedParentDeliveries } from "../adapters/state-db.js";
import { ok, type Result } from "./result.js";

/** Lazily settle parent mail before any verifier or supervisor can restart delivery. */
export function settleClosedParentBacklog(database: DatabaseHandle): Result<void> {
  const checked = new Set<string>();
  let cursor: { createdAt: string; id: string } | undefined;
  do {
    const page = listOutboxPage(database, { after: cursor, limit: 100 });
    if (page.kind !== "ok") return page;
    for (const row of page.value.rows) {
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
    cursor = page.value.nextCursor;
  } while (cursor !== undefined);
  return ok(undefined);
}
