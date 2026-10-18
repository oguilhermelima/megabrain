import { applyCuratorOutput, buildCuratorPrompt, candidateTopics } from "./curator.js";
import { distill, editedFiles, linesAfter, type DistillTurn } from "./distill.js";
import { extractRefs, mergeRefs } from "./refs.js";
import { askModel, buildSummaryPrompt, parseSummaryAnswer, readSummarySettings, type SummaryKey } from "../chat/summaries.js";
import { openProject } from "./store.js";
import { togglesFor } from "./settings.js";
import type { ChatRecord, Ref } from "./types.js";
import { summaryDue } from "./summary-trigger.js";
import { ModelBudgetExceeded, trackedModelCall } from "./model-usage.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  /** Explicit knowledge scan: bypasses work-block thresholds but remains subject to the daily budget. */
  manual?: boolean;
  deferCurator?: boolean;
  forceBudget?: boolean;
};

export type SummaryResult = { title: string | null; text: string; refs: Ref[]; keys: SummaryKey[]; userTurns: number };

export type ProcessResult =
  | { status: "disabled" | "nothing-new" | "summary-failed"; error?: string }
  | { status: "queued" | "worker" | "curated" | "curator-failed"; chatId: string; topicId?: string; error?: string };

export type PipelineOptions = { stateDir: string; environment: Environment; ask?: Ask; now?: () => Date; forceBudget?: boolean };

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
  private readonly curatorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly curatorRuns = new Map<string, Promise<Set<string>>>();
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
    const settings = readSummarySettings(stateDir);
    if (users < settings.minNewTurns) return { status: "nothing-new" };
    if (users <= covered) {
      if (existing !== null && !existing.curated && existing.summary !== "") {
        if (input.deferCurator === true) return { status: "curated", chatId: existing.id };
        const deferred = await this.flushCurators([input.repo], input.forceBudget);
        const refreshed = openProject(stateDir, input.repo).chat(existing.id);
        if (refreshed?.curated === true) return { status: "curated", chatId: existing.id, topicId: refreshed.topics.at(-1) };
        const last = this.lastCuratorAt(project.dir);
        return deferred.has(input.repo) || last > 0 && this.now().getTime() - last < readSummarySettings(stateDir).curatorEveryMinutes * 60_000 ? { status: "queued", chatId: existing.id } : { status: "curator-failed", chatId: existing.id };
      }
      return { status: "nothing-new" };
    }
    const lastActivityAt = input.endedAt || input.turns.at(-1)?.at || input.startedAt;
    if (input.manual !== true && !summaryDue({ newTurns: users - covered, totalTurns: users, lastActivityAt, now: this.now(), idleMinutes: settings.idleMinutes, minNewTurns: settings.minNewTurns, maxTurns: settings.maxTurns })) return { status: "nothing-new" };

    let output: string;
    try {
      const prompt = buildSummaryPrompt(existing?.summary ?? null, linesAfter(lines, covered));
      output = await trackedModelCall({ stateDir, dailyLimit: settings.dailyCallLimit, force: this.options.forceBudget || input.forceBudget, kind: "summary", project: input.repo, session: input.chatId ?? input.sessionKeys[0] ?? "session", agent: input.agent, model: input.model ?? settings.model, prompt, now: this.now, call: () => this.ask(prompt, "summary") });
    }
    catch (error) { if (error instanceof ModelBudgetExceeded) return { status: "nothing-new" }; return { status: "summary-failed", error: error instanceof Error ? error.message : String(error) }; }
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
    if (input.deferCurator === true) return { status: "curated", chatId: id };
    const deferred = await this.flushCurators([input.repo], input.forceBudget);
    const updated = project.chat(id);
    if (updated?.curated === true) return { status: "curated", chatId: id, topicId: updated.topics.at(-1) };
    const last = this.lastCuratorAt(project.dir);
    if (deferred.has(input.repo) || last > 0 && this.now().getTime() - last < readSummarySettings(this.options.stateDir).curatorEveryMinutes * 60_000) return { status: "queued", chatId: id };
    return { status: "curator-failed", chatId: id };
  }

  private lastCuratorAt(projectDir: string): number {
    try { return Date.parse((JSON.parse(readFileSync(join(projectDir, "curator.json"), "utf8")) as { at: string }).at) || 0; } catch { return 0; }
  }

  private scheduleCurator(repo: string, delay: number): void {
    const current = this.curatorTimers.get(repo);
    if (current !== undefined) clearTimeout(current);
    const timer = setTimeout(() => { this.curatorTimers.delete(repo); void this.flushCurators([repo]); }, Math.max(1, delay));
    timer.unref?.();
    this.curatorTimers.set(repo, timer);
  }

  /** Runs one curator call for all pending summaries in each due project. Invalid or omitted items stay pending. */
  async flushCurators(repos: readonly string[], forceBudget = false): Promise<Set<string>> {
    const deferred = new Set<string>();
    await Promise.all([...new Set(repos)].map(async (repo) => {
      const active = this.curatorRuns.get(repo);
      if (active !== undefined) { for (const item of await active) deferred.add(item); return; }
      const running = this.flushCuratorsUnlocked([repo], forceBudget);
      this.curatorRuns.set(repo, running);
      try { for (const item of await running) deferred.add(item); }
      finally { this.curatorRuns.delete(repo); }
    }));
    return deferred;
  }

  private async flushCuratorsUnlocked(repos: readonly string[], forceBudget = false): Promise<Set<string>> {
    const deferred = new Set<string>();
    const settings = readSummarySettings(this.options.stateDir);
    for (const repo of new Set(repos)) {
      const project = openProject(this.options.stateDir, repo);
      const marker = join(project.dir, "curator.json");
      let last = 0;
      try { last = Date.parse((JSON.parse(readFileSync(marker, "utf8")) as { at: string }).at) || 0; } catch { /* first curator run */ }
      if (last > 0 && this.now().getTime() - last < settings.curatorEveryMinutes * 60_000) {
        deferred.add(repo);
        this.scheduleCurator(repo, last + settings.curatorEveryMinutes * 60_000 - this.now().getTime());
        continue;
      }
      const pending = project.chats().filter((record) => !record.curated && record.summary !== "").sort((a, b) => a.summarizedAt.localeCompare(b.summarizedAt));
      if (pending.length === 0) continue;
      const linesById = new Map(pending.map((record) => [record.id, project.transcript(record.id)]));
      const promptFor = (record: ChatRecord): string => {
        const lines = linesById.get(record.id) ?? [];
        const keys = record.pendingKeys ?? [];
        return buildCuratorPrompt({ title: record.title, summary: record.summary, branch: record.branch, refs: (record.verifiedRefs ?? record.refs).filter((ref) => ref.kind !== "file"), keys: keys.flatMap((key) => { const line = lines.find((candidate) => candidate.cursor === key.cursor); return line === undefined ? [] : [{ ...key, text: line.text }]; }), topics: project.topics(), candidates: candidateTopics(project.topics(), { branch: record.branch, refs: record.verifiedRefs ?? record.refs, text: `${record.title ?? ""} ${record.summary}` }) }).slice(0, 24_000);
      };
      const records: ChatRecord[] = [];
      let inputChars = 0;
      for (const record of [...pending].reverse()) {
        const size = promptFor(record).length;
        if (inputChars + size > 24_000) break;
        records.unshift(record);
        inputChars += size;
      }
      const agent = records[0]?.agent ?? "claude";
      const model = records[0]?.model ?? settings.model;
      const prompt = records.length === 1 ? promptFor(records[0] as ChatRecord) : ["Curate every chat independently. Reply with one JSON object: {\"results\":[{\"chatId\":\"...\", ...curator fields}]}. Include each input chatId once. Use the same topic/sections/decisions/refs/status fields accepted by the single-summary curator. Never include unknown chat ids.", ...records.map((record) => `CHAT ${record.id}\n${promptFor(record)}`)].join("\n\n---\n\n");
      let output: string;
      try { output = await trackedModelCall({ stateDir: this.options.stateDir, dailyLimit: settings.dailyCallLimit, force: this.options.forceBudget || forceBudget, kind: "curator", project: repo, session: records.map((record) => record.id).join(","), agent, model, prompt, now: this.now, call: () => this.ask(prompt, "curator") }); }
      catch (error) {
        if (error instanceof ModelBudgetExceeded) {
          deferred.add(repo);
          const nextDay = new Date(this.now()); nextDay.setHours(24, 0, 0, 0);
          this.scheduleCurator(repo, nextDay.getTime() - this.now().getTime());
        } else process.stderr.write(`knowledge: curator batch for ${repo} failed: ${error instanceof Error ? error.message : String(error)}\n`);
        continue;
      }
      const outputs = new Map<string, string>();
      if (records.length === 1) outputs.set((records[0] as ChatRecord).id, output);
      else {
        try {
          const parsed = JSON.parse(output) as { results?: unknown };
          if (Array.isArray(parsed.results)) for (const item of parsed.results) {
            if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
            const value = item as Record<string, unknown>;
            if (typeof value.chatId !== "string" || !records.some((record) => record.id === value.chatId) || outputs.has(value.chatId)) continue;
            const { chatId, ...answer } = value;
            outputs.set(chatId, JSON.stringify(answer));
          }
        } catch { /* every item remains pending for the next run */ }
      }
      const newTopics = new Map<string, string>();
      for (const record of records) {
        const answer = outputs.get(record.id);
        if (answer === undefined) continue;
        const lines = linesById.get(record.id) ?? [];
        let normalized = answer;
        try {
          const value = JSON.parse(answer) as { topic?: { new?: { title?: string } } };
          const title = value.topic?.new?.title;
          if (title !== undefined && newTopics.has(title)) normalized = JSON.stringify({ ...(value as object), topic: { assign: newTopics.get(title) } });
        } catch { /* validator below reports invalid output */ }
        const applied = applyCuratorOutput(project, normalized, { chatId: record.id, at: this.now().toISOString(), branch: record.branch, refs: record.verifiedRefs ?? record.refs, proposedRefs: record.pendingRefs ?? [], lines, keyMessages: record.pendingKeys ?? [] });
        if (applied.kind !== "ok") { process.stderr.write(`knowledge: curator answer for ${record.id} rejected: ${applied.error}\n`); continue; }
        if (record.pendingKeys !== undefined || record.pendingRefs !== undefined) newTopics.set(applied.value.title, applied.value.id);
        const { pendingKeys: _keys, pendingRefs: _refs, ...rest } = record;
        project.saveChat({ ...rest, topics: [...new Set([...record.topics, applied.value.id])], curated: true });
      }
      mkdirSync(project.dir, { recursive: true, mode: 0o700 });
      const temporary = `${marker}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ at: this.now().toISOString() })}\n`, { mode: 0o600 });
      renameSync(temporary, marker);
    }
    return deferred;
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

}
