import type { ProcessAdapter } from "../../adapters/proc.js";
import { getDispatch, isDispatchArchived, readOnlyStateDatabase } from "../../adapters/state-db.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { callStateOwner } from "../../db/state-owner.js";
import { usageText } from "../../core/usage.js";
import { resolveParentDispatchId } from "./parent-dispatch.js";

type Environment = Readonly<Record<string, string | undefined>>;

export async function executeOrchestrateKeepOpen(args: readonly string[], environment: Environment, _process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-keep-open"));
  if (args.length !== 1 || args[0] === undefined || args[0] === "") return failed(usageText("orchestrate-keep-open"), 2);
  const database = readOnlyStateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const resolved = resolveParentDispatchId(database.value, args[0]);
  if (resolved.kind !== "ok") return resolved;
  const stored = getDispatch(database.value, resolved.value);
  if (stored.kind !== "ok") return stored;
  if (stored.value === undefined) return failed(`dispatch not found: ${resolved.value}`);
  const archived = isDispatchArchived(database.value, resolved.value);
  if (archived.kind !== "ok") return archived;
  if (archived.value) return failed(`dispatch ${resolved.value} is archived; refusing to keep it open`);
  if (stored.value.state === "closed") return failed(`dispatch ${resolved.value} is already closed`);
  try {
    await callStateOwner(resolveStateDirectory(environment), {
      operation: "dispatch-patch", dispatchId: resolved.value,
      patch: { keepOpen: true }, expectedState: String(stored.value.state),
    });
  } catch (cause: unknown) {
    return failed(`could not keep dispatch open: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return ok(`dispatch will stay open: ${resolved.value}\n`);
}
