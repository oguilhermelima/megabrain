import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { failed, ok, unknown, type Result } from "../../core/result.js";
import { closeDecision, closeOutput, hostCloseReason, isHostTerminalAbsent, parseCloseArgs } from "../../core/orchestrate-close.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { getHost, type HostCommand } from "../../hosts/index.js";
import { getTmux, verifyTmuxPane } from "../../hosts/tmux.js";
import { usageText } from "../../core/usage.js";
import { cleanTranscript } from "../../core/dispatch-read.js";
import { stateDatabase, getDispatch, listDispatches, mutateDispatch, getTmuxSession, getTmuxSessionByStableId, deleteTmuxSession, transcriptPath } from "../../adapters/state-db.js";
import { resolveParentDispatchId } from "./parent-dispatch.js";
import { ownedGrokLeaders, stopGrokLeader, sweepGrokLeaders } from "../../agents/grok-leader.js";
import { resolveStateDirectory } from "../../core/state.js";
import { agyParentKey, forgetAgyLanguageServer } from "../../agents/agy-ls.js";

type RecordValue = Record<string, unknown>;
const text = (value: unknown): string => typeof value === "string" ? value : "";


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

async function preserveTranscript(environment: QueueEnvironment, id: string, meta: RecordValue, process: ProcessAdapter): Promise<void> {
  if (text(meta.runtime) !== "tmux") return;
  const storedPath = transcriptPath(environment, id);
  if (storedPath.kind !== "ok") return;
  const path = storedPath.value;
  if (await access(path).then(() => true, () => false)) return;
  const pane = text(meta.tmuxPane);
  if (pane === "") return;
  const captured = await getTmux().capturePane(pane, 200, process);
  if (captured.kind !== "ok" || captured.value === "") return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, cleanTranscript(captured.value).text);
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
  return isHostTerminalAbsent(reason) ? ok("absent") : failed(reason);
}

async function closeRecordedTmuxHost(hostId: string, terminalId: string, workspaceId: string | null, process: ProcessAdapter): Promise<Result<void>> {
  const provider = getHost(hostId);
  if (provider === undefined) return failed(`cannot close recorded ${hostId} terminal ${terminalId}: host is unavailable`);
  const call = provider.close({ workspaceId, terminalId });
  if (call.kind === "failed") return call;
  if (call.kind === "unknown") return unknown(call.reason);
  const result = await process.run(call.value.command, call.value.args);
  if (result.kind === "ok" || isHostTerminalAbsent(errorText(result))) return ok(undefined);
  return failed(`could not close recorded ${hostId} terminal ${terminalId}: ${errorText(result)}`, result.exitCode);
}

export async function executeOrchestrateClose(args: readonly string[], environment: QueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-close"));
  const parsed = parseCloseArgs(args); if (parsed.kind !== "ok") return parsed;
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const current = await resolveCaller(environment, process);
  const resolved = resolveParentDispatchId(database.value, parsed.value.dispatchId, current);
  if (resolved.kind !== "ok") return resolved;
  const dispatchId = resolved.value;
  const metaResult = getDispatch(database.value, dispatchId);
  if (metaResult.kind !== "ok") return metaResult;
  const meta = metaResult.value;
  if (meta === undefined) return failed(`dispatch not found: ${dispatchId}`);
  const active = listDispatches(database.value);
  if (active.kind !== "ok") return active;
  if (!active.value.some((item) => item.dispatchId === dispatchId)) {
    const message = `dispatch ${dispatchId} is archived; nothing to close`;
    return ok(parsed.value.json ? `${JSON.stringify({ dispatchId, status: "archived", message }, null, 2)}\n` : `${message}\n`);
  }
  let tmuxSession = current.tmuxSession ?? undefined;
  const callerSession = await tmuxSessionForEnvironment(environment, process);
  if (callerSession !== undefined) tmuxSession = callerSession;
  const decision = closeDecision(meta, { host: current.host, id: current.id, tmuxPane: environment.TMUX_PANE, tmuxSession }, parsed.value.forceRelease);
  if (decision.kind !== "ok") return decision;
  if (decision.value === "retained") return failed(`dispatch ${dispatchId} terminal is retained because identity is unproven; refusing release; verify it manually or rerun with --force-release`);
  if (decision.value === "duplicate") return ok(parsed.value.json ? `${JSON.stringify({ dispatchId, status: "closed", duplicate: true }, null, 2)}\n` : `closed: ${dispatchId}\n`);

  const host = text(meta.childHost); const runtime = text(meta.runtime) || "host";
  let outcome = "unknown";
  await preserveTranscript(environment, dispatchId, meta, process);
  if (runtime === "tmux") {
    const session = text(meta.tmuxSession); const pane = text(meta.tmuxPane); const parentSession = text(meta.parentTmuxSession);
    const stableId = text(meta.tmuxSessionId);
    const shared = session === parentSession || session === tmuxSession;
    const hasSession = await getTmux().sessionExists(session, process);
    if (shared) {
      outcome = "shared-pane";
      if (hasSession.kind === "ok" && hasSession.value) {
        const panes = await getTmux().panesForSession(session, process);
        if (panes.kind === "ok" && panes.value.includes(pane) && (await getTmux().killPane(pane, process, stableId || undefined)).kind !== "ok") return failed("could not close dispatch terminal");
      }
    } else {
      let paneCount = 0;
      let paneExists = false;
      let sessionWasKilled = false;
      if (hasSession.kind === "ok" && hasSession.value) {
        const proof = await verifyTmuxPane(pane, process, stableId === "" ? undefined : stableId);
        if (proof.kind !== "ok") return failed(`could not verify tmux pane ${pane} before close`);
        paneExists = proof.value;
        if (paneExists) {
          const panes = await getTmux().panesForSession(session, process);
          if (panes.kind !== "ok") return failed(`could not verify tmux panes for session ${session} before close`);
          paneCount = panes.value.length;
        }
      }
      const stableRecord = stableId === "" ? { kind: "ok" as const, value: undefined } : getTmuxSessionByStableId(database.value, stableId);
      if (stableRecord.kind !== "ok") return failed(stableRecord.error, stableRecord.exitCode);
      const namedRecord = stableRecord.value === undefined ? getTmuxSession(database.value, session) : stableRecord;
      if (namedRecord.kind !== "ok") return failed(namedRecord.error, namedRecord.exitCode);
      const sessionRecord = namedRecord.value;
      const legacyUnregisteredSession = meta.tmuxSessionOwned === undefined && sessionRecord === undefined;
      const sessionOwned = meta.tmuxSessionOwned === true || sessionRecord?.megabrainOwned === true || sessionRecord?.tmuxSessionOwned === true || session === `megabrain-${dispatchId}` || legacyUnregisteredSession;
      if (paneExists && paneCount > 1) {
        outcome = "exclusive-pane";
        if ((await getTmux().killPane(pane, process, stableId || undefined)).kind !== "ok") return failed("could not close dispatch terminal");
      } else if (paneExists && sessionOwned) {
        outcome = "exclusive-session";
        const killed = await getTmux().killSession(session, process, stableId || undefined);
        if (killed.kind !== "ok") return failed(`could not close tmux session ${session}: ${killed.error}`);
        sessionWasKilled = true;
      } else if (paneExists) {
        return failed(`refusing to close the last pane in unowned tmux session ${session}`);
      } else {
        outcome = sessionOwned ? "exclusive-session" : "exclusive-pane";
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
        deleteTmuxSession(database.value, session);
      }
    }
  } else {
    const hostClose = await closeHostTerminal(meta, process);
    if (hostClose.kind !== "ok") return failed(`could not close dispatch ${dispatchId}: ${hostClose.error}`);
    if (hostClose.value === "absent") outcome = "absent";
  }
  // A Grok child's own leader outlives its pane; nothing else would ever stop it.
  if (text(meta.grokLeaderSocket) !== "") await stopGrokLeader(text(meta.grokLeaderSocket), process);
  const now = new Date().toISOString();
  const processState = text(meta.processState);
  const next: RecordValue = {
    ...meta,
    state: "closed",
    ...( ["starting", "start-unproven", "running", "stopping", "stop-unproven"].includes(processState) ? { processState: "stopped" } : {}),
    updatedAt: now,
    terminalState: "released",
    terminalReason: null,
    ...(current.operator === true ? { closedBy: "operator" } : {}),
  };
  const updated = mutateDispatch(database.value, dispatchId, () => next);
  if (updated.kind !== "ok") return updated;
  // The agy language server token dies with that agy; keeping it would only leave a secret behind.
  await forgetAgyLanguageServer(resolveStateDirectory(environment), dispatchId);
  await forgetAgyLanguageServer(resolveStateDirectory(environment), agyParentKey(dispatchId));
  const remaining = listDispatches(database.value);
  if (remaining.kind === "ok") await sweepGrokLeaders(resolveStateDirectory(environment), ownedGrokLeaders(remaining.value), process);
  return ok(closeOutput(dispatchId, parsed.value.json, runtime, host, outcome));
}
