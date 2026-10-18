import type { Socket } from "node:net";
import { CHAT_PROTOCOL_MIN_VERSION, type ChatDaemon } from "../daemon.js";

type Request = { operation: string; [key: string]: unknown };
type Part = import("../protocol.js").MessagePart;
export async function dispatchRequest(daemon: ChatDaemon, request: Request, socket?: Socket): Promise<unknown> {
  switch (request.operation) {
    case "list":
      await Promise.all([...daemon.eventChains.values(), ...daemon.appendChains.values()]);
      return await daemon.store.list();
    case "hello": {
      const offered = object(request.protocol);
      const clientMin = Number(offered.min ?? 1);
      const clientMax = Number(offered.max ?? offered.version ?? 1);
      if (!Number.isSafeInteger(clientMin) || !Number.isSafeInteger(clientMax) || clientMin < 1 || clientMax < clientMin || clientMax < CHAT_PROTOCOL_MIN_VERSION || clientMin > daemon.protocol) {
        const error = Object.assign(new Error("chatd protocol is incompatible with this client"), { code: "chatd-incompatible", liveChats: await daemon.liveChats() });
        throw error;
      }
      return { protocol: { version: daemon.protocol, min: CHAT_PROTOCOL_MIN_VERSION, max: daemon.protocol }, daemonVersion: daemon.version, liveChats: await daemon.liveChats(), pid: process.pid, build: daemon.build };
    }
    case "daemon-status": return await daemon.daemonStatus();
    case "drain": return request.wait === false ? (void daemon.drainDaemon().catch(() => undefined), await daemon.daemonStatus()) : await daemon.drainDaemon();
    case "retire": return await daemon.retireDaemon();
    case "handover": return await daemon.handover();
    case "start": return await daemon.startChat(request);
    case "send": return await daemon.send(text(request.id), validateParts(request.parts), request.fresh === true);
    case "fork": return await daemon.fork(text(request.id), text(request.eventId));
    case "edit-last": return await daemon.editLast(text(request.id), request.parts);
    case "resume": return await daemon.resume(text(request.id));
    case "queue": return await daemon.queueOperation(request);
    case "interrupt": return await daemon.interrupt(text(request.id));
    case "stop": return await daemon.stop(text(request.id));
    case "remove": return await daemon.remove(text(request.id));
    case "approve": return await daemon.approve(text(request.id), text(request.approvalId), text(request.decision));
    case "events": return await daemon.events(text(request.id), Number(request.since ?? 0), request.follow === true, socket);
    case "mode": return await daemon.mode(text(request.id), text(request.mode));
    case "take-over": return await daemon.takeOver(text(request.id));
    case "model": return await daemon.setModel(text(request.id), text(request.model), text(request.effort) || null);
    case "rename": return await daemon.rename(text(request.id), text(request.title));
    case "summarize": return await daemon.summarizer.summarize(text(request.id));
    case "terminal-command": return await daemon.terminalCommand(text(request.id));
    case "permission": return await daemon.permission(text(request.id), object(request.request));
    default: throw new Error("unknown chat operation");
  }
}
function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function validateParts(value: unknown): Part[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("--parts must be a non-empty JSON array");
  return value.map((part, index) => {
    const item = object(part);
    if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text };
    if (item.type === "image" && typeof item.path === "string" && item.path !== "") return { type: "image", path: item.path };
    throw new Error(`invalid message part at index ${index}`);
  });
}
