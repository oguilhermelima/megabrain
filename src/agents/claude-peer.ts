import { randomUUID } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { resolve } from "node:path";
import { failed, ok, type Result } from "../core/result.js";
import { resolveClaudeSession } from "./claude-session.js";

// Claude Code's cross-session inbox (peerProtocol 1, measured on 2.1.296). Every interactive
// session lists a Unix socket in ~/.claude/sessions/<pid>.json and a peer token in
// <pid>.<hash>.key beside it. A peer connects, writes {"type":"auth","token"} and one user frame,
// one JSON object per line, and Claude queues the message for its next turn without touching the
// composer. The socket answers nothing, and it closes cleanly even on a frame it drops, so only
// the message's msg_id reaching the session transcript proves delivery.

export type ClaudePeerTarget = Readonly<{
  pid: number;
  sessionId: string;
  socketPath: string;
  token?: string;
  version: string;
  transcript: string;
}>;

export type ClaudePeerResolution =
  | Readonly<{ kind: "ok"; value: ClaudePeerTarget }>
  | Readonly<{ kind: "unresolved"; reason: string }>
  | Readonly<{ kind: "unsupported"; reason: string; version: string }>;

const ENVELOPE = "cross-session-message";
const SEND_TIMEOUT_MS = 5_000;

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function peerToken(sessions: string, pid: number): Promise<string | undefined> {
  const names = await readdir(sessions).catch(() => [] as string[]);
  for (const name of names.filter((entry) => entry.startsWith(`${pid}.`) && entry.endsWith(".key")).sort()) {
    const key = await readJson(resolve(sessions, name));
    if (typeof key?.peerToken === "string" && key.peerToken !== "") return key.peerToken;
  }
  return undefined;
}

async function findTranscript(home: string, sessionId: string): Promise<string | undefined> {
  const projects = resolve(home, ".claude", "projects");
  const directories = await readdir(projects).catch(() => [] as string[]);
  for (const directory of directories) {
    const candidate = resolve(projects, directory, `${sessionId}.jsonl`);
    if (await stat(candidate).then((info) => info.isFile(), () => false)) return candidate;
  }
  return undefined;
}

export async function resolveClaudePeer(home: string, pid: number, sessionId: string): Promise<ClaudePeerResolution> {
  const session = await resolveClaudeSession(home, pid, sessionId);
  if (session === undefined) return { kind: "unresolved", reason: "no live Claude session matches the recorded session id" };
  const sessions = resolve(home, ".claude", "sessions");
  const record = await readJson(resolve(sessions, `${session.pid}.json`));
  if (record === undefined) return { kind: "unresolved", reason: "Claude session file could not be read" };
  const version = typeof record.version === "string" && record.version !== "" ? record.version : "unknown";
  const socketPath = record.messagingSocketPath;
  if (record.peerProtocol !== 1 || typeof socketPath !== "string" || socketPath === "") {
    return { kind: "unsupported", reason: `Claude ${version} does not advertise peer protocol 1 with a messaging socket`, version };
  }
  const transcript = await findTranscript(home, sessionId);
  if (transcript === undefined) return { kind: "unresolved", reason: "Claude session transcript was not found" };
  const token = await peerToken(sessions, session.pid);
  return { kind: "ok", value: { pid: session.pid, sessionId, socketPath, version, transcript, ...(token === undefined ? {} : { token }) } };
}

// Claude's permission-mode parity: a session that bypasses prompts holds a peer message for review
// unless the sender attests the same class with from-mode. The attestation is the sender's claim,
// so it is only made for a sender that really runs without prompts.
export type PeerPermissionClass = "bypass" | "prompting";

const MODE_TAIL_BYTES = 1024 * 1024;

// The class of a Claude session megabrain did not launch, from the permissionMode its transcript
// recorded last (every user entry carries one). Undefined when no mode can be read, so nothing is
// attested on a guess; only bypassPermissions counts as bypass.
export async function claudeSessionPermissionClass(home: string, sessionId: string): Promise<PeerPermissionClass | undefined> {
  const transcript = await findTranscript(home, sessionId);
  if (transcript === undefined) return undefined;
  const handle = await open(transcript, "r").catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, MODE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const modes = [...buffer.toString("utf8").matchAll(/"permissionMode":"([A-Za-z]+)"/g)];
    const last = modes.at(-1)?.[1];
    if (last === undefined) return undefined;
    return last === "bypassPermissions" ? "bypass" : "prompting";
  } finally {
    await handle.close();
  }
}

export function claudePeerContent(body: string, mode?: PeerPermissionClass): string {
  const safe = body.replaceAll(`</${ENVELOPE}>`, `</${ENVELOPE} >`);
  return `<${ENVELOPE} from-name="megabrain"${mode === undefined ? "" : ` from-mode="${mode}"`}>\n${safe}\n</${ENVELOPE}>`;
}

// Resolves with the msg_id once the frame is written and the socket closed without error.
export function sendClaudePeer(target: ClaudePeerTarget, body: string, mode?: PeerPermissionClass, timeoutMs = SEND_TIMEOUT_MS): Promise<Result<string>> {
  const msgId = randomUUID();
  const message = { msgV: 1, msg_id: msgId, type: "user", message: { role: "user", content: claudePeerContent(body, mode) }, priority: "next" };
  const auth = target.token === undefined ? "" : `${JSON.stringify({ type: "auth", token: target.token })}\n`;
  const frame = `${auth}${JSON.stringify(message)}\n`;
  return new Promise((settle) => {
    let done = false;
    const finish = (result: Result<string>) => {
      if (done) return;
      done = true;
      socket.destroy();
      settle(result);
    };
    const socket = connect({ path: target.socketPath }, () => { socket.end(frame); });
    socket.setTimeout(timeoutMs, () => finish(failed(`peer socket timed out after ${timeoutMs} ms`)));
    socket.on("error", (error: NodeJS.ErrnoException) => finish(failed(`peer socket: ${error.code ?? error.message}`)));
    socket.on("close", (hadError) => finish(hadError ? failed("peer socket closed with an error") : ok(msgId)));
    socket.resume();
  });
}

export async function transcriptSize(path: string): Promise<number> {
  return stat(path).then((info) => info.size, () => 0);
}

export type TranscriptScan = Readonly<{ seen: "consumed" | "held" | undefined; next: number }>;

// Scans whole transcript lines written since `from`. A consumed peer message carries its msg_id;
// a held one leaves a "Held peer message" notice naming the sender, with no msg_id. Only one
// megabrain message is in flight per target, so a megabrain hold after `from` is this message.
export async function scanTranscript(path: string, from: number, msgId: string): Promise<TranscriptScan> {
  const handle = await open(path, "r").catch(() => undefined);
  if (handle === undefined) return { seen: undefined, next: from };
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, Math.min(from, size));
    if (size <= start) return { seen: undefined, next: start };
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const complete = buffer.lastIndexOf(0x0a);
    if (complete < 0) return { seen: undefined, next: start };
    let seen: TranscriptScan["seen"];
    for (const line of buffer.subarray(0, complete).toString("utf8").split("\n")) {
      if (line.includes(msgId)) { seen = "consumed"; break; }
      if (line.includes("Held peer message") && line.includes("peer claims name: megabrain")) seen = "held";
    }
    return { seen, next: start + complete + 1 };
  } finally {
    await handle.close();
  }
}
