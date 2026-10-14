import { classifyLiveness } from "../../core/liveness.js";
import type { SupervisionFinding } from "../../core/supervise.js";
import { deliveryComposer } from "./delivery-screen.js";

// Where the first prompt (or a later message) stands, read from the agent's own terminal. There is no
// age in any of these: an agent can code for twenty minutes without reading its queue.
//   received           the child said so
//   unsubmitted        the prompt sits in an idle composer and was never sent
//   queued             a message waits in the agent's queue for the current turn to end
//   delivered-working  the agent is working
//   delivered          the prompt shows as a submitted turn and the agent is idle
//   lost               idle at an empty composer, prompt shown nowhere, no receipt
//   unknown            the pane cannot say
export type PromptState = "received" | "unsubmitted" | "queued" | "delivered-working" | "delivered" | "lost" | "unknown";

export type PromptStateInput = Readonly<{
  agent: string;
  frame: string;
  prompt: string;
  received: boolean;
  // Terminal title (tmux #{pane_title}). Codex puts a braille spinner in front of it while a turn runs.
  title?: string;
  // Scrollback older than the frame, read only to avoid calling a long-finished turn lost.
  history?: string;
}>;

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const SPINNER_TITLE = /^[⠀-⣿]/;
const CLAUDE_QUEUED = /Press up to edit queued messages|ctrl\+x ctrl\+s to send now|Messages to be submitted after next tool call/;
const PASTE_PLACEHOLDER = /^\[(?:Pasted text #\d+(?: \+\d+ lines)?|Pasted Content \d+ chars)\]$/;
const MIN_TAIL = 30;

function tailOf(prompt: string): string {
  return squash(prompt).slice(-80);
}

// Grok shows a long user prompt as its first two lines and an ellipsis, so a brief is also known by
// its dispatch header, which names the dispatch and is on screen only once that brief was submitted.
const BRIEF_HEADER = /^\[megabrain dispatch: [^\n]+\]$/;

function shows(text: string, prompt: string): boolean {
  const tail = tailOf(prompt);
  const seen = squash(text);
  if (tail.length >= Math.min(MIN_TAIL, squash(prompt).length) && tail !== "" && seen.includes(tail)) return true;
  const header = prompt.split("\n")[0] ?? "";
  return BRIEF_HEADER.test(header) && seen.includes(squash(header));
}

function composerHoldsPrompt(agent: string, frame: string, prompt: string): boolean {
  const draft = squash(deliveryComposer(agent, frame) ?? "");
  if (draft === "") return false;
  if (PASTE_PLACEHOLDER.test(draft)) return true;
  const whole = squash(prompt);
  return whole.startsWith(draft.slice(0, 40)) || whole.includes(draft);
}

// Codex lists a waiting message as its own "›" block directly above the working line, either steered
// text or a "💬 ..." item with "→ full text: megabrain check". The prompt's own block sits there too
// while the first turn runs, so a block that holds the prompt does not count.
function codexQueuedAbove(frame: string, prompt: string): boolean {
  const lines = frame.split("\n");
  let working = -1;
  lines.forEach((line, index) => { if (/^\s*•\s+Working \(/.test(line)) working = index; });
  if (working < 0) return false;
  for (let index = working - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!/^\s*[•›]/.test(line)) continue;
    if (!/^\s*›/.test(line)) return false;
    return !shows(lines.slice(index, working).join("\n"), prompt);
  }
  return false;
}

function grokQueued(frame: string, prompt: string): boolean {
  const lines = frame.split("\n");
  const queued = lines.findIndex((line) => /^\s*▾ Queued \d+\s*$/.test(line));
  if (queued < 0) return false;
  const items = lines.slice(queued + 1).filter((line) => /^\s*#\d+\s/.test(line));
  return shows(items.join("\n"), prompt);
}

function queued(agent: string, frame: string, prompt: string): boolean {
  if (agent === "claude") return CLAUDE_QUEUED.test(frame);
  if (agent === "grok") return grokQueued(frame, prompt);
  return agent === "codex" && codexQueuedAbove(frame, prompt);
}

export function classifyPromptState(input: PromptStateInput): Readonly<{ state: PromptState }> {
  const { agent, frame, prompt, received } = input;
  if (received) return { state: "received" };
  if (agent !== "claude" && agent !== "codex" && agent !== "grok") return { state: "unknown" };
  const liveness = classifyLiveness(agent, frame).status;
  const busy = liveness === "working" || liveness === "pending-check" || SPINNER_TITLE.test(input.title ?? "");
  if (!busy && composerHoldsPrompt(agent, frame, prompt)) return { state: "unsubmitted" };
  if (queued(agent, frame, prompt)) return { state: "queued" };
  if (busy) return { state: "delivered-working" };
  if (shows(frame, prompt) || (input.history !== undefined && shows(input.history, prompt))) return { state: "delivered" };
  return { state: liveness === "idle" ? "lost" : "unknown" };
}

// Only these two are findings. Queued and working prompts stay silent however long they last.
export function promptFinding(state: PromptState): SupervisionFinding {
  if (state === "lost") return { cause: "prompt-lost" };
  if (state === "unsubmitted") return { cause: "prompt-unsubmitted" };
  return { cause: "unknown" };
}
