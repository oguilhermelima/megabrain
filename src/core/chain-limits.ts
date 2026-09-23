import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProcessAdapter, ProcessOutput } from "../adapters/proc.js";
import type { Result } from "./result.js";
import type { ChainConfig } from "./chain.js";

// Ports lib/module-chain.sh's megabrain_chain_limit_read and everything it reaches
// (codex rollout scan, claude/agy live usage, the on-disk cache, and the usage
// notice) for `chain run`'s step-gating. The shell versions stay in place: they
// are still reached from hooks/megabrain-turn-end.sh (megabrain_chain_continue_refused),
// so this is a second, TypeScript-side implementation of the same contract, not a
// replacement of the shell one.

export type LimitWindowName = "5h" | "weekly";
export type LimitAgent = "codex" | "claude" | "agy";

export type LimitEntry = Readonly<{
  readonly name: string;
  readonly bucket: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly resetsAt: string;
  readonly windowMinutes?: number;
}>;

export type LimitResult = Readonly<{
  readonly provider: string;
  readonly fetchedAt: number;
  readonly reading?: Readonly<{ readonly kind: string; readonly basis: string; readonly fetchedAt: number }>;
  readonly windows: readonly LimitEntry[];
}>;

export type LimitReading =
  | Readonly<{ readonly status: "current"; readonly usedPercent: number; readonly resetsAt: string; readonly reason: string; readonly source: "disk" | "cache" | "live"; readonly result: LimitResult; readonly fetchedAt: number }>
  | Readonly<{ readonly status: "unknown"; readonly reason: string }>;

export type ChainLimitEnvironment = Readonly<Record<string, string | undefined>>;

type JsonRecord = Record<string, unknown>;

export function percentText(value: number): string {
  return value.toFixed(1);
}

function unknownReading(agent: LimitAgent, window: LimitWindowName, reason: string): LimitReading {
  return { status: "unknown", reason: `${agent} ${window} window unknown (${reason})` };
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
  return { status: "current", usedPercent: value.used_percent, resetsAt: String(resetsAt), reason: `codex ${actualWindow} window at ${percentText(value.used_percent)} percent`, source: "disk", result, fetchedAt };
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

function applyLimitResult(result: LimitResult, agent: LimitAgent, window: LimitWindowName, source: "cache" | "live"): LimitReading {
  const entry = result.windows.find((candidate) => candidate.name === window);
  if (entry === undefined || typeof entry.usedPercent !== "number" || typeof entry.remainingPercent !== "number" || typeof entry.resetsAt !== "string" || entry.resetsAt.length === 0) {
    return unknownReading(agent, window, "provider response has no usable window");
  }
  return { status: "current", usedPercent: entry.usedPercent, resetsAt: entry.resetsAt, reason: `${agent} ${window} window at ${percentText(entry.usedPercent)} percent`, source, result, fetchedAt: result.fetchedAt };
}

function limitTimeout(config: ChainConfig, environment: ChainLimitEnvironment): number {
  const override = environment.MEGABRAIN_CHAIN_LIMIT_TIMEOUT_SECONDS;
  if (override !== undefined && override.length > 0) return Number(override);
  return config.usageLimits?.timeoutSeconds ?? 5;
}

function limitTtl(config: ChainConfig, environment: ChainLimitEnvironment): number {
  const override = environment.MEGABRAIN_CHAIN_LIMIT_TTL_SECONDS;
  if (override !== undefined && override.length > 0) return Number(override);
  return config.usageLimits?.cacheTtlSeconds ?? 30;
}

function cachePath(stateDir: string, agent: LimitAgent): string {
  return resolve(stateDir, `usage-limits-${agent}.json`);
}

function readCache(agent: "claude" | "agy", window: LimitWindowName, config: ChainConfig, environment: ChainLimitEnvironment, stateDir: string, now: number): LimitReading | undefined {
  const path = cachePath(stateDir, agent);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
  if (!isObject(parsed) || parsed.provider !== agent || typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.windows)) return undefined;
  const ttl = limitTtl(config, environment);
  if (!(parsed.fetchedAt <= now && now - parsed.fetchedAt < ttl)) return undefined;
  const reading = applyLimitResult(parsed as unknown as LimitResult, agent, window, "cache");
  return reading.status === "current" ? reading : undefined;
}

function writeCache(agent: LimitAgent, result: LimitResult, stateDir: string): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const path = cachePath(stateDir, agent);
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, JSON.stringify(result));
    renameSync(temp, path);
  } catch { /* the cache is an optimization; a write failure just costs a re-fetch */ }
}

type CurlOutcome =
  | { readonly kind: "ok"; readonly body: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "network-failed" }
  | { readonly kind: "http-error"; readonly status: number };

function parseCurlResult(result: Result<ProcessOutput>): CurlOutcome {
  if (result.kind !== "ok") {
    return result.exitCode === 28 ? { kind: "timeout" } : { kind: "network-failed" };
  }
  const marker = "MEGABRAIN_HTTP_STATUS:";
  const stdout = result.value.stdout;
  const index = stdout.lastIndexOf(marker);
  if (index === -1) return { kind: "network-failed" };
  const status = Number(stdout.slice(index + marker.length).trim());
  let body = stdout.slice(0, index);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  if (!Number.isFinite(status) || status === 0) return { kind: "network-failed" };
  if (status < 200 || status >= 300) return { kind: "http-error", status };
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

async function fetchClaudeUsage(window: LimitWindowName, processAdapter: ProcessAdapter, timeoutSeconds: number, environment: ChainLimitEnvironment): Promise<LimitReading> {
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
  const result = await processAdapter.run("curl", ["-sS", "--connect-timeout", timeout, "--max-time", timeout, "-H", `Authorization: Bearer ${credentials.token}`, "-H", "anthropic-beta: oauth-2025-04-20", "-H", "anthropic-version: 2023-06-01", "-w", "\nMEGABRAIN_HTTP_STATUS:%{http_code}", url]);
  const parsed = parseCurlResult(result);
  if (parsed.kind === "timeout") return unknownReading("claude", window, "request timed out");
  if (parsed.kind === "network-failed") return unknownReading("claude", window, "network request failed");
  if (parsed.kind === "http-error") return unknownReading("claude", window, `provider returned HTTP ${parsed.status}`);
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

async function agyCredentials(processAdapter: ProcessAdapter): Promise<{ kind: "ok"; token: string } | { kind: "missing" } | { kind: "unsupported" } | { kind: "no-token" }> {
  const result = await processAdapter.run("security", ["find-generic-password", "-s", "gemini", "-w"]);
  if (result.kind !== "ok") return { kind: "missing" };
  const raw = result.value.stdout.trim();
  const prefix = "go-keyring-base64:";
  if (!raw.startsWith(prefix)) return { kind: "unsupported" };
  let decoded: string;
  try { decoded = Buffer.from(raw.slice(prefix.length), "base64").toString("utf8"); } catch { return { kind: "unsupported" }; }
  try {
    const parsed = JSON.parse(decoded) as JsonRecord;
    const token = typeof parsed.token === "string" ? parsed.token : "";
    return token === "" ? { kind: "no-token" } : { kind: "ok", token };
  } catch { return { kind: "no-token" }; }
}

function resetAtFor(value: JsonRecord): string | undefined {
  const candidates: readonly unknown[] = [value.reset_at, value.resets_at, value.reset_time, value.resetTime];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (isObject(candidate) && typeof candidate.seconds === "number") return new Date(candidate.seconds * 1000).toISOString();
  }
  return undefined;
}

function clampPercent(value: number): number {
  return value < 0 ? 0 : value > 100 ? 100 : value;
}

function quotaEntries(map: JsonRecord, bucket: string): LimitEntry[] {
  const entries: LimitEntry[] = [];
  for (const [key, raw] of Object.entries(map)) {
    if (!isObject(raw) || typeof raw.remaining_fraction !== "number") continue;
    const resetsAt = resetAtFor(raw);
    if (resetsAt === undefined || resetsAt === "") continue;
    const name = key.endsWith("-5h") ? "5h" : key.endsWith("-weekly") ? "weekly" : undefined;
    if (name === undefined) continue;
    const fraction = raw.remaining_fraction;
    entries.push({ name, bucket, usedPercent: clampPercent(100 - fraction * 100), remainingPercent: clampPercent(fraction * 100), resetsAt });
  }
  return entries;
}

function agyWindowsFrom(body: JsonRecord): LimitEntry[] {
  const legacy = isObject(body.quota) ? quotaEntries(body.quota, "default") : [];
  const groups = Array.isArray(body.buckets)
    ? (body.buckets as unknown[]).filter(isObject).flatMap((group) => {
      const bucketName = (typeof group.displayName === "string" && group.displayName) || (typeof group.name === "string" && group.name) || "unknown";
      const quota = isObject(group.quota) ? group.quota : group;
      return quotaEntries(quota, bucketName);
    })
    : [];
  return [...legacy, ...groups];
}

async function fetchAgyUsage(window: LimitWindowName, processAdapter: ProcessAdapter, timeoutSeconds: number, environment: ChainLimitEnvironment): Promise<LimitReading> {
  const credentials = await agyCredentials(processAdapter);
  if (credentials.kind === "missing") return unknownReading("agy", window, "Keychain item is missing");
  if (credentials.kind === "unsupported") return unknownReading("agy", window, "Keychain credential wrapper is unsupported");
  if (credentials.kind === "no-token") return unknownReading("agy", window, "Keychain credential has no token");
  const url = environment.MEGABRAIN_CHAIN_AGY_USAGE_URL ?? "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
  const timeout = String(timeoutSeconds);
  const result = await processAdapter.run("curl", ["-sS", "--connect-timeout", timeout, "--max-time", timeout, "-X", "POST", "-H", `Authorization: Bearer ${credentials.token}`, "-H", "Content-Type: application/json", "-d", "{}", "-w", "\nMEGABRAIN_HTTP_STATUS:%{http_code}", url]);
  const parsed = parseCurlResult(result);
  if (parsed.kind === "timeout") return unknownReading("agy", window, "request timed out");
  if (parsed.kind === "network-failed") return unknownReading("agy", window, "network request failed");
  if (parsed.kind === "http-error") return unknownReading("agy", window, `provider returned HTTP ${parsed.status}`);
  let body: JsonRecord;
  try { body = JSON.parse(parsed.body) as JsonRecord; } catch { return unknownReading("agy", window, "response body is unparseable or incomplete"); }
  const windows = agyWindowsFrom(body);
  if (windows.length === 0) return unknownReading("agy", window, "response body is unparseable or incomplete");
  const result2: LimitResult = { provider: "agy", fetchedAt: Math.floor(Date.now() / 1000), windows };
  return applyLimitResult(result2, "agy", window, "live");
}

// Ports megabrain_chain_limit_read: codex reads the local rollout scan; claude/agy
// only make a live request when the agent is in usageLimits.liveProviders, and are
// otherwise reported unknown without touching the network, matching the shell's
// opt-in gate exactly.
export async function readLimit(agent: LimitAgent, window: LimitWindowName, config: ChainConfig, environment: ChainLimitEnvironment, processAdapter: ProcessAdapter, stateDir: string): Promise<LimitReading> {
  const now = Math.floor(Date.now() / 1000);
  if (agent === "codex") {
    const sessionsDir = environment.MEGABRAIN_CODEX_SESSIONS_DIR ?? resolve(environment.HOME ?? "", ".codex/sessions");
    return resolveCodexLimit(sessionsDir, window, now);
  }
  const liveProviders = config.usageLimits?.liveProviders ?? [];
  if (!liveProviders.includes(agent)) return unknownReading(agent, window, "live provider is not enabled");
  const cached = readCache(agent, window, config, environment, stateDir, now);
  if (cached !== undefined) return cached;
  const timeoutSeconds = limitTimeout(config, environment);
  const reading = agent === "claude"
    ? await fetchClaudeUsage(window, processAdapter, timeoutSeconds, environment)
    : await fetchAgyUsage(window, processAdapter, timeoutSeconds, environment);
  if (reading.status === "current") writeCache(agent, reading.result, stateDir);
  return reading;
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
  for (const agent of ["codex", "claude", "agy"] as const) {
    const reading = await readLimit(agent, "5h", config, environment, processAdapter, stateDir);
    const summary = reading.status === "current"
      ? reading.result.windows.map((entry) => `${entry.bucket} ${entry.name} ${entry.usedPercent}% used, resets ${entry.resetsAt}`).join("; ")
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
