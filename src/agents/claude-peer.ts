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

export function claudePeerContent(body: string): string {
  const safe = body.replaceAll(`</${ENVELOPE}>`, `</${ENVELOPE} >`);
  return `<${ENVELOPE} from-name="megabrain">\n${safe}\n</${ENVELOPE}>`;
}

// Resolves with the msg_id once the frame is written and the socket closed without error.
export function sendClaudePeer(target: ClaudePeerTarget, body: string, timeoutMs = SEND_TIMEOUT_MS): Promise<Result<string>> {
  const msgId = randomUUID();
  const message = { msgV: 1, msg_id: msgId, type: "user", message: { role: "user", content: claudePeerContent(body) }, priority: "next" };
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

// Scans the transcript from `from` for the msg_id and returns where the next scan starts.
export async function scanTranscript(path: string, from: number, msgId: string): Promise<Readonly<{ found: boolean; next: number }>> {
  const handle = await open(path, "r").catch(() => undefined);
  if (handle === undefined) return { found: false, next: from };
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, Math.min(from, size));
    if (size <= start) return { found: false, next: start };
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return { found: buffer.includes(msgId), next: Math.max(start, size - msgId.length) };
  } finally {
    await handle.close();
  }
}
