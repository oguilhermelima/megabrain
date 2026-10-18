import { classifyMarkers, doubleQuote, launchArgv, shellArgument, type Agent, type AgentFlags, type AgentMarker } from "./types.js";
import { agyModelId } from "../core/model.js";
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

export const agyFlags: AgentFlags = {
  executable: "agy",
  permission: ["--dangerously-skip-permissions"],
  startup: [],
  model: (value, quote) => ["--model", quote(value)],
  // agy 1.4.0 also has --effort, but the ids `agy models` lists carry the level, and those are the
  // ones known to start; the registry folds them per model and the launch joins them back.
  effort: null,
  modelWithEffort: agyModelId,
  resume: (id, quote) => ({ lead: [], trail: ["--conversation", quote(id)] }),
};

export const agy: Agent = {
  id: "agy",
  matchesDescriptor: (descriptor) => descriptor === "agy" || /^agy_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: (output) => classifyMarkers(markers, output),
  firstRunDialog: trustDialog,
  initialPromptFlag: "-i",
  flags: agyFlags,
  commandLine: ({ model, effort, agentArgs }) => {
    const parts = launchArgv(agyFlags, model, effort, doubleQuote);
    parts.push(...agentArgs.map(shellArgument));
    return { kind: "ok", value: parts.join(" ") };
  },
  submitKey: () => ok("Enter"),
};
