export const TOPIC_KINDS = ["feat", "fix", "refactor", "decision", "investigation"] as const;
export const TOPIC_STATUSES = ["active", "shipped", "dropped"] as const;
/** The markdown sections of a topic, in page order. Decisions are a list of their own. */
export const SECTIONS = ["overview", "state", "pitfalls", "open"] as const;
export const REF_KINDS = ["issue", "pr", "commit", "branch", "file"] as const;

export type TopicKind = (typeof TOPIC_KINDS)[number];
export type TopicStatus = (typeof TOPIC_STATUSES)[number];
export type SectionName = (typeof SECTIONS)[number];
export type RefKind = (typeof REF_KINDS)[number];

export type Ref = { kind: RefKind; id: string; url?: string; title?: string; state?: string };
/** Never deleted; a later decision supersedes it. */
export type Decision = { id: string; text: string; why: string; at: string; chatId: string; supersededBy?: string };
export type KeyMessage = { chatId: string; eventCursor: string; at: string; role: "person" | "agent"; text: string; why: string };

export type Topic = {
  id: string;
  /** The repository path. */
  project: string;
  title: string;
  kind: TopicKind;
  status: TopicStatus;
  createdAt: string;
  updatedAt: string;
  /** Old titles, kept for search and merges. */
  aliases: string[];
  sections: Record<SectionName, string>;
  decisions: Decision[];
  refs: Ref[];
  chats: string[];
  keyMessages: KeyMessage[];
};

/** One line of a chat's distilled transcript. */
export type TranscriptLine = { cursor: string; at: string; role: "person" | "agent" | "tool"; text: string; images?: string[] };

export type ChatRecord = {
  id: string;
  /** Every id the session is known by: the app's chat id and the agent's own session id, as "chat:<id>" and "<agent>:<id>". */
  sessionKeys: string[];
  title: string | null;
  summary: string;
  agent: string;
  model: string | null;
  branch: string;
  worktree: string;
  startedAt: string;
  endedAt: string;
  topics: string[];
  refs: Ref[];
  /** User turns the summary covers; the next summary counts from here. */
  userTurns: number;
  summarizedAt: string;
  /** False while the curator has not accepted this summary yet; it is retried at the next pass. */
  curated: boolean;
  /** The session this one was dispatched from; a worker is shown under it and never summarised on its own. */
  parentSessionKey?: string;
  /** Key messages the summary named, waiting for the curator. */
  pendingKeys?: Array<{ cursor: string; why: string }>;
};
