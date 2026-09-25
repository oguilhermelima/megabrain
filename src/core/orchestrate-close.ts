import { failed, ok, type Result } from "./result.js";
import { usageText } from "./usage.js";

export type CloseArguments = Readonly<{ dispatchId: string; forceRelease: boolean; json: boolean }>;
export type CloseDecision = "close" | "duplicate" | "retained" | "caller";

export function hostCloseReason(raw: string): string {
  let extracted: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const error = parsed.error;
      if (typeof error === "object" && error !== null) {
        if ("message" in error && typeof error.message === "string") extracted = error.message;
        else if ("code" in error && typeof error.code === "string") extracted = error.code;
      } else if (typeof error === "string") extracted = error;
    }
    if (extracted === undefined && typeof parsed === "object" && parsed !== null && "message" in parsed && typeof parsed.message === "string") extracted = parsed.message;
  } catch {
    // The host may return plain text instead of JSON.
  }
  const reason = (typeof extracted === "string" ? extracted : raw).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return reason === "" ? "the host gave no reason" : reason;
}

export function parseCloseArgs(args: readonly string[]): Result<CloseArguments> {
  const dispatchId = args[0] ?? "";
  if (dispatchId === "") return failed(usageText("orchestrate-close"), 2);
  let forceRelease = false;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force-release") forceRelease = true;
    else if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return ok({ dispatchId, forceRelease, json });
    else return failed(`unknown orchestrate close option: ${arg}`, 2);
  }
  return ok({ dispatchId, forceRelease, json });
}

export function closeDecision(meta: Readonly<Record<string, unknown>>, caller: Readonly<{ host?: string; id?: string; tmuxPane?: string; tmuxSession?: string }>, forceRelease: boolean): Result<CloseDecision> {
  if (meta.runtime === "tmux" && caller.tmuxPane !== undefined && caller.tmuxPane !== "" && meta.tmuxPane === caller.tmuxPane && (caller.tmuxSession === undefined || caller.tmuxSession === "" || meta.tmuxSession === caller.tmuxSession)) {
    return failed(`refusing to close dispatch ${String(meta.dispatchId ?? "")}: target tmux pane ${caller.tmuxPane} is the calling pane`);
  }
  if (meta.terminalState === "retained" && !forceRelease) return ok("retained");
  if (meta.state === "closed") return ok("duplicate");
  return ok("close");
}

export function closeOutput(dispatchId: string, json: boolean, runtime: string, host: string, outcome: string): string {
  if (!json) {
    const message = outcome === "shared-pane" ? "tmux pane removed; the shared tmux session and host terminal tab were kept." : outcome === "exclusive-pane" ? "tmux pane removed; the exclusive tmux session and host terminal tab were kept for remaining panes." : outcome === "exclusive-session" ? "last tmux pane removed; the exclusive tmux session and host terminal tab were closed." : host === "superset" ? "Superset leaves the pane visible as Desconectado until the human dismisses it with the pane X." : "";
    return `closed: ${dispatchId}\n${message === "" ? "" : `${message}\n`}`;
  }
  const message = runtime === "tmux" && outcome === "shared-pane" ? "tmux pane removed; the shared tmux session and host terminal tab were kept." : runtime === "tmux" && outcome === "exclusive-pane" ? "tmux pane removed; the exclusive tmux session and host terminal tab were kept for remaining panes." : runtime === "tmux" && outcome === "exclusive-session" ? "last tmux pane removed; the exclusive tmux session and host terminal tab were closed." : host === "superset" ? "Superset leaves the pane visible as Desconectado until the human dismisses it with the pane X." : undefined;
  return `${JSON.stringify(message === undefined ? { dispatchId, status: "closed" } : { dispatchId, status: "closed", message }, null, 2)}\n`;
}
