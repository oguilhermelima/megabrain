import { classifyMarkers, doubleQuote, launchArgv, shellArgument, type Agent, type AgentFlags, type AgentMarker } from "./types.js";
import { ok } from "../core/result.js";

// Measured against real grok 1.0.50 in tmux. The composer is a bordered box whose "❯" row is the
// same on an idle and a working screen, so only the spinner row above it ("… 4.0s … [stop]")
// separates them. A permission dialog replaces the box while the tool row (and its [stop]) is
// still on screen, so it is checked first.
const markers: readonly AgentMarker[] = [
  { status: "blocked", first: /^[ \t]*┃[ \t]+\d \([●○]\) /m, second: /No, reject/, reason: "terminal shows a permission dialog" },
  { status: "working", first: /\[stop\][ \t]*$/m, reason: "terminal shows the stop affordance" },
  { status: "idle", first: /^[ \t]*│ ❯[ \t]*│[ \t]*$/m, reason: "terminal shows an empty Grok composer" },
];

export const grokFlags: AgentFlags = {
  executable: "grok",
  permission: ["--always-approve"],
  startup: [],
  model: (value, quote) => ["-m", quote(value)],
  effort: (value, quote) => ["--reasoning-effort", quote(value)],
  resume: (id, quote) => ({ lead: [], trail: ["--resume", quote(id)] }),
};

export const grok: Agent = {
  id: "grok",
  matchesDescriptor: (descriptor) => descriptor === "grok" || descriptor === "grok-build" || /^grok_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: (output) => classifyMarkers(markers, output),
  contextSource: "grok-session",
  initialPromptFlag: "--",
  flags: grokFlags,
  commandLine: ({ model, effort, agentArgs }) => {
    const parts = launchArgv(grokFlags, model, effort, doubleQuote);
    parts.push(...agentArgs.map(shellArgument));
    return { kind: "ok", value: parts.join(" ") };
  },
  submitKey: () => ok("Enter"),
};
