import { classifyMarkers, doubleQuote, shellArgument, type Agent, type AgentMarker } from "./types.js";
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

const trustDialog = /Do you trust the contents of this directory\?[\s\S]*Yes, proceed[ \t]+y\b[\s\S]*No, quit[ \t]+n\b/;

export const grok: Agent = {
  id: "grok",
  matchesDescriptor: (descriptor) => descriptor === "grok" || descriptor === "grok-build" || /^grok_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: (output) => classifyMarkers(markers, output),
  contextSource: "grok-session",
  firstRunDialog: trustDialog,
  firstRunDialogKey: "y",
  commandLine: ({ model, effort, agentArgs }) => {
    const parts = ["grok", "--always-approve"];
    if (model !== null) parts.push("-m", doubleQuote(model));
    if (effort !== null) parts.push("--reasoning-effort", doubleQuote(effort));
    parts.push(...agentArgs.map(shellArgument));
    return { kind: "ok", value: parts.join(" ") };
  },
  submitKey: () => ok("Enter"),
  // Escape only leaves the scrollback; Ctrl+C is what cancels a running turn (measured).
  interruptKey: () => ok("C-c"),
};
