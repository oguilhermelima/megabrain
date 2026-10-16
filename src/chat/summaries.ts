import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { scrubAgentEnvironment } from "../core/agent-env.js";
import { failed, ok, type Result } from "../core/result.js";
import type { Chat, ChatEvent, ChatStore } from "./store.js";

type Environment = Readonly<Record<string, string | undefined>>;
export type SummaryAgent = "claude" | "codex" | "grok" | "agy";
export type SummarySettings = { enabled: boolean; agent: SummaryAgent; model: string; effort: string | null; everyMessages: number; everyMinutes: number; retitle: boolean };
/** What a chat record keeps: the latest summary. The history lives in the chat's summaries.jsonl. */
export type ChatSummary = { text: string; updatedAt: string; model: string };
/** One line of summaries.jsonl: the summary plus the user-turn count it covered, which is where the next one counts from. */
export type SummaryEntry = ChatSummary & { title: string | null; userTurns: number };

export const defaultSummarySettings: SummarySettings = { enabled: false, agent: "claude", model: "claude-haiku-5-5", effort: null, everyMessages: 6, everyMinutes: 10, retitle: true };
const AGENTS: readonly string[] = ["claude", "codex", "grok", "agy"];
const DEFAULT_TIMEOUT_MS = 120_000;
const TRANSCRIPT_EVENTS = 60;
const EVENT_CHARS = 1500;
const TRANSCRIPT_CHARS = 14_000;

export function summarySettingsPath(stateDir: string): string { return join(stateDir, "chat-summaries.json"); }

export function parseSummarySettings(raw: string): Result<SummarySettings> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("chat-summaries: not valid JSON", 2); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return failed("chat-summaries: expected a JSON object", 2);
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !Object.hasOwn(defaultSummarySettings, key));
  if (unknown !== undefined) return failed(`chat-summaries: unknown key ${unknown}`, 2);
  const merged = { ...defaultSummarySettings, ...input };
  const positive = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number) && number > 0;
  if (typeof merged.enabled !== "boolean" || typeof merged.retitle !== "boolean") return failed("chat-summaries: enabled and retitle must be booleans", 2);
  if (typeof merged.agent !== "string" || !AGENTS.includes(merged.agent)) return failed("chat-summaries: agent must be claude, codex, grok or agy", 2);
  if (typeof merged.model !== "string") return failed("chat-summaries: model must be a string", 2);
  if (merged.effort !== null && typeof merged.effort !== "string") return failed("chat-summaries: effort must be a string or null", 2);
  if (!positive(merged.everyMessages) || !positive(merged.everyMinutes)) return failed("chat-summaries: everyMessages and everyMinutes must be positive numbers", 2);
  return ok(merged as SummarySettings);
}

export function readSummarySettings(stateDir: string): SummarySettings {
  try {
    const parsed = parseSummarySettings(readFileSync(summarySettingsPath(stateDir), "utf8"));
    return parsed.kind === "ok" ? parsed.value : defaultSummarySettings;
  } catch { return defaultSummarySettings; }
}

function summariesPath(stateDir: string, id: string): string { return join(stateDir, "chats", id, "summaries.jsonl"); }

/** A chat's summaries, newest first. */
export function readSummaries(stateDir: string, id: string): SummaryEntry[] {
  let content: string;
  try { content = readFileSync(summariesPath(stateDir, id), "utf8"); } catch { return []; }
  return content.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as SummaryEntry]; } catch { return []; } }).reverse();
}

/** One row of the search index: where the chat lives and what it was last said to be about. */
export type SummaryIndexEntry = { chatId: string; project: string; branch: string | null; title: string | null; summary: string; updatedAt: string };

function indexPath(stateDir: string): string { return join(stateDir, "chat-summaries-index.json"); }

function readIndex(stateDir: string): Record<string, SummaryIndexEntry> {
  try { return JSON.parse(readFileSync(indexPath(stateDir), "utf8")) as Record<string, SummaryIndexEntry>; } catch { return {}; }
}

/** Past chats whose project, branch, title or summary contain the text, newest first. Chats since removed drop out. */
export function searchSummaries(stateDir: string, text: string): SummaryIndexEntry[] {
  const needle = text.trim().toLowerCase();
  if (needle === "") return [];
  return Object.values(readIndex(stateDir))
    .filter((entry) => existsSync(join(stateDir, "chats", entry.chatId, "chat.json")))
    .map((entry) => {
      // A rename after the summary changes the title; the record is the truth.
      try { const record = JSON.parse(readFileSync(join(stateDir, "chats", entry.chatId, "chat.json"), "utf8")) as Chat; return { ...entry, title: record.title }; } catch { return entry; }
    })
    .filter((entry) => [entry.project, entry.branch ?? "", entry.title ?? "", entry.summary].some((field) => field.toLowerCase().includes(needle)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function gitBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 }, (error, out) => resolve(error === null && out.trim() !== "" ? out.trim() : null)));
}

type Invocation = { command: string; args: string[]; stdin?: string };

/** One non-interactive, tool-less, read-only run of the configured agent. It starts in an empty directory, so even an agent that cannot disable its tools has nothing to touch. */
function invocation(settings: SummarySettings, prompt: string, cwd: string): Invocation {
  const model = settings.model === "" ? [] : [settings.model];
  const effort = settings.effort === null || settings.effort === "" ? [] : [settings.effort];
  switch (settings.agent) {
    case "claude": return { command: "claude", stdin: prompt, args: ["-p", "--no-session-persistence", "--tools", "", "--permission-mode", "dontAsk", ...model.flatMap((m) => ["--model", m]), ...effort.flatMap((e) => ["--effort", e])] };
    case "codex": return { command: "codex", stdin: prompt, args: ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", cwd, ...model.flatMap((m) => ["-m", m]), ...effort.flatMap((e) => ["-c", `model_reasoning_effort="${e}"`]), "-"] };
    case "grok": return { command: "grok", args: ["-p", prompt, "--permission-mode", "dontAsk", "--cwd", cwd, ...model.flatMap((m) => ["-m", m]), ...effort.flatMap((e) => ["--reasoning-effort", e])] };
    case "agy": return { command: "agy", args: ["-p", prompt, "--sandbox", ...model.flatMap((m) => ["--model", m]), ...effort.flatMap((e) => ["--effort", e])] };
  }
}

function run(call: Invocation, cwd: string, environment: Environment, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(call.command, call.args, { cwd, env: scrubAgentEnvironment({ ...process.env, ...environment }), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", settled = false;
    const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); action(); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(() => reject(new Error(`summary agent timed out after ${timeoutMs} ms`))); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => code === 0 ? resolve(out) : reject(new Error(`summary agent exited ${code}: ${err.trim().slice(0, 300)}`))));
    child.stdin.on("error", () => {});
    child.stdin.end(call.stdin ?? "");
  });
}

const INSTRUCTIONS = [
  "You write the running summary of a coding chat between a person and an AI agent.",
  "Use only the text below. You have no tools and must not try to use any.",
  "Reply in exactly this form and nothing else:",
  "TITLE: <what this chat is about now, under 60 characters, no quotes>",
  "SUMMARY: <3 to 6 sentences: what the person asked for, what was done or decided, what is still open>",
].join("\n");

function clip(text: string): string { return text.length > EVENT_CHARS ? `${text.slice(0, EVENT_CHARS)}…` : text; }

function buildPrompt(previous: string | null, events: readonly ChatEvent[]): string {
  let transcript = events.slice(-TRANSCRIPT_EVENTS).map((event) => `${event.kind === "user" ? "PERSON" : "AGENT"}: ${clip(event.text)}`).join("\n\n");
  if (transcript.length > TRANSCRIPT_CHARS) transcript = transcript.slice(-TRANSCRIPT_CHARS);
  return [INSTRUCTIONS, ...(previous === null ? [] : [`Previous summary (update it, keep what still holds):\n${previous}`]), `${previous === null ? "Conversation" : "New messages since the previous summary"}:\n${transcript}`].join("\n\n");
}

/** The model's answer as title and summary; an answer without the TITLE line is a summary whose title is its first line. */
function parseAnswer(output: string): { title: string | null; text: string } {
  const lines = output.trim().split("\n");
  const titleLine = lines.find((line) => /^TITLE:/i.test(line));
  const title = titleLine === undefined ? null : titleLine.replace(/^TITLE:\s*/i, "").trim();
  const summaryAt = lines.findIndex((line) => /^SUMMARY:/i.test(line));
  const text = summaryAt === -1 ? lines.filter((line) => line !== titleLine).join("\n").trim() : [lines[summaryAt]?.replace(/^SUMMARY:\s*/i, "") ?? "", ...lines.slice(summaryAt + 1)].join("\n").trim();
  return { title: title === "" ? null : title, text };
}

const TITLE_CHARS = 60;
function shortTitle(title: string): string { const one = title.replace(/\s+/g, " ").trim(); return one.length <= TITLE_CHARS ? one : `${one.slice(0, TITLE_CHARS - 1).trimEnd()}…`; }

type Emit = (chat: Chat, event: ChatEvent) => Promise<void>;
export type SummarizerOptions = { store: ChatStore; stateDir: string; environment: Environment; emit: Emit; /** False for a chat that was removed while its job ran: nothing is written back. */ alive?: (id: string) => boolean };

export class ChatSummarizer {
  private readonly running = new Map<string, Promise<ChatSummary | null>>();
  private indexing: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: SummarizerOptions) {}

  /** After a turn ends: summarise when enough user turns or minutes passed. A failure is logged and retried at the next turn end. */
  async turnEnded(id: string): Promise<void> {
    try {
      const settings = readSummarySettings(this.options.stateDir);
      if (!settings.enabled || this.running.has(id)) return;
      const chat = await this.options.store.get(id);
      if (chat === null) return;
      const covered = readSummaries(this.options.stateDir, id)[0]?.userTurns ?? 0;
      const turns = (await this.options.store.events(id)).filter((line) => line.event?.kind === "user").length;
      if (turns <= covered) return;
      const since = Date.parse(chat.summary?.updatedAt ?? chat.createdAt);
      const due = turns - covered >= settings.everyMessages || Date.now() - since >= settings.everyMinutes * 60_000;
      if (due) await this.job(chat, settings, true);
    } catch (error) { this.log(id, error); }
  }

  /** On demand: ignores the thresholds and the enabled switch, and reports a failure to the caller. */
  async summarize(id: string): Promise<ChatSummary> {
    const chat = await this.options.store.get(id);
    if (chat === null) throw new Error(`unknown chat: ${id}`);
    const settings = readSummarySettings(this.options.stateDir);
    const summary = await this.job(chat, settings, false);
    if (summary === null) throw new Error("a summary is already being written for this chat");
    return summary;
  }

  /** One job per chat: a second request while one runs gets null. */
  private job(chat: Chat, settings: SummarySettings, swallow: boolean): Promise<ChatSummary | null> {
    if (this.running.has(chat.id)) return Promise.resolve(null);
    const promise = this.write(chat.id, settings).catch((error) => { if (!swallow) throw error; this.log(chat.id, error); return null; }).finally(() => this.running.delete(chat.id));
    this.running.set(chat.id, promise);
    return promise;
  }

  private async write(id: string, settings: SummarySettings): Promise<ChatSummary> {
    const { store, stateDir, environment } = this.options;
    const lines = await store.events(id);
    const turns = lines.filter((line) => line.event?.kind === "user").length;
    const previous = readSummaries(stateDir, id)[0];
    const chat = await store.get(id);
    const transcript = lines.flatMap((line) => line.event !== undefined && (line.event.kind === "user" || line.event.kind === "assistant") && line.event.parentId === undefined ? [line.event] : []);
    // Incremental: everything up to the previous summary is already in it.
    let start = 0;
    if (previous !== undefined) {
      let seen = 0;
      for (let index = 0; index < transcript.length && seen < previous.userTurns; index += 1) if (transcript[index]?.kind === "user") { seen += 1; start = index + 1; }
      while (transcript[start]?.kind === "assistant") start += 1;
    }
    const prompt = buildPrompt(previous?.text ?? null, transcript.slice(start));
    const cwd = await mkdtemp(join(tmpdir(), "megabrain-summary-"));
    let output: string;
    try { output = await run(invocation(settings, prompt, cwd), cwd, environment, Number(environment.MEGABRAIN_CHAT_SUMMARY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS); }
    finally { await rm(cwd, { recursive: true, force: true }); }
    if (this.options.alive?.(id) === false) throw new Error("chat was removed");
    const answer = parseAnswer(output);
    if (answer.text === "") throw new Error("summary agent answered with nothing");
    const summary: ChatSummary = { text: answer.text, updatedAt: new Date().toISOString(), model: settings.model };
    appendFileSync(summariesPath(stateDir, id), `${JSON.stringify({ ...summary, title: answer.title, userTurns: turns } satisfies SummaryEntry)}\n`, { mode: 0o600 });
    const current = await store.get(id) ?? chat;
    if (current === null) return summary;
    await this.apply(current, summary, settings.retitle ? answer.title : null);
    return summary;
  }

  /** Stores the summary on the record, retitles the chat unless the person named it, and tells followers. */
  private async apply(chat: Chat, summary: ChatSummary, title: string | null): Promise<void> {
    chat.summary = summary;
    const retitled = title !== null && chat.titleSource !== "person";
    if (retitled) { chat.title = shortTitle(title); chat.titleSource = "summary"; }
    await this.options.store.put(chat);
    await this.index(chat, summary);
    await this.options.emit(chat, { id: crypto.randomUUID(), at: summary.updatedAt, kind: "summary", text: summary.text });
    if (retitled) await this.options.emit(chat, { id: crypto.randomUUID(), at: summary.updatedAt, kind: "state", text: chat.state });
  }

  /** Keeps the search index current; writes are chained so two chats finishing together never lose a row. */
  private index(chat: Chat, summary: ChatSummary): Promise<unknown> {
    const { stateDir } = this.options;
    const write = async () => {
      const entry: SummaryIndexEntry = { chatId: chat.id, project: basename(chat.cwd), branch: await gitBranch(chat.cwd), title: chat.title, summary: summary.text, updatedAt: summary.updatedAt };
      const target = indexPath(stateDir), temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ ...readIndex(stateDir), [chat.id]: entry })}\n`, { mode: 0o600 });
      renameSync(temporary, target);
    };
    this.indexing = this.indexing.then(write, write);
    return this.indexing;
  }

  private log(id: string, error: unknown): void {
    process.stderr.write(`chat summary for ${id} failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
