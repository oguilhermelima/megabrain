import { join } from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { dispatchFile, dispatchRoot, resolveDispatchDirectory } from "../../adapters/dispatch-store.js";
import { failed, ok, type Result } from "../../core/result.js";
import { hasCallerIdentity, isAgentSessionId } from "../../core/context.js";
import { resolveStateDirectory } from "../../core/state.js";
import { acquireLock, atomicJson, readJson, resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { usageText } from "../../core/usage.js";

type AdoptionLiveness = "alive" | "not-alive" | "unknown";
type Meta = Record<string, unknown>;

function parseArgs(args: readonly string[]): Result<{ dispatchId: string; force: boolean; json: boolean }> {
  let dispatchId: string | undefined;
  let force = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--force") force = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("-")) return failed(`unknown orchestrate adopt option: ${arg}`, 2);
    else if (dispatchId === undefined) dispatchId = arg;
    else return failed("orchestrate adopt accepts one dispatch id", 2);
  }
  if (dispatchId === undefined || !/^[A-Za-z0-9._-]+$/.test(dispatchId)) return failed(usageText("orchestrate-adopt"), 2);
  return ok({ dispatchId, force, json });
}

async function claudeOwnerLiveness(sessionId: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<AdoptionLiveness> {
  const home = environment.HOME ?? process.env.HOME;
  if (home === undefined || home === "") return "unknown";
  const directory = join(home, ".claude", "sessions");
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "not-alive";
    return "unknown";
  }
  let matched = false;
  for (const entry of entries) {
    let value: unknown;
    try { value = JSON.parse(await readFile(join(directory, entry), "utf8")) as unknown; }
    catch { continue; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.sessionId !== sessionId.slice("claude:".length)) continue;
    matched = true;
    if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) continue;
    const probe = await processAdapter.run("kill", ["-0", String(record.pid)]);
    if (probe.kind === "ok") return "alive";
    if (probe.kind === "failed" && /operation not permitted|not permitted/i.test(probe.error)) return "alive";
    if (probe.kind === "unknown") return "unknown";
  }
  return matched ? "not-alive" : "not-alive";
}

async function codexOwnerLiveness(sessionId: string, processAdapter: ProcessAdapter): Promise<AdoptionLiveness> {
  const processes = await processAdapter.run("ps", ["-eww", "-ax", "-o", "command="]);
  if (processes.kind !== "ok") return "unknown";
  const expected = sessionId.slice("codex:".length);
  for (const line of processes.value.stdout.split("\n")) {
    for (const token of line.split(/\s+/)) {
      if (token === `CODEX_THREAD_ID=${expected}`) return "alive";
    }
  }
  // `ps` can expose the current process arguments without exposing a sibling process's
  // environment. An absent match therefore does not prove the Codex session has ended.
  return "unknown";
}

async function ownerLiveness(sessionId: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<AdoptionLiveness> {
  if (sessionId.startsWith("claude:")) return claudeOwnerLiveness(sessionId, environment, processAdapter);
  if (sessionId.startsWith("codex:")) return codexOwnerLiveness(sessionId, processAdapter);
  return "unknown";
}

function output(dispatchId: string, adopted: boolean, owner: string, json: boolean): string {
  return json
    ? `${JSON.stringify({ dispatchId, adopted, owner }, null, 2)}\n`
    : `${adopted ? "adopted" : "already owned"}: ${dispatchId}\n`;
}

export async function executeOrchestrateAdopt(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-adopt"));
  const parsed = parseArgs(args);
  if (parsed.kind !== "ok") return parsed;
  const current = await resolveCaller(environment, processAdapter);
  if (!hasCallerIdentity(current) || !isAgentSessionId(current.id)) return failed("orchestrate adopt requires an agent session identity (claude:<id> or codex:<id>)");

  const root = resolveStateDirectory(environment);
  const initial = await resolveDispatchDirectory(root, parsed.value.dispatchId);
  if (initial.kind !== "ok") return initial;
  if (initial.value.archived) return failed(`dispatch ${parsed.value.dispatchId} is archived; refusing to adopt it`);
  if (await readJson(dispatchFile(initial.value, "meta")) === undefined) return failed(`dispatch not found: ${parsed.value.dispatchId}`);
  const lockPath = join(dispatchRoot(root), `.${parsed.value.dispatchId}.adopt.lock`);
  const acquired = await acquireLock(lockPath, environment);
  if (acquired.kind !== "ok") return acquired;
  try {
    const resolved = await resolveDispatchDirectory(root, parsed.value.dispatchId);
    if (resolved.kind !== "ok") return resolved;
    if (resolved.value.archived) return failed(`dispatch ${parsed.value.dispatchId} is archived; refusing to adopt it`);
    const path = dispatchFile(resolved.value, "meta");
    const meta = await readJson(path);
    if (meta === undefined) return failed(`dispatch not found: ${parsed.value.dispatchId}`);
    const previousOwner = typeof meta.parentSessionId === "string" ? meta.parentSessionId : "";
    const ownerHost = typeof meta.parentHost === "string" ? meta.parentHost : "";
    if (previousOwner === current.id && ownerHost === current.host) return ok(output(parsed.value.dispatchId, false, current.id, parsed.value.json));

    const knownAgentOwner = isAgentSessionId(previousOwner);
    if (knownAgentOwner && !parsed.value.force) {
      const liveness = await ownerLiveness(previousOwner, environment, processAdapter);
      if (liveness === "alive") return failed(`dispatch ${parsed.value.dispatchId} has a live owner ${previousOwner}; use --force to take it over`);
      if (liveness === "unknown") return failed(`dispatch ${parsed.value.dispatchId} owner liveness is unknown for ${previousOwner}; refusing adoption without --force`);
    }

    const now = new Date().toISOString();
    const adoptions = Array.isArray(meta.adoptions) ? meta.adoptions : [];
    const next: Meta = {
      ...meta,
      parentHost: current.host,
      parentSessionId: current.id,
      adoptions: [...adoptions, { previousOwner, adoptedBy: current.id, adoptedAt: now }],
      updatedAt: now,
    };
    try { await atomicJson(path, next); }
    catch (error: unknown) { return failed(`could not record dispatch adoption: ${error instanceof Error ? error.message : "metadata write failed"}`); }
    return ok(output(parsed.value.dispatchId, true, current.id, parsed.value.json));
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
