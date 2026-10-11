import { classifyMarkers, doubleQuote, shellArgument, type Agent, type AgentMarker } from "./types.js";
import { ok } from "../core/result.js";

// The composer box renders a bare "> " at the bottom whether Antigravity CLI is idle or
// generating, so the box alone cannot tell the two apart (measured against real 1.2.9 in tmux) —
// the "Generating..." spinner line above it is what distinguishes them, and it must be checked
// first since it is present on both screens.
const markers: readonly AgentMarker[] = [
  { status: "working", first: /^[ \t]*[\u2800-\u28ff][ \t]+Generating\.*$/m, reason: "terminal shows the Generating indicator" },
  { status: "idle", first: /^>\s*$/m, reason: "terminal shows an empty Antigravity composer" },
];

const trustDialog = /^[ \t]*Do you trust the contents of this project\?[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*Antigravity CLI requires permission to read, edit, and execute files here\.[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*> Yes, I trust this folder[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*No, exit[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*↑\/↓ Navigate · enter Confirm[ \t]*$/m;

export const agy: Agent = {
  id: "agy",
  matchesDescriptor: (descriptor) => descriptor === "agy" || /^agy_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: (output) => classifyMarkers(markers, output),
  firstRunDialog: trustDialog,
  commandLine: ({ model, agentArgs }) => {
    const parts = ["agy", "--dangerously-skip-permissions"];
    if (model !== null) parts.push("--model", doubleQuote(model));
    parts.push(...agentArgs.map(shellArgument));
    return { kind: "ok", value: parts.join(" ") };
  },
  submitKey: () => ok("Enter"),
  interruptKey: () => ok("Escape"),
};
