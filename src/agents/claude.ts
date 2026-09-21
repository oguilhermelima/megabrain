import { classifyMarkers, type Agent, type AgentMarker } from "./types.js";
import { ok } from "../core/result.js";

const markers: readonly AgentMarker[] = [
  { status: "pending-check", first: /Messages to be submitted after next tool call/, second: /press esc to interrupt and send immediately/, reason: "terminal is waiting to submit queued messages" },
  { status: "working", first: /Working/, second: /esc to interrupt/, reason: "terminal shows the working indicator" },
  { status: "idle", first: /^\s*❯\s*$/m, reason: "terminal shows an empty Claude composer" },
  { status: "blocked", first: /API Error:/, second: /authentication/, reason: "terminal shows an authentication error" },
];

export const claude: Agent = {
  id: "claude",
  matchesDescriptor: (descriptor) => descriptor === "claude" || /^claude-code_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: (output) => classifyMarkers(markers, output),
  submitKey: () => ok("Enter"),
  interruptKey: () => ok("Escape"),
};
