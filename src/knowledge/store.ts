import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectId } from "./project-id.js";
import type { ChatRecord, Topic, TranscriptLine } from "./types.js";

export function knowledgeRoot(stateDir: string): string { return join(stateDir, "knowledge"); }

function safe(id: string): string {
  if (!/^[\w.:-]+$/.test(id) || id.includes("..")) throw new Error(`invalid knowledge id: ${id}`);
  return id.replace(/:/g, "-");
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

/** Written whole through a temporary file, so a reader never sees half a document. */
function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

function lines<T>(path: string): T[] {
  let content: string;
  try { content = readFileSync(path, "utf8"); } catch { return []; }
  return content.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as T]; } catch { return []; } });
}

export type KnowledgeProject = ReturnType<typeof openProject>;

/** One project's topics, chat records and transcripts. Nothing is created until something is written. */
export function openProject(stateDir: string, repo: string) {
  const dir = join(knowledgeRoot(stateDir), projectId(repo));
  const topicDir = (id: string): string => join(dir, "topics", safe(id));
  const chatFile = (id: string): string => join(dir, "chats", `${safe(id)}.json`);
  const transcriptFile = (id: string): string => join(dir, "chats", safe(id), "transcript.jsonl");

  const names = (folder: string, directories: boolean): string[] => {
    try { return readdirSync(folder, { withFileTypes: true }).filter((entry) => directories ? entry.isDirectory() : entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name); } catch { return []; }
  };

  /** Records which repository this folder belongs to, so a project with chats and no topic yet is still listed. */
  const mark = (): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (readJson(join(dir, "project.json")) === null) writeAtomic(join(dir, "project.json"), `${JSON.stringify({ repo })}\n`);
  };

  return {
    repo,
    dir,
    topics(): Topic[] { return names(join(dir, "topics"), true).flatMap((name) => { const topic = readJson<Topic>(join(dir, "topics", name, "topic.json")); return topic === null ? [] : [topic]; }); },
    topic(id: string): Topic | null { return readJson<Topic>(join(topicDir(id), "topic.json")); },
    revisions(id: string): Topic[] { return lines<Topic>(join(topicDir(id), "revisions.jsonl")); },
    /** Saves a topic; the version it replaces goes to the revisions first, so a write can always be undone. */
    saveTopic(topic: Topic): void {
      const folder = topicDir(topic.id);
      mark();
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const previous = readJson<Topic>(join(folder, "topic.json"));
      if (previous !== null) appendFileSync(join(folder, "revisions.jsonl"), `${JSON.stringify(previous)}\n`, { mode: 0o600 });
      writeAtomic(join(folder, "topic.json"), `${JSON.stringify(topic, null, 2)}\n`);
    },
    /** Drops a topic with its revisions; a merge calls this after the target has taken everything. */
    removeTopic(id: string): void { rmSync(topicDir(id), { recursive: true, force: true }); },
    chats(): ChatRecord[] { return names(join(dir, "chats"), false).flatMap((name) => { const chat = readJson<ChatRecord>(join(dir, "chats", name)); return chat === null ? [] : [chat]; }); },
    chat(id: string): ChatRecord | null { return readJson<ChatRecord>(chatFile(id)); },
    chatBySession(key: string): ChatRecord | null { return this.chats().find((chat) => chat.sessionKeys.includes(key)) ?? null; },
    saveChat(chat: ChatRecord): void {
      mark();
      mkdirSync(join(dir, "chats"), { recursive: true, mode: 0o700 });
      writeAtomic(chatFile(chat.id), `${JSON.stringify(chat, null, 2)}\n`);
    },
    transcript(id: string): TranscriptLine[] { return lines<TranscriptLine>(transcriptFile(id)); },
    writeTranscript(id: string, transcript: readonly TranscriptLine[]): void {
      mkdirSync(join(dir, "chats", safe(id)), { recursive: true, mode: 0o700 });
      writeAtomic(transcriptFile(id), transcript.map((line) => JSON.stringify(line)).join("\n") + (transcript.length > 0 ? "\n" : ""));
    },
  };
}

/** Every project that has knowledge on disk, with the repository path it was written for. */
export function listProjects(stateDir: string): Array<{ repo: string; id: string }> {
  const root = knowledgeRoot(stateDir);
  let folders: string[];
  try { folders = readdirSync(root); } catch { return []; }
  return folders.flatMap((id) => {
    const topic = subdirectories(join(root, id, "topics")).map((name) => readJson<Topic>(join(root, id, "topics", name, "topic.json"))).find((candidate) => candidate !== null);
    const chat = readJson<{ repo?: string }>(join(root, id, "project.json"));
    const repo = chat?.repo ?? topic?.project;
    return repo === undefined ? [] : [{ repo, id }];
  });
}

function subdirectories(folder: string): string[] {
  try { return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
}
