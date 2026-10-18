import { classifyMarkers, doubleQuote, launchArgv, shellArgument, type Agent, type AgentFlags, type AgentMarker } from "./types.js";
import { failed, ok } from "../core/result.js";

const markers: readonly AgentMarker[] = [
  { status: "pending-check", first: /Messages to be submitted after next tool call/, second: /press esc to interrupt and send immediately/, reason: "terminal is waiting to submit queued messages" },
  { status: "working", first: /^[ \t]*[·✢✻✽✶✳]\s+\w[^\n]*…(?:\s+\([^\n]*\))?[ \t]*$/m, reason: "terminal shows the working indicator" },
  { status: "working", first: /(?:Working|[✢✻✽✶]\s+[^\n]+…)/, second: /(?:esc to interrupt|·\s*(?:thinking|running))/i, reason: "terminal shows the working indicator" },
  { status: "idle", first: /^[ \t]*❯(?:[ \t\u00a0]+Try "[^"\r\n]*")?[ \t\u00a0]*$/m, reason: "terminal shows an empty or placeholder Claude composer" },
  { status: "blocked", first: /API Error:/, second: /authentication/, reason: "terminal shows an authentication error" },
];

export const claudeFlags: AgentFlags = {
  executable: "claude",
  permission: ["--dangerously-skip-permissions"],
  startup: [],
  model: (value, quote) => ["--model", quote(value)],
  effort: (value, quote) => ["--effort", quote(value)],
  resume: (id, quote) => ({ lead: [], trail: ["--resume", quote(id)] }),
};

export const claude: Agent = {
  id: "claude",
  matchesDescriptor: (descriptor) => descriptor === "claude" || /^claude-code_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: (output) => classifyMarkers(markers, output),
  contextSource: "claude-transcript",
  compactCommand: "/compact",
  initialPromptFlag: "--",
  flags: claudeFlags,
  commandLine: ({ model, effort, agentArgs }) => {
    // Every Claude child runs in bypass; peer delivery depends on it, so no flag may change the mode.
    if (agentArgs.some((arg) => arg === "--permission-mode" || arg.startsWith("--permission-mode="))) {
      return failed("a Claude child always runs with --dangerously-skip-permissions; --permission-mode cannot be passed through --agent-arg", 2);
    }
    const parts = launchArgv(claudeFlags, model, effort, doubleQuote);
    parts.push(...agentArgs.map(shellArgument));
    return { kind: "ok", value: parts.join(" ") };
  },
  submitKey: () => ok("Enter"),
};
