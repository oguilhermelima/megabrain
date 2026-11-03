import { classifyMarkers, doubleQuote, launchArgv, shellArgument, type Agent, type AgentFlags, type AgentMarker } from "./types.js";
import { ok } from "../core/result.js";

const markers: readonly AgentMarker[] = [
  { status: "blocked", first: /Update available/, second: /Skip until next version/, reason: "codex update dialog" },
  { status: "working", first: /OpenAI Codex[\s\S]{0,120}\bloading\b/i, reason: "Codex is still drawing its startup header" },
  { status: "working", first: /Starting MCP servers(?:\s+\(\d+\/\d+\))?/i, reason: "Codex is still starting MCP servers" },
  { status: "pending-check", first: /Messages to be submitted after next tool call/, second: /press esc to interrupt and send immediately/, reason: "terminal is waiting to submit queued messages" },
  { status: "working", first: /Working \(/, second: /esc to interrupt/, reason: "terminal shows the working indicator" },
  { status: "idle", first: /^\s*›(?: Ask Codex to do anything)?\s*$/m, reason: "terminal shows an empty Codex composer" },
  { status: "blocked", first: /^\s*You've hit your usage limit for/m, second: /Switch to another model now,/, reason: "terminal shows a usage limit refusal" },
  { status: "blocked", first: /Hook error:/, second: /socket connection was closed unexpectedly/, reason: "terminal shows a socket connection transport error" },
];

export const codexFlags: AgentFlags = {
  executable: "codex",
  permission: ["--dangerously-bypass-approvals-and-sandbox"],
  startup: ["-c", "check_for_update_on_startup=false"],
  model: (value, quote) => ["-c", `model=${quote(value)}`],
  effort: (value, quote) => ["-c", `model_reasoning_effort=${quote(value)}`],
  resume: (id, quote) => ({ lead: ["resume", quote(id)], trail: [] }),
};

export const codex: Agent = {
  id: "codex",
  matchesDescriptor: (descriptor) => descriptor === "codex" || /^codex_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: (output) => classifyMarkers(markers, output),
  contextSource: "codex-rollout",
  compactCommand: "/compact",
  initialPromptFlag: "--",
  flags: codexFlags,
  commandLine: ({ model, effort, browser, agentArgs }) => {
    const [executable, ...permission] = launchArgv(codexFlags, null, null, doubleQuote);
    const parts = [executable ?? "codex", "--dangerously-bypass-hook-trust", ...permission];
    // Fast send-keys text immediately followed by Enter is read as one paste burst, and the
    // trailing Enter is absorbed into the paste instead of submitting it (measured against real
    // codex 0.155.1 in tmux).
    parts.push("-c", "disable_paste_burst=true");
    parts.push(...launchArgv(codexFlags, model, effort, doubleQuote).slice(1 + codexFlags.permission.length + codexFlags.startup.length));
    parts.push("-c", `mcp_servers.playwright.enabled=${browser}`);
    parts.push(...agentArgs.map(shellArgument));
    return { kind: "ok", value: parts.join(" ") };
  },
  submitKey: () => ok("Tab"),
};
