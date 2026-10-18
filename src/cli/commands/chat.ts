import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";
import { loadModelRegistry } from "../../core/model.js";
import { readModelSettings, startModel } from "../../core/model-settings.js";
import { callChatd, callPermissionServer, chatdStatus, drainChatd } from "../../chat/daemon.js";
import { ChatStore, type ChatLine } from "../../chat/store.js";
import { readSummaries, searchSummaries } from "../../chat/summaries.js";
import { listChatArtifacts, readChatArtifact } from "../../chat/artifacts.js";

export type Environment = Readonly<Record<string, string | undefined>>;
function stateDir(environment: Environment): string { return environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain"); }
function errorResult(error: unknown): Result<string> {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "terminal-busy" || code === "chat-busy" || code === "nothing-to-edit") return failed(message, 1, `${JSON.stringify({ refusal: { code, message } })}\n`);
  return failed(message, 2);
}
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
/** Exits the process once the one that started it is gone (reparented), and returns the stop function. */
function endWithParent(): () => void {
  const parent = process.ppid;
  const timer = setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 500);
  return () => clearInterval(timer);
}
function argsJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

const QUEUE_USAGE = "Usage: megabrain chat queue list|clear <id> --json | add <id> --parts <json> --json | edit <id> <item> --parts <json> --json | move <id> <item> --to <index> --json | remove|send-now|steer <id> <item> --json";
/** The chatd request for one queue verb; every verb answers with the queue as it is after the change. */
function queueRequest(args: readonly string[]): Record<string, unknown> & { operation: string } {
  const [action, id, ...tail] = args;
  const parts = takeValue(tail, "--parts");
  const to = takeValue(parts.rest, "--to");
  const [itemId, ...flags] = to.rest;
  const withItem = action === "edit" || action === "move" || action === "remove" || action === "send-now" || action === "steer";
  const wantsParts = action === "add" || action === "edit";
  const positional = withItem ? flags : to.rest;
  if (!id || !["list", "clear", "add", ...(withItem ? [action] : [])].includes(action ?? "") || (withItem && !itemId) || positional.length !== 1 || positional[0] !== "--json"
    || wantsParts !== (parts.value !== undefined) || (action === "move") !== (to.value !== undefined)) throw new Error(QUEUE_USAGE);
  if (to.value !== undefined && !/^\d+$/.test(to.value)) throw new Error("--to must be a non-negative index");
  return { operation: "queue", action, id, ...(withItem ? { itemId } : {}), ...(wantsParts ? { parts: partsJson(parts.value) } : {}), ...(to.value === undefined ? {} : { to: Number(to.value) }) };
}

export async function executeChat(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const [verb, ...rest] = args;
  if (verb === undefined || verb === "-h" || verb === "--help") return ok(usageText("chat"));
  if (verb === "mcp-permission") return runPermissionServer(rest, environment);
  try {
    const dir = stateDir(environment);
    let value: unknown;
    if (verb === "daemon") {
      const [action, ...tail] = rest;
      const json = tail.includes("--json");
      if ((action !== "status" && action !== "drain") || tail.some((arg) => arg !== "--json")) throw new Error("Usage: megabrain chat daemon status|drain [--json]");
      // Neither starts a daemon: status reads the running one, drain waits for its turns and then for it to exit.
      if (action === "status") {
        const status = await chatdStatus(dir);
        return ok(json ? argsJson(status) : status.running ? `chatd ${status.pid}: ${status.draining ? "draining" : "running"}, ${status.working.length} working\n` : "chatd is not running\n");
      }
      const drained = await drainChatd(dir);
      return ok(json ? argsJson(drained) : drained.running ? `chatd drained after ${Math.round(drained.waitedMs / 1000)} s; ${drained.resumes.length} queued for the next daemon\n` : "chatd is not running\n");
    }
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
      const effortArg = takeValue(modelArg.rest, "--effort");
      const cwdArg = takeValue(effortArg.rest, "--cwd");
      const partsArg = takeValue(cwdArg.rest, "--parts");
      const approvals = partsArg.rest.includes("--approvals");
      partsArg.rest = partsArg.rest.filter((arg) => arg !== "--approvals");
      if (agent === undefined || cwdArg.value === undefined || effortArg.value === "" || partsArg.rest.some((arg) => arg !== "--json") || !partsArg.rest.includes("--json")) throw new Error("Usage: megabrain chat start --agent <claude|codex> --cwd <path> [--model <model>] [--effort <level>] [--approvals] [--parts <json>] --json");
      const parts = partsJson(partsArg.value);
      // Without --model the chat takes the agent's default from Settings > Models, when one is set.
      const registry = loadModelRegistry(environment);
      const start = startModel(await readModelSettings(dir), registry.kind === "loaded" ? registry.registry.models : [], agent, modelArg.value, effortArg.value);
      value = await callChatd(dir, { operation: "start", agent, model: start.model, effort: start.effort, cwd: cwdArg.value, approvals, parts }, environment, processAdapter);
      return ok(argsJson(value));
    }
    if (verb === "send") {
      const [id, ...tail] = rest;
      const parsed = takeValue(tail, "--parts");
      const fresh = parsed.rest.includes("--fresh");
      const json = parsed.rest.includes("--json");
      if (!id || parsed.value === undefined || parsed.rest.some((arg) => arg !== "--fresh" && arg !== "--json")) throw new Error("Usage: megabrain chat send <id> --parts <json> [--fresh] [--json]");
      value = await callChatd(dir, { operation: "send", id, parts: partsJson(parsed.value), ...(fresh ? { fresh } : {}) }, environment, processAdapter);
      return ok(json ? argsJson(value) : "");
    }
    if (verb === "fork") {
      const [id, ...tail] = rest;
      const at = takeValue(tail, "--at");
      const json = at.rest.includes("--json");
      if (!id || !at.value || at.rest.some((arg) => arg !== "--json")) throw new Error("Usage: megabrain chat fork <id> --at <eventId> [--json]");
      value = await callChatd(dir, { operation: "fork", id, eventId: at.value }, environment, processAdapter);
      return ok(json ? argsJson(value) : "");
    }
    if (verb === "edit-last") {
      const [id, ...tail] = rest;
      const parsed = takeValue(tail, "--parts");
      const json = parsed.rest.includes("--json");
      if (!id || parsed.value === undefined || parsed.rest.some((arg) => arg !== "--json")) throw new Error("Usage: megabrain chat edit-last <id> --parts <json> [--json]");
      value = await callChatd(dir, { operation: "edit-last", id, parts: partsJson(parsed.value) }, environment, processAdapter);
      return ok(json ? argsJson(value) : "");
    }
    if (verb === "resume") {
      const [id, ...tail] = rest;
      if (!id || tail.length !== 1 || tail[0] !== "--json") throw new Error("Usage: megabrain chat resume <id> --json");
      value = await callChatd(dir, { operation: "resume", id }, environment, processAdapter);
      return ok(argsJson(value));
    }
    if (verb === "queue") return ok(argsJson(await callChatd(dir, queueRequest(rest), environment, processAdapter)));
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
    if (verb === "take-over") {
      const [id, ...tail] = rest;
      if (!id || tail.length !== 1 || tail[0] !== "--json") throw new Error("Usage: megabrain chat take-over <id> --json");
      value = await callChatd(dir, { operation: "take-over", id }, environment, processAdapter);
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
    if (verb === "rename") {
      const [id, title, ...tail] = rest;
      if (!id || !title || tail.some((arg) => arg !== "--json") || tail.length > 1) throw new Error("Usage: megabrain chat rename <id> <title> [--json]");
      value = await callChatd(dir, { operation: "rename", id, title }, environment, processAdapter);
      return ok(tail.length ? argsJson(value) : "");
    }
    if (verb === "summarize") {
      const [id, ...tail] = rest;
      if (!id || tail.some((arg) => arg !== "--json") || tail.length > 1) throw new Error("Usage: megabrain chat summarize <id> [--json]");
      value = await callChatd(dir, { operation: "summarize", id }, environment, processAdapter);
      return ok(tail.length ? argsJson(value) : `${(value as { text: string }).text}\n`);
    }
    if (verb === "summaries") {
      const [id, ...tail] = rest;
      if (!id || tail.length !== 1 || tail[0] !== "--json") throw new Error("Usage: megabrain chat summaries <id> --json");
      // The history is a plain file, so it reads without a daemon.
      return ok(argsJson(readSummaries(dir, id)));
    }
    if (verb === "artifacts") {
      if (rest.includes("-h") || rest.includes("--help")) return ok(usageText("chat-artifacts"));
      const [id, ...tail] = rest;
      if (!id || tail.length !== 1 || tail[0] !== "--json") throw new Error(usageText("chat-artifacts").trimEnd());
      const chat = await new ChatStore(dir).get(id);
      if (chat === null) throw new Error(`unknown chat: ${id}`);
      value = { artifacts: await listChatArtifacts(dir, chat, environment.HOME ?? process.env.HOME ?? "") };
      return ok(argsJson(value));
    }
    if (verb === "artifact") {
      if (rest.includes("-h") || rest.includes("--help")) return ok(usageText("chat-artifact"));
      const revisionArg = takeValue(rest, "--revision");
      const [id, artifactId, ...tail] = revisionArg.rest;
      const revision = revisionArg.value === undefined ? undefined : Number(revisionArg.value);
      if (!id || !artifactId || tail.length !== 1 || tail[0] !== "--json" || (revisionArg.value !== undefined && (!/^\d+$/.test(revisionArg.value) || !Number.isSafeInteger(revision) || (revision ?? 0) < 1))) throw new Error(usageText("chat-artifact").trimEnd());
      const chat = await new ChatStore(dir).get(id);
      if (chat === null) throw new Error(`unknown chat: ${id}`);
      const artifact = await readChatArtifact(dir, chat, environment.HOME ?? process.env.HOME ?? "", artifactId, revision);
      if (artifact === null) throw new Error(`unknown artifact for chat ${id}: ${artifactId}`);
      return ok(argsJson(artifact));
    }
    if (verb === "search") {
      const [query, ...tail] = rest;
      if (!query || query.startsWith("--") || tail.length !== 1 || tail[0] !== "--json") throw new Error("Usage: megabrain chat search <text> --json");
      return ok(argsJson(searchSummaries(dir, query)));
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
      // A follow outlives nothing: the desktop app that started it may be killed without a chance to stop it.
      const watch = follow ? endWithParent() : undefined;
      value = await callChatd(dir, { operation: "events", id, since: Number(since.value ?? 0), follow }, environment, processAdapter, (line) => {
        if (follow) process.stdout.write(`${JSON.stringify(line)}\n`); else lines.push(line);
      });
      if (follow) { watch?.(); return ok(""); }
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
