import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, readdir } from "node:fs/promises";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { hasCallerIdentity, isAgentSessionId } from "../../core/context.js";
import { resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { usageText } from "../../core/usage.js";
import { stateDatabase, getDispatch, listDispatches, mutateDispatch, acquireLease, releaseLease } from "../../adapters/state-db.js";
import { findCodexProcess } from "../../core/codex-delivery.js";
import { resolveDispatchIdSuffix } from "../../core/dispatch-paths.js";

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

async function codexOwnerLiveness(sessionId: string, meta: Meta, processAdapter: ProcessAdapter): Promise<AdoptionLiveness> {
  const result = await findCodexProcess(sessionId.slice("codex:".length), {
    runtime: typeof meta.parentTmuxPane === "string" ? "tmux" : "host",
    host: meta.parentHost, terminalId: meta.parentTerminalId ?? meta.parentSessionId,
    workspaceId: meta.parentWorkspaceId, tmuxPane: meta.parentTmuxPane, tmuxSessionId: meta.parentTmuxSessionId,
  }, processAdapter);
  return "pid" in result ? "alive" : "unknown";
}

async function ownerLiveness(sessionId: string, meta: Meta, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<AdoptionLiveness> {
  if (sessionId.startsWith("claude:")) return claudeOwnerLiveness(sessionId, environment, processAdapter);
  if (sessionId.startsWith("codex:")) return codexOwnerLiveness(sessionId, meta, processAdapter);
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

  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const dispatches = listDispatches(database.value, { includeArchived: true });
  if (dispatches.kind !== "ok") return dispatches;
  const resolved = resolveDispatchIdSuffix(parsed.value.dispatchId, dispatches.value.map((record) => record.dispatchId));
  if (resolved.kind === "ambiguous") return failed(`dispatch id suffix ${parsed.value.dispatchId} is ambiguous: ${resolved.dispatchIds.join(", ")}`);
  if (resolved.kind === "too-short") return failed("dispatch id must contain at least 8 characters", 2);
  if (resolved.kind === "unknown") return failed(`dispatch not found: ${parsed.value.dispatchId}`);
  const dispatchId = resolved.dispatchId;
  const initial = getDispatch(database.value, dispatchId);
  if (initial.kind !== "ok") return initial;
  if (initial.value === undefined) return failed(`dispatch not found: ${dispatchId}`);
  const initialLive = listDispatches(database.value);
  if (initialLive.kind !== "ok") return initialLive;
  if (!initialLive.value.some((record) => record.dispatchId === dispatchId)) return failed(`dispatch ${dispatchId} is archived; refusing to adopt it`);
  const lockPath = `dispatches/.${dispatchId}.adopt.lock`;
  const holder = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + Math.max(0, Number(environment.MEGABRAIN_LOCK_WAIT_SECONDS ?? "15")) * 1000;
  let locked = false;
  while (!locked) {
    const acquired = acquireLease(database.value, lockPath, holder, Math.max(1, Number(environment.MEGABRAIN_LOCK_STALE_SECONDS ?? "30")));
    if (acquired.kind !== "ok") return acquired;
    locked = acquired.value;
    if (locked) break;
    if (Date.now() >= deadline) return failed(`mailbox lock is held by another writer: ${lockPath}`);
    await delay(20);
  }
  try {
    const refreshed = getDispatch(database.value, dispatchId);
    if (refreshed.kind !== "ok") return refreshed;
    if (refreshed.value === undefined) return failed(`dispatch not found: ${dispatchId}`);
    const live = listDispatches(database.value);
    if (live.kind !== "ok") return live;
    if (!live.value.some((record) => record.dispatchId === dispatchId)) return failed(`dispatch ${dispatchId} is archived; refusing to adopt it`);
    const meta = refreshed.value as Meta;
    const previousOwner = typeof meta.parentSessionId === "string" ? meta.parentSessionId : "";
    const ownerHost = typeof meta.parentHost === "string" ? meta.parentHost : "";
    if (previousOwner === current.id && ownerHost === current.host) return ok(output(dispatchId, false, current.id, parsed.value.json));

    const knownAgentOwner = isAgentSessionId(previousOwner);
    if (knownAgentOwner && !parsed.value.force) {
      const liveness = await ownerLiveness(previousOwner, meta, environment, processAdapter);
      if (liveness === "alive") return failed(`dispatch ${dispatchId} has a live owner ${previousOwner}; use --force to take it over`);
      if (liveness === "unknown") return failed(`dispatch ${dispatchId} owner liveness is unknown for ${previousOwner}; refusing adoption without --force`);
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
    const updated = mutateDispatch(database.value, dispatchId, () => next);
    if (updated.kind !== "ok") return failed(`could not record dispatch adoption: ${updated.error}`);
    return ok(output(dispatchId, true, current.id, parsed.value.json));
  } finally {
    releaseLease(database.value, lockPath, holder);
  }
}
