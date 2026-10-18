import { describe, expect, test } from "bun:test";
import { AcpPeer } from "../../src/chat/grok-acp.js";

describe("Grok ACP peer", () => {
  test("keeps out-of-order JSON-RPC replies attached to their request", async () => {
    const frames: Record<string, unknown>[] = [];
    const peer = new AcpPeer((frame) => frames.push(JSON.parse(frame) as Record<string, unknown>));
    const first = peer.request("initialize", {});
    const second = peer.request("session/new", { cwd: "/tmp/project" });

    peer.receive(JSON.stringify({ jsonrpc: "2.0", id: frames[1]?.id, result: { sessionId: "s1" } }));
    peer.receive(JSON.stringify({ jsonrpc: "2.0", id: frames[0]?.id, result: { protocolVersion: 1 } }));

    await expect(first).resolves.toMatchObject({ protocolVersion: 1 });
    await expect(second).resolves.toMatchObject({ sessionId: "s1" });
  });

  test("rejects malformed frames and fails pending requests when the process exits", async () => {
    const peer = new AcpPeer(() => undefined);
    const pending = peer.request("session/prompt", { sessionId: "s1", prompt: [] });

    expect(() => peer.receive("{not json")).toThrow();
    peer.close(new Error("agent exited"));

    await expect(pending).rejects.toThrow("agent exited");
  });

  test("routes agent requests and notifications separately from replies", () => {
    const peer = new AcpPeer(() => undefined);
    const requests: unknown[] = [];
    const notifications: unknown[] = [];
    peer.onRequest = (frame) => requests.push(frame);
    peer.onNotification = (frame) => notifications.push(frame);

    peer.receive(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "session/request_permission", params: { sessionId: "s1" } }));
    peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1" } }));

    expect(requests).toHaveLength(1);
    expect(notifications).toHaveLength(1);
  });
});
