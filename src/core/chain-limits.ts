import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProcessAdapter, ProcessOutput } from "../adapters/proc.js";
import type { Result } from "./result.js";
import type { ChainConfig } from "./chain.js";

// Ports lib/module-chain.sh's former megabrain_chain_limit_read and everything it reached
// (codex rollout scan, claude/agy live usage, the on-disk cache, and the usage notice) for
// `chain run`'s step-gating. Both the shell reader and its only caller,
// megabrain_chain_continue_refused (formerly reached from the turn-end hook), are gone: the
// turn-end hook's own chain-continuation path now calls src/cli/commands/chain-run.ts's
// continueRefusedChain directly, which reads limits through this module.

export type LimitWindowName = "5h" | "weekly";
export type LimitAgent = "codex" | "claude" | "agy" | "grok";

export type LimitEntry = Readonly<{
  readonly name: string;
  readonly bucket: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly resetsAt: string;
  readonly windowMinutes?: number;
  // The models a provider says share this bucket (agy: "Gemini Flash, Gemini Pro").
  readonly models?: string;
}>;

export type LimitResult = Readonly<{
  readonly provider: string;
  readonly fetchedAt: number;
  readonly reading?: Readonly<{ readonly kind: string; readonly basis: string; readonly fetchedAt: number }>;
  readonly windows: readonly LimitEntry[];
}>;

export type LimitReading =
  | Readonly<{ readonly status: "current"; readonly usedPercent: number; readonly resetsAt: string; readonly bucket: string; readonly reason: string; readonly source: "disk" | "cache" | "live"; readonly result: LimitResult; readonly fetchedAt: number }>
  // The provider could not be asked just now (rate limited, timed out, in backoff); this is its last
  // good snapshot, `fetchedAt` old, and `retryAt` (unix seconds) is the earliest the next live call may go out.
  | Readonly<{ readonly status: "stale"; readonly stale: true; readonly staleReason: string; readonly usedPercent: number; readonly resetsAt: string; readonly bucket: string; readonly reason: string; readonly source: "cache"; readonly result: LimitResult; readonly fetchedAt: number; readonly retryAt?: number }>
  | Readonly<{ readonly status: "unknown"; readonly reason: string; readonly transient?: Readonly<{ readonly retryAfterSeconds?: number }> }>;

export type ChainLimitEnvironment = Readonly<Record<string, string | undefined>>;

type JsonRecord = Record<string, unknown>;

export function percentText(value: number): string {
  return value.toFixed(1);
}

function unknownReading(agent: LimitAgent, window: LimitWindowName, reason: string): LimitReading {
  return { status: "unknown", reason: `${agent} ${window} window unknown (${reason})` };
}

// A failure that says nothing about the provider's state: asking again later may work, so the last
// good snapshot stands and the next live call waits.
function transientReading(agent: LimitAgent, window: LimitWindowName, reason: string, retryAfterSeconds?: number): LimitReading {
  return { status: "unknown", reason: `${agent} ${window} window unknown (${reason})`, transient: retryAfterSeconds === undefined ? {} : { retryAfterSeconds } };
}

function windowMinutesFor(window: LimitWindowName): number {
  return window === "5h" ? 300 : 10080;
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usableEntries(snapshot: JsonRecord): Array<[string, JsonRecord]> {
  return Object.entries(snapshot).filter((entry): entry is [string, JsonRecord] => isObject(entry[1]) && typeof (entry[1] as JsonRecord).window_minutes === "number");
}

function windowNameFor(field: string, minutes: number): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "weekly";
  return `${field}-${minutes}m`;
}

function buildCodexResult(snapshot: JsonRecord, fetchedAt: number): LimitResult {
  const windows: LimitEntry[] = [];
  for (const [key, value] of usableEntries(snapshot)) {
    if (typeof value.used_percent !== "number" || typeof value.resets_at !== "number") continue;
    const minutes = value.window_minutes as number;
    windows.push({ name: windowNameFor(key, minutes), bucket: "default", usedPercent: value.used_percent, remainingPercent: 100 - value.used_percent, resetsAt: String(value.resets_at), windowMinutes: minutes });
  }
  return { provider: "codex", fetchedAt, reading: { kind: "floor", basis: "last-recorded-turn", fetchedAt }, windows };
}

function resolveCodexSnapshot(snapshot: JsonRecord, window: LimitWindowName, now: number, fetchedAt: number): LimitReading {
  const expectedMinutes = windowMinutesFor(window);
  const usable = usableEntries(snapshot);
  let field = usable.find(([, value]) => value.window_minutes === expectedMinutes)?.[0];
  let actualWindow: string;
  if (field === undefined) {
    if (usable.length === 1) {
      const [key, value] = usable[0];
      field = key;
      actualWindow = windowNameFor(key, value.window_minutes as number);
    } else {
      const observed = usable.map(([key, value]) => `${key} ${value.window_minutes as number} minutes`).join(", ");
      return unknownReading("codex", window, `snapshot reports ${observed}; requested window is not present`);
    }
  } else {
    actualWindow = window;
  }
  const value = snapshot[field] as JsonRecord;
  if (typeof value.used_percent !== "number" || typeof value.resets_at !== "number") {
    return unknownReading("codex", window, `snapshot reports ${field} ${expectedMinutes} minutes but its usage data is incomplete`);
  }
  const resetsAt = value.resets_at;
  if (resetsAt <= now) {
    return unknownReading("codex", window, `recorded window has already reset at ${resetsAt} and carries no information about the current window`);
  }
  const result = buildCodexResult(snapshot, fetchedAt);
  return { status: "current", usedPercent: value.used_percent, resetsAt: String(resetsAt), bucket: "default", reason: `codex ${actualWindow} window at ${percentText(value.used_percent)} percent`, source: "disk", result, fetchedAt };
}

const CODEX_MAX_AGE_SECONDS: Readonly<Record<LimitWindowName, number>> = { "5h": 18000, weekly: 604800 };
const CODEX_ROLLOUT_SCAN_LIMIT = 50;

function walkRollouts(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) out.push(...walkRollouts(path));
    else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

function codexRolloutCandidates(sessionsDir: string, window: LimitWindowName, now: number): Array<{ mtime: number; path: string }> {
  const cutoff = now - CODEX_MAX_AGE_SECONDS[window] - 1;
  const candidates: Array<{ mtime: number; path: string }> = [];
  for (const path of walkRollouts(sessionsDir)) {
    let mtime: number;
    try { mtime = Math.floor(statSync(path).mtimeMs / 1000); } catch { continue; }
    if (mtime > cutoff) candidates.push({ mtime, path });
  }
  candidates.sort((a, b) => {
    if (b.mtime !== a.mtime) return b.mtime - a.mtime;
    if (a.path === b.path) return 0;
    return a.path > b.path ? -1 : 1;
  });
  return candidates.slice(0, CODEX_ROLLOUT_SCAN_LIMIT);
}

function lastMatchingSnapshot(path: string, expectedMinutes: number): { snapshot: JsonRecord; matches: number } | undefined {
  let content: string;
  try { content = readFileSync(path, "utf8"); } catch { return undefined; }
  let found: { snapshot: JsonRecord; matches: number } | undefined;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isObject(parsed)) continue;
    const payload = isObject(parsed.payload) ? parsed.payload : undefined;
    const limits = payload?.rate_limits ?? parsed.rate_limits;
    if (!isObject(limits)) continue;
    const windows = usableEntries(limits);
    if (windows.length === 0) continue;
    const matches = windows.filter(([, value]) => value.window_minutes === expectedMinutes).length;
    found = { snapshot: limits, matches };
  }
  return found;
}

function resolveCodexLimit(sessionsDir: string, window: LimitWindowName, now: number): LimitReading {
  const expectedMinutes = windowMinutesFor(window);
  const candidates = codexRolloutCandidates(sessionsDir, window, now);
  let matchingSnapshot: JsonRecord | undefined;
  let latestSnapshot: JsonRecord | undefined;
  let lastPath: string | undefined;
  for (const candidate of candidates) {
    lastPath = candidate.path;
    const found = lastMatchingSnapshot(candidate.path, expectedMinutes);
    if (found === undefined) continue;
    latestSnapshot = found.snapshot;
    if (found.matches > 0 && matchingSnapshot === undefined) matchingSnapshot = found.snapshot;
  }
  const snapshot = matchingSnapshot ?? latestSnapshot;
  if (snapshot === undefined) return unknownReading("codex", window, "rollout has no rate limit snapshot");
  let fetchedAt = now;
  if (lastPath !== undefined) {
    try { fetchedAt = Math.floor(statSync(lastPath).mtimeMs / 1000); } catch { fetchedAt = now; }
  }
  return resolveCodexSnapshot(snapshot, window, now, fetchedAt);
}

// A provider with several buckets per window (agy groups models by family) answers for the bucket
// that names the step's model family; without a model the most used bucket is the safe answer.
function entryFor(result: LimitResult, window: LimitWindowName, model: string | undefined): LimitEntry | undefined {
  const entries = result.windows.filter((candidate) => candidate.name === window);
  const shared = new Set(result.windows.map((entry) => entry.bucket)).size <= 1;
  if (shared || model === undefined || model === "") return mostUsed(entries);
  const terms = model.toLowerCase().split(/[-_ .]+/).filter((term) => term.length > 1 && !/^\d+$/.test(term));
  const ranked = entries.map((entry) => {
    const description = `${entry.bucket} ${entry.models ?? ""}`.toLowerCase();
    return { entry, score: terms.reduce((score, term) => score + (description.includes(term) ? 1 : 0), 0) };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);
  if (ranked.length === 0 || (ranked[1] !== undefined && ranked[0]!.score === ranked[1].score)) return undefined;
  return ranked[0]!.entry;
}

function mostUsed(entries: readonly LimitEntry[]): LimitEntry | undefined {
  return entries.reduce<LimitEntry | undefined>((most, entry) => most === undefined || entry.usedPercent > most.usedPercent ? entry : most, undefined);
}

function applyLimitResult(result: LimitResult, agent: LimitAgent, window: LimitWindowName, source: "cache" | "live", model?: string): LimitReading {
  const entry = entryFor(result, window, model);
  if (entry === undefined || typeof entry.usedPercent !== "number" || typeof entry.remainingPercent !== "number" || typeof entry.resetsAt !== "string" || entry.resetsAt.length === 0) {
    return unknownReading(agent, window, "provider response has no usable window");
  }
  const bucket = entry.bucket === "default" ? "" : ` (${entry.bucket})`;
  return { status: "current", usedPercent: entry.usedPercent, resetsAt: entry.resetsAt, bucket: entry.bucket, reason: `${agent} ${window} window${bucket} at ${percentText(entry.usedPercent)} percent`, source, result, fetchedAt: result.fetchedAt };
}

function limitTimeout(config: ChainConfig, environment: ChainLimitEnvironment): number {
  const override = environment.MEGABRAIN_CHAIN_LIMIT_TIMEOUT_SECONDS;
  if (override !== undefined && override.length > 0) return Number(override);
  return config.usageLimits?.timeoutSeconds ?? 5;
}

const DEFAULT_TTL_SECONDS = 60;
// Claude 429-blacklists faster pollers of oauth/usage; Superset and Claude Code both hold to five minutes.
const CLAUDE_TTL_SECONDS = 300;

function limitTtl(agent: LimitAgent, config: ChainConfig, environment: ChainLimitEnvironment): number {
  const override = environment.MEGABRAIN_CHAIN_LIMIT_TTL_SECONDS;
  if (override !== undefined && override.length > 0) return Number(override);
  return config.usageLimits?.cacheTtlSeconds ?? (agent === "claude" ? CLAUDE_TTL_SECONDS : DEFAULT_TTL_SECONDS);
}

function cachePath(stateDir: string, agent: LimitAgent): string {
  return resolve(stateDir, `usage-limits-${agent}.json`);
}

function readCache(agent: Exclude<LimitAgent, "codex">, window: LimitWindowName, config: ChainConfig, environment: ChainLimitEnvironment, stateDir: string, now: number, model: string | undefined): LimitReading | undefined {
  const path = cachePath(stateDir, agent);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
  if (!isObject(parsed) || parsed.provider !== agent || typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.windows)) return undefined;
  const ttl = limitTtl(agent, config, environment);
  if (!(parsed.fetchedAt <= now && now - parsed.fetchedAt < ttl)) return undefined;
  // `source` describes where the reading originated, not how this invocation obtained it.
  const reading = applyLimitResult(parsed as unknown as LimitResult, agent, window, "live", model);
  return reading.status === "current" ? reading : undefined;
}

function writeCache(agent: LimitAgent, result: LimitResult, stateDir: string): void {
  writeStateFile(cachePath(stateDir, agent), result, stateDir);
}

function writeStateFile(path: string, value: unknown, stateDir: string): void {
  let temporaryDirectory: string | undefined;
  try {
    mkdirSync(stateDir, { recursive: true });
    temporaryDirectory = mkdtempSync(resolve(stateDir, ".usage-limits-"));
    const temp = resolve(temporaryDirectory, "reading.json");
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch { /* the cache is an optimization; a write failure just costs a re-fetch */ }
  finally { if (temporaryDirectory !== undefined) rmSync(temporaryDirectory, { recursive: true, force: true }); }
}

type CurlOutcome =
  | { readonly kind: "ok"; readonly body: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "network-failed" }
  | { readonly kind: "http-error"; readonly status: number; readonly retryAfterSeconds?: number };

// Retry-After is a number of seconds or an HTTP date; anything else is no instruction.
function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

function parseCurlResult(result: Result<ProcessOutput>): CurlOutcome {
  if (result.kind !== "ok") {
    return result.exitCode === 28 ? { kind: "timeout" } : { kind: "network-failed" };
  }
  const marker = "MEGABRAIN_HTTP_STATUS:";
  const stdout = result.value.stdout;
  const index = stdout.lastIndexOf(marker);
  if (index === -1) return { kind: "network-failed" };
  const trailer = stdout.slice(index + marker.length);
  const status = Number(trailer.split("\n")[0]?.trim());
  const retryAfterSeconds = parseRetryAfter(trailer.match(/MEGABRAIN_RETRY_AFTER:(.*)/)?.[1]?.trim());
  let body = stdout.slice(0, index);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  if (!Number.isFinite(status) || status === 0) return { kind: "network-failed" };
  if (status < 200 || status >= 300) return { kind: "http-error", status, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
  return { kind: "ok", body };
}

async function claudeCredentials(processAdapter: ProcessAdapter): Promise<{ kind: "ok"; token: string; expiresAt: string | undefined } | { kind: "missing" } | { kind: "no-token" }> {
  const result = await processAdapter.run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  if (result.kind !== "ok") return { kind: "missing" };
  try {
    const parsed = JSON.parse(result.value.stdout) as JsonRecord;
    const oauth = isObject(parsed.claudeAiOauth) ? parsed.claudeAiOauth : undefined;
    const token = typeof oauth?.accessToken === "string" ? oauth.accessToken : "";
    if (token === "") return { kind: "no-token" };
    const expiresAt = oauth?.expiresAt;
    return { kind: "ok", token, expiresAt: expiresAt === undefined ? undefined : String(expiresAt) };
  } catch { return { kind: "no-token" }; }
}

// The installed Claude Code version, asked once a day: it is what Claude Code itself sends as its User-Agent.
async function claudeUserAgent(processAdapter: ProcessAdapter, stateDir: string): Promise<string[]> {
  const path = resolve(stateDir, "claude-version.json");
  const today = new Date().toISOString().slice(0, 10);
  let version: string | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isObject(parsed) && parsed.day === today && typeof parsed.version === "string") version = parsed.version;
  } catch { /* no cached version */ }
  if (version === undefined) {
    const result = await processAdapter.run("claude", ["--version"]);
    version = result.kind === "ok" ? /^\d+\.\d+\.\d+\S*/.exec(result.value.stdout.trim())?.[0] : undefined;
    if (version === undefined) return [];
    writeStateFile(path, { day: today, version }, stateDir);
  }
  return ["-H", `User-Agent: claude-code/${version}`];
}

async function fetchClaudeUsage(window: LimitWindowName, processAdapter: ProcessAdapter, timeoutSeconds: number, environment: ChainLimitEnvironment, stateDir: string): Promise<LimitReading> {
  const credentials = await claudeCredentials(processAdapter);
  if (credentials.kind === "missing") return unknownReading("claude", window, "Keychain item is missing");
  if (credentials.kind === "no-token") return unknownReading("claude", window, "Keychain credential has no access token");
  const now = Math.floor(Date.now() / 1000);
  if (credentials.expiresAt !== undefined) {
    if (!/^\d+$/.test(credentials.expiresAt)) return unknownReading("claude", window, "credential expiry is malformed");
    let expires = Number(credentials.expiresAt);
    if (expires > 100000000000) expires = Math.floor(expires / 1000);
    if (expires <= now) return unknownReading("claude", window, `credential is expired at ${expires}; refreshing requires a separate OAuth flow`);
  }
  const url = environment.MEGABRAIN_CHAIN_CLAUDE_USAGE_URL ?? "https://api.anthropic.com/api/oauth/usage";
  const timeout = String(timeoutSeconds);
  const userAgent = await claudeUserAgent(processAdapter, stateDir);
  const result = await processAdapter.run("curl", ["-sS", "--connect-timeout", timeout, "--max-time", timeout, ...userAgent, "-H", `Authorization: Bearer ${credentials.token}`, "-H", "anthropic-beta: oauth-2025-04-20", "-H", "anthropic-version: 2023-06-01", "-w", "\nMEGABRAIN_HTTP_STATUS:%{http_code}\nMEGABRAIN_RETRY_AFTER:%header{retry-after}", url]);
  const parsed = parseCurlResult(result);
  if (parsed.kind === "timeout") return transientReading("claude", window, "request timed out");
  if (parsed.kind === "network-failed") return transientReading("claude", window, "network request failed");
  if (parsed.kind === "http-error") return transientReading("claude", window, `provider returned HTTP ${parsed.status}`, parsed.retryAfterSeconds);
  let body: JsonRecord;
  try { body = JSON.parse(parsed.body) as JsonRecord; } catch { return unknownReading("claude", window, "response body is unparseable or incomplete"); }
  const windows: LimitEntry[] = [];
  const sources: ReadonlyArray<readonly [string, unknown]> = [["5h", body.five_hour], ["weekly", body.seven_day]];
  for (const [name, raw] of sources) {
    if (!isObject(raw)) continue;
    const utilization = raw.utilization;
    const resetsAt = raw.resets_at;
    if (typeof utilization !== "number" || typeof resetsAt !== "string" || resetsAt.length === 0) continue;
    windows.push({ name, bucket: "default", usedPercent: utilization, remainingPercent: 100 - utilization, resetsAt });
  }
  if (windows.length === 0) return unknownReading("claude", window, "response body is unparseable or incomplete");
  const result2: LimitResult = { provider: "claude", fetchedAt: Math.floor(Date.now() / 1000), windows };
  return applyLimitResult(result2, "claude", window, "live");
}

function clampPercent(value: number): number {
  return value < 0 ? 0 : value > 100 ? 100 : value;
}

const AGY_USAGE_ARGS = ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"] as const;
const AGY_SIGNED_OUT = /AGY_ERROR:.*(?:UNAUTHENTICATED|"error_code":\s*401)|not logged in|not signed in|run agy login/i;

// Antigravity CLI 1.3.3 answers /usage as a command (no model turn, num_turns 0) with
// command.data.groups[].buckets[] — window "5h"|"weekly", remaining_fraction, reset_time — the
// same source Orca's status bar reads. A disabled bucket (the 5h limit while the weekly one is
// spent) carries no reset and is not a reading.
export function agyWindowsFrom(output: string): LimitEntry[] {
  const entries: LimitEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const data = isObject(parsed) && isObject(parsed.command) && isObject(parsed.command.data) ? parsed.command.data : undefined;
    const groups = Array.isArray(data?.groups) ? data.groups.filter(isObject) : [];
    for (const group of groups) {
      const bucket = typeof group.name === "string" && group.name !== "" ? group.name : "unknown";
      const models = typeof group.description === "string" ? group.description : undefined;
      for (const raw of Array.isArray(group.buckets) ? group.buckets.filter(isObject) : []) {
        const name = raw.window === "5h" || raw.window === "weekly" ? raw.window : undefined;
        if (name === undefined || raw.disabled === true || typeof raw.remaining_fraction !== "number" || typeof raw.reset_time !== "string" || raw.reset_time === "") continue;
        const remaining = clampPercent(raw.remaining_fraction * 100);
        entries.push({ name, bucket, usedPercent: clampPercent(100 - remaining), remainingPercent: remaining, resetsAt: raw.reset_time, windowMinutes: windowMinutesFor(name), ...(models === undefined ? {} : { models }) });
      }
    }
    if (entries.length > 0) break;
  }
  return entries;
}

async function fetchAgyUsage(window: LimitWindowName, processAdapter: ProcessAdapter, model: string | undefined): Promise<LimitReading> {
  const result = await processAdapter.run("agy", AGY_USAGE_ARGS, { timeoutMs: 30_000 });
  const output = result.kind === "ok" ? `${result.value.stdout}\n${result.value.stderr}` : `${result.kind === "failed" ? result.stdout ?? "" : ""}\n${result.error}`;
  if (AGY_SIGNED_OUT.test(output)) return unknownReading("agy", window, "agy is not signed in; run agy and sign in");
  if (result.kind !== "ok" && /executable not found|not found in \$PATH/i.test(result.error)) return unknownReading("agy", window, "agy CLI is not installed");
  const windows = agyWindowsFrom(output);
  if (windows.length === 0) return unknownReading("agy", window, result.kind === "ok" ? "agy CLI reported no quota" : `agy CLI failed: ${result.error.slice(0, 120)}`);
  return applyLimitResult({ provider: "agy", fetchedAt: Math.floor(Date.now() / 1000), windows }, "agy", window, "live", model);
}

type GrokSession = { readonly token: string; readonly userId: string | undefined; readonly expiresAt: number | undefined };

// Grok keeps its sign-in in <GROK_HOME>/auth.json, keyed by issuer ("https://auth.x.ai" or
// "https://auth.x.ai::<client>"), each entry holding the bearer `key` and its `expires_at`.
function grokSession(environment: ChainLimitEnvironment): GrokSession | undefined {
  const home = environment.GROK_HOME ?? resolve(environment.HOME ?? "", ".grok");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(resolve(home, "auth.json"), "utf8")); } catch { return undefined; }
  if (!isObject(parsed)) return undefined;
  const sessions = Object.entries(parsed)
    .filter(([issuer, value]) => (issuer === "https://auth.x.ai" || issuer.startsWith("https://auth.x.ai::")) && isObject(value) && typeof value.key === "string" && value.key !== "")
    .map(([, value]) => {
      const entry = value as JsonRecord;
      const expires = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
      return { token: entry.key as string, userId: typeof entry.user_id === "string" ? entry.user_id : undefined, expiresAt: Number.isFinite(expires) ? expires : undefined };
    });
  return sessions.find((session) => session.expiresAt === undefined || session.expiresAt > Date.now()) ?? sessions[0];
}

const GROK_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

// The Grok CLI's own /usage reads GET <chat proxy>/billing?format=credits; a weekly period
// reports creditUsagePercent and ends at currentPeriod.end.
async function fetchGrokUsage(window: LimitWindowName, processAdapter: ProcessAdapter, timeoutSeconds: number, environment: ChainLimitEnvironment): Promise<LimitReading> {
  const session = grokSession(environment);
  if (session === undefined) return unknownReading("grok", window, "not signed in to Grok; run grok login");
  if (session.expiresAt !== undefined && session.expiresAt - Date.now() <= GROK_EXPIRY_MARGIN_MS) return unknownReading("grok", window, "Grok sign-in expired; run grok once to refresh it");
  const base = (environment.GROK_CLI_CHAT_PROXY_BASE_URL?.trim().replace(/\/$/, "") || "https://cli-chat-proxy.grok.com/v1");
  const url = environment.MEGABRAIN_CHAIN_GROK_USAGE_URL ?? `${base}/billing?format=credits`;
  const timeout = String(timeoutSeconds);
  const headers = ["-H", `Authorization: Bearer ${session.token}`, "-H", "X-XAI-Token-Auth: xai-grok-cli", "-H", "Accept: application/json", ...(session.userId === undefined ? [] : ["-H", `x-userid: ${session.userId}`])];
  const parsed = parseCurlResult(await processAdapter.run("curl", ["-sS", "--connect-timeout", timeout, "--max-time", timeout, ...headers, "-w", "\nMEGABRAIN_HTTP_STATUS:%{http_code}", url]));
  if (parsed.kind === "timeout") return transientReading("grok", window, "request timed out");
  if (parsed.kind === "network-failed") return transientReading("grok", window, "network request failed");
  if (parsed.kind === "http-error") return transientReading("grok", window, `provider returned HTTP ${parsed.status}`);
  let body: JsonRecord;
  try { body = JSON.parse(parsed.body) as JsonRecord; } catch { return unknownReading("grok", window, "response body is unparseable or incomplete"); }
  const config = isObject(body.config) ? body.config : body;
  const period = isObject(config.currentPeriod) ? config.currentPeriod : undefined;
  const used = config.creditUsagePercent;
  const end = typeof period?.end === "string" ? period.end : typeof config.billingPeriodEnd === "string" ? config.billingPeriodEnd : undefined;
  if (typeof used !== "number" || period?.type !== "USAGE_PERIOD_TYPE_WEEKLY" || end === undefined) return unknownReading("grok", window, "provider reported no weekly credit usage");
  const usedPercent = clampPercent(used);
  const windows: LimitEntry[] = [{ name: "weekly", bucket: "default", usedPercent, remainingPercent: 100 - usedPercent, resetsAt: end, windowMinutes: 10080 }];
  return applyLimitResult({ provider: "grok", fetchedAt: Math.floor(Date.now() / 1000), windows }, "grok", window, "live");
}

// Ports megabrain_chain_limit_read: codex reads the local rollout scan; claude/agy
// only make a live request when the agent is in usageLimits.liveProviders, and are
// otherwise reported unknown without touching the network, matching the shell's
// opt-in gate exactly.
export async function readLimit(agent: LimitAgent, window: LimitWindowName, config: ChainConfig, environment: ChainLimitEnvironment, processAdapter: ProcessAdapter, stateDir: string, model?: string): Promise<LimitReading> {
  const now = Math.floor(Date.now() / 1000);
  if (agent === "codex") {
    const sessionsDir = environment.MEGABRAIN_CODEX_SESSIONS_DIR ?? resolve(environment.HOME ?? "", ".codex/sessions");
    return resolveCodexLimit(sessionsDir, window, now);
  }
  const liveProviders = config.usageLimits?.liveProviders ?? [];
  if (!liveProviders.includes(agent)) return unknownReading(agent, window, "live provider is not enabled");
  const cached = readCache(agent, window, config, environment, stateDir, now, model);
  if (cached !== undefined) return cached;
  let claim = claimLiveCall(agent, stateDir, now);
  // Someone else is already asking: wait for their answer instead of asking too.
  const deadline = Date.now() + (limitTimeout(config, environment) + 1) * 1000;
  while (claim.kind === "blocked" && claim.retryAt === undefined && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50));
    const waited = readCache(agent, window, config, environment, stateDir, Math.floor(Date.now() / 1000), model);
    if (waited !== undefined) return waited;
    claim = claimLiveCall(agent, stateDir, Math.floor(Date.now() / 1000));
  }
  if (claim.kind === "blocked") return staleReading(agent, window, stateDir, model, claim.reason, claim.retryAt) ?? unknownReading(agent, window, claim.reason);
  const timeoutSeconds = limitTimeout(config, environment);
  const reading = agent === "claude"
    ? await fetchClaudeUsage(window, processAdapter, timeoutSeconds, environment, stateDir)
    : agent === "grok"
      ? await fetchGrokUsage(window, processAdapter, timeoutSeconds, environment)
      : await fetchAgyUsage(window, processAdapter, model);
  if (reading.status === "current") {
    writeCache(agent, reading.result, stateDir);
    settleLiveCall(agent, stateDir, { kind: "success" });
    return reading;
  }
  if (reading.status === "unknown" && reading.transient !== undefined) {
    const retryAt = settleLiveCall(agent, stateDir, { kind: "failure", reason: reading.reason, retryAfterSeconds: reading.transient.retryAfterSeconds });
    return staleReading(agent, window, stateDir, model, innerReason(reading.reason), retryAt) ?? reading;
  }
  settleLiveCall(agent, stateDir, { kind: "neutral" });
  return staleReading(agent, window, stateDir, model, innerReason(reading.reason), undefined) ?? reading;
}

// The wait after consecutive failures: the provider's Retry-After when it sent one, else 60 seconds
// doubling to 15 minutes.
const BACKOFF_FIRST_SECONDS = 60;
const BACKOFF_CAP_SECONDS = 900;
// Claude Code's own rule for oauth/usage: Retry-After, else five minutes, never over an hour.
const CLAUDE_RETRY_DEFAULT_SECONDS = 300;
const CLAUDE_RETRY_CAP_SECONDS = 3600;
const CLAIM_SECONDS = 35;
const CALL_LOG_LIMIT = 100;
const LOCK_STALE_SECONDS = 10;

// Shared by every caller through the state directory (the app, chain selection, every pane): when
// the next live call may go out, whether one is in flight, and when each was made.
type Backoff = { failures: number; retryAt: number; claimUntil: number; reason: string; calls: number[] };

function backoffPath(stateDir: string, agent: LimitAgent): string {
  return resolve(stateDir, `usage-backoff-${agent}.json`);
}

function readBackoff(stateDir: string, agent: LimitAgent): Backoff {
  const empty: Backoff = { failures: 0, retryAt: 0, claimUntil: 0, reason: "", calls: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(backoffPath(stateDir, agent), "utf8"));
    if (!isObject(parsed)) return empty;
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
    return { failures: number(parsed.failures), retryAt: number(parsed.retryAt), claimUntil: number(parsed.claimUntil), reason: typeof parsed.reason === "string" ? parsed.reason : "", calls: Array.isArray(parsed.calls) ? parsed.calls.filter((call): call is number => typeof call === "number") : [] };
  } catch { return empty; }
}

// The read-modify-write runs under a directory lock (mkdir is atomic), so two processes cannot both
// see "free" and both call out. A lock someone else holds just means a call is being claimed.
function withBackoffLock<T>(agent: LimitAgent, stateDir: string, now: number, body: () => T, busy: T): T {
  const lock = resolve(stateDir, `usage-backoff-${agent}.lock`);
  try { mkdirSync(stateDir, { recursive: true }); } catch { return busy; }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock);
      try { return body(); } finally { rmSync(lock, { recursive: true, force: true }); }
    } catch (cause) {
      const exists = typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "EEXIST";
      if (!exists) return body();
      let age = 0;
      try { age = now - Math.floor(statSync(lock).mtimeMs / 1000); } catch { continue; }
      if (age < LOCK_STALE_SECONDS) return busy;
      rmSync(lock, { recursive: true, force: true });
    }
  }
  return busy;
}

type Claim = { kind: "claimed" } | { kind: "blocked"; reason: string; retryAt: number | undefined };

function claimLiveCall(agent: LimitAgent, stateDir: string, now: number): Claim {
  const busy: Claim = { kind: "blocked", reason: "refresh in progress", retryAt: undefined };
  return withBackoffLock(agent, stateDir, now, () => {
    const state = readBackoff(stateDir, agent);
    if (state.retryAt > now) return { kind: "blocked", reason: innerReason(state.reason) || "backing off", retryAt: state.retryAt } satisfies Claim;
    if (state.claimUntil > now) return busy;
    writeStateFile(backoffPath(stateDir, agent), { ...state, claimUntil: now + CLAIM_SECONDS, calls: [...state.calls, now].slice(-CALL_LOG_LIMIT) }, stateDir);
    return { kind: "claimed" } satisfies Claim;
  }, busy);
}

type Settlement = { kind: "success" } | { kind: "neutral" } | { kind: "failure"; reason: string; retryAfterSeconds: number | undefined };

// Returns when the next live call may go out after a failure.
function settleLiveCall(agent: LimitAgent, stateDir: string, settlement: Settlement): number | undefined {
  const now = Math.floor(Date.now() / 1000);
  return withBackoffLock<number | undefined>(agent, stateDir, now, () => {
    const state = readBackoff(stateDir, agent);
    if (settlement.kind === "failure") {
      const failures = state.failures + 1;
      const wait = agent === "claude"
        ? Math.min(CLAUDE_RETRY_CAP_SECONDS, settlement.retryAfterSeconds ?? CLAUDE_RETRY_DEFAULT_SECONDS)
        : settlement.retryAfterSeconds ?? Math.min(BACKOFF_CAP_SECONDS, BACKOFF_FIRST_SECONDS * 2 ** (failures - 1));
      const retryAt = now + Math.max(1, wait);
      writeStateFile(backoffPath(stateDir, agent), { ...state, failures, retryAt, claimUntil: 0, reason: settlement.reason }, stateDir);
      return retryAt;
    }
    writeStateFile(backoffPath(stateDir, agent), settlement.kind === "success" ? { ...state, failures: 0, retryAt: 0, claimUntil: 0, reason: "" } : { ...state, claimUntil: 0 }, stateDir);
    return undefined;
  }, undefined);
}

// "claude 5h window unknown (provider returned HTTP 429)" -> "provider returned HTTP 429".
function innerReason(reason: string): string {
  return reason.replace(/^.*window unknown \(/, "").replace(/\)$/, "");
}

// The last good snapshot, whatever its age: it outlives the cache's freshness window and a restart.
function staleReading(agent: LimitAgent, window: LimitWindowName, stateDir: string, model: string | undefined, why: string, retryAt: number | undefined): LimitReading | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(cachePath(stateDir, agent), "utf8")); } catch { return undefined; }
  if (!isObject(parsed) || parsed.provider !== agent || typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.windows)) return undefined;
  const reading = applyLimitResult(parsed as unknown as LimitResult, agent, window, "cache", model);
  if (reading.status !== "current") return undefined;
  return { ...reading, status: "stale", stale: true, staleReason: why, source: "cache", reason: `${agent} ${window} window is stale (${why})`, ...(retryAt === undefined ? {} : { retryAt }) };
}

// Ports megabrain_chain_reset_display: codex's resetsAt is a stringified epoch
// (converted to ISO here); claude/agy's is already ISO and passes through unchanged,
// exactly like the shell's `date -r` failing on a non-numeric value and falling back
// to the original string.
export function resetDisplay(resetsAt: string): string {
  if (!/^\d+$/.test(resetsAt)) return resetsAt;
  const iso = new Date(Number(resetsAt) * 1000).toISOString();
  return `${iso.slice(0, 19)}Z`;
}

// Ports megabrain_chain_usage_notice_report/due/mark: the periodic "Usage limits:"
// mail queued to a chain-spawned dispatch's parent.
export async function usageNoticeReport(config: ChainConfig, environment: ChainLimitEnvironment, processAdapter: ProcessAdapter, stateDir: string): Promise<string> {
  let report = "Usage limits:";
  for (const agent of ["codex", "claude", "agy", "grok"] as const) {
    const reading = await readLimit(agent, "5h", config, environment, processAdapter, stateDir);
    const summary = reading.status !== "unknown"
      ? reading.result.windows.map((entry) => `${entry.bucket} ${entry.name} ${entry.usedPercent}% used, resets ${entry.resetsAt}`).join("; ") + (reading.status === "stale" ? " (stale)" : "")
      : `unknown (${reading.reason.replace(/^.*window unknown \(/, "").replace(/\)$/, "")})`;
    report += ` ${agent} ${summary};`;
  }
  return report;
}

function noticeStatePath(stateDir: string): string {
  return resolve(stateDir, "usage-limit-notice.json");
}

export function usageNoticeDue(config: ChainConfig, stateDir: string, now: number): boolean {
  const notice = config.usageLimits?.notice;
  if (notice?.enabled !== true) return false;
  const interval = notice.intervalSeconds ?? 3600;
  const path = noticeStatePath(stateDir);
  let sentAt = 0;
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
      sentAt = typeof parsed.sentAt === "number" ? parsed.sentAt : 0;
    } catch { sentAt = 0; }
  }
  return sentAt > now || now - sentAt >= interval;
}

export function markUsageNoticeSent(stateDir: string, now: number): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const path = noticeStatePath(stateDir);
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, JSON.stringify({ sentAt: now }));
    renameSync(temp, path);
  } catch { /* the notice mark is an optimization; a write failure just re-sends next time */ }
}
