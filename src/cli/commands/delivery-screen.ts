import { failed, ok, type Result } from "../../core/result.js";
import { classifyLiveness } from "../../core/liveness.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { getHost } from "../../hosts/index.js";
import { getTmux } from "../../hosts/tmux.js";
import { terminalStatus } from "./orchestrate-terminal.js";

export type DeliveryMeta = Record<string, unknown>;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function normalizeInterruptedScreen(agent: string, output: string): string {
  if (classifyLiveness(agent, output).status !== "unknown") return output;
  if (agent === "codex" && /Conversation interrupted/.test(output) && /^\s*› (?!Ask Codex to do anything\s*$).+$/m.test(output)) return `${output}\n› Ask Codex to do anything`;
  if (agent === "claude" && /Interrupted · What should Claude do instead\?/.test(output) && /^\s*❯\s*\S.+$/m.test(output)) return `${output}\n❯`;
  return output;
}

function hostScreen(stdout: string): Result<string> {
  try {
    const root = recordValue(JSON.parse(stdout));
    const terminal = recordValue(recordValue(root?.result)?.terminal);
    const tail = terminal?.tail;
    const output = typeof tail === "string" ? tail : Array.isArray(tail) && tail.every((line) => typeof line === "string") ? tail.join("\n") : undefined;
    if (output === undefined) return failed("terminal screen read did not include result.terminal.tail");
    const draft = typeof terminal?.draft === "string" ? terminal.draft : "";
    return ok(draft === "" ? output : `${output}\nMEGABRAIN_COMPOSER_DRAFT:${draft}`);
  } catch {
    return failed("terminal screen read returned invalid JSON");
  }
}

export async function readDeliveryScreen(meta: DeliveryMeta, process: ProcessAdapter): Promise<Result<string>> {
  const agent = typeof meta.agent === "string" ? meta.agent : "";
  const identity = await terminalStatus(meta, process);
  if (identity !== "proven") return failed(identity === "missing" ? "terminal is no longer available" : "terminal identity is unproven");
  if (meta.runtime === "tmux") {
    const capture = await getTmux().capturePane(String(meta.tmuxPane ?? ""), 200, process, true);
    return capture.kind === "ok" ? ok(normalizeInterruptedScreen(agent, capture.value)) : capture;
  }
  const provider = getHost(String(meta.childHost ?? ""));
  if (provider === undefined) return failed(`screen read is unavailable for host ${String(meta.childHost ?? "unknown")}`);
  const call = provider.read({ workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: String(meta.terminalId ?? "") });
  if (call.kind !== "ok") return call.kind === "failed" ? failed(call.error, call.exitCode) : failed(call.reason);
  const captured = await process.run(call.value.command, [...call.value.args, "--screen"]);
  if (captured.kind !== "ok") return failed(captured.error, captured.exitCode);
  const raw = hostScreen(captured.value.stdout);
  return raw.kind === "ok" ? ok(normalizeInterruptedScreen(agent, raw.value)) : raw;
}

export function deliveryComposer(agent: string, screen: string): string | undefined {
  const draftLine = [...screen.split("\n")].reverse().find((line: string) => line.startsWith("MEGABRAIN_COMPOSER_DRAFT:"));
  if (draftLine !== undefined) return draftLine.slice("MEGABRAIN_COMPOSER_DRAFT:".length);
  const prompt = agent === "claude" ? /^\s*❯ ?(.*)$/ : agent === "codex" ? /^\s*› ?(.*)$/ : /^\s*[>$] ?(.*)$/;
  const lines = screen.split("\n");
  const match = [...lines].reverse().find((line: string) => prompt.test(line));
  if (match === undefined) return undefined;
  const value = prompt.exec(match)?.[1] ?? "";
  if (agent === "codex" && value.trim() === "Ask Codex to do anything") return "";
  if (agent === "claude" && value.trim().startsWith("Try \"")) return "";
  return value.trimEnd();
}
