import { classifyMarkers, doubleQuote, shellArgument, type Agent, type AgentMarker } from "./types.js";
import { ok } from "../core/result.js";

// The composer box renders a bare "> " at the bottom whether Antigravity CLI is idle or
// generating, so the box alone cannot tell the two apart (measured against real 1.2.9 in tmux) —
// the "Generating..." spinner line above it is what distinguishes them, and it must be checked
// first since it is present on both screens.
const markers: readonly AgentMarker[] = [
  { status: "working", first: /Generating\.\.\./, reason: "terminal shows the Generating indicator" },
  { status: "idle", first: /^>\s*$/m, reason: "terminal shows an empty Antigravity composer" },
];

export const agy: Agent = {
  id: "agy",
  matchesDescriptor: (descriptor) => descriptor === "agy" || /^agy_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: (output) => classifyMarkers(markers, output),
  commandLine: ({ model, agentArgs }) => {
    const parts = ["agy", "--dangerously-skip-permissions"];
    if (model !== null) parts.push("--model", doubleQuote(model));
    parts.push(...agentArgs.map(shellArgument));
    return { kind: "ok", value: parts.join(" ") };
  },
  submitKey: () => ok("Enter"),
  interruptKey: () => ok("Escape"),
};
