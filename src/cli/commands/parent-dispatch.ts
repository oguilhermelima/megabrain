import type { DatabaseHandle } from "../../db/db.js";
import { hasCallerIdentity, ownsDispatch, type CallerIdentity } from "../../core/context.js";
import { resolveDispatchIdSuffix } from "../../core/dispatch-paths.js";
import { failed, type Result } from "../../core/result.js";
import { listDispatches } from "../../adapters/state-db.js";

const missingIdentity = "this command cannot tell who is running it: no agent session and no shell were found";

export function resolveParentDispatchId(database: DatabaseHandle, requested: string, caller: CallerIdentity): Result<string> {
  if (!hasCallerIdentity(caller)) return failed(missingIdentity);
  const listed = listDispatches(database, { includeArchived: true });
  if (listed.kind !== "ok") return listed;
  const exact = listed.value.find((record) => record.dispatchId === requested);
  if (exact !== undefined) {
    const owner = { parentHost: String(exact.parentHost ?? ""), parentSessionId: String(exact.parentSessionId ?? "") };
    if (!ownsDispatch(caller, owner)) return failed(`dispatch ${requested} is owned by ${owner.parentHost}/${owner.parentSessionId}, not ${caller.host}/${caller.id || caller.terminalId || ""}`);
    return { kind: "ok", value: exact.dispatchId };
  }
  const visible = listed.value.filter((record) => ownsDispatch(caller, {
    parentHost: String(record.parentHost ?? ""),
    parentSessionId: String(record.parentSessionId ?? ""),
  }));
  const resolved = resolveDispatchIdSuffix(requested, visible.map((record) => record.dispatchId));
  if (resolved.kind === "resolved") return { kind: "ok", value: resolved.dispatchId };
  if (resolved.kind === "ambiguous") return failed(`dispatch id suffix ${requested} is ambiguous: ${resolved.dispatchIds.join(", ")}`);
  if (resolved.kind === "too-short") return failed("dispatch id must contain at least 8 characters", 2);
  return failed(`dispatch not found: ${requested}`);
}
