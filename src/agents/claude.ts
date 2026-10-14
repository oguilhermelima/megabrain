import { classifyMarkers, doubleQuote, shellArgument, type Agent, type AgentMarker } from "./types.js";
import { failed, ok } from "../core/result.js";

const markers: readonly AgentMarker[] = [
  { status: "pending-check", first: /Messages to be submitted after next tool call/, second: /press esc to interrupt and send immediately/, reason: "terminal is waiting to submit queued messages" },
  { status: "working", first: /^[ \t]*[·✢✻✽✶✳]\s+\w[^\n]*…(?:\s+\([^\n]*\))?[ \t]*$/m, reason: "terminal shows the working indicator" },
  { status: "working", first: /(?:Working|[✢✻✽✶]\s+[^\n]+…)/, second: /(?:esc to interrupt|·\s*(?:thinking|running))/i, reason: "terminal shows the working indicator" },
  { status: "idle", first: /^[ \t]*❯(?:[ \t\u00a0]+Try "[^"\r\n]*")?[ \t\u00a0]*$/m, reason: "terminal shows an empty or placeholder Claude composer" },
  { status: "blocked", first: /API Error:/, second: /authentication/, reason: "terminal shows an authentication error" },
];

export const claude: Agent = {
  id: "claude",
  matchesDescriptor: (descriptor) => descriptor === "claude" || /^claude-code_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: (output) => classifyMarkers(markers, output),
  contextSource: "claude-transcript",
  compactCommand: "/compact",
  initialPromptFlag: "--",
  commandLine: ({ model, effort, agentArgs }) => {
    // Every Claude child runs in bypass; peer delivery depends on it, so no flag may change the mode.
    if (agentArgs.some((arg) => arg === "--permission-mode" || arg.startsWith("--permission-mode="))) {
      return failed("a Claude child always runs with --dangerously-skip-permissions; --permission-mode cannot be passed through --agent-arg", 2);
    }
    const parts = ["claude", "--dangerously-skip-permissions"];
    if (model !== null) parts.push("--model", doubleQuote(model));
    if (effort !== null) parts.push("--effort", doubleQuote(effort));
    parts.push(...agentArgs.map(shellArgument));
    return { kind: "ok", value: parts.join(" ") };
  },
  submitKey: () => ok("Enter"),
  interruptKey: () => ok("Escape"),
};
