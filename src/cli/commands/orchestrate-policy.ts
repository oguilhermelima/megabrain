import { resolveCaller } from "./queue-write.js";
import { resolveParentDispatchId } from "./parent-dispatch.js";
import { failed, ok, type Result } from "../../core/result.js";
import { validateContextPolicy, type ContextPolicy } from "../../core/context-policy.js";
import { stateDatabase, getDispatch, listDispatches, listMessages, mutateDispatch, noDispatchChange } from "../../adapters/state-db.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { usageText } from "../../core/usage.js";
import { getAgent } from "../../agents/index.js";
import type { QueueEnvironment } from "./queue-write.js";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};

type PolicyChanges = Readonly<{
  readonly contextCeiling?: number;
  readonly compactAt?: number;
  readonly loop?: boolean;
  readonly maxIterations?: number;
  readonly json: boolean;
}>;

function parseChanges(args: readonly string[]): Result<Readonly<{ dispatchId: string; changes: PolicyChanges }>> {
  const dispatchId = args[0] ?? "";
  if (dispatchId === "") return failed(usageText("orchestrate-policy"), 2);
  let contextCeiling: number | undefined;
  let compactAt: number | undefined;
  let loop: boolean | undefined;
  let maxIterations: number | undefined;
  let json = false;
  let changed = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--loop") { loop = true; changed = true; }
    else if (arg === "--no-loop") { loop = false; changed = true; }
    else if (["--context-ceiling", "--compact-at", "--max-iterations"].includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value === "") return failed(`${arg} requires a value`, 2);
      if (arg === "--context-ceiling") contextCeiling = Number(value);
      else if (arg === "--compact-at") compactAt = Number(value);
      else maxIterations = Number(value);
      changed = true;
      index += 1;
    } else return failed(`unknown orchestrate policy option: ${arg}`, 2);
  }
  if (!changed) return failed("orchestrate policy requires at least one policy option", 2);
  return ok({ dispatchId, changes: { contextCeiling, compactAt, loop, maxIterations, json } });
}

export async function executeOrchestratePolicy(args: readonly string[], environment: QueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-policy"));
  const parsed = parseChanges(args);
  if (parsed.kind !== "ok") return parsed;
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const caller = await resolveCaller(environment, process);
  const resolved = resolveParentDispatchId(database.value, parsed.value.dispatchId, caller);
  if (resolved.kind !== "ok") return resolved;
  const stored = getDispatch(database.value, resolved.value);
  if (stored.kind !== "ok") return stored;
  const meta = stored.value;
  if (meta === undefined) return failed(`dispatch not found: ${resolved.value}`);
  const active = listDispatches(database.value);
  if (active.kind !== "ok") return active;
  if (!active.value.some((item) => item.dispatchId === resolved.value)) return failed(`dispatch ${resolved.value} is archived; refusing to change its policy`);
  if (!["spawning", "running", "waiting_for_reply"].includes(String(meta.state ?? ""))) return failed(`dispatch ${resolved.value} is not active`);

  const agent = getAgent(String(meta.agent ?? ""));
  let loopPrompt = typeof meta.contextLoopPrompt === "string" ? meta.contextLoopPrompt : "";
  if ((parsed.value.changes.loop === true || typeof record(meta.contextPolicy).loop === "boolean" && record(meta.contextPolicy).loop === true) && loopPrompt === "") {
    const messages = listMessages(database.value, resolved.value);
    if (messages.kind !== "ok") return messages;
    loopPrompt = [...messages.value].reverse().find((message) => message.from === "parent" && message.type === "prompt")?.text ?? "";
    if (loopPrompt === "") return failed(`dispatch ${resolved.value} has no original prompt to loop`);
  }

  let policy: ContextPolicy | undefined;
  let policyError: string | undefined;
  const updated = mutateDispatch(database.value, resolved.value, (current) => {
    if (!["spawning", "running", "waiting_for_reply"].includes(String(current.state ?? ""))) {
      policyError = `dispatch ${resolved.value} is not active`;
      return noDispatchChange;
    }
    const previous = record(current.contextPolicy);
    const next: ContextPolicy = {
      ...(typeof previous.contextCeiling === "number" ? { contextCeiling: previous.contextCeiling } : {}),
      ...(typeof previous.compactAt === "number" ? { compactAt: previous.compactAt } : {}),
      ...(typeof previous.loop === "boolean" ? { loop: previous.loop } : {}),
      ...(typeof previous.maxIterations === "number" ? { maxIterations: previous.maxIterations } : {}),
      ...(parsed.value.changes.contextCeiling === undefined ? {} : { contextCeiling: parsed.value.changes.contextCeiling }),
      ...(parsed.value.changes.compactAt === undefined ? {} : { compactAt: parsed.value.changes.compactAt }),
      ...(parsed.value.changes.loop === undefined ? {} : { loop: parsed.value.changes.loop }),
      ...(parsed.value.changes.maxIterations === undefined ? {} : { maxIterations: parsed.value.changes.maxIterations }),
    };
    const valid = validateContextPolicy(next);
    if (valid.kind !== "ok") { policyError = valid.error; return noDispatchChange; }
    if ((next.contextCeiling !== undefined || next.compactAt !== undefined || next.loop === true) && agent?.contextSource === undefined) {
      policyError = `${String(current.agent ?? "unknown")} has no measured context meter`;
      return noDispatchChange;
    }
    if (next.compactAt !== undefined && agent?.compactCommand === undefined) {
      policyError = `${String(current.agent ?? "unknown")} has no measured context compact command`;
      return noDispatchChange;
    }
    if (next.loop === true && loopPrompt === "") {
      policyError = `dispatch ${resolved.value} has no original prompt to loop`;
      return noDispatchChange;
    }
    policy = next;
    const currentState = record(current.contextPolicyState);
    return {
      ...current,
      contextPolicy: next,
      contextPolicyState: {
        ceilingLatched: parsed.value.changes.contextCeiling === undefined ? currentState.ceilingLatched === true : false,
        compactLatched: parsed.value.changes.compactAt === undefined ? currentState.compactLatched === true : false,
        loopIterations: typeof currentState.loopIterations === "number" ? currentState.loopIterations : 0,
        actions: Array.isArray(currentState.actions) ? currentState.actions : [],
      },
      ...(next.loop === true || next.compactAt !== undefined ? { contextLoopPrompt: loopPrompt } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  if (updated.kind !== "ok") return updated;
  if (policyError !== undefined) return failed(policyError, policyError.startsWith("--") ? 2 : 1);
  if (policy === undefined) return failed(`dispatch ${resolved.value} policy was not updated`);
  const output = { dispatchId: resolved.value, contextPolicy: policy };
  return ok(parsed.value.changes.json ? `${JSON.stringify(output, null, 2)}\n` : `dispatch: ${resolved.value}\ncontext policy: ${JSON.stringify(policy)}\n`);
}
