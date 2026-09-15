import { failed, ok, type Result } from "../../core/result.js";
import { closeDecision, closeOutput, hostCloseReason, parseCloseArgs } from "../../core/orchestrate-close.js";
import { resolveStateDirectory } from "../../core/state.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { atomicJson, readJson, type QueueEnvironment } from "./queue-write.js";

type RecordValue = Record<string, unknown>;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const absent = (value: string): boolean => /not found|does not exist|no such|already closed|already gone|already deleted|404/i.test(value);

function caller(environment: QueueEnvironment): { host?: string; id?: string; tmuxPane?: string; tmuxSession?: string } {
  if (environment.TMUX && environment.TMUX_PANE) {
    const identity = environment.SUPERSET_TERMINAL_ID ? { host: "superset", id: environment.SUPERSET_TERMINAL_ID } : environment.ORCA_TERMINAL_HANDLE ? { host: "orca", id: environment.ORCA_TERMINAL_HANDLE } : { host: "tmux", id: environment.MEGABRAIN_SESSION_ID };
    return { ...identity, tmuxPane: environment.TMUX_PANE };
  }
  if (environment.MEGABRAIN_SESSION_ID || environment.SUPERSET_TERMINAL_ID) return { host: environment.MEGABRAIN_SESSION_HOST ?? (environment.SUPERSET_TERMINAL_ID !== undefined ? "superset" : "orca"), id: environment.MEGABRAIN_SESSION_ID ?? environment.SUPERSET_TERMINAL_ID };
  if (environment.ORCA_TERMINAL_HANDLE) return { host: "orca", id: environment.ORCA_TERMINAL_HANDLE };
  return {};
}

function errorText(result: { readonly error?: string; readonly value?: { readonly stderr: string } }): string {
  const raw = result.error ?? result.value?.stderr ?? "";
  return hostCloseReason(/^(?:orca|megabrain_superset) exited with status \d+$/.test(raw) ? "" : raw);
}

export async function executeOrchestrateClose(args: readonly string[], environment: QueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate close <dispatch-id> [--force-release] [--json]\n");
  const parsed = parseCloseArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment);
  const path = `${root}/dispatches/${parsed.value.dispatchId}/meta.json`;
  const meta = await readJson(path); if (meta === undefined) return failed(`dispatch not found: ${parsed.value.dispatchId}`);
  const current = caller(environment);
  if (current.host === undefined || current.id === undefined) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const expectedHost = text(meta.parentHost); const expectedId = text(meta.parentSessionId);
  if (current.host !== expectedHost || current.id !== expectedId) return failed(`dispatch ${parsed.value.dispatchId} is owned by ${expectedHost}/${expectedId}, not ${current.host}/${current.id}`);
  let tmuxSession = current.tmuxSession;
  if (environment.TMUX && environment.TMUX_PANE) {
    const session = await process.run("tmux", ["display-message", "-p", "-t", environment.TMUX_PANE, "#{session_name}"]);
    tmuxSession = session.kind === "ok" ? session.value.stdout.trim() : undefined;
  }
  const decision = closeDecision(meta, { ...current, tmuxSession }, parsed.value.forceRelease);
  if (decision.kind !== "ok") return decision;
  if (decision.value === "retained") return failed(`dispatch ${parsed.value.dispatchId} terminal is retained because identity is unproven; refusing release; verify it manually or rerun with --force-release`);
  if (decision.value === "duplicate") return ok(parsed.value.json ? `${JSON.stringify({ dispatchId: parsed.value.dispatchId, status: "closed", duplicate: true }, null, 2)}\n` : `closed: ${parsed.value.dispatchId}\n`);

  const host = text(meta.childHost); const runtime = text(meta.runtime) || "host"; const terminal = text(meta.terminalId); const workspace = text(meta.workspaceId);
  let outcome = "unknown";
  let releaseFailed = false;
  let reason = "";
  if (runtime === "tmux") {
    const session = text(meta.tmuxSession); const pane = text(meta.tmuxPane); const parentSession = text(meta.parentTmuxSession);
    const shared = session === parentSession || session === tmuxSession;
    const killed = await process.run("tmux", [shared ? "kill-pane" : "kill-session", "-t", shared ? pane : session]);
    if (killed.kind !== "ok") return failed("could not close dispatch terminal");
    outcome = shared ? "shared-pane" : "exclusive-session";
  } else {
    const command = host === "orca" ? "orca" : "megabrain_superset";
    const hostArgs = host === "orca" ? ["terminal", "close", "--terminal", terminal, "--json"] : ["terminals", "close", "--workspace", workspace, "--terminal", terminal, "--json"];
    const result = await process.run(command, hostArgs);
    if (result.kind !== "ok") {
      reason = errorText(result);
      if (!absent(reason)) releaseFailed = true;
    }
  }
  if (releaseFailed) return failed(`could not close dispatch ${parsed.value.dispatchId}: ${reason}`);
  const now = new Date().toISOString();
  const next: RecordValue = { ...meta, state: "closed", updatedAt: now, ...(releaseFailed ? { terminalState: "retained", terminalReason: reason } : { terminalState: "released", terminalReason: null }) };
  await atomicJson(path, next);
  return ok(closeOutput(parsed.value.dispatchId, parsed.value.json, runtime, host, outcome));
}
