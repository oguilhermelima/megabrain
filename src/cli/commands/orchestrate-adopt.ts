import { ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import type { QueueEnvironment } from "./queue-write.js";

// Kept for one release so scripts using the old verb do not break.
export async function executeOrchestrateAdopt(args: readonly string[], _environment: QueueEnvironment, _processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("orchestrate-adopt"));
  return ok("orchestrate adopt is deprecated and no longer needed; dispatches follow their terminal.\n");
}
