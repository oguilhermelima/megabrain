import { randomUUID, createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveStateDirectory } from "./state.js";
import { resolvePackageRoot } from "./package-root.js";
import { discoverAgentDirectories } from "./agent-directories.js";

export type Environment = Readonly<Record<string, string | undefined>>;

export type SkillSyncScan = {
  readonly targetCount: number;
  readonly driftCount: number;
  readonly failureCount: number;
  readonly repairedCount: number;
  readonly error?: string;
  readonly diagnostics: readonly string[];
};

export type SkillSyncDoctorReport = {
  readonly status: string;
  readonly reason: string;
  readonly diagnostics: readonly string[];
};

type FileMetadata = { readonly mtime: number; readonly size: number };

type TargetOutcome =
  | { readonly kind: "current" }
  | { readonly kind: "drift" }
  | { readonly kind: "repaired" }
  | { readonly kind: "unwritable"; readonly error: string }
  | { readonly kind: "error"; readonly error: string };

function tempPath(path: string): string {
  return `${path}.${randomUUID()}.tmp`;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileMetadata(path: string): FileMetadata {
  const info = statSync(path);
  return { mtime: Math.floor(info.mtimeMs / 1000), size: info.size };
}

function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// WHY: matches the shell stamp key exactly (percent-escape "%" before escaping "/") so a
// binary and a still-shell install path reading each other's stamps would agree on the name.
function stampPath(stateDir: string, target: string): string {
  const key = target.replaceAll("%", "%25").replaceAll("/", "%2F");
  return join(stateDir, "skill-sync", `path-${key}.stamp`);
}

function readStamp(stateDir: string, target: string):
  | { readonly sourceMtime: string; readonly sourceSize: string; readonly targetMtime: string; readonly targetSize: string }
  | undefined {
  let content: string;
  try {
    content = readFileSync(stampPath(stateDir, target), "utf8");
  } catch {
    return undefined;
  }
  const [, , sourceMtime, sourceSize, targetMtime, targetSize] = content.split("\n");
  if (sourceMtime === undefined || sourceSize === undefined || targetMtime === undefined || targetSize === undefined) return undefined;
  return { sourceMtime, sourceSize, targetMtime, targetSize };
}

function writeStamp(stateDir: string, target: string, sourceHash: string, targetHash: string, source: FileMetadata, targetMeta: FileMetadata): void {
  const stamp = stampPath(stateDir, target);
  mkdirSync(dirname(stamp), { recursive: true });
  const temporary = tempPath(stamp);
  try {
    writeFileSync(temporary, `${sourceHash}\n${targetHash}\n${source.mtime}\n${source.size}\n${targetMeta.mtime}\n${targetMeta.size}\n`);
    renameSync(temporary, stamp);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
}

function skillSource(environment: Environment): string {
  const root = resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT);
  return join(root, "skills/megabrain/SKILL.md");
}

export function skillTargetPaths(environment: Environment): string[] {
  const home = environment.HOME ?? "";
  const targets = new Set<string>();
  const directories = discoverAgentDirectories(environment);
  for (const agent of Object.values(directories)) {
    if (agent === undefined) continue;
    for (const target of [agent.globalSkill, resolve(agent.projectSkill)]) {
      if (existsSync(target)) targets.add(target);
    }
  }
  for (const agent of [".claude", ".codex"]) {
    const cache = `${home}/${agent}/plugins/cache/megabrain-local/megabrain`;
    try {
      for (const entry of readdirSync(cache, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const target = `${cache}/${entry.name}/skills/megabrain/SKILL.md`;
        if (existsSync(target)) targets.add(target);
      }
    } catch {
      // An absent agent cache has no registered copies.
    }
  }
  return [...targets];
}

function reconcileTarget(
  stateDir: string,
  source: string,
  sourceMeta: FileMetadata,
  target: string,
  targetMeta: FileMetadata,
  repair: boolean,
  sourceHashCache: { value?: string },
  diagnostics: string[],
): TargetOutcome {
  const stamp = readStamp(stateDir, target);
  if (
    stamp !== undefined &&
    stamp.sourceMtime === String(sourceMeta.mtime) &&
    stamp.sourceSize === String(sourceMeta.size) &&
    stamp.targetMtime === String(targetMeta.mtime) &&
    stamp.targetSize === String(targetMeta.size)
  ) {
    return { kind: "current" };
  }

  if (sourceHashCache.value === undefined) {
    try {
      sourceHashCache.value = hashFile(source);
    } catch {
      const message = `could not hash installed skill source: ${source}`;
      diagnostics.push(`megabrain: ${message}`);
      return { kind: "error", error: message };
    }
  }
  const sourceHash = sourceHashCache.value;

  let targetHash: string;
  try {
    targetHash = hashFile(target);
  } catch {
    const message = `could not hash skill target: ${target}`;
    diagnostics.push(`megabrain: ${message}`);
    return { kind: "error", error: message };
  }

  if (targetHash === sourceHash) {
    try {
      writeStamp(stateDir, target, sourceHash, targetHash, sourceMeta, targetMeta);
    } catch {
      const message = `could not write skill sync stamp for: ${target}`;
      diagnostics.push(`megabrain: ${message}`);
      return { kind: "error", error: message };
    }
    return { kind: "current" };
  }

  if (!repair) return { kind: "drift" };

  if (!isWritable(target) || !isWritable(dirname(target))) {
    const message = `skill target is not writable: ${target}`;
    diagnostics.push(`megabrain: ${message}`);
    return { kind: "unwritable", error: message };
  }

  const temporary = tempPath(target);
  try {
    copyFileSync(source, temporary);
    const sourceStat = statSync(source);
    chmodSync(temporary, sourceStat.mode);
    utimesSync(temporary, sourceStat.atime, sourceStat.mtime);
  } catch {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    const message = `could not write repaired skill target: ${target}`;
    diagnostics.push(`megabrain: ${message}`);
    return { kind: "error", error: message };
  }
  try {
    renameSync(temporary, target);
  } catch {
    try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
    const message = `could not replace repaired skill target: ${target}`;
    diagnostics.push(`megabrain: ${message}`);
    return { kind: "error", error: message };
  }

  let newTargetMeta: FileMetadata;
  try {
    newTargetMeta = fileMetadata(target);
  } catch {
    const message = `could not write skill sync stamp for: ${target}`;
    diagnostics.push(`megabrain: ${message}`);
    return { kind: "error", error: message };
  }
  try {
    writeStamp(stateDir, target, sourceHash, sourceHash, sourceMeta, newTargetMeta);
  } catch {
    const message = `could not write skill sync stamp for: ${target}`;
    diagnostics.push(`megabrain: ${message}`);
    return { kind: "error", error: message };
  }
  return { kind: "repaired" };
}

// WHY: repair=false mirrors the shell doctor scan (reports drift, still caches a matching
// hash as a stamp); repair=true mirrors the runtime and install reconcile, which overwrite
// a drifted target. Both paths share this scan so their target discovery never diverges.
export function scanSkillSync(environment: Environment, repair: boolean): SkillSyncScan {
  const diagnostics: string[] = [];
  const source = skillSource(environment);
  const stateDir = resolveStateDirectory(environment);

  if (!existsSync(source)) {
    const message = `installed skill source is missing: ${source}`;
    diagnostics.push(`megabrain: ${message}`);
    return { targetCount: 0, driftCount: 0, failureCount: 1, repairedCount: 0, error: message, diagnostics };
  }

  const targets = skillTargetPaths(environment);

  let sourceMeta: FileMetadata;
  try {
    sourceMeta = fileMetadata(source);
  } catch {
    const message = `could not read installed skill source metadata: ${source}`;
    diagnostics.push(`megabrain: ${message}`);
    return { targetCount: 0, driftCount: 0, failureCount: 1, repairedCount: 0, error: message, diagnostics };
  }

  let driftCount = 0;
  let failureCount = 0;
  let repairedCount = 0;
  let lastError: string | undefined;
  const sourceHashCache: { value?: string } = {};

  for (const target of targets) {
    let targetMeta: FileMetadata;
    try {
      targetMeta = fileMetadata(target);
    } catch {
      failureCount += 1;
      lastError = `could not read skill target metadata: ${target}`;
      diagnostics.push(`megabrain: ${lastError}`);
      continue;
    }
    const outcome = reconcileTarget(stateDir, source, sourceMeta, target, targetMeta, repair, sourceHashCache, diagnostics);
    if (outcome.kind === "drift") driftCount += 1;
    else if (outcome.kind === "repaired") repairedCount += 1;
    else if (outcome.kind === "unwritable" || outcome.kind === "error") {
      failureCount += 1;
      lastError = outcome.error;
    }
  }

  return { targetCount: targets.length, driftCount, failureCount, repairedCount, error: lastError, diagnostics };
}

export function reconcileSkills(environment: Environment): SkillSyncScan {
  return scanSkillSync(environment, true);
}

// WHY: this is the function a later install lane calls for the skill-sync module; the
// shell module_skill_sync_install body is exactly this call, kept only for the shell
// install command until that lane lands.
export function installSkillSync(environment: Environment): SkillSyncScan {
  return reconcileSkills(environment);
}

export function skillSyncDoctor(environment: Environment): SkillSyncDoctorReport {
  const scan = scanSkillSync(environment, false);
  if (scan.driftCount > 0) {
    return { status: "misconfigured", reason: `skill drift detected in ${scan.driftCount} target(s)`, diagnostics: scan.diagnostics };
  }
  if (scan.failureCount > 0) {
    return { status: "misconfigured", reason: `skill synchronization failed: ${scan.error ?? "target unavailable"}`, diagnostics: scan.diagnostics };
  }
  if (scan.targetCount === 0) {
    return { status: "ok", reason: "no registered skill copies found", diagnostics: scan.diagnostics };
  }
  return { status: "ok", reason: `skill copies current: ${scan.targetCount}`, diagnostics: scan.diagnostics };
}

// WHY: mirrors the bash entry script's exclusions exactly (literal "--help" anywhere,
// "doctor" as the first argument) so moving the check to the binary changes nothing a
// user can observe.
export function shouldReconcileSkillsAtStartup(args: readonly string[]): boolean {
  if (args.includes("--help")) return false;
  if (args[0] === "doctor") return false;
  // The turn-end hook runs on every agent turn, for every agent, forever — it is the one
  // hot-path command in this binary. The shell hook it replaces never ran skill reconcile.
  if (args[0] === "hook") return false;
  return true;
}

// WHY: skill cache repair is best-effort runtime hygiene; its stderr diagnostics are useful,
// but an unwritable plugin cache must not fail an unrelated command. The scan already
// contains its own defenses per step; this outer catch is a last-resort net so a defect in
// the scan itself can never surface as a command failure either.
export async function reconcileSkillsAtStartup(environment: Environment): Promise<string | undefined> {
  try {
    const scan = reconcileSkills(environment);
    return scan.diagnostics.length > 0 ? `${scan.diagnostics.join("\n")}\n` : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `megabrain: skill reconcile failed: ${message}\n`;
  }
}
