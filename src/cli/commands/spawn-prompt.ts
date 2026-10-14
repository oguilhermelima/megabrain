import type { ProcessAdapter } from "../../adapters/proc.js";
import { composerHoldsText } from "../../core/composer-proof.js";
import { classifyLiveness } from "../../core/liveness.js";
import { failed, ok, type Result } from "../../core/result.js";
import type { SpawnStepOutcome } from "../../core/spawn-plan.js";
import { getTmux, withTmuxPaneLock, type TmuxSendEnvironment } from "../../hosts/tmux.js";

const POLL_MS = 100;
const CLEAR_ATTEMPTS = 5;
const MAX_CLEAR_PRESSES = 400;
const DEFAULT_VERIFY_TIMEOUT_MS = 2000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 3000;
// Codex shows an idle composer for about four seconds while its MCP servers start before it
// submits an argv prompt (measured 2026-10-14), so an idle pane is no proof the brief was dropped.
const DEFAULT_ARGV_GRACE_MS = 30_000;
// The first line of every brief (see finalPrompt); a fresh pane shows it only once the agent
// has submitted the brief as a turn.
const BRIEF_HEADER = "[megabrain dispatch:";

export type PromptTransportOutcome = Extract<SpawnStepOutcome, { readonly kind: "prompt-transport" }>;

export type SpawnPromptEnvironment = TmuxSendEnvironment & Readonly<{
  readonly MEGABRAIN_PROMPT_VERIFY_TIMEOUT_MS?: string;
  readonly MEGABRAIN_PROMPT_SUBMIT_TIMEOUT_MS?: string;
  readonly MEGABRAIN_PROMPT_ARGV_GRACE_MS?: string;
}>;

type PromptTarget = Readonly<{
  readonly root: string;
  readonly pane: string;
  readonly agent: string;
  readonly prompt: string;
  readonly environment: SpawnPromptEnvironment;
  readonly process: ProcessAdapter;
  // Told the last composer frame whenever the prompt did not reach it whole, so the evidence
  // outlives the pane that a failed spawn may remove.
  readonly rejectedFrame?: (frame: string) => void;
}>;

function milliseconds(raw: string | undefined, fallback: number): number {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : fallback;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readScreen(target: PromptTarget): Promise<string | undefined> {
  const captured = await getTmux().capturePane(target.pane, 200, target.process, true);
  return captured.kind === "ok" ? captured.value : undefined;
}

async function composerShowsPrompt(target: PromptTarget): Promise<boolean> {
  const deadline = Date.now() + milliseconds(target.environment.MEGABRAIN_PROMPT_VERIFY_TIMEOUT_MS, DEFAULT_VERIFY_TIMEOUT_MS);
  let last: string | undefined;
  while (true) {
    const screen = await readScreen(target);
    last = screen ?? last;
    if (screen !== undefined && composerHoldsText(target.agent, screen, target.prompt)) return true;
    if (Date.now() >= deadline) {
      if (last !== undefined) target.rejectedFrame?.(last);
      return false;
    }
    await sleep(POLL_MS);
  }
}

// Whether the pane is running a turn right now. A pane that cannot be read proves nothing.
export async function paneShowsTurn(target: Pick<PromptTarget, "pane" | "agent" | "process">): Promise<boolean> {
  const captured = await getTmux().capturePane(target.pane, 200, target.process, true);
  if (captured.kind !== "ok") return false;
  const status = classifyLiveness(target.agent, captured.value).status;
  return status === "working" || status === "pending-check";
}

// An empty composer is the one the agent's classifier calls idle: its placeholder and nothing typed.
// C-u may clear only one line per press (Antigravity empties a line, then joins it to the one above),
// so presses continue while each one changes the screen and give up only once they stop helping.
export async function clearComposer(target: Pick<PromptTarget, "pane" | "agent" | "process">): Promise<Result<void>> {
  let previous: string | undefined;
  let stalled = 0;
  for (let press = 0; press < MAX_CLEAR_PRESSES && stalled < CLEAR_ATTEMPTS; press += 1) {
    const captured = await getTmux().capturePane(target.pane, 200, target.process, true);
    if (captured.kind === "ok" && classifyLiveness(target.agent, captured.value).status === "idle") return ok(undefined);
    const frame = captured.kind === "ok" ? captured.value : undefined;
    stalled = frame !== undefined && frame === previous ? stalled + 1 : 0;
    previous = frame;
    const cleared = await getTmux().sendKey(target.pane, "C-u", target.process);
    if (cleared.kind !== "ok") return cleared;
    await sleep(POLL_MS);
  }
  return failed(`could not clear the ${target.agent} composer in ${target.pane}`);
}

async function placePrompt(target: PromptTarget): Promise<Result<void>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      const cleared = await clearComposer(target);
      if (cleared.kind !== "ok") return cleared;
    }
    const pasted = await getTmux().pasteText(target.pane, target.prompt, target.process);
    if (pasted.kind !== "ok") return pasted;
    if (await composerShowsPrompt(target)) return ok(undefined);
  }
  return failed(`the prompt did not arrive whole in the ${target.agent} composer of ${target.pane}, even after clearing it and pasting again`);
}

// A turn started when the agent reports one running, or when the prompt has left the composer.
async function turnStartedWithin(target: PromptTarget): Promise<boolean> {
  const deadline = Date.now() + milliseconds(target.environment.MEGABRAIN_PROMPT_SUBMIT_TIMEOUT_MS, DEFAULT_SUBMIT_TIMEOUT_MS);
  while (true) {
    const screen = await readScreen(target);
    if (screen !== undefined) {
      const status = classifyLiveness(target.agent, screen).status;
      if (status === "working" || status === "pending-check" || !composerHoldsText(target.agent, screen, target.prompt)) return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

// A composer left inside an unterminated bracketed paste takes every Enter as a newline. Sending
// the paste end marker closes it, and the next Enter submits.
const PASTE_END_MARKER = "\u001b[201~";

async function submitPrompt(target: PromptTarget): Promise<Result<boolean>> {
  for (let press = 0; press < 2; press += 1) {
    const sent = await getTmux().sendKey(target.pane, "Enter", target.process);
    if (sent.kind !== "ok") return sent;
    if (await turnStartedWithin(target)) return ok(true);
  }
  const closed = await getTmux().sendText(target.pane, PASTE_END_MARKER, target.process);
  if (closed.kind !== "ok") return closed;
  const sent = await getTmux().sendKey(target.pane, "Enter", target.process);
  if (sent.kind !== "ok") return sent;
  return ok(await turnStartedWithin(target));
}

// Pastes the prompt, proves the composer holds all of it before submitting (one clear and repaste
// on a mismatch), submits, and confirms the agent started a turn. The result says whether it did.
export async function deliverPrompt(target: PromptTarget): Promise<Result<boolean>> {
  return withTmuxPaneLock(target.root, target.pane, target.environment, async () => {
    const placed = await placePrompt(target);
    if (placed.kind !== "ok") return placed;
    return submitPrompt(target);
  });
}

function transportFailure(target: PromptTarget, detail: string): PromptTransportOutcome {
  return { kind: "prompt-transport", status: "failed", failure: { call: `tmux paste-buffer --target ${target.pane}`, detail } };
}

// A started turn proves the prompt arrived; the child may simply still be queued behind its own
// work, so this is recorded silently and never fails the dispatch.
function turnWithoutReceipt(): PromptTransportOutcome {
  return { kind: "prompt-transport", status: "turn-without-receipt", receiptMissing: "no-receipt-after-turn" };
}

// Delivers the first prompt to a tmux pane and reports what spawn can prove at that moment. There is
// no receipt deadline: a child may code for twenty minutes before it reads its queue. A receipt
// already in the queue means delivered; a started turn proves the prompt arrived; otherwise the
// dispatch stays awaiting its receipt and the supervisor judges the pane. Nothing is resent here and
// only a failed paste fails the spawn. The pane is always kept.
export async function transportTmuxPrompt(target: PromptTarget, receiptSeen: () => boolean): Promise<PromptTransportOutcome> {
  const first = await deliverPrompt(target);
  if (first.kind !== "ok") return transportFailure(target, first.error);
  if (receiptSeen()) return { kind: "prompt-transport", status: "delivered" };
  if (first.value || await paneShowsTurn(target)) return turnWithoutReceipt();
  return { kind: "prompt-transport", status: "awaiting-receipt" };
}

// Whether a pane shows that its agent took the brief from argv: the brief echoed as a turn, or a
// turn running, which nothing but that brief starts in a freshly launched agent.
export function argvBriefStarted(agent: string, frame: string): boolean {
  if (frame.includes(BRIEF_HEADER)) return true;
  const status = classifyLiveness(agent, frame).status;
  return status === "working" || status === "pending-check";
}

// Waits for proof that the agent submitted the brief it was launched with. Undefined means the
// grace passed with no receipt, no echoed brief and no turn: the caller pastes it instead.
export async function awaitArgvPrompt(target: Pick<PromptTarget, "pane" | "agent" | "environment" | "process">, receiptSeen: () => boolean): Promise<PromptTransportOutcome | undefined> {
  const deadline = Date.now() + milliseconds(target.environment.MEGABRAIN_PROMPT_ARGV_GRACE_MS, DEFAULT_ARGV_GRACE_MS);
  while (true) {
    if (receiptSeen()) return { kind: "prompt-transport", status: "delivered" };
    const captured = await getTmux().capturePane(target.pane, 200, target.process, true);
    if (captured.kind === "ok" && argvBriefStarted(target.agent, captured.value)) return receiptSeen() ? { kind: "prompt-transport", status: "delivered" } : turnWithoutReceipt();
    if (Date.now() >= deadline) return undefined;
    await sleep(POLL_MS);
  }
}
