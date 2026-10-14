import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Antigravity CLI runs its language server in process (measured on 1.3.4) and hands every tool
// shell ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN and ANTIGRAVITY_CONVERSATION_ID. The
// server speaks Connect JSON over HTTP with the token in x-codeium-csrf-token.
// SendUserCascadeMessage queues a user message into a conversation, run when it is next idle,
// but only with the cascade config the CLI itself sends; every user input in the conversation's
// trajectory records that config, so the latest one is reused unchanged.

const SERVICE = "exa.language_server_pb.LanguageServerService";
const REQUEST_TIMEOUT_MS = 10_000;

export type AgyEndpoint = Readonly<{ address: string; csrfToken: string; conversationId: string; version: string }>;

// The token is a secret for the life of that agy process, so it lives in its own 0600 file and
// never in the dispatch record that `db show` prints.
export function agyLanguageServerFile(stateRoot: string, dispatchId: string): string {
  return join(stateRoot, "agy", `${dispatchId}.json`);
}

export async function recordAgyLanguageServer(stateRoot: string, dispatchId: string, environment: Readonly<Record<string, string | undefined>>): Promise<void> {
  const address = environment.ANTIGRAVITY_LS_ADDRESS;
  const csrfToken = environment.ANTIGRAVITY_CSRF_TOKEN;
  const conversationId = environment.ANTIGRAVITY_CONVERSATION_ID;
  if (!address || !csrfToken || !conversationId) return;
  const file = agyLanguageServerFile(stateRoot, dispatchId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ address, csrfToken, conversationId, version: environment.ANTIGRAVITY_LS_VERSION ?? "unknown" }), { mode: 0o600 });
}

export async function readAgyLanguageServer(stateRoot: string, dispatchId: string): Promise<AgyEndpoint | undefined> {
  try {
    const value = JSON.parse(await readFile(agyLanguageServerFile(stateRoot, dispatchId), "utf8")) as Record<string, unknown>;
    const { address, csrfToken, conversationId, version } = value;
    if (typeof address !== "string" || typeof csrfToken !== "string" || typeof conversationId !== "string") return undefined;
    return { address, csrfToken, conversationId, version: typeof version === "string" ? version : "unknown" };
  } catch {
    return undefined;
  }
}

export async function forgetAgyLanguageServer(stateRoot: string, dispatchId: string): Promise<void> {
  await rm(agyLanguageServerFile(stateRoot, dispatchId), { force: true });
}

type Call = Readonly<{ kind: "ok"; body: Record<string, unknown> }> | Readonly<{ kind: "unreachable" | "rejected"; reason: string }>;

async function call(endpoint: AgyEndpoint, method: string, body: unknown): Promise<Call> {
  let response: Response;
  try {
    response = await fetch(`http://${endpoint.address}/${SERVICE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-codeium-csrf-token": endpoint.csrfToken },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "unreachable", reason: `agy language server unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text === "" ? {} : JSON.parse(text) as Record<string, unknown>; } catch { /* a non-JSON body is reported by status */ }
  if (response.ok) return { kind: "ok", body: parsed };
  // A stale token means this agy restarted since megabrain recorded it, not a broken channel.
  if (response.status === 401) return { kind: "unreachable", reason: "agy language server rejected the recorded CSRF token" };
  return { kind: "rejected", reason: `agy ${method} answered ${response.status}: ${String(parsed.message ?? text.slice(0, 200))}` };
}

type Trajectory = Readonly<{ config?: unknown; occurrences: number }>;

function inputTexts(step: unknown): string[] {
  const input = (step as { userInput?: { items?: Array<{ text?: unknown }> } } | undefined)?.userInput;
  return (input?.items ?? []).flatMap((item) => typeof item.text === "string" ? [item.text] : []);
}

async function trajectory(endpoint: AgyEndpoint, text: string): Promise<Readonly<{ kind: "ok"; value: Trajectory }> | Exclude<Call, { kind: "ok" }>> {
  const read = await call(endpoint, "GetCascadeTrajectory", { cascadeId: endpoint.conversationId });
  if (read.kind !== "ok") return read;
  const steps = (read.body.trajectory as { steps?: unknown[] } | undefined)?.steps ?? [];
  const configs = steps.flatMap((step) => {
    const config = (step as { userInput?: { userConfig?: unknown } }).userInput?.userConfig;
    return config === undefined ? [] : [config];
  });
  return { kind: "ok", value: { config: configs.at(-1), occurrences: steps.filter((step) => inputTexts(step).includes(text)).length } };
}

export type AgySend =
  | Readonly<{ kind: "queued"; before: number }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{ kind: "broken"; reason: string }>;

export async function sendAgyMessage(endpoint: AgyEndpoint, text: string): Promise<AgySend> {
  const read = await trajectory(endpoint, text);
  if (read.kind !== "ok") return { kind: read.kind === "unreachable" ? "unavailable" : "broken", reason: read.reason };
  if (read.value.config === undefined) return { kind: "unavailable", reason: "agy conversation has no recorded cascade config to send with" };
  const sent = await call(endpoint, "SendUserCascadeMessage", {
    cascadeId: endpoint.conversationId,
    items: [{ text }],
    deliveryStrategy: "MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE",
    cascadeConfig: read.value.config,
  });
  if (sent.kind !== "ok") return { kind: sent.kind === "unreachable" ? "unavailable" : "broken", reason: sent.reason };
  return { kind: "queued", before: read.value.occurrences };
}

// The message is in the conversation once one more user input carries its text than before.
export async function agyMessageArrived(endpoint: AgyEndpoint, text: string, before: number): Promise<boolean> {
  const read = await trajectory(endpoint, text);
  return read.kind === "ok" && read.value.occurrences > before;
}
