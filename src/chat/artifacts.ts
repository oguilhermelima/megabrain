import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Chat } from "./store.js";
import { sessionLogPath } from "./session-log.js";
import { ARTIFACT_MAX_BYTES, listArtifacts, stripGoogleFonts } from "../knowledge/artifacts.js";

export type ChatArtifactSource = "megabrain" | "claude-artifact" | "claude-design" | "codex-plan" | "agy" | "grok";
export type ChatArtifactFormat = "html" | "markdown" | "text" | "url";
export type ChatArtifact = {
  id: string;
  source: ChatArtifactSource;
  title: string;
  format: ChatArtifactFormat;
  path?: string;
  url?: string;
  updatedAt: string;
  revision: number | null;
  editable: false;
};
export type ChatArtifactContent = { artifact: ChatArtifact; content: string | null; updatedAt: string; reason?: string };

export type LocatedChatArtifact = { artifact: ChatArtifact; localPath?: string };
type JsonObject = Record<string, unknown>;
type ClaudeCall = { id: string; name: string; input: JsonObject; at: string };

function object(value: unknown): JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function iso(value: string): string { return Number.isNaN(Date.parse(value)) ? new Date(0).toISOString() : new Date(value).toISOString(); }
function localFormat(path: string): ChatArtifactFormat {
  const extension = extname(path).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  return "text";
}
function localUpdatedAt(path: string, fallback: string): string {
  try { return statSync(path).mtime.toISOString(); } catch { return fallback; }
}
function remoteUrl(input: JsonObject, result: string): string {
  const created = /Created a new Artifact at\s+(https:\/\/claude\.ai\/artifact\/[^\s(]+)/i.exec(result)?.[1];
  return created ?? string(input.url);
}
function designType(input: JsonObject, result: string, toolName: string): boolean {
  if (toolName === "DesignSync") return true;
  if (string(input.type_url).toLowerCase().includes("design")) return true;
  return /\bdesign\b.{0,80}\btype\b|\btype\b.{0,100}\bdesign\b/i.test(result);
}
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => textOf(object(part).text ?? object(part).content)).join("");
  return "";
}
function parseClaude(path: string): LocatedChatArtifact[] {
  let transcript: string;
  try { transcript = readFileSync(path, "utf8"); } catch { return []; }
  const calls = new Map<string, ClaudeCall>();
  const artifacts = new Map<string, LocatedChatArtifact>();
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    let row: JsonObject;
    try { row = object(JSON.parse(line) as unknown); } catch { continue; }
    const message = object(row.message);
    const content = Array.isArray(message.content) ? message.content : [];
    for (const partValue of content) {
      const part = object(partValue);
      if (part.type === "tool_use" && (part.name === "Artifact" || part.name === "DesignSync")) {
        calls.set(string(part.id), { id: string(part.id), name: string(part.name), input: object(part.input), at: string(row.timestamp) });
        continue;
      }
      if (part.type !== "tool_result") continue;
      const call = calls.get(string(part.tool_use_id));
      if (call === undefined) continue;
      calls.delete(call.id);
      const result = textOf(part.content);
      const input = call.input;
      const action = string(input.action);
      if (call.name === "Artifact" && action !== "publish") continue;
      const localPath = string(input.file_path) || undefined;
      let existsLocally = false;
      if (localPath !== undefined) { try { existsLocally = statSync(localPath).isFile(); } catch { /* a missing local copy may still have a remote URL */ } }
      const url = remoteUrl(input, result) || (call.name === "DesignSync" ? string(input.type_url) : "");
      if (!existsLocally && url === "") continue;
      const source: ChatArtifactSource = designType(input, result, call.name) ? "claude-design" : "claude-artifact";
      const title = string(input.title) || string(input.label) || (localPath === undefined ? "Claude artifact" : basename(localPath));
      const identity = existsLocally && localPath !== undefined ? localPath : url;
      const id = `${source}:${encodeURIComponent(identity)}`;
      let updatedAt = iso(string(row.timestamp) || call.at);
      if (existsLocally && localPath !== undefined) updatedAt = localUpdatedAt(localPath, updatedAt);
      artifacts.set(id, { artifact: { id, source, title, format: existsLocally && localPath !== undefined ? localFormat(localPath) : "url", ...(existsLocally && localPath !== undefined ? { path: localPath } : {}), ...(url === "" ? {} : { url }), updatedAt, revision: null, editable: false }, ...(existsLocally && localPath !== undefined ? { localPath } : {}) });
    }
  }
  return [...artifacts.values()];
}

export async function listMegabrainChatArtifacts(stateDir: string, chat: Chat): Promise<LocatedChatArtifact[]> {
  return (await listArtifacts(stateDir, {}))
    .filter((artifact) => artifact.chatId === chat.id)
    .map((stored) => ({ artifact: { id: stored.id, source: "megabrain", title: stored.title, format: stored.format === "html" ? "html" : "markdown", path: stored.path, updatedAt: localUpdatedAt(stored.path, stored.updatedAt), revision: stored.revision, editable: false }, localPath: stored.path }));
}

export async function listClaudeChatArtifacts(chat: Chat, home: string): Promise<LocatedChatArtifact[]> {
  const log = chat.agent === "claude" ? await sessionLogPath(chat, home) : null;
  return log === null ? [] : parseClaude(log);
}

export async function locateChatArtifacts(stateDir: string, chat: Chat, home: string): Promise<LocatedChatArtifact[]> {
  const merged = new Map<string, LocatedChatArtifact>();
  for (const item of [...await listMegabrainChatArtifacts(stateDir, chat), ...await listClaudeChatArtifacts(chat, home)]) merged.set(item.artifact.id, item);
  return [...merged.values()].sort((left, right) => right.artifact.updatedAt.localeCompare(left.artifact.updatedAt) || left.artifact.id.localeCompare(right.artifact.id));
}

export async function listChatArtifacts(stateDir: string, chat: Chat, home: string): Promise<ChatArtifact[]> {
  return (await locateChatArtifacts(stateDir, chat, home)).map((item) => item.artifact);
}

/** Reads one artifact belonging to the chat; file reads are bounded even if the file grows while it is open. */
export async function readChatArtifact(stateDir: string, chat: Chat, home: string, id: string): Promise<ChatArtifactContent | null> {
  const item = (await locateChatArtifacts(stateDir, chat, home)).find((candidate) => candidate.artifact.id === id);
  if (item === undefined) return null;
  if (item.localPath === undefined) return { artifact: item.artifact, content: null, updatedAt: item.artifact.updatedAt };
  let descriptor: number;
  try { descriptor = openSync(item.localPath, "r"); } catch { return { artifact: item.artifact, content: null, updatedAt: item.artifact.updatedAt, reason: "The local artifact file is no longer available." }; }
  try {
    if (fstatSync(descriptor).size > ARTIFACT_MAX_BYTES) return { artifact: item.artifact, content: null, updatedAt: item.artifact.updatedAt, reason: `Content exceeds the ${ARTIFACT_MAX_BYTES}-byte limit.` };
    const buffer = Buffer.alloc(ARTIFACT_MAX_BYTES + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > ARTIFACT_MAX_BYTES) return { artifact: item.artifact, content: null, updatedAt: item.artifact.updatedAt, reason: `Content exceeds the ${ARTIFACT_MAX_BYTES}-byte limit.` };
    let content = buffer.subarray(0, bytes).toString("utf8");
    if (item.artifact.format === "html") content = stripGoogleFonts(content);
    return { artifact: item.artifact, content, updatedAt: item.artifact.updatedAt };
  } finally { closeSync(descriptor); }
}

/** A cheap fingerprint for followers: metadata already contains every listed local file's mtime. */
export function chatArtifactSignature(artifacts: readonly ChatArtifact[]): string {
  return JSON.stringify(artifacts.map(({ id, updatedAt, path, url }) => [id, updatedAt, path ?? null, url ?? null]));
}

/** Directory mtimes find new or removed artifacts; only metadata files already linked to this chat need per-file checks. */
export function chatArtifactStoreFingerprint(stateDir: string, artifacts: readonly ChatArtifact[]): string {
  const knowledge = join(stateDir, "knowledge");
  const parts: string[] = [];
  if (existsSync(knowledge)) {
    for (const project of readdirSync(knowledge)) {
      const root = join(knowledge, project, "artifacts");
      try { parts.push(`${root}:${statSync(root).mtimeMs}`); } catch { /* project has no artifact folder */ }
    }
  }
  for (const artifact of artifacts) {
    if (artifact.source !== "megabrain" || artifact.path === undefined) continue;
    const metadata = join(dirname(artifact.path), "artifact.json");
    try { parts.push(`${metadata}:${statSync(metadata).mtimeMs}`); } catch { parts.push(`${metadata}:missing`); }
  }
  return parts.sort().join("\n");
}

/** Mtimes for local content paths already in a chat's artifact list. */
export function chatArtifactFileFingerprint(artifacts: readonly ChatArtifact[]): string {
  return artifacts.flatMap((artifact) => {
    if (artifact.path === undefined) return [];
    try { const info = statSync(artifact.path); return [`${artifact.path}:${info.mtimeMs}:${info.size}`]; }
    catch { return [`${artifact.path}:missing`]; }
  }).sort().join("\n");
}

