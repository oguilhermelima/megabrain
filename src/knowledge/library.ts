import { basename } from "node:path";
import { defaultBranch, resolveLocation } from "../chat/summary-library.js";
import { listProjects, openProject } from "./store.js";
import { togglesFor } from "./settings.js";
import type { ChatRecord, Ref, Topic, TranscriptLine } from "./types.js";

export type TopicSummary = Pick<Topic, "id" | "project" | "title" | "kind" | "status" | "createdAt" | "updatedAt" | "aliases" | "chats" | "refs"> & { overview: string; activity: number };
export type ChatCard = Pick<ChatRecord, "id" | "title" | "summary" | "agent" | "model" | "branch" | "worktree" | "startedAt" | "endedAt" | "topics" | "refs"> & { parent?: string; lastMessages: Array<{ role: "person" | "agent"; text: string; at: string }> };

const CONTEXT_BYTES = 3000;

function oneLine(text: string, chars: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= chars ? one : `${one.slice(0, Math.max(0, chars - 1)).trimEnd()}…`;
}

export function summarizeTopic(topic: Topic): TopicSummary {
  return { id: topic.id, project: topic.project, title: topic.title, kind: topic.kind, status: topic.status, createdAt: topic.createdAt, updatedAt: topic.updatedAt, aliases: topic.aliases, overview: oneLine(topic.sections.overview.replace(/^#+\s*/gm, ""), 160), chats: topic.chats, refs: topic.refs, activity: topic.keyMessages.length + topic.chats.length };
}

function matchesRepo(repo: string, filter: string | undefined): boolean {
  return filter === undefined || repo === filter || basename(repo) === filter;
}

/** Projects with knowledge on disk and their topics, newest first. */
export function listKnowledge(stateDir: string, filter: { repo?: string }): { projects: Array<{ repo: string; project: string; enabled: boolean; topics: TopicSummary[] }> } {
  const projects = listProjects(stateDir).filter((entry) => matchesRepo(entry.repo, filter.repo)).map((entry) => ({
    repo: entry.repo,
    project: basename(entry.repo),
    enabled: togglesFor(stateDir, entry.repo).summaries,
    topics: openProject(stateDir, entry.repo).topics().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summarizeTopic),
  }));
  return { projects };
}

function score(topic: Topic, terms: readonly string[]): number {
  const live = topic.decisions.filter((decision) => decision.supersededBy === undefined);
  const fields: Array<[string, number]> = [
    [topic.title, 3], [topic.aliases.join(" "), 2], [Object.values(topic.sections).join(" "), 1],
    [live.map((decision) => `${decision.text} ${decision.why}`).join(" "), 1], [topic.refs.map((ref) => `${ref.id} ${ref.title ?? ""}`).join(" "), 1],
  ];
  let total = 0;
  for (const term of terms) {
    const hit = fields.filter(([text]) => text.toLowerCase().includes(term)).reduce((sum, [, weight]) => sum + weight, 0);
    if (hit === 0) return 0;
    total += hit;
  }
  return total;
}

/** Topics holding every word of the text, title hits ranking above body hits. */
export function searchKnowledge(stateDir: string, text: string, filter: { repo?: string; limit?: number }): { results: Array<TopicSummary & { score: number }> } {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { results: [] };
  const results = listProjects(stateDir).filter((entry) => matchesRepo(entry.repo, filter.repo)).flatMap((entry) => openProject(stateDir, entry.repo).topics())
    .map((topic) => ({ topic, score: score(topic, terms) })).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.topic.updatedAt.localeCompare(a.topic.updatedAt))
    .map((entry) => ({ ...summarizeTopic(entry.topic), score: entry.score }));
  return { results: results.slice(0, filter.limit ?? 20) };
}

function lastMessages(lines: readonly TranscriptLine[]): ChatCard["lastMessages"] {
  return lines.filter((line) => line.role !== "tool").slice(-3).map((line) => ({ role: line.role === "person" ? "person" : "agent", text: oneLine(line.text, 300), at: line.at }));
}

function isParent(chat: ChatRecord, parentKey: string): boolean {
  const bare = parentKey.includes(":") ? parentKey.slice(parentKey.indexOf(":") + 1) : parentKey;
  return chat.sessionKeys.some((key) => key === parentKey || key.endsWith(`:${bare}`) || key === bare);
}

function card(chat: ChatRecord, all: readonly ChatRecord[], lines: readonly TranscriptLine[]): ChatCard {
  const parent = chat.parentSessionKey === undefined ? undefined : all.find((candidate) => candidate.id !== chat.id && isParent(candidate, chat.parentSessionKey as string));
  return { id: chat.id, title: chat.title, summary: chat.summary, agent: chat.agent, model: chat.model, branch: chat.branch, worktree: chat.worktree, startedAt: chat.startedAt, endedAt: chat.endedAt, topics: chat.topics, refs: chat.refs, ...(parent === undefined ? {} : { parent: parent.id }), lastMessages: lastMessages(lines) };
}

/** The whole topic plus the cards of the chats that built it, each dispatch worker under its parent's card. */
export function showTopic(stateDir: string, id: string): (Topic & { chatRecords: ChatCard[] }) | null {
  for (const entry of listProjects(stateDir)) {
    const project = openProject(stateDir, entry.repo);
    const topic = project.topic(id);
    if (topic === null) continue;
    const all = project.chats();
    const own = all.filter((chat) => topic.chats.includes(chat.id));
    const workers = all.filter((chat) => chat.parentSessionKey !== undefined && !own.includes(chat) && own.some((parent) => isParent(parent, chat.parentSessionKey as string)));
    return { ...topic, chatRecords: [...own, ...workers].map((chat) => card(chat, all, project.transcript(chat.id))) };
  }
  return null;
}

/** A chat's record and its distilled transcript. */
export function readTranscript(stateDir: string, chatId: string): { chat: ChatRecord; events: TranscriptLine[] } | null {
  for (const entry of listProjects(stateDir)) {
    const project = openProject(stateDir, entry.repo);
    const chat = project.chat(chatId);
    if (chat !== null) return { chat, events: project.transcript(chatId) };
  }
  return null;
}

/** The topics for a folder: those that name its branch, else the repository's latest active ones. */
export async function topicFor(stateDir: string, cwd: string): Promise<Topic[]> {
  const location = await resolveLocation(cwd);
  const defaultRef = await defaultBranch(cwd);
  const topics = openProject(stateDir, location.repo).topics().filter((topic) => topic.status === "active");
  const named = topics.filter((topic) => topic.refs.some((ref) => ref.kind === "branch" && ref.id === location.branch && ref.id !== defaultRef));
  const chosen = named.length > 0 ? named : topics;
  return chosen.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, named.length > 0 ? 3 : 2);
}

function live(topic: Topic) { return topic.decisions.filter((decision) => decision.supersededBy === undefined); }

/** A Markdown block for an agent's context: the topics of the folder's branch, capped at about 3 KB. Empty when there is nothing or the project's context toggle is off. */
export async function knowledgeContext(stateDir: string, cwd: string): Promise<string> {
  const location = await resolveLocation(cwd);
  if (!togglesFor(stateDir, location.repo).context) return "";
  const topics = await topicFor(stateDir, cwd);
  if (topics.length === 0) return "";
  const header = `# Project knowledge (${location.project})\nMore: megabrain knowledge search <text>, megabrain knowledge show <topic id>\n`;
  const room = Math.floor((CONTEXT_BYTES - Buffer.byteLength(header)) / topics.length) - 8;
  let out = header;
  for (const topic of topics) {
    const parts = [
      `\n## ${topic.title} (${topic.kind}, ${topic.status}) ${topic.id}`,
      `Overview: ${oneLine(topic.sections.overview, 450)}`,
      `State: ${oneLine(topic.sections.state, 550)}`,
      ...(live(topic).length > 0 ? [`Decisions:\n${live(topic).slice(-5).map((decision) => `- ${oneLine(decision.text, 140)} (${oneLine(decision.why, 80)})`).join("\n")}`] : []),
      ...(topic.sections.pitfalls.trim() === "" ? [] : [`Pitfalls: ${oneLine(topic.sections.pitfalls, 350)}`]),
      ...(topic.sections.open.trim() === "" ? [] : [`Open: ${oneLine(topic.sections.open, 250)}`]),
    ];
    let block = "";
    for (const part of parts) {
      if (Buffer.byteLength(block + part) + 1 > room) break;
      block += `${block === "" ? "" : "\n"}${part}`;
    }
    out += `${block}\n`;
  }
  while (Buffer.byteLength(out) > CONTEXT_BYTES) out = out.slice(0, -20);
  return out;
}

export type { Ref };
