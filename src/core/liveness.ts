export type Liveness = "working" | "idle" | "blocked" | "pending-check" | "unknown" | "missing";
export type LivenessResult = Readonly<{ status: Liveness; reason: string | null }>;
type Marker = Readonly<{ agent: string; status: Exclude<Liveness, "unknown" | "missing">; first: RegExp; second?: RegExp; reason: string }>;
const markers: readonly Marker[] = [
  { agent: "codex", status: "pending-check", first: /Messages to be submitted after next tool call/, second: /press esc to interrupt and send immediately/, reason: "terminal is waiting to submit queued messages" },
  { agent: "codex", status: "working", first: /Working \(/, second: /esc to interrupt/, reason: "terminal shows the working indicator" },
  { agent: "codex", status: "idle", first: /^\s*› Ask Codex to do anything\s*$/m, reason: "terminal shows an empty Codex composer" },
  { agent: "codex", status: "blocked", first: /^\s*You've hit your usage limit for/m, second: /Switch to another model now,/, reason: "terminal shows a usage limit refusal" },
  { agent: "codex", status: "blocked", first: /Hook error:/, second: /socket connection was closed unexpectedly/, reason: "terminal shows a socket connection transport error" },
  { agent: "claude", status: "pending-check", first: /Messages to be submitted after next tool call/, second: /press esc to interrupt and send immediately/, reason: "terminal is waiting to submit queued messages" },
  { agent: "claude", status: "working", first: /Working/, second: /esc to interrupt/, reason: "terminal shows the working indicator" },
  { agent: "claude", status: "idle", first: /^\s*❯\s*$/m, reason: "terminal shows an empty Claude composer" },
  { agent: "claude", status: "blocked", first: /API Error:/, second: /authentication/, reason: "terminal shows an authentication error" },
];
export function classifyLiveness(agent: string, output: string): LivenessResult {
  for (const marker of markers) if (marker.agent === agent && marker.first.test(output) && (marker.second === undefined || marker.second.test(output))) return { status: marker.status, reason: marker.reason };
  return { status: "unknown", reason: null };
}
