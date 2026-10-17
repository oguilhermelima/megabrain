import { randomUUID } from "node:crypto";
import { failed, ok, type Result } from "../core/result.js";
import { isWellFormedRef, mergeRefs } from "./refs.js";
import type { KnowledgeProject } from "./store.js";
import { SECTIONS, TOPIC_KINDS, TOPIC_STATUSES, type Decision, type KeyMessage, type Ref, type SectionName, type Topic, type TopicKind, type TopicStatus, type TranscriptLine } from "./types.js";

/** What the model proposes. Nothing here is trusted until validated against the project's topics. */
export type CuratorAnswer = {
  topic: { assign: string } | { new: { kind: TopicKind; title: string } };
  sections: Partial<Record<SectionName, string>>;
  decisions: { add: Array<{ text: string; why: string }>; supersede: Array<{ id: string; by: number }> };
  refs: Ref[];
  status?: TopicStatus;
};

export type CuratorContext = {
  chatId: string;
  at: string;
  branch: string;
  /** Refs found mechanically and named by the summary. */
  refs: readonly Ref[];
  lines: readonly TranscriptLine[];
  /** Cursors the summary marked as setting direction, each with its one-line why. */
  keyMessages: ReadonlyArray<{ cursor: string; why: string }>;
};

const NO_BRANCH = "(no branch)";
const STOP = new Set(["feat", "fix", "refactor", "chore", "docs", "test", "perf", "polish", "the", "and", "for", "with", "from", "into", "that", "this", "work", "add", "new"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON object in a model's reply, which may sit inside a fence or after a sentence. */
function jsonObject(output: string): unknown {
  const start = output.indexOf("{"), end = output.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try { return JSON.parse(output.slice(start, end + 1)); } catch { return undefined; }
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

export function parseCuratorAnswer(output: string): Result<CuratorAnswer> {
  const value = jsonObject(output);
  if (!isRecord(value)) return failed("curator: the answer holds no JSON object", 1);
  const unknown = Object.keys(value).find((key) => !["topic", "sections", "decisions", "refs", "status"].includes(key));
  if (unknown !== undefined) return failed(`curator: unknown field ${unknown}`, 1);

  const target = value.topic;
  if (!isRecord(target)) return failed("curator: topic must be { assign } or { new }", 1);
  let topic: CuratorAnswer["topic"];
  if (nonEmpty(target.assign) && target.new === undefined) topic = { assign: target.assign };
  else if (isRecord(target.new) && target.assign === undefined) {
    const { kind, title } = target.new;
    if (typeof kind !== "string" || !(TOPIC_KINDS as readonly string[]).includes(kind)) return failed(`curator: unknown topic kind ${String(kind)}`, 1);
    if (!nonEmpty(title)) return failed("curator: a new topic needs a title", 1);
    topic = { new: { kind: kind as TopicKind, title: title.trim() } };
  } else return failed("curator: topic must be { assign } or { new }", 1);

  const sections: CuratorAnswer["sections"] = {};
  if (value.sections !== undefined) {
    if (!isRecord(value.sections)) return failed("curator: sections must be an object", 1);
    for (const [name, text] of Object.entries(value.sections)) {
      if (!(SECTIONS as readonly string[]).includes(name)) return failed(`curator: unknown section ${name}`, 1);
      if (typeof text !== "string") return failed(`curator: section ${name} must be markdown text`, 1);
      sections[name as SectionName] = text;
    }
  }

  const decisions: CuratorAnswer["decisions"] = { add: [], supersede: [] };
  if (value.decisions !== undefined) {
    if (!isRecord(value.decisions)) return failed("curator: decisions are patched with add and supersede, never replaced", 1);
    const extra = Object.keys(value.decisions).find((key) => key !== "add" && key !== "supersede");
    if (extra !== undefined) return failed(`curator: decisions are never removed (${extra})`, 1);
    for (const entry of Array.isArray(value.decisions.add) ? value.decisions.add : value.decisions.add === undefined ? [] : [null]) {
      if (!isRecord(entry) || !nonEmpty(entry.text) || typeof entry.why !== "string") return failed("curator: a decision needs text and why", 1);
      decisions.add.push({ text: entry.text.trim(), why: entry.why.trim() });
    }
    for (const entry of Array.isArray(value.decisions.supersede) ? value.decisions.supersede : value.decisions.supersede === undefined ? [] : [null]) {
      if (!isRecord(entry) || !nonEmpty(entry.id) || !Number.isInteger(entry.by)) return failed("curator: a supersede needs the decision id and the index of the decision that replaces it", 1);
      decisions.supersede.push({ id: entry.id, by: entry.by as number });
    }
  }

  const refs: Ref[] = [];
  if (value.refs !== undefined) {
    if (!Array.isArray(value.refs)) return failed("curator: refs must be a list", 1);
    for (const ref of value.refs) {
      if (!isWellFormedRef(ref)) return failed(`curator: malformed ref ${JSON.stringify(ref)}`, 1);
      refs.push(ref);
    }
  }

  let status: TopicStatus | undefined;
  if (value.status !== undefined) {
    if (typeof value.status !== "string" || !(TOPIC_STATUSES as readonly string[]).includes(value.status)) return failed(`curator: unknown status ${String(value.status)}`, 1);
    status = value.status as TopicStatus;
  }
  return ok({ topic, sections, decisions, refs, ...(status === undefined ? {} : { status }) });
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "topic";
}

function nextDecisionNumber(decisions: readonly Decision[]): number {
  return decisions.reduce((highest, decision) => Math.max(highest, Number(/^d(\d+)$/.exec(decision.id)?.[1] ?? 0)), 0) + 1;
}

/** Validates the model's answer against the project and writes the resulting topic; a bad answer writes nothing. */
export function applyCuratorOutput(project: KnowledgeProject, output: string, context: CuratorContext): Result<Topic> {
  const parsed = parseCuratorAnswer(output);
  if (parsed.kind !== "ok") return parsed;
  const answer = parsed.value;

  let base: Topic;
  if ("assign" in answer.topic) {
    const existing = project.topic(answer.topic.assign);
    if (existing === null) return failed(`curator: unknown topic ${answer.topic.assign}`, 1);
    base = existing;
  } else {
    let id = `${slug(answer.topic.new.title)}-${randomUUID().slice(0, 6)}`;
    while (project.topic(id) !== null) id = `${slug(answer.topic.new.title)}-${randomUUID().slice(0, 6)}`;
    base = { id, project: project.repo, title: answer.topic.new.title, kind: answer.topic.new.kind, status: "active", createdAt: context.at, updatedAt: context.at, aliases: [], sections: { overview: "", state: "", pitfalls: "", open: "" }, decisions: [], refs: [], chats: [], keyMessages: [] };
  }

  const added = answer.decisions.add;
  for (const { id, by } of answer.decisions.supersede) {
    const target = base.decisions.find((decision) => decision.id === id);
    if (target === undefined) return failed(`curator: cannot supersede unknown decision ${id}`, 1);
    if (by < 0 || by >= added.length) return failed(`curator: decision ${id} is superseded by a decision the answer does not add`, 1);
  }

  const first = nextDecisionNumber(base.decisions);
  const decisions: Decision[] = base.decisions.map((decision) => ({ ...decision }));
  for (const { id, by } of answer.decisions.supersede) {
    const target = decisions.find((decision) => decision.id === id);
    if (target !== undefined) target.supersededBy = `d${first + by}`;
  }
  added.forEach((decision, index) => decisions.push({ id: `d${first + index}`, text: decision.text, why: decision.why, at: context.at, chatId: context.chatId }));

  const keyMessages: KeyMessage[] = [...base.keyMessages];
  for (const key of context.keyMessages) {
    const line = context.lines.find((candidate) => candidate.cursor === key.cursor);
    if (line === undefined || keyMessages.some((message) => message.chatId === context.chatId && message.eventCursor === key.cursor)) continue;
    keyMessages.push({ chatId: context.chatId, eventCursor: key.cursor, at: line.at, role: line.role === "person" ? "person" : "agent", text: line.text, why: key.why });
  }

  const branch: Ref[] = context.branch === NO_BRANCH || context.branch === "main" || context.branch === "master" ? [] : [{ kind: "branch", id: context.branch }];
  const topic: Topic = {
    ...base,
    status: answer.status ?? base.status,
    updatedAt: context.at,
    sections: { ...base.sections, ...answer.sections },
    decisions,
    refs: mergeRefs(base.refs, context.refs, branch, answer.refs),
    chats: base.chats.includes(context.chatId) ? base.chats : [...base.chats, context.chatId],
    keyMessages,
  };
  project.saveTopic(topic);
  return ok(topic);
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !STOP.has(token)));
}

const MIN_SCORE = 3;

/** The topics most likely to be the one a summary belongs to, best first: shared branch words and refs weigh most. */
export function candidateTopics(topics: readonly Topic[], hint: { branch: string; refs: readonly Ref[]; text: string }, limit = 2): Topic[] {
  const branch = tokens(hint.branch), text = tokens(hint.text);
  const refKeys = new Set(hint.refs.filter((ref) => ref.kind !== "file").map((ref) => `${ref.kind}:${ref.id}`));
  const scored = topics.map((topic) => {
    const title = tokens([topic.title, ...topic.aliases].join(" "));
    const branches = tokens(topic.refs.filter((ref) => ref.kind === "branch").map((ref) => ref.id).join(" "));
    let score = 0;
    for (const token of branch) { if (title.has(token)) score += 3; else if (branches.has(token)) score += 2; }
    for (const ref of topic.refs) if (refKeys.has(`${ref.kind}:${ref.id}`)) score += ref.kind === "branch" ? 6 : 4;
    for (const token of text) if (title.has(token)) score += 1;
    return { topic, score };
  });
  return scored.filter((entry) => entry.score >= MIN_SCORE).sort((a, b) => b.score - a.score || b.topic.updatedAt.localeCompare(a.topic.updatedAt)).slice(0, limit).map((entry) => entry.topic);
}

const INSTRUCTIONS = [
  "You keep a project's knowledge base: topics, each describing one subject (a feature, a fix, a refactor, a decision, an investigation) as it stands now.",
  "You are given the summary of one chat. Decide which topic it belongs to and how the topic changes. Use only the text below; you have no tools.",
  "A topic is a subject, not a branch or a chat: several branches and chats can build one topic. Prefer assigning to an existing topic when the subject is the same.",
  "Reply with one JSON object and nothing else:",
  '{"topic": {"assign": "<topic id>"} or {"new": {"kind": "feat|fix|refactor|decision|investigation", "title": "<names the subject, e.g. Chat summaries>"}},',
  ' "sections": {"overview": "<markdown>", "state": "<markdown>", "pitfalls": "<markdown>", "open": "<markdown>"},',
  ' "decisions": {"add": [{"text": "<what was decided>", "why": "<why>"}], "supersede": [{"id": "<existing decision id>", "by": <index in add>}]},',
  ' "refs": [{"kind": "issue|pr|commit|branch|file", "id": "<number, hash, branch or path>", "title": "<optional>"}],',
  ' "status": "active|shipped|dropped"}',
  "Rules: leave out any key you do not change. A section you give replaces the old text, so keep what still holds. Decisions are never removed or rewritten, only superseded by a new one.",
  "Write about the work, never about the people or the agent. Be concrete. Write in the language of the summary.",
].join("\n");

function oneLine(text: string, chars: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= chars ? one : `${one.slice(0, chars - 1).trimEnd()}…`;
}

export type CuratorPromptInput = {
  title: string | null;
  summary: string;
  branch: string;
  refs: readonly Ref[];
  keys: ReadonlyArray<{ cursor: string; why: string; text: string }>;
  topics: readonly Topic[];
  candidates: readonly Topic[];
};

export function buildCuratorPrompt(input: CuratorPromptInput): string {
  const index = input.topics.map((topic) => `- ${topic.id} | ${topic.kind} | ${topic.title}${topic.aliases.length > 0 ? ` (also: ${topic.aliases.join("; ")})` : ""} | ${oneLine(topic.sections.overview, 120)}`).join("\n");
  const candidates = input.candidates.map((topic) => JSON.stringify({ id: topic.id, title: topic.title, kind: topic.kind, status: topic.status, sections: topic.sections, decisions: topic.decisions.filter((decision) => decision.supersededBy === undefined) })).join("\n");
  return [
    INSTRUCTIONS,
    `Branch: ${input.branch}`,
    `Summary${input.title === null ? "" : ` (${input.title})`}:\n${input.summary}`,
    input.refs.length === 0 ? "" : `Refs seen: ${input.refs.map((ref) => `${ref.kind} ${ref.id}${ref.title === undefined ? "" : ` - ${ref.title}`}`).join("; ")}`,
    input.keys.length === 0 ? "" : `Key messages:\n${input.keys.map((key) => `- [${key.cursor}] ${oneLine(key.text, 200)} (${key.why})`).join("\n")}`,
    `Existing topics of this project:\n${index === "" ? "(none yet)" : index}`,
    candidates === "" ? "" : `Most likely candidates, in full:\n${candidates}`,
  ].filter((part) => part !== "").join("\n\n");
}
