import { classifyMarkers, doubleQuote, shellArgument, type Agent, type AgentMarker } from "./types.js";
import { ok } from "../core/result.js";

const markers: readonly AgentMarker[] = [
  { status: "pending-check", first: /Messages to be submitted after next tool call/, second: /press esc to interrupt and send immediately/, reason: "terminal is waiting to submit queued messages" },
  { status: "working", first: /Working \(/, second: /esc to interrupt/, reason: "terminal shows the working indicator" },
  { status: "idle", first: /^\s*› Ask Codex to do anything\s*$/m, reason: "terminal shows an empty Codex composer" },
  { status: "blocked", first: /^\s*You've hit your usage limit for/m, second: /Switch to another model now,/, reason: "terminal shows a usage limit refusal" },
  { status: "blocked", first: /Hook error:/, second: /socket connection was closed unexpectedly/, reason: "terminal shows a socket connection transport error" },
];

export const codex: Agent = {
  id: "codex",
  matchesDescriptor: (descriptor) => descriptor === "codex" || /^codex_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: (output) => classifyMarkers(markers, output),
  commandLine: ({ model, effort, browser, agentArgs }) => {
    const parts = ["codex", "--dangerously-bypass-hook-trust", "--dangerously-bypass-approvals-and-sandbox"];
    // Codex's own startup update check can pop an "Update available!" modal (default option
    // runs a remote installer) over an already-idle composer, after readiness has been
    // confirmed and right as the prompt's Enter is about to land. Disable it at launch.
    parts.push("-c", "check_for_update_on_startup=false");
    if (model !== null) parts.push("-c", `model=${doubleQuote(model)}`);
    if (effort !== null) parts.push("-c", `model_reasoning_effort=${doubleQuote(effort)}`);
    parts.push("-c", `mcp_servers.playwright.enabled=${browser}`);
    parts.push(...agentArgs.map(shellArgument));
    return { kind: "ok", value: parts.join(" ") };
  },
  submitKey: () => ok("Tab"),
  interruptKey: () => ok("Escape"),
};
