import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";
import { callChatd, callPermissionServer } from "../../chat/daemon.js";
import { ChatStore, type ChatLine } from "../../chat/store.js";

export type Environment = Readonly<Record<string, string | undefined>>;
function stateDir(environment: Environment): string { return environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain"); }
function errorResult(error: unknown): Result<string> { return failed(error instanceof Error ? error.message : String(error), 2); }
function takeValue(args: readonly string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === name) { value = args[index + 1]; index += 1; }
    else rest.push(arg);
  }
  return { value, rest };
}
function partsJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try { return JSON.parse(value) as unknown; } catch { throw new Error("--parts must contain valid JSON"); }
}
function argsJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

export async function executeChat(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const [verb, ...rest] = args;
  if (verb === undefined || verb === "-h" || verb === "--help") return ok(usageText("chat"));
  if (verb === "mcp-permission") return runPermissionServer(rest, environment);
  try {
    const dir = stateDir(environment);
    let value: unknown;
    if (verb === "list") {
      if (rest.length !== 1 || rest[0] !== "--json") throw new Error("chat list requires --json");
      // Listing must never block on a daemon: the records are plain files.
      try { value = await callChatd(dir, { operation: "list" }, environment, processAdapter); }
      catch { value = await new ChatStore(dir).list(); }
      return ok(argsJson(value));
    }
    if (verb === "start") {
      const parsed = takeValue(rest, "--agent"); const agent = parsed.value;
      const modelArg = takeValue(parsed.rest, "--model");
      const cwdArg = takeValue(modelArg.rest, "--cwd");
      const partsArg = takeValue(cwdArg.rest, "--parts");
      const approvals = partsArg.rest.includes("--approvals");
      partsArg.rest = partsArg.rest.filter((arg) => arg !== "--approvals");
      if (agent === undefined || cwdArg.value === undefined || partsArg.rest.some((arg) => arg !== "--json") || !partsArg.rest.includes("--json")) throw new Error("Usage: megabrain chat start --agent <claude|codex> --cwd <path> [--model <model>] [--approvals] [--parts <json>] --json");
      const parts = partsJson(partsArg.value);
      value = await callChatd(dir, { operation: "start", agent, model: modelArg.value, cwd: cwdArg.value, approvals, parts }, environment, processAdapter);
      return ok(argsJson(value));
    }
    if (verb === "send") {
      const [id, ...tail] = rest;
      const parsed = takeValue(tail, "--parts");
      if (!id || parsed.value === undefined || parsed.rest.length > 0) throw new Error("Usage: megabrain chat send <id> --parts <json>");
      await callChatd(dir, { operation: "send", id, parts: partsJson(parsed.value) }, environment, processAdapter);
      return ok("");
    }
    if (verb === "interrupt" || verb === "stop") {
      const [id, ...tail] = rest;
      if (!id || tail.length) throw new Error(`Usage: megabrain chat ${verb} <id>`);
      await callChatd(dir, { operation: verb, id }, environment, processAdapter);
      return ok("");
    }
    if (verb === "remove") {
      const [id, ...tail] = rest;
      if (!id || tail.some((arg) => arg !== "--json") || tail.length > 1) throw new Error("Usage: megabrain chat remove <id> [--json]");
      value = await callChatd(dir, { operation: "remove", id }, environment, processAdapter);
      return ok(tail.length ? argsJson(value) : "");
    }
    if (verb === "approve") {
      const [id, approvalId, ...tail] = rest;
      const parsed = takeValue(tail, "--decision");
      if (!id || !approvalId || !parsed.value || parsed.rest.length) throw new Error("Usage: megabrain chat approve <id> <approvalId> --decision allow|allow-session|deny");
      await callChatd(dir, { operation: "approve", id, approvalId, decision: parsed.value }, environment, processAdapter);
      return ok("");
    }
    if (verb === "mode") {
      const [id, mode, ...tail] = rest;
      if (!id || !mode || tail.length !== 1 || tail[0] !== "--json") throw new Error("Usage: megabrain chat mode <id> chat|terminal --json");
      value = await callChatd(dir, { operation: "mode", id, mode }, environment, processAdapter);
      return ok(argsJson(value));
    }
    if (verb === "model") {
      const [id, model, ...tail] = rest;
      const effort = takeValue(tail, "--effort");
      const json = effort.rest.includes("--json");
      if (!id || !model || effort.rest.some((arg) => arg !== "--json")) throw new Error("Usage: megabrain chat model <id> <model> [--effort <level>] [--json]");
      value = await callChatd(dir, { operation: "model", id, model, effort: effort.value }, environment, processAdapter);
      return ok(json ? argsJson(value) : "");
    }
    if (verb === "terminal-command") {
      const [id, ...tail] = rest;
      if (!id || tail.length !== 1 || tail[0] !== "--json") throw new Error("Usage: megabrain chat terminal-command <id> --json");
      value = await callChatd(dir, { operation: "terminal-command", id }, environment, processAdapter);
      return ok(argsJson(value));
    }
    if (verb === "events") {
      const [id, ...tail] = rest;
      if (!id) throw new Error("Usage: megabrain chat events <id> [--since <cursor>] [--follow] --json");
      const since = takeValue(tail, "--since");
      const follow = since.rest.includes("--follow");
      const flags = since.rest.filter((arg) => arg !== "--follow");
      if (flags.length !== 1 || flags[0] !== "--json") throw new Error("Usage: megabrain chat events <id> [--since <cursor>] [--follow] --json");
      if (since.value !== undefined && !/^\d+$/.test(since.value)) throw new Error("--since must be a non-negative cursor");
      const lines: ChatLine[] = [];
      value = await callChatd(dir, { operation: "events", id, since: Number(since.value ?? 0), follow }, environment, processAdapter, (line) => {
        if (follow) process.stdout.write(`${JSON.stringify(line)}\n`); else lines.push(line);
      });
      if (follow) return ok("");
      const events = Array.isArray(value) ? value as ChatLine[] : lines;
      return ok(events.map((line) => JSON.stringify(line)).join("\n") + (events.length ? "\n" : ""));
    }
    return failed(`unknown chat operation: ${verb}`, 2);
  } catch (error) { return errorResult(error); }
}

const PERMISSION_TOOL = {
  name: "permissionPrompt",
  description: "Ask the megabrain chat user to approve a tool call.",
  inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
} as const;

async function runPermissionServer(args: readonly string[], environment: Environment): Promise<Result<string>> {
  const chatId = args[0];
  if (!chatId || args.length !== 1) return failed("Usage: megabrain chat mcp-permission <chatId>", 2);
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    let request: Record<string, unknown>;
    try { request = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const id = request.id;
    const reply = (result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    // Notifications carry no id and get no reply.
    if (request.method === "initialize") {
      const params = request.params as Record<string, unknown> | undefined;
      reply({ protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "megabrain", version: "1" } });
      continue;
    }
    if (request.method === "tools/list") { reply({ tools: [PERMISSION_TOOL] }); continue; }
    if (request.method !== "tools/call") continue;
    const params = request.params as Record<string, unknown> | undefined;
    if (params?.name !== "permissionPrompt") continue;
    let response: unknown;
    try { response = await callPermissionServer(stateDir(environment), chatId, params); }
    catch { response = { behavior: "deny" }; }
    reply({ content: [{ type: "text", text: JSON.stringify(response) }] });
  }
  return ok("");
}
