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
    const capture = await getTmux().capturePane(String(meta.tmuxPane ?? ""), 200, process, true, undefined, true);
    return capture.kind === "ok" ? ok(normalizeInterruptedScreen(agent, withoutGhostText(capture.value))) : capture;
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

const PROMPT_GLYPH = /^\s*[❯›>$]/;
const SGR = /\x1b\[([0-9;:]*)m/g;
const RULE = /^\s*─{8,}\s*$/;

function stripStyles(line: string, dropDim: boolean): string {
  let dim = false;
  let out = "";
  let last = 0;
  for (const match of line.matchAll(SGR)) {
    if (!dim) out += line.slice(last, match.index);
    last = match.index + match[0].length;
    const codes = (match[1] ?? "").split(/[;:]/).map((code) => (code === "" ? 0 : Number(code)));
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 38 || code === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
      else if (code === 0 || code === 22) dim = false;
      else if (code === 2) dim = true;
    }
  }
  if (!dim) out += line.slice(last);
  return dropDim ? out : line.replace(SGR, "");
}

// A finished Claude turn leaves a dim (SGR 2) next-prompt suggestion in the empty composer; tmux
// can tell it from typed text, so drop dim text on prompt lines and return a plain screen.
function withoutGhostText(escaped: string): string {
  return escaped.split("\n").map((line) => {
    const plain = stripStyles(line, false);
    return PROMPT_GLYPH.test(plain) ? stripStyles(line, true) : plain;
  }).join("\n");
}

export function deliveryComposer(agent: string, screen: string): string | undefined {
  const draftLine = [...screen.split("\n")].reverse().find((line: string) => line.startsWith("MEGABRAIN_COMPOSER_DRAFT:"));
  if (draftLine !== undefined) return draftLine.slice("MEGABRAIN_COMPOSER_DRAFT:".length);
  const prompt = agent === "claude" ? /^\s*❯[  ]?(.*)$/ : agent === "codex" ? /^\s*›[  ]?(.*)$/ : /^\s*[>$] ?(.*)$/;
  const lines = screen.split("\n");
  const rules = lines.flatMap((line, index) => (RULE.test(line) ? [index] : []));
  const boxed = rules.length >= 2;
  const region = boxed ? lines.slice((rules.at(-2) ?? 0) + 1, rules.at(-1)) : lines;
  const match = boxed ? region.find((line: string) => prompt.test(line)) : [...region].reverse().find((line: string) => prompt.test(line));
  if (match === undefined) return undefined;
  const value = prompt.exec(match)?.[1] ?? "";
  if (agent === "codex" && value.trim() === "Ask Codex to do anything") return "";
  if (agent === "claude" && value.trim().startsWith("Try \"")) return "";
  return value.trimEnd();
}

// Never submit an agent's confirmation or selection dialog with the delivery key.
export function deliveryHasKeystrokeDialog(agent: string, screen: string): boolean {
  const lines = screen.split("\n");
  const bottom = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim() !== "").slice(-15);
  const text = bottom.map(({ line }) => line).join("\n");
  const dialog = agent === "claude"
    ? /Allow this action\?|Do you want to proceed\?|Allow .+? to run/i
    : agent === "codex"
      ? /Would you like to run this command\?|Run this command\?/i
      : agent === "grok"
        ? /Yes, and don't ask again for anything|No, reject \(type to add feedback\)/i
        : agent === "agy"
          ? /Do you trust the contents of this project\?|Antigravity CLI requires permission to read, edit, and execute files here\./i
          : undefined;
  if (dialog === undefined) return false;
  const match = dialog.exec(text);
  if (match === null || match.index === undefined) return false;

  // Old agent output can contain any words. When a composer is still visible, only treat
  // a dialog drawn after it as active; dialogs that replace the composer remain detectable.
  const prompt = agent === "claude" ? /^\s*❯/ : agent === "codex" ? /^\s*›/ : /^\s*[>$]/;
  let composerLine = -1;
  if (deliveryComposer(agent, screen) === "") {
    for (const { line, index } of bottom) if (prompt.test(line)) composerLine = index;
  }
  if (composerLine >= 0) {
    const precedingText = bottom.filter(({ index }) => index <= composerLine).map(({ line }) => line).join("\n");
    if (dialog.test(precedingText)) return false;
  }
  return true;
}
