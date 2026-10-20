import type { DatabaseHandle } from "../../db/db.js";
import type { CallerIdentity } from "../../core/context.js";
import { resolveDispatchIdSuffix } from "../../core/dispatch-paths.js";
import { failed, type Result } from "../../core/result.js";
import { listDispatches } from "../../adapters/state-db.js";

export function resolveParentDispatchId(database: DatabaseHandle, requested: string, caller: CallerIdentity): Result<string> {
  void caller;
  const listed = listDispatches(database, { includeArchived: true });
  if (listed.kind !== "ok") return listed;
  const exact = listed.value.find((record) => record.dispatchId === requested);
  if (exact !== undefined) {
    return { kind: "ok", value: exact.dispatchId };
  }
  const resolved = resolveDispatchIdSuffix(requested, listed.value.map((record) => record.dispatchId));
  if (resolved.kind === "resolved") return { kind: "ok", value: resolved.dispatchId };
  if (resolved.kind === "ambiguous") return failed(`dispatch id suffix ${requested} is ambiguous: ${resolved.dispatchIds.join(", ")}`);
  if (resolved.kind === "too-short") return failed("dispatch id must contain at least 8 characters", 2);
  return failed(`dispatch not found: ${requested}`);
}
