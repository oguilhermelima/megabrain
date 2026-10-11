import type { ProcessAdapter } from "../../adapters/proc.js";
import { composerHoldsText } from "../../core/composer-proof.js";
import { classifyLiveness } from "../../core/liveness.js";
import { failed, ok, type Result } from "../../core/result.js";
import type { SpawnStepOutcome } from "../../core/spawn-plan.js";
import { getTmux, withTmuxPaneLock, type TmuxSendEnvironment } from "../../hosts/tmux.js";

const POLL_MS = 100;
const CLEAR_ATTEMPTS = 5;
const DEFAULT_VERIFY_TIMEOUT_MS = 2000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 3000;

export type PromptTransportOutcome = Extract<SpawnStepOutcome, { readonly kind: "prompt-transport" }>;

export type SpawnPromptEnvironment = TmuxSendEnvironment & Readonly<{
  readonly MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS?: string;
  readonly MEGABRAIN_PROMPT_VERIFY_TIMEOUT_MS?: string;
  readonly MEGABRAIN_PROMPT_SUBMIT_TIMEOUT_MS?: string;
}>;

type PromptTarget = Readonly<{
  readonly root: string;
  readonly pane: string;
  readonly agent: string;
  readonly prompt: string;
  readonly environment: SpawnPromptEnvironment;
  readonly process: ProcessAdapter;
}>;

function milliseconds(raw: string | undefined, fallback: number): number {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : fallback;
}

// Seconds the spawn waits for the child's received message. Zero is the explicit opt-out: spawn
// returns at once and leaves the dispatch awaiting its receipt.
export function receiptTimeoutMs(environment: SpawnPromptEnvironment): number {
  const seconds = Number(environment.MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS ?? "30");
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
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
  while (true) {
    const screen = await readScreen(target);
    if (screen !== undefined && composerHoldsText(target.agent, screen, target.prompt)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

// An empty composer is the one the agent's classifier calls idle: its placeholder and nothing typed.
export async function clearComposer(target: Pick<PromptTarget, "pane" | "agent" | "process">): Promise<Result<void>> {
  for (let attempt = 0; attempt < CLEAR_ATTEMPTS; attempt += 1) {
    const captured = await getTmux().capturePane(target.pane, 200, target.process, true);
    if (captured.kind === "ok" && classifyLiveness(target.agent, captured.value).status === "idle") return ok(undefined);
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

async function submitPrompt(target: PromptTarget): Promise<Result<boolean>> {
  for (let press = 0; press < 2; press += 1) {
    const sent = await getTmux().sendKey(target.pane, "Enter", target.process);
    if (sent.kind !== "ok") return sent;
    if (await turnStartedWithin(target)) return ok(true);
  }
  return ok(false);
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

// Delivers the first prompt to a tmux pane and waits for the child's receipt. A receipt that does
// not come leaves the dispatch awaiting it.
export async function transportTmuxPrompt(target: PromptTarget, awaitReceipt: () => Promise<boolean>): Promise<PromptTransportOutcome> {
  const delivered = await deliverPrompt(target);
  if (delivered.kind !== "ok") return transportFailure(target, delivered.error);
  return { kind: "prompt-transport", status: await awaitReceipt() ? "delivered" : "awaiting-receipt" };
}
