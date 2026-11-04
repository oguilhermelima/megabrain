import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";
import { failed, ok, type Result } from "../core/result.js";

type TrustEnvironment = Readonly<Record<string, string | undefined>>;
export type TrustPreflightHooks = Readonly<{ beforeConfigCommit?: (configPath: string) => Promise<void> }>;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const CONFIG_WRITE_ATTEMPTS = 3;

/** Pre-seed only the exact workspace keys Claude Code and Codex use for their trust prompt. */
export async function preflightWorktreeTrust(agent: string, worktreePath: string, environment: TrustEnvironment, hooks: TrustPreflightHooks = {}): Promise<Result<void>> {
  if (agent !== "codex") return ok(undefined);
  try {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(worktreePath);
    } catch (cause) {
      // Test doubles and invalid spawn targets may name no directory. There is no canonical
      // workspace to grant; the normal launch path reports the missing directory itself.
      if (isMissing(cause)) return ok(undefined);
      throw cause;
    }
    const canonical = normalize(canonicalPath).normalize("NFC");
    const home = environment.HOME;
    if (home === undefined || home === "") return failed(`cannot preflight ${agent} worktree trust without HOME`);
    if (agent === "codex") {
      const config = join(environment.CODEX_HOME ?? join(home, ".codex"), "config.toml");
      await updateConfig(config, (raw) => upsertCodexTrust(raw, canonical), hooks);
    } else {
      const config = await claudeConfigPath(home, environment);
      await updateConfig(config, (raw) => upsertClaudeTrust(raw, canonical));
    }
    return ok(undefined);
  } catch (cause) {
    return failed(`could not preflight ${agent} worktree trust: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function claudeConfigPath(home: string, environment: TrustEnvironment): Promise<string> {
  const configDirectory = environment.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const legacy = join(configDirectory, ".config.json");
  try {
    await stat(legacy);
    return legacy;
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
  }
  const suffix = environment.CLAUDE_CODE_CUSTOM_OAUTH_URL === undefined ? "" : "-custom-oauth";
  return join(environment.CLAUDE_CONFIG_DIR ?? home, `.claude${suffix}.json`);
}

function isMissing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && (cause.code === "ENOENT" || cause.code === "ENOTDIR");
}

async function updateConfig(path: string, change: (raw: string) => string, hooks: TrustPreflightHooks = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const target = await existingTarget(path);
  await withFileLock(target, async () => {
    for (let attempt = 0; attempt < CONFIG_WRITE_ATTEMPTS; attempt += 1) {
      const before = await readConfigSnapshot(target);
      const next = change(before.raw);
      if (next === before.raw) return;
      const written = await atomicWrite(target, next, before.mode, async () => {
        await hooks.beforeConfigCommit?.(target);
        return sameSnapshot(before, await readConfigSnapshot(target));
      });
      if (written) return;
    }
    throw new Error(`trust config changed repeatedly while being updated: ${basename(target)}`);
  });
}

type ConfigSnapshot = Readonly<{ raw: string; mode: number; size: number; mtimeMs: number; exists: boolean }>;

async function readConfigSnapshot(path: string): Promise<ConfigSnapshot> {
  try {
    const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { raw, mode: info.mode & 0o777, size: info.size, mtimeMs: info.mtimeMs, exists: true };
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
    return { raw: "", mode: 0o600, size: 0, mtimeMs: 0, exists: false };
  }
}

function sameSnapshot(left: ConfigSnapshot, right: ConfigSnapshot): boolean {
  return left.exists === right.exists && left.raw === right.raw && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function existingTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (cause) {
    if (isMissing(cause)) return path;
    throw cause;
  }
}

async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lockDirectory = `${path}.megabrain-lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      break;
    } catch (cause) {
      if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")) throw cause;
      try {
        if (Date.now() - (await stat(lockDirectory)).mtimeMs > LOCK_STALE_MS) {
          await rm(lockDirectory, { recursive: true, force: true });
          continue;
        }
      } catch (statCause) {
        if (isMissing(statCause)) continue;
        throw statCause;
      }
      if (Date.now() >= deadline) throw new Error(`trust config is locked: ${basename(path)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await run();
  } finally {
    await rm(lockDirectory, { recursive: true, force: true });
  }
}

async function atomicWrite(path: string, content: string, mode: number, stillCurrent: () => Promise<boolean>): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(mode);
  } catch (cause) {
    await handle.close();
    await rm(temporary, { force: true });
    throw cause;
  }
  await handle.close();
  if (!await stillCurrent()) {
    await rm(temporary, { force: true });
    return false;
  }
  try {
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function upsertClaudeTrust(raw: string, worktree: string): string {
  let parsed: unknown;
  try {
    parsed = raw === "" ? {} : JSON.parse(raw);
  } catch {
    throw new Error("Claude global config is not valid JSON");
  }
  if (!isPlainObject(parsed)) throw new Error("Claude global config must be a JSON object");
  if (parsed.projects !== undefined && !isPlainObject(parsed.projects)) throw new Error("Claude projects config must be a JSON object");
  const projects = { ...parsed.projects } as Record<string, unknown>;
  const current = projects[worktree];
  if (current !== undefined && !isPlainObject(current)) throw new Error("Claude worktree config must be a JSON object");
  if (isPlainObject(current) && current.hasTrustDialogAccepted === true) return raw;
  projects[worktree] = { ...(isPlainObject(current) ? current : {}), hasTrustDialogAccepted: true };
  return `${JSON.stringify({ ...parsed, projects }, null, 2)}\n`;
}

function upsertCodexTrust(raw: string, worktree: string): string {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw === "" ? [] : raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const matches: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = parseProjectHeader(lines[index] ?? "");
    if (header === worktree) matches.push(index);
  }
  if (matches.length > 1) throw new Error("Codex config has duplicate project trust tables");
  if (matches.length === 0) {
    const separator = lines.length === 0 ? "" : lines.at(-1)?.endsWith("\n") ? eol : `${eol}${eol}`;
    return `${raw}${separator}[projects."${escapeTomlString(worktree)}"]${eol}trust_level = "trusted"${eol}`;
  }
  const headerIndex = matches[0]!;
  let end = headerIndex + 1;
  while (end < lines.length && !/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?(?:\r?\n)?$/.test(lines[end] ?? "")) end += 1;
  const trustLines: number[] = [];
  for (let index = headerIndex + 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*trust_level\s*=/.test(line)) trustLines.push(index);
  }
  if (trustLines.length > 1) throw new Error("Codex project has duplicate trust_level keys");
  if (trustLines.length === 0) {
    lines.splice(headerIndex + 1, 0, `trust_level = "trusted"${eol}`);
    return lines.join("");
  }
  const trustIndex = trustLines[0]!;
  const line = lines[trustIndex] ?? "";
  const match = /^(\s*trust_level\s*=\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(\s*(?:#.*)?(?:\r?\n)?)$/.exec(line);
  if (match === null) throw new Error("Codex project trust_level value is not a supported scalar");
  if (/^\s*trust_level\s*=\s*"trusted"(?:\s*(?:#.*)?)?(?:\r?\n)?$/.test(line)) return raw;
  lines[trustIndex] = `${match[1]}"trusted"${match[2]}`;
  return lines.join("");
}

function parseProjectHeader(line: string): string | null {
  const match = /^\s*\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]\s*(?:#.*)?(?:\r?\n)?$/.exec(line);
  if (match === null) return null;
  const quoted = match[1];
  if (quoted === undefined) return match[2] ?? null;
  return quoted.replace(/\\(["\\])/g, "$1");
}

function escapeTomlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
