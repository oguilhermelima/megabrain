import { type ProcessAdapter } from "../adapters/proc.js";
import { failed, ok, unknown, type Result } from "../core/result.js";

export type TmuxProvider = Readonly<{
  readonly id: string;
  readonly sessionForPane: (pane: string, process: ProcessAdapter) => Promise<Result<string>>;
  readonly sessionExists: (session: string, process: ProcessAdapter) => Promise<Result<boolean>>;
  readonly panesForSession: (session: string, process: ProcessAdapter) => Promise<Result<readonly string[]>>;
  readonly panePid: (pane: string, process: ProcessAdapter) => Promise<Result<string>>;
  readonly capturePane: (pane: string, lines: number, process: ProcessAdapter) => Promise<Result<string>>;
  readonly sendText: (pane: string, text: string, process: ProcessAdapter) => Promise<Result<void>>;
  readonly sendKey: (pane: string, key: string, process: ProcessAdapter) => Promise<Result<void>>;
}>;

function unavailable(query: string): Result<never> {
  return unknown(`tmux ${query} could not be determined`);
}

const provider: TmuxProvider = {
  id: "tmux",
  sessionForPane: async (pane, process) => {
    const result = await process.run("tmux", ["display-message", "-p", "-t", pane, "#{session_name}"]);
    if (result.kind !== "ok") return unavailable(`session for pane ${pane}`);
    const session = result.value.stdout.trim();
    return session.length > 0 ? ok(session) : unavailable(`session for pane ${pane}`);
  },
  sessionExists: async (session, process) => {
    const result = await process.run("tmux", ["has-session", "-t", session]);
    return result.kind === "ok" ? ok(true) : unavailable(`existence of session ${session}`);
  },
  panesForSession: async (session, process) => {
    const result = await process.run("tmux", ["list-panes", "-t", session, "-F", "#{pane_id}"]);
    if (result.kind !== "ok") return unavailable(`panes for session ${session}`);
    return ok(result.value.stdout.split("\n").filter((pane) => pane.length > 0));
  },
  panePid: async (pane, process) => {
    const result = await process.run("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"]);
    if (result.kind !== "ok") return unavailable(`PID for pane ${pane}`);
    const pid = result.value.stdout.trim();
    return pid.length > 0 ? ok(pid) : unavailable(`PID for pane ${pane}`);
  },
  capturePane: async (pane, lines, process) => {
    const result = await process.run("tmux", ["capture-pane", "-p", "-t", pane, "-S", `-${lines}`]);
    return result.kind === "ok" ? ok(result.value.stdout) : unavailable(`capture of pane ${pane}`);
  },
  sendText: async (pane, text, process) => {
    const result = await process.run("tmux", ["send-keys", "-t", pane, "-l", text]);
    return result.kind === "ok" ? ok(undefined) : failed(result.error);
  },
  sendKey: async (pane, key, process) => {
    const result = await process.run("tmux", ["send-keys", "-t", pane, key]);
    return result.kind === "ok" ? ok(undefined) : failed(result.error);
  },
};

const registry = new Map<string, TmuxProvider>([[provider.id, provider]]);

export function registerTmux(value: TmuxProvider): void {
  registry.set(value.id, value);
}

export function unregisterTmux(id: string): void {
  registry.delete(id);
}

export function getTmux(): TmuxProvider {
  return registry.get(provider.id) ?? provider;
}
