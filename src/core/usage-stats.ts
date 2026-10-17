// Token usage from the logs agents keep: one parser per log format, fed one line at a time (a log
// can be most of a gigabyte), and the aggregation that turns per-file usage into per-day and
// per-provider totals. Reading files and caching what they gave lives in adapters/usage-logs.ts.

import { costOf, PRICE_NOTE, PRICES_AS_OF, type TokenCounts } from "./usage-prices.js";

export const USAGE_PROVIDERS = ["claude", "codex", "grok", "agy"] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];
/** The providers whose logs record token usage; agy keeps none. */
const TRACKED: ReadonlySet<UsageProvider> = new Set(["claude", "codex", "grok"]);

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
export type DayUsage = { turns: number; models: Record<string, Tokens> };

/** What one log contributes. `days` are local dates (YYYY-MM-DD) in the time zone it was read in. */
export type FileUsage = {
  session: string;
  project: string | null;
  days: Record<string, DayUsage>;
  firstAt: string | null;
  lastAt: string | null;
  lastModel: string | null;
};

export interface LineParser {
  line(raw: Uint8Array): void;
  result(): FileUsage;
}

const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
const tokenTotal = (tokens: TokenCounts): number => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;

function addTokens(into: Tokens, from: TokenCounts): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.reasoning += from.reasoning;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/**
 * The local date of an ISO timestamp. Formatting is the slow part of a large log, so dates are
 * remembered per minute: every time zone's offset is a whole number of minutes.
 */
export function dayReader(timeZone: string): (timestamp: string) => string | null {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const memo = new Map<string, string>();
  return (timestamp) => {
    const minute = timestamp.slice(0, 16);
    const known = memo.get(minute);
    if (known !== undefined) return known;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    const day = format.format(date);
    memo.set(minute, day);
    return day;
  };
}

/** Shared bookkeeping: days, first and last activity. */
function usageBook(timeZone: string) {
  const dayOf = dayReader(timeZone);
  const days: Record<string, DayUsage> = {};
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  const dayEntry = (day: string): DayUsage => (days[day] ??= { turns: 0, models: {} });
  return {
    days,
    seen(timestamp: string): void {
      if (firstAt === null || timestamp < firstAt) firstAt = timestamp;
      if (lastAt === null || timestamp > lastAt) lastAt = timestamp;
    },
    turn(timestamp: string): void {
      const day = dayOf(timestamp);
      if (day !== null) dayEntry(day).turns += 1;
    },
    tokens(timestamp: string, model: string, tokens: TokenCounts): void {
      const day = dayOf(timestamp);
      if (day === null || tokenTotal(tokens) === 0) return;
      addTokens((dayEntry(day).models[model] ??= emptyTokens()), tokens);
    },
    span: () => ({ firstAt, lastAt }),
  };
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function includes(raw: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).includes(needle);
}

function parseLine(raw: Uint8Array): Record<string, unknown> | undefined {
  try { return record(JSON.parse(decoder.decode(raw))); } catch { return undefined; }
}

const USAGE_KEY = encoder.encode('"usage"');
const USER_TYPE = encoder.encode('"type":"user"');
const TOOL_RESULT = encoder.encode('"tool_result"');

/**
 * Claude Code's session log. A streamed message is written once per content block with the same
 * usage, so a message counts once by its id. Thinking is part of output_tokens and is split out as
 * reasoning. A turn is a prompt the person typed: a user line that is not a tool result, a meta
 * line or a subagent's.
 */
export function claudeParser(timeZone: string): LineParser {
  const book = usageBook(timeZone);
  const counted = new Set<string>();
  let session: string | null = null;
  let project: string | null = null;
  let lastModel: string | null = null;
  let lastModelAt = "";
  return {
    line(raw) {
      const user = includes(raw, USER_TYPE);
      if (user ? includes(raw, TOOL_RESULT) : !includes(raw, USAGE_KEY)) return;
      const entry = parseLine(raw);
      const timestamp = text(entry?.timestamp);
      if (entry === undefined || timestamp === undefined) return;
      book.seen(timestamp);
      session ??= text(entry.sessionId) ?? null;
      project ??= text(entry.cwd) ?? null;
      const message = record(entry.message);
      if (entry.type === "user") {
        const content = message?.content;
        const typed = typeof content === "string" || (Array.isArray(content) && content.some((part) => record(part)?.type === "text"));
        if (typed && entry.isMeta !== true && entry.isSidechain !== true) book.turn(timestamp);
        return;
      }
      const usage = record(message?.usage);
      const model = text(message?.model);
      if (entry.type !== "assistant" || usage === undefined || model === undefined || model === "<synthetic>") return;
      const id = text(message?.id) ?? text(entry.requestId);
      if (id !== undefined) {
        if (counted.has(id)) return;
        counted.add(id);
      }
      const reasoning = Math.min(count(record(usage.output_tokens_details)?.thinking_tokens), count(usage.output_tokens));
      book.tokens(timestamp, model, {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens) - reasoning,
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
        reasoning,
      });
      if (timestamp >= lastModelAt) { lastModel = model; lastModelAt = timestamp; }
    },
    result: () => ({ session: session ?? "", project, days: book.days, ...book.span(), lastModel }),
  };
}

const CODEX_KEYS = ['"token_count"', '"turn_context"', '"task_started"', '"session_meta"'].map((key) => encoder.encode(key));

type CodexTotal = { input: number; cached: number; cacheWrite: number; output: number; reasoning: number };

/**
 * A Codex rollout. Each token_count event carries the session's running total; what it grew by
 * since the last one is this step's usage, so a repeated event adds nothing. Input includes cached
 * input and output includes reasoning, the OpenAI way; both are split apart here. The model is the
 * latest turn_context's, and a turn is a task_started event.
 */
export function codexParser(timeZone: string): LineParser {
  const book = usageBook(timeZone);
  let session: string | null = null;
  let project: string | null = null;
  let model: string | null = null;
  let lastModel: string | null = null;
  let previous: CodexTotal = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const totalOf = (usage: Record<string, unknown>): CodexTotal => ({
    input: count(usage.input_tokens),
    cached: count(usage.cached_input_tokens),
    cacheWrite: count(usage.cache_write_input_tokens),
    output: count(usage.output_tokens),
    reasoning: count(usage.reasoning_output_tokens),
  });
  return {
    line(raw) {
      if (!CODEX_KEYS.some((key) => includes(raw, key))) return;
      const entry = parseLine(raw);
      const timestamp = text(entry?.timestamp);
      const payload = record(entry?.payload);
      if (entry === undefined || timestamp === undefined || payload === undefined) return;
      book.seen(timestamp);
      if (entry.type === "session_meta") {
        session ??= text(payload.id) ?? text(payload.session_id) ?? null;
        project ??= text(payload.cwd) ?? null;
        return;
      }
      if (entry.type === "turn_context") {
        model = text(payload.model) ?? model;
        project ??= text(payload.cwd) ?? null;
        return;
      }
      if (entry.type !== "event_msg") return;
      if (payload.type === "task_started") return book.turn(timestamp);
      if (payload.type !== "token_count") return;
      const info = record(payload.info);
      const total = record(info?.total_token_usage);
      if (total === undefined) return;
      const next = totalOf(total);
      let step: CodexTotal = { input: next.input - previous.input, cached: next.cached - previous.cached, cacheWrite: next.cacheWrite - previous.cacheWrite, output: next.output - previous.output, reasoning: next.reasoning - previous.reasoning };
      // A total that went down was reset (a compacted or forked thread); the event's own step is the truth then.
      if (Object.values(step).some((value) => value < 0)) {
        const last = record(info?.last_token_usage);
        step = last === undefined ? { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 } : totalOf(last);
      }
      previous = next;
      const cached = Math.min(step.cached, step.input);
      const reasoning = Math.min(step.reasoning, step.output);
      const name = model ?? "unknown";
      book.tokens(timestamp, name, { input: step.input - cached, output: step.output - reasoning, cacheRead: cached, cacheWrite: step.cacheWrite, reasoning });
      if (step.input + step.output > 0) lastModel = name;
    },
    result: () => ({ session: session ?? "", project, days: book.days, ...book.span(), lastModel }),
  };
}

/**
 * Grok's usage.json: one record per turn with the day it ended and the tokens per model. Like
 * Codex, input includes cached reads and output includes reasoning.
 */
export function parseGrokUsage(raw: string, project: string | null, timeZone: string): FileUsage {
  const book = usageBook(timeZone);
  let value: Record<string, unknown> | undefined;
  try { value = record(JSON.parse(raw)); } catch { value = undefined; }
  let lastModel: string | null = null;
  const turns = Array.isArray(value?.turns) ? value.turns : [];
  for (const item of turns) {
    const turn = record(item);
    const endedAt = text(turn?.endedAt);
    const ended = endedAt === undefined ? Number.NaN : Date.parse(endedAt);
    if (turn === undefined || Number.isNaN(ended)) continue;
    const timestamp = new Date(ended).toISOString();
    book.seen(timestamp);
    book.turn(timestamp);
    const perModel = Object.entries(record(turn.modelUsage) ?? {});
    const entries = perModel.length > 0 ? perModel : [[text(turn.primaryModelId) ?? "unknown", turn] as const];
    for (const [model, usageValue] of entries) {
      const usage = record(usageValue) ?? {};
      const input = count(usage.inputTokens);
      const output = count(usage.outputTokens);
      const cacheRead = Math.min(count(usage.cachedReadTokens), input);
      const reasoning = Math.min(count(usage.reasoningTokens), output);
      book.tokens(timestamp, model, { input: input - cacheRead, output: output - reasoning, cacheRead, cacheWrite: count(usage.cacheCreationTokens), reasoning });
    }
    lastModel = text(turn.primaryModelId) ?? lastModel;
  }
  return { session: text(value?.sessionId) ?? "", project, days: book.days, ...book.span(), lastModel };
}

function parseText(parser: LineParser, raw: string): FileUsage {
  for (const line of raw.split("\n")) if (line.length > 0) parser.line(encoder.encode(line));
  return parser.result();
}

export const parseClaudeLog = (raw: string, timeZone: string): FileUsage => parseText(claudeParser(timeZone), raw);
export const parseCodexRollout = (raw: string, timeZone: string): FileUsage => parseText(codexParser(timeZone), raw);

// Aggregation.

export type ProviderUsage = Tokens & {
  provider: UsageProvider;
  /** False for an agent whose logs carry no token counts. */
  tracked: boolean;
  total: number;
  sessions: number;
  turns: number;
  /** Dollars for the priced models; null when none of its tokens has a price. */
  cost: number | null;
  unpricedTokens: number;
  /** Of every token in the report. */
  share: number;
  lastModel: string | null;
  lastProject: string | null;
  lastActiveAt: string | null;
};

export type UsageReport = {
  generatedAt: string;
  timeZone: string;
  range: { days: number | null; from: string | null; to: string };
  prices: { asOf: string; note: string };
  totals: Tokens & { total: number; sessions: number; turns: number; cost: number | null; unpricedTokens: number };
  daily: Array<{ date: string; total: number; byProvider: Partial<Record<UsageProvider, number>> }>;
  activeDays: number;
  bestDay: { date: string; total: number } | null;
  /** Cache reads over every input-side token; null with no input. */
  cacheShare: number | null;
  /** The first day any log has usage, whatever the range. */
  trackingSince: string | null;
  providers: ProviderUsage[];
  models: Array<{ provider: UsageProvider; model: string; total: number; cost: number | null }>;
  projects: Array<{ project: string; total: number }>;
};

export type AggregateOptions = { days: number | null; provider: UsageProvider | null; now: Date; timeZone: string };

const TOP = 10;

/** The first day of a range of `days` days that ends today. */
export function rangeStart(today: string, days: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (days - 1));
  return date.toISOString().slice(0, 10);
}

export function aggregateUsage(files: ReadonlyArray<FileUsage & { provider: UsageProvider }>, options: AggregateOptions): UsageReport {
  const today = dayReader(options.timeZone)(options.now.toISOString()) ?? options.now.toISOString().slice(0, 10);
  const from = options.days === null ? null : rangeStart(today, options.days);
  const inRange = (day: string) => (from === null || day >= from) && day <= today;
  const providers = USAGE_PROVIDERS.filter((provider) => options.provider === null || options.provider === provider);

  const totals = { ...emptyTokens(), total: 0, sessions: 0, turns: 0, cost: null as number | null, unpricedTokens: 0 };
  const daily = new Map<string, { date: string; total: number; byProvider: Partial<Record<UsageProvider, number>> }>();
  const models = new Map<string, { provider: UsageProvider; model: string; tokens: Tokens; total: number }>();
  const projects = new Map<string, number>();
  const perProvider = new Map<UsageProvider, ProviderUsage & { sessionIds: Set<string>; lastAt: string }>();
  for (const provider of providers) {
    perProvider.set(provider, { provider, tracked: TRACKED.has(provider), ...emptyTokens(), total: 0, sessions: 0, turns: 0, cost: null, unpricedTokens: 0, share: 0, lastModel: null, lastProject: null, lastActiveAt: null, sessionIds: new Set(), lastAt: "" });
  }
  let trackingSince: string | null = null;

  for (const file of files) {
    const entry = perProvider.get(file.provider);
    if (entry === undefined) continue;
    let active = false;
    for (const [day, usage] of Object.entries(file.days)) {
      const dayTotal = Object.values(usage.models).reduce((sum, tokens) => sum + tokenTotal(tokens), 0);
      if (dayTotal > 0 && (trackingSince === null || day < trackingSince)) trackingSince = day;
      if (!inRange(day)) continue;
      if (dayTotal > 0 || usage.turns > 0) active = true;
      entry.turns += usage.turns;
      for (const [model, tokens] of Object.entries(usage.models)) {
        const total = tokenTotal(tokens);
        addTokens(entry, tokens);
        entry.total += total;
        const key = `${file.provider}\u0000${model}`;
        const modelEntry = models.get(key) ?? { provider: file.provider, model, tokens: emptyTokens(), total: 0 };
        addTokens(modelEntry.tokens, tokens);
        modelEntry.total += total;
        models.set(key, modelEntry);
        if (file.project !== null) projects.set(file.project, (projects.get(file.project) ?? 0) + total);
      }
      if (dayTotal > 0) {
        const row = daily.get(day) ?? { date: day, total: 0, byProvider: {} };
        row.total += dayTotal;
        row.byProvider[file.provider] = (row.byProvider[file.provider] ?? 0) + dayTotal;
        daily.set(day, row);
      }
    }
    if (!active) continue;
    entry.sessionIds.add(file.session);
    if (file.lastAt !== null && file.lastAt > entry.lastAt) {
      entry.lastAt = file.lastAt;
      entry.lastActiveAt = file.lastAt;
      entry.lastModel = file.lastModel ?? entry.lastModel;
      entry.lastProject = file.project ?? entry.lastProject;
    }
  }

  const modelList = [...models.values()].map((entry) => ({ provider: entry.provider, model: entry.model, total: entry.total, cost: costOf(entry.model, entry.tokens) }));
  for (const model of modelList) {
    const entry = perProvider.get(model.provider);
    if (entry === undefined) continue;
    if (model.cost === null) entry.unpricedTokens += model.total;
    else entry.cost = (entry.cost ?? 0) + model.cost;
  }
  const providerList: ProviderUsage[] = [...perProvider.values()].map(({ sessionIds, lastAt: _lastAt, ...entry }) => ({ ...entry, sessions: sessionIds.size }));
  for (const entry of providerList) {
    addTokens(totals, entry);
    totals.total += entry.total;
    totals.sessions += entry.sessions;
    totals.turns += entry.turns;
    totals.unpricedTokens += entry.unpricedTokens;
    if (entry.cost !== null) totals.cost = (totals.cost ?? 0) + entry.cost;
  }
  for (const entry of providerList) entry.share = totals.total === 0 ? 0 : entry.total / totals.total;

  const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const best = days.reduce<(typeof days)[number] | null>((top, day) => (top === null || day.total > top.total ? day : top), null);
  const inputSide = totals.input + totals.cacheRead + totals.cacheWrite;
  return {
    generatedAt: options.now.toISOString(),
    timeZone: options.timeZone,
    range: { days: options.days, from: from ?? days[0]?.date ?? null, to: today },
    prices: { asOf: PRICES_AS_OF, note: PRICE_NOTE },
    totals,
    daily: days,
    activeDays: days.length,
    bestDay: best === null ? null : { date: best.date, total: best.total },
    cacheShare: inputSide === 0 ? null : totals.cacheRead / inputSide,
    trackingSince,
    providers: providerList,
    models: modelList.sort((a, b) => b.total - a.total).slice(0, TOP),
    projects: [...projects.entries()].map(([project, total]) => ({ project, total })).sort((a, b) => b.total - a.total).slice(0, TOP),
  };
}
