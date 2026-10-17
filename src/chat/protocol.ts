import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Chat } from "./store.js";
import { selfInvocation } from "../core/self-invocation.js";
import { knowledgeContext } from "../knowledge/library.js";
import { togglesFor } from "../knowledge/settings.js";
import { resolveLocation, summariesContext } from "./summary-library.js";

export type MessagePart = { type: "text"; text: string } | { type: "image"; path: string };
export type RpcRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export type AgentInvocation = { command: string; args: string[] };

/** The daemon owns the process and transcript; adapters own each agent's wire contract. */
export interface ChatProtocolAdapter {
  prepare(chat: Chat, stateDir: string): Promise<AgentInvocation>;
  send(chat: Chat, child: ChildProcessWithoutNullStreams, parts: MessagePart[], request: RpcRequest): Promise<string | undefined>;
  steer(chat: Chat, child: ChildProcessWithoutNullStreams, turnId: string, parts: MessagePart[], request: RpcRequest): Promise<void>;
  interrupt(chat: Chat, child: ChildProcessWithoutNullStreams | undefined, turnId: string | undefined, request: RpcRequest): Promise<void>;
  terminalCommand(chat: Chat): string[];
}

async function claudeContent(parts: MessagePart[]): Promise<unknown[]> {
  return Promise.all(parts.map(async (part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(part.path));
    const extension = part.path.toLowerCase().split(".").at(-1);
    const mediaType = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "gif" ? "image/gif" : extension === "webp" ? "image/webp" : extension === "png" ? "image/png" : undefined;
    if (!mediaType) throw new Error(`unsupported image type: ${part.path}`);
    if (bytes.length > 5 * 1024 * 1024) throw new Error(`image exceeds 5 MiB: ${part.path}`);
    return { type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } };
  }));
}

/** The latest summaries of the chat's worktree, when the feature is on and there is something to say. */
async function launchContext(chat: Chat, stateDir: string): Promise<string> {
  try {
    if (!togglesFor(stateDir, (await resolveLocation(chat.cwd)).repo).context) return "";
    return await knowledgeContext(stateDir, chat.cwd) || await summariesContext(stateDir, chat.cwd, 3);
  } catch { return ""; }
}

const claude: ChatProtocolAdapter = {
  async prepare(chat, stateDir) {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--thinking-display", "summarized"];
    if (chat.model) args.push("--model", chat.model);
    if (chat.effort) args.push("--effort", chat.effort);
    if (chat.agentSessionId) args.push("--resume", chat.agentSessionId);
    const context = await launchContext(chat, stateDir);
    if (context !== "") args.push("--append-system-prompt", context);
    if (chat.approvals !== true) return { command: "claude", args: [...args, "--dangerously-skip-permissions"] };
    // Only an approving chat needs the permission server, so a bypass chat never pays its startup.
    const server = selfInvocation(process.execPath, process.argv, ["chat", "mcp-permission", chat.id]);
    const config = { mcpServers: { megabrain: { type: "stdio", command: server.command, args: server.args, env: { MEGABRAIN_STATE_DIR: stateDir } } } };
    const configPath = join(stateDir, "chats", chat.id, "mcp.json");
    await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    await chmod(configPath, 0o600);
    args.push("--permission-prompt-tool", "mcp__megabrain__permissionPrompt", "--mcp-config", configPath);
    return { command: "claude", args };
  },
  async send(_chat, child, parts) {
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: await claudeContent(parts) } })}\n`);
    return undefined;
  },
  async steer() { throw new Error("Claude does not support steering a running turn"); },
  async interrupt(_chat, child) { child?.kill("SIGINT"); },
  terminalCommand(chat) {
    return ["claude", ...(chat.agentSessionId ? ["--resume", chat.agentSessionId] : []), ...(chat.approvals === true ? [] : ["--dangerously-skip-permissions"]), ...(chat.model ? ["--model", chat.model] : []), ...(chat.effort ? ["--effort", chat.effort] : [])];
  },
};

const codex: ChatProtocolAdapter = {
  async prepare(chat, stateDir) {
    const context = await launchContext(chat, stateDir);
    // The value is parsed as TOML: a JSON string literal is a valid basic string, so quotes and newlines come out escaped.
    return { command: "codex", args: ["app-server", "-c", "check_for_update_on_startup=false", ...(context === "" ? [] : ["-c", `developer_instructions=${JSON.stringify(context)}`])] };
  },
  async send(chat, child, parts, request) {
    const input = codexInput(parts);
    // A summary is the only reasoning text Codex streams; without asking for one each reasoning item is empty.
    const response = await request("turn/start", { threadId: chat.agentSessionId, input, summary: "auto", ...(chat.model ? { model: chat.model } : {}), ...(chat.effort ? { effort: chat.effort } : {}) });
    const turn = typeof response === "object" && response !== null ? (response as Record<string, unknown>).turn : undefined;
    const turnId = typeof turn === "object" && turn !== null ? (turn as Record<string, unknown>).id : undefined;
    return typeof turnId === "string" ? turnId : undefined;
  },
  async steer(chat, _child, turnId, parts, request) {
    await request("turn/steer", { threadId: chat.agentSessionId, expectedTurnId: turnId, input: codexInput(parts) });
  },
  async interrupt(chat, child, turnId, request) {
    if (turnId) await request("turn/interrupt", { threadId: chat.agentSessionId, turnId });
  },
  terminalCommand(chat) {
    return ["codex", ...(chat.agentSessionId ? ["resume", chat.agentSessionId] : []), ...(chat.approvals === true ? [] : ["--dangerously-bypass-approvals-and-sandbox"]), "-c", "check_for_update_on_startup=false", ...(chat.model ? ["--model", chat.model] : []), ...(chat.effort ? ["--effort", chat.effort] : [])];
  },
};

function codexInput(parts: MessagePart[]): unknown[] {
  return parts.map((part) => part.type === "text" ? { type: "text", text: part.text } : { type: "localImage", path: part.path });
}

export const chatProtocolAdapters: Readonly<Record<Chat["agent"], ChatProtocolAdapter>> = { claude, codex };
