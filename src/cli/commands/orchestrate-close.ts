import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { failed, ok, unknown, type Result } from "../../core/result.js";
import { closeDecision, closeOutput, hostCloseReason, parseCloseArgs } from "../../core/orchestrate-close.js";
import { hasCallerIdentity, ownsDispatch } from "../../core/context.js";
import { resolveStateDirectory } from "../../core/state.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { atomicJson, readJson, resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { dispatchFile, resolveDispatchDirectory } from "../../adapters/dispatch-store.js";
import { getHost, type HostCommand } from "../../hosts/index.js";
import { getTmux } from "../../hosts/tmux.js";
import { usageText } from "../../core/usage.js";

type RecordValue = Record<string, unknown>;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const absent = (value: string): boolean => {
  const detail = value.replaceAll("_", " ");
  return /not found|does not exist|no such|already closed|already gone|already deleted|404|terminal handle stale|can't find (?:session|pane)|no server running/i.test(detail);
};


export async function tmuxSessionForEnvironment(environment: QueueEnvironment, process: ProcessAdapter): Promise<string | undefined> {
  if (!environment.TMUX || !environment.TMUX_PANE) return undefined;
  const result = await getTmux().sessionForPane(environment.TMUX_PANE, process);
  return result.kind === "ok" ? result.value : undefined;
}

function errorText(result: { readonly error?: string; readonly stdout?: string; readonly value?: { readonly stderr: string } }): string {
  const stdout = result.stdout ?? "";
  const raw = stdout.trim() !== "" ? stdout : result.error ?? result.value?.stderr ?? "";
  return hostCloseReason(/^(?:orca|megabrain_superset) exited with status \d+$/.test(raw) ? "" : raw);
}

async function preserveTranscript(directory: string, meta: RecordValue, process: ProcessAdapter): Promise<void> {
  if (text(meta.runtime) !== "tmux") return;
  const path = `${directory}/transcript`;
  if (await access(path).then(() => true, () => false)) return;
  const pane = text(meta.tmuxPane);
  if (pane === "") return;
  const captured = await getTmux().capturePane(pane, 200, process);
  if (captured.kind !== "ok" || captured.value === "") return;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, captured.value);
  } catch {
    // Transcript capture is best effort; an existing transcript is never overwritten.
  }
}

export function hostCloseCommand(meta: RecordValue): HostCommand | undefined {
  const host = text(meta.childHost);
  const terminal = text(meta.terminalId);
  const workspace = text(meta.workspaceId);
  const provider = getHost(host);
  if (provider === undefined) return undefined;
  const result = provider.close({ workspaceId: workspace === "" ? null : workspace, terminalId: terminal });
  return result.kind === "ok" ? result.value : undefined;
}

async function closeHostTerminal(meta: RecordValue, process: ProcessAdapter): Promise<Result<string>> {
  const call = hostCloseCommand(meta);
  if (call === undefined) return unknown(`capability-unavailable: ${text(meta.childHost)} cannot close terminals`);
  const result = await process.run(call.command, call.args);
  if (result.kind === "ok") return ok("closed");
  const reason = errorText(result);
  return absent(reason) ? ok("absent") : failed(reason);
}

async function closeRecordedTmuxHost(hostId: string, terminalId: string, workspaceId: string | null, process: ProcessAdapter): Promise<Result<void>> {
  const provider = getHost(hostId);
  if (provider === undefined) return failed(`cannot close recorded ${hostId} terminal ${terminalId}: host is unavailable`);
  const call = provider.close({ workspaceId, terminalId });
  if (call.kind === "failed") return call;
  if (call.kind === "unknown") return unknown(call.reason);
  const result = await process.run(call.value.command, call.value.args);
  if (result.kind === "ok" || absent(errorText(result))) return ok(undefined);
  return failed(`could not close recorded ${hostId} terminal ${terminalId}: ${errorText(result)}`, result.exitCode);
}

export async function executeOrchestrateClose(args: readonly string[], environment: QueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-close"));
  const parsed = parseCloseArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment);
  const resolved = await resolveDispatchDirectory(root, parsed.value.dispatchId);
  if (resolved.kind !== "ok") return { ...resolved, error: `${resolved.error}\nmegabrain: dispatch not found: ${parsed.value.dispatchId}` };
  const path = dispatchFile(resolved.value, "meta");
  const meta = await readJson(path); if (meta === undefined) return failed(`dispatch not found: ${parsed.value.dispatchId}`);
  const current = await resolveCaller(environment, process);
  if (!hasCallerIdentity(current)) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const expectedHost = text(meta.parentHost); const expectedId = text(meta.parentSessionId);
  if (!ownsDispatch(current, { parentHost: expectedHost, parentSessionId: expectedId })) return failed(`dispatch ${parsed.value.dispatchId} is owned by ${expectedHost}/${expectedId}, not ${current.host}/${current.id || current.terminalId || ""}`);
  let tmuxSession = current.tmuxSession ?? undefined;
  const callerSession = await tmuxSessionForEnvironment(environment, process);
  if (callerSession !== undefined) tmuxSession = callerSession;
  const decision = closeDecision(meta, { host: current.host, id: current.id, tmuxPane: environment.TMUX_PANE, tmuxSession }, parsed.value.forceRelease);
  if (decision.kind !== "ok") return decision;
  if (decision.value === "retained") return failed(`dispatch ${parsed.value.dispatchId} terminal is retained because identity is unproven; refusing release; verify it manually or rerun with --force-release`);
  if (decision.value === "duplicate") return ok(parsed.value.json ? `${JSON.stringify({ dispatchId: parsed.value.dispatchId, status: "closed", duplicate: true }, null, 2)}\n` : `closed: ${parsed.value.dispatchId}\n`);

  const host = text(meta.childHost); const runtime = text(meta.runtime) || "host";
  let outcome = "unknown";
  await preserveTranscript(resolved.value.directory, meta, process);
  if (runtime === "tmux") {
    const session = text(meta.tmuxSession); const pane = text(meta.tmuxPane); const parentSession = text(meta.parentTmuxSession);
    const shared = session === parentSession || session === tmuxSession;
    const hasSession = await getTmux().sessionExists(session, process);
    if (shared) {
      outcome = "shared-pane";
      if (hasSession.kind === "ok" && hasSession.value) {
        const panes = await getTmux().panesForSession(session, process);
        if (panes.kind === "ok" && panes.value.includes(pane)) {
          if ((await getTmux().killPane(pane, process)).kind !== "ok") return failed("could not close dispatch terminal");
        } else if (panes.kind === "ok") outcome = "absent";
      } else if (hasSession.kind === "ok") {
        outcome = "absent";
      }
    } else {
      let paneCount = 0;
      let paneExists = false;
      let sessionWasKilled = false;
      if (hasSession.kind === "ok" && hasSession.value) {
        const panes = await getTmux().panesForSession(session, process);
        if (panes.kind === "ok") {
          paneCount = panes.value.length;
          paneExists = panes.value.includes(pane);
        }
      }
      const recordPath = `${root}/sessions/${encodeURIComponent(session)}.json`;
      const sessionRecord = await readJson(recordPath);
      const legacyUnregisteredSession = meta.tmuxSessionOwned === undefined && sessionRecord === undefined;
      const sessionOwned = meta.tmuxSessionOwned === true || sessionRecord?.megabrainOwned === true || sessionRecord?.tmuxSessionOwned === true || session === `megabrain-${parsed.value.dispatchId}` || legacyUnregisteredSession;
      if (paneExists && paneCount > 1) {
        outcome = "exclusive-pane";
        if ((await getTmux().killPane(pane, process)).kind !== "ok") return failed("could not close dispatch terminal");
      } else if (paneExists && sessionOwned) {
        outcome = "exclusive-session";
        const killed = await getTmux().killSession(session, process);
        if (killed.kind !== "ok") return failed(`could not close tmux session ${session}: ${killed.error}`);
        sessionWasKilled = true;
      } else if (paneExists) {
        return failed(`refusing to close the last pane in unowned tmux session ${session}`);
      } else {
        outcome = "absent";
      }

      const finalSession = sessionWasKilled ? ok(false) : await getTmux().sessionExists(session, process);
      const sessionGone = finalSession.kind === "ok" && !finalSession.value;
      if (sessionOwned && sessionGone) {
        const hostTerminalId = text(meta.tmuxHostTerminalId) || text(sessionRecord?.hostTerminalId);
        const hostTerminalHost = text(meta.tmuxHostTerminalHost) || text(sessionRecord?.hostTerminalHost);
        const workspaceId = text(meta.workspaceId) || text(sessionRecord?.workspaceId);
        if (hostTerminalId !== "" && hostTerminalHost !== "") {
          const closed = await closeRecordedTmuxHost(hostTerminalHost, hostTerminalId, workspaceId === "" ? null : workspaceId, process);
          if (closed.kind !== "ok") return closed;
        }
        await rm(recordPath, { force: true }).catch(() => undefined);
      }
    }
  } else {
    const hostClose = await closeHostTerminal(meta, process);
    if (hostClose.kind !== "ok") return failed(`could not close dispatch ${parsed.value.dispatchId}: ${hostClose.error}`);
    if (hostClose.value === "absent") outcome = "absent";
  }
  const now = new Date().toISOString();
  const processState = text(meta.processState);
  const next: RecordValue = {
    ...meta,
    state: "closed",
    ...( ["starting", "start-unproven", "running", "stopping", "stop-unproven"].includes(processState) ? { processState: "stopped" } : {}),
    updatedAt: now,
    terminalState: "released",
    terminalReason: null,
  };
  await atomicJson(path, next);
  return ok(closeOutput(parsed.value.dispatchId, parsed.value.json, runtime, host, outcome));
}
