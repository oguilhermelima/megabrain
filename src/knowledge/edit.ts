import { failed, ok, type Result } from "../core/result.js";
import { mergeRefs } from "./refs.js";
import { listProjects, openProject, type KnowledgeProject } from "./store.js";
import { TOPIC_KINDS, TOPIC_STATUSES, type Decision, type Topic, type TopicKind, type TopicStatus } from "./types.js";

/**
 * Hand edits of the knowledge base. Each one saves through the store, so the topic it replaces goes to its revisions first.
 * Every check runs before the first write: a refused edit changes nothing.
 */

type Found = { project: KnowledgeProject; topic: Topic };

function findTopic(stateDir: string, id: string): Found | null {
  for (const entry of listProjects(stateDir)) {
    const project = openProject(stateDir, entry.repo);
    const topic = project.topic(id);
    if (topic !== null) return { project, topic };
  }
  return null;
}

function unknown(id: string): Result<never> { return failed(`unknown topic: ${id}`, 1); }

function changed(found: Found, update: Partial<Topic>, at: Date): Topic {
  const topic: Topic = { ...found.topic, ...update, updatedAt: at.toISOString() };
  found.project.saveTopic(topic);
  return topic;
}

/** The old title stays findable as an alias. */
export function renameTopic(stateDir: string, id: string, title: string, at: Date): Result<Topic> {
  const found = findTopic(stateDir, id);
  if (found === null) return unknown(id);
  const next = title.trim();
  if (next === "") return failed("knowledge: a topic needs a title", 2);
  if (next === found.topic.title) return ok(found.topic);
  return ok(changed(found, { title: next, aliases: [...new Set([...found.topic.aliases, found.topic.title])].filter((alias) => alias !== next) }, at));
}

export function setTopicKind(stateDir: string, id: string, kind: string, at: Date): Result<Topic> {
  if (!(TOPIC_KINDS as readonly string[]).includes(kind)) return failed(`knowledge: kind must be one of ${TOPIC_KINDS.join(", ")}`, 2);
  const found = findTopic(stateDir, id);
  return found === null ? unknown(id) : ok(changed(found, { kind: kind as TopicKind }, at));
}

export function setTopicStatus(stateDir: string, id: string, status: string, at: Date): Result<Topic> {
  if (!(TOPIC_STATUSES as readonly string[]).includes(status)) return failed(`knowledge: status must be one of ${TOPIC_STATUSES.join(", ")}`, 2);
  const found = findTopic(stateDir, id);
  return found === null ? unknown(id) : ok(changed(found, { status: status as TopicStatus }, at));
}

/** Decision ids are per topic ("d1", "d2"): the source's follow the target's, and what they supersede follows them. */
function renumbered(target: readonly Decision[], source: readonly Decision[]): Decision[] {
  const highest = target.reduce((most, decision) => Math.max(most, Number(/^d(\d+)$/.exec(decision.id)?.[1] ?? 0)), 0);
  const ids = new Map(source.map((decision, index) => [decision.id, `d${highest + index + 1}`]));
  return source.map((decision) => {
    const { supersededBy, ...rest } = decision;
    const next = supersededBy === undefined ? undefined : ids.get(supersededBy);
    return { ...rest, id: ids.get(decision.id) as string, ...(next === undefined ? {} : { supersededBy: next }) };
  });
}

/** Folds one topic into another: the target keeps its own title, sections and status, and gains the source's title and aliases, refs, chats, decisions and key messages. The source topic is removed; its chats point at the target. */
export function mergeTopics(stateDir: string, id: string, intoId: string, at: Date): Result<Topic> {
  const source = findTopic(stateDir, id);
  if (source === null) return unknown(id);
  const target = findTopic(stateDir, intoId);
  if (target === null) return unknown(intoId);
  if (source.topic.id === target.topic.id) return failed("knowledge: a topic cannot be merged into itself", 2);
  if (source.project.repo !== target.project.repo) return failed("knowledge: topics of different projects cannot be merged", 2);
  const from = source.topic, into = target.topic;
  const merged = changed(target, {
    aliases: [...new Set([...into.aliases, from.title, ...from.aliases])].filter((alias) => alias !== into.title),
    refs: mergeRefs(into.refs, from.refs),
    chats: [...new Set([...into.chats, ...from.chats])],
    decisions: [...into.decisions, ...renumbered(into.decisions, from.decisions)],
    keyMessages: [...into.keyMessages, ...from.keyMessages.filter((message) => !into.keyMessages.some((kept) => kept.chatId === message.chatId && kept.eventCursor === message.eventCursor))],
  }, at);
  for (const chat of target.project.chats()) {
    if (chat.topics.includes(from.id)) target.project.saveChat({ ...chat, topics: [...new Set(chat.topics.map((topic) => topic === from.id ? into.id : topic))] });
  }
  source.project.removeTopic(from.id);
  return ok(merged);
}

/** Files a chat under one topic only: it leaves every other topic's list, and each topic touched gets a revision. */
export function moveChat(stateDir: string, chatId: string, topicId: string, at: Date): Result<Topic> {
  const target = findTopic(stateDir, topicId);
  if (target === null) return unknown(topicId);
  const chat = target.project.chat(chatId);
  if (chat === null) return failed(`unknown chat in the project of topic ${topicId}: ${chatId}`, 1);
  for (const topic of target.project.topics()) {
    if (topic.id !== topicId && topic.chats.includes(chatId)) changed({ project: target.project, topic }, { chats: topic.chats.filter((id) => id !== chatId) }, at);
  }
  const moved = changed(target, { chats: [...new Set([...target.topic.chats, chatId])] }, at);
  target.project.saveChat({ ...chat, topics: [topicId] });
  return ok(moved);
}
