import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";

// Grok's shared-leader protocol (leader_protocol_version 1, measured on 1.0.52). A TUI started
// with --leader runs its session inside a leader process listening on a Unix socket. Each frame is
// a 4-byte big-endian length and one JSON object: a client sends {type: "register"}, gets
// {type: "registered"}, then exchanges ACP JSON-RPC as strings inside {type: "acp", payload}.
// Any registered client may send session/prompt to a live session: the leader queues it as a
// user turn, announces it in _x.ai/queue/changed, and runs it even after that client disconnects.

// macOS rejects a Unix socket path of 104 bytes or more.
const SOCKET_PATH_LIMIT = 103;
const SEND_TIMEOUT_MS = 10_000;

// One leader per child, so its tools inherit that child's environment (MEGABRAIN_DISPATCH_ID) and
// a crash takes down one child only. Undefined when the state directory makes the path unbindable.
export function grokLeaderSocket(stateRoot: string, dispatchId: string): string | undefined {
  const name = createHash("sha256").update(dispatchId).digest("hex").slice(0, 16);
  const path = join(stateRoot, "grok", `${name}.sock`);
  return Buffer.byteLength(path) <= SOCKET_PATH_LIMIT ? path : undefined;
}

export type GrokLeaderSend =
  | Readonly<{ kind: "delivered"; promptId: string; version: string }>
  | Readonly<{ kind: "failed"; reason: string; version?: string }>;

type Json = Record<string, unknown>;

const object = (value: unknown): Json | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : undefined;

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

// Proof is the leader naming our prompt id in the session queue, or as the prompt now running.
function queued(payload: Json, sessionId: string, promptId: string): boolean {
  if (payload.method !== "_x.ai/queue/changed") return false;
  const params = object(payload.params);
  if (params?.sessionId !== sessionId) return false;
  if (params.runningPromptId === promptId) return true;
  return Array.isArray(params.entries) && params.entries.some((entry) => object(entry)?.id === promptId);
}

export function sendGrokLeaderPrompt(socketPath: string, sessionId: string, text: string, timeoutMs = SEND_TIMEOUT_MS): Promise<GrokLeaderSend> {
  const promptId = randomUUID();
  return new Promise((resolve) => {
    let version: string | undefined;
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = connect(socketPath);
    const finish = (result: GrokLeaderSend): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The queued prompt belongs to the session now; leaving does not cancel it.
      if (socket.writable) socket.end(frame({ type: "disconnect" }));
      else socket.destroy();
      resolve(result);
    };
    const fail = (reason: string): void => finish(version === undefined ? { kind: "failed", reason } : { kind: "failed", reason, version });
    const timer = setTimeout(() => fail(`Grok leader did not queue prompt ${promptId} within ${timeoutMs} ms`), timeoutMs);
    const acp = (payload: Json): void => { socket.write(frame({ type: "acp", payload: JSON.stringify({ jsonrpc: "2.0", ...payload }) })); };
    const handle = (message: Json): void => {
      if (message.type === "registered") {
        version = typeof message.leader_binary_version === "string" ? message.leader_binary_version : "unknown";
        if (message.leader_protocol_version !== 1) { fail(`Grok leader speaks protocol ${String(message.leader_protocol_version)}, not 1`); return; }
        acp({ id: 0, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
        return;
      }
      if (message.type !== "acp" || typeof message.payload !== "string") return;
      let payload: Json | undefined;
      try { payload = object(JSON.parse(message.payload)); } catch { return; }
      if (payload === undefined) return;
      if (payload.id === 0 && payload.result !== undefined) {
        acp({ id: 1, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text }], _meta: { promptId } } });
      } else if ((payload.id === 0 || payload.id === 1) && payload.error !== undefined) {
        fail(`Grok leader refused ${payload.id === 0 ? "initialize" : "the prompt"}: ${String(object(payload.error)?.message ?? JSON.stringify(payload.error))}`);
      } else if (queued(payload, sessionId, promptId)) {
        finish({ kind: "delivered", promptId, version: version ?? "unknown" });
      }
    };
    socket.on("connect", () => {
      // The capabilities a megabrain Grok child itself registers with: it runs with --always-approve.
      socket.write(frame({ type: "register", client_type: "grok-shell", mode: "stdio", capabilities: { yolo_mode: true, auto_mode: false, terminal: false, fs_read: false, fs_write: false, status_line: false, user_message_echo: true } }));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) break;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        try {
          const message = object(JSON.parse(body.toString("utf8")));
          if (message !== undefined) handle(message);
        } catch {
          // A frame this client cannot read is not one it waits on.
        }
      }
    });
    socket.on("error", (error) => fail(error.message));
    socket.on("close", () => fail("Grok leader closed the connection before queuing the prompt"));
  });
}

// The TUI starts its leader with --no-exit-on-disconnect, so the leader outlives the child's pane.
// Its pid sits in <name>.lock beside the socket; the process is checked before the kill because a
// stale lock may name a reused pid.
export async function stopGrokLeader(socketPath: string, process: ProcessAdapter): Promise<void> {
  const lock = socketPath.replace(/\.sock$/, ".lock");
  const pid = (await readFile(lock, "utf8").catch(() => "")).trim();
  if (!/^\d+$/.test(pid)) return;
  const command = await process.run("ps", ["-o", "command=", "-p", pid]);
  if (command.kind !== "ok" || !/\bgrok\b.*\bagent leader\b/.test(command.value.stdout)) return;
  await process.run("kill", [pid]);
}
