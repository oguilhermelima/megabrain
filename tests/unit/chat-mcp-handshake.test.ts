import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function exchange(messages: unknown[], expectedReplies: number): Promise<Array<Record<string, any>>> {
  const root = mkdtempSync(join(tmpdir(), "megabrain-mcp-"));
  const child = spawn(process.execPath, [join(process.cwd(), "src/cli/index.ts"), "chat", "mcp-permission", "chat-1"], {
    env: { ...process.env, HOME: root, MEGABRAIN_STATE_DIR: root },
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    const replies = await new Promise<Array<Record<string, any>>>((resolve, reject) => {
      const lines: Array<Record<string, any>> = [];
      let buffer = "";
      const timer = setTimeout(() => resolve(lines), 3000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
          lines.push(JSON.parse(buffer.slice(0, end)));
          buffer = buffer.slice(end + 1);
          if (lines.length >= expectedReplies) { clearTimeout(timer); resolve(lines); }
        }
      });
      child.once("error", reject);
      for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    });
    return replies;
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
}

describe("permission server MCP handshake", () => {
  test("initialize echoes the protocol version and advertises tools", async () => {
    const [reply] = await exchange([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }], 1);
    expect(reply?.id).toBe(1);
    expect(reply?.result.protocolVersion).toBe("2025-03-26");
    expect(reply?.result.capabilities.tools).toBeDefined();
    expect(reply?.result.serverInfo.name).toBe("megabrain");
  });

  test("tools/list names permissionPrompt with an input schema", async () => {
    const [reply] = await exchange([{ jsonrpc: "2.0", id: 2, method: "tools/list" }], 1);
    expect(reply?.id).toBe(2);
    const tool = reply?.result.tools.find((candidate: { name: string }) => candidate.name === "permissionPrompt");
    expect(tool.inputSchema.type).toBe("object");
  });

  test("notifications get no reply, and the next request still does", async () => {
    const replies = await exchange([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 3, method: "tools/list" }], 2);
    expect(replies.map((reply) => reply.id)).toEqual([3]);
  });
});
