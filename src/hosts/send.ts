import type { ProcessAdapter, ProcessOutput } from "../adapters/proc.js";
import { type Result } from "../core/result.js";
import type { HostCommand } from "./types.js";

const MAX_REISSUES = 1;
const RETRY_WAIT_SECONDS = 10;

const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

function ownershipRetryRequestId(stdout: string | undefined): string | undefined {
  if (stdout === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return undefined; }
  const root = record(parsed);
  const error = record(root.error);
  if (stringValue(error.code) !== "agent_session_ownership_unknown") return undefined;
  const message = stringValue(error.message) ?? "";
  const match = /Terminal prompt request ID: ([0-9a-fA-F-]+)/.exec(message);
  return match?.[1];
}

// Orca can refuse a terminal send with agent_session_ownership_unknown when it cannot prove which
// process incarnation the prompt targets. Its own --help says the fix is to reissue the exact same
// command with the request ID it reports, bound to that one prompt payload; retrying without the ID
// is unsafe. Every send call site (spawn's command submission and prompt transport, queue-write's
// parent and child notify, stop-reconcile's interrupt) runs through this one function so the retry
// exists in a single place. Tmux sends never reach here; Superset sends pass through unaffected
// since its errors never carry this code.
export async function runHostSend(hostId: string, process: ProcessAdapter, call: HostCommand): Promise<Result<ProcessOutput>> {
  let current = call;
  let attempt = 0;
  while (true) {
    const result = await process.run(current.command, current.args);
    if (result.kind !== "failed" || hostId !== "orca") return result;
    const requestId = ownershipRetryRequestId(result.stdout);
    if (requestId === undefined || attempt >= MAX_REISSUES) return result;
    attempt += 1;
    current = { command: current.command, args: [...current.args, "--retry-request", requestId, "--wait-submit", String(RETRY_WAIT_SECONDS)] };
  }
}
