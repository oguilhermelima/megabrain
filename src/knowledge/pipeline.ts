import { applyCuratorOutput, buildCuratorPrompt, candidateTopics } from "./curator.js";
import { distill, editedFiles, linesAfter, type DistillTurn } from "./distill.js";
import { extractRefs, mergeRefs } from "./refs.js";
import { askModel, buildSummaryPrompt, parseSummaryAnswer, readSummarySettings, type SummaryKey } from "../chat/summaries.js";
import { openProject } from "./store.js";
import { togglesFor } from "./settings.js";
import type { ChatRecord, Ref, TranscriptLine } from "./types.js";

type Environment = Readonly<Record<string, string | undefined>>;

export type Purpose = "summary" | "curator";
/** One question to the configured summary model. */
export type Ask = (prompt: string, purpose: Purpose) => Promise<string>;

/** A session as the pipeline sees it, whoever ran it: an app chat, a terminal, a dispatch worker. */
export type SessionInput = {
  /** Every id the session is known by ("chat:<id>", "<agent>:<session id>"). One session is one record whichever host ran it. */
  sessionKeys: string[];
  chatId?: string | undefined;
  agent: string;
  model: string | null;
  repo: string;
  cwd: string;
  branch: string;
  worktree: string;
  startedAt: string;
  endedAt: string;
  title?: string | null;
  turns: DistillTurn[];
  parentSessionKey?: string | undefined;
};

export type SummaryResult = { title: string | null; text: string; refs: Ref[]; keys: SummaryKey[]; userTurns: number };

export type ProcessResult =
  | { status: "disabled" | "nothing-new" | "summary-failed"; error?: string }
  | { status: "worker" | "curated" | "curator-failed"; chatId: string; topicId?: string; error?: string };

export type PipelineOptions = { stateDir: string; environment: Environment; ask?: Ask; now?: () => Date };

function commandSource(command: string): Ref["source"] | undefined {
  const segments = command.split(/&&|\|\||[;|]/).map((segment) => segment.trim());
  if (segments.some((segment) => /^git\b/.test(segment))) return "git-output";
  if (segments.some((segment) => /^(?:gh|github)\b/.test(segment))) return "gh-output";
  if (segments.some((segment) => /^megabrain\s+worktree\b/.test(segment))) return "megabrain-output";
  return undefined;
}

function recordId(input: SessionInput): string {
  return input.chatId ?? (input.sessionKeys[0] ?? "session").replace(/[^\w-]+/g, "-");
}

function userTurnCount(turns: readonly DistillTurn[]): number { return turns.filter((turn) => turn.kind === "user").length; }

/** Summarises sessions and files the summaries into topics. Everything it knows about a project is gated by that project's switch first. */
export class KnowledgePipeline {
  private readonly ask: Ask;
  private readonly now: () => Date;
  constructor(private readonly options: PipelineOptions) {
    this.now = options.now ?? (() => new Date());
    this.ask = options.ask ?? (async (prompt) => askModel(readSummarySettings(options.stateDir), prompt, options.environment));
  }

  /** Why a project's sessions may not reach a model, or null when they may. */
  blocked(repo: string): "disabled" | null {
    const toggles = togglesFor(this.options.stateDir, repo);
    return toggles.summaries && toggles.topics ? null : "disabled";
  }

  async processSession(input: SessionInput): Promise<ProcessResult> {
    const blocked = this.blocked(input.repo);
    if (blocked !== null) return { status: blocked };
    const { stateDir } = this.options;
    const project = openProject(stateDir, input.repo);
    const existing = input.sessionKeys.map((key) => project.chatBySession(key)).find((chat) => chat !== null && chat !== undefined) ?? null;
    const lines = distill(input.turns);
    const covered = existing?.userTurns ?? 0;
    const users = userTurnCount(input.turns);

    if (input.parentSessionKey !== undefined) {
      const id = existing?.id ?? recordId(input);
      if (existing === null || project.transcript(id).length !== lines.length) {
        project.saveChat({ ...(existing ?? this.blank(input, id)), sessionKeys: [...new Set([...(existing?.sessionKeys ?? []), ...input.sessionKeys])], parentSessionKey: input.parentSessionKey, endedAt: input.endedAt, refs: this.refsOf(input), curated: true });
        project.writeTranscript(id, lines);
      }
      return { status: "worker", chatId: id };
    }

    if (users === 0) return { status: "nothing-new" };
    if (users <= covered) {
      if (existing !== null && !existing.curated && existing.summary !== "") return this.curate(input, existing, lines);
      return { status: "nothing-new" };
    }
    const settings = readSummarySettings(stateDir);
    const since = Date.parse(existing?.summarizedAt ?? input.startedAt);
    if (users - covered < settings.everyMessages && this.now().getTime() - since < settings.everyMinutes * 60_000) return { status: "nothing-new" };

    let output: string;
    try { output = await this.ask(buildSummaryPrompt(existing?.summary ?? null, linesAfter(lines, covered)), "summary"); }
    catch (error) { return { status: "summary-failed", error: error instanceof Error ? error.message : String(error) }; }
    const answer = parseSummaryAnswer(output);
    if (answer.text === "") return { status: "summary-failed", error: "summary agent answered with nothing" };
    return this.curateSummary(input, { ...answer, userTurns: users });
  }

  /** Files a summary that already exists: writes the chat record and its transcript, then asks the curator which topic it belongs to. */
  async curateSummary(input: SessionInput, summary: SummaryResult): Promise<ProcessResult> {
    const blocked = this.blocked(input.repo);
    if (blocked !== null) return { status: blocked };
    const project = openProject(this.options.stateDir, input.repo);
    const existing = input.sessionKeys.map((key) => project.chatBySession(key)).find((chat) => chat !== null && chat !== undefined) ?? null;
    const id = existing?.id ?? recordId(input);
    const lines = distill(input.turns);
    const sessionRefs = this.refsOf(input);
    const verifiedRefs = input.turns.length === 0 ? mergeRefs(existing?.verifiedRefs ?? [], sessionRefs) : sessionRefs;
    const record: ChatRecord = {
      ...(existing ?? this.blank(input, id)),
      sessionKeys: [...new Set([...(existing?.sessionKeys ?? []), ...input.sessionKeys])],
      title: summary.title ?? input.title ?? existing?.title ?? null,
      summary: summary.text,
      model: input.model,
      branch: input.branch,
      worktree: input.worktree,
      endedAt: input.endedAt,
      refs: mergeRefs(existing?.refs ?? [], sessionRefs, summary.refs),
      verifiedRefs,
      userTurns: Math.max(summary.userTurns, existing?.userTurns ?? 0),
      summarizedAt: this.now().toISOString(),
      curated: false,
      pendingKeys: summary.keys,
      pendingRefs: summary.refs,
    };
    project.saveChat(record);
    if (lines.length > 0) project.writeTranscript(id, lines);
    return this.curate(input, record, lines.length > 0 ? lines : project.transcript(id));
  }

  private blank(input: SessionInput, id: string): ChatRecord {
    return { id, sessionKeys: input.sessionKeys, title: input.title ?? null, summary: "", agent: input.agent, model: input.model, branch: input.branch, worktree: input.worktree, startedAt: input.startedAt, endedAt: input.endedAt, topics: [], refs: [], userTurns: 0, summarizedAt: this.now().toISOString(), curated: false };
  }

  /** Mechanical refs: issue mentions in session text and refs supported by command output, plus edited files. */
  private refsOf(input: SessionInput): Ref[] {
    const refs: Ref[] = [];
    let previous: DistillTurn | undefined;
    for (const turn of input.turns) {
      if (turn.kind === "tool-call") { previous = turn; continue; }
      if (turn.kind === "tool-result") {
        const command = previous?.tool?.input ?? "";
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(command) as Record<string, unknown>; } catch { /* an unavailable command is not evidence */ }
        const shell = String(parsed.command ?? parsed.cmd ?? "");
        const source = commandSource(shell);
        if (source !== undefined) {
          const created = /\b(?:issue|pr)\s+create\b|\b(?:git\s+)?(?:commit|checkout\s+-b|switch\s+-c|branch\s+(?!-))\b/.test(shell);
          refs.push(...extractRefs(turn.text, { source, origin: created ? "created" : "mentioned", at: turn.at }));
        } else if (/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+/i.test(turn.text)) {
          const created = /\b(?:created|opened)\b/i.test(turn.text);
          refs.push(...extractRefs(turn.text, { source: "gh-output", origin: created ? "created" : "mentioned", at: turn.at }));
        }
        previous = undefined;
        continue;
      }
      if (turn.kind === "user" || turn.kind === "assistant") refs.push(...extractRefs(turn.text, { source: "text", origin: "mentioned", at: turn.at }));
    }
    const branch = input.branch.trim();
    if (/^(?:feat|fix|refactor|chore|docs|test|perf|polish)\//.test(branch)) refs.push({ kind: "branch", id: branch, origin: "created", source: "git-output", firstAt: input.startedAt, lastAt: input.endedAt || input.startedAt, count: 1 });
    return mergeRefs(refs, editedFiles(input.turns, input.cwd));
  }

  private async curate(input: SessionInput, record: ChatRecord, lines: readonly TranscriptLine[]): Promise<ProcessResult> {
    const project = openProject(this.options.stateDir, input.repo);
    const keys = record.pendingKeys ?? [];
    const prompt = buildCuratorPrompt({
      title: record.title,
      summary: record.summary,
      branch: record.branch,
      refs: (record.verifiedRefs ?? record.refs).filter((ref) => ref.kind !== "file"),
      keys: keys.flatMap((key) => { const line = lines.find((candidate) => candidate.cursor === key.cursor); return line === undefined ? [] : [{ ...key, text: line.text }]; }),
      topics: project.topics(),
      candidates: candidateTopics(project.topics(), { branch: record.branch, refs: record.verifiedRefs ?? record.refs, text: `${record.title ?? ""} ${record.summary}` }),
    });
    let output: string;
    try { output = await this.ask(prompt, "curator"); }
    catch (error) { return { status: "curator-failed", chatId: record.id, error: error instanceof Error ? error.message : String(error) }; }
    const applied = applyCuratorOutput(project, output, { chatId: record.id, at: this.now().toISOString(), branch: record.branch, refs: record.verifiedRefs ?? record.refs, proposedRefs: record.pendingRefs ?? [], lines, keyMessages: keys });
    if (applied.kind !== "ok") {
      process.stderr.write(`knowledge: curator answer for ${record.id} rejected: ${applied.error}\n`);
      return { status: "curator-failed", chatId: record.id, error: applied.error };
    }
    const { pendingKeys: _pending, pendingRefs: _pendingRefs, ...rest } = record;
    project.saveChat({ ...rest, topics: [...new Set([...record.topics, applied.value.id])], curated: true });
    return { status: "curated", chatId: record.id, topicId: applied.value.id };
  }
}
