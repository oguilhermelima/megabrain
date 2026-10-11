import { access, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { parseGitWorktrees } from "../../core/worktree-list.js";
import { openDispatchStates, dispatchStates } from "../../core/dispatch-states.js";
import { parseWorktreePruneArgs } from "../../core/worktree-prune.js";
import { openDatabase, withWrite } from "../../db/db.js";
import { finishWorktree, listWorktrees, type WorktreeRecord } from "../../db/queries/worktrees.js";
import { usageText } from "../../core/usage.js";
import { executeWorktreeFinish } from "./worktree-write.js";
import { repoFromOrca } from "./repository-selector.js";

type Environment = Readonly<Record<string, string | undefined>>;
type Candidate = {
  path: string; repo: string; branch: string; createdAt: string | null; ageDays: number | null;
  sizeBytes: number | null; purpose: string | null; origin: string; createdByMegabrain: boolean;
  eligible: boolean; reason: string;
};

async function run(process: ProcessAdapter, command: string, args: readonly string[]): Promise<Result<string>> {
  const result = await process.run(command, args);
  return result.kind === "ok" ? ok(result.value.stdout) : failed(result.error, result.exitCode);
}

async function sharedRoot(environment: Environment): Promise<Result<string>> {
  const state = environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? "", ".megabrain");
  let raw: string;
  try { raw = (await (await import("node:fs/promises")).readFile(join(state, "worktree-root"), "utf8")).trim(); }
  catch { return failed(`shared worktree root is unset: ${join(state, "worktree-root")}`); }
  if (raw === "") return failed(`shared worktree root is unset: ${join(state, "worktree-root")}`);
  const expanded = raw.startsWith("~") ? join(environment.HOME ?? process.cwd(), raw.slice(1)) : raw;
  return ok(await realpath(resolve(expanded)).catch(() => resolve(expanded)));
}

async function repoRootFor(process: ProcessAdapter, path: string): Promise<string | undefined> {
  const common = await run(process, "git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.kind !== "ok") return undefined;
  const commonPath = await realpath(common.value.trim()).catch(() => common.value.trim());
  const candidate = commonPath.endsWith("/.git") ? dirname(commonPath) : path;
  const top = await run(process, "git", ["-C", candidate, "rev-parse", "--path-format=absolute", "--show-toplevel"]);
  return top.kind === "ok" ? await realpath(top.value.trim()).catch(() => top.value.trim()) : undefined;
}

async function discoverCandidates(process: ProcessAdapter, environment: Environment, selector?: string): Promise<Result<Array<{ path: string; repo: string; branch: string }>>> {
  if (selector !== undefined) {
    const selected = await repoFromOrca(process, selector, environment);
    if (selected.kind !== "ok") return selected;
    const repo = await realpath(selected.value).catch(() => selected.value);
    const output = await run(process, "git", ["-C", repo, "worktree", "list", "--porcelain"]);
    if (output.kind !== "ok") return output;
    return ok(parseGitWorktrees(output.value, repo).filter((item) => item.path !== repo).map((item) => ({ path: item.path, repo, branch: item.branch })));
  }
  const root = await sharedRoot(environment);
  if (root.kind !== "ok") return root;
  let entries;
  try { entries = await readdir(root.value, { withFileTypes: true }); }
  catch (cause: unknown) { return failed(`could not read shared worktree root: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const found: Array<{ path: string; repo: string; branch: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = await realpath(join(root.value, entry.name)).catch(() => undefined);
    if (path === undefined) continue;
    try { await access(join(path, ".git")); } catch { continue; }
    const repo = await repoRootFor(process, path);
    if (repo === undefined) continue;
    const branch = await run(process, "git", ["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    found.push({ path, repo, branch: branch.kind === "ok" ? branch.value.trim() : "detached" });
  }
  return ok(found.sort((left, right) => left.path.localeCompare(right.path)));
}

async function directorySize(process: ProcessAdapter, path: string): Promise<number | null> {
  const result = await run(process, "du", ["-sk", path]);
  if (result.kind !== "ok") return null;
  const kilobytes = Number(result.value.trim().split(/\s+/, 1)[0]);
  return Number.isSafeInteger(kilobytes) && kilobytes >= 0 ? kilobytes * 1024 : null;
}

async function assess(process: ProcessAdapter, candidate: { path: string; repo: string; branch: string }, record: WorktreeRecord | undefined, openByPath: ReadonlyMap<string, string[]>, olderThan: number, now: number): Promise<Candidate> {
  const createdAt = record?.createdAt ?? null;
  const parsedTime = createdAt === null ? NaN : Date.parse(createdAt);
  const ageDays = Number.isFinite(parsedTime) ? Math.max(0, Math.floor((now - parsedTime) / 86_400_000)) : null;
  const sizeBytes = await directorySize(process, candidate.path);
  const reasons: string[] = [];
  if (record === undefined || record.origin === "discovered") reasons.push("registry creation time is unknown");
  else if (record.finishedAt !== null) reasons.push("registry marks this worktree finished");
  if (ageDays === null) reasons.push("creation time is missing or invalid");
  else if (ageDays < olderThan) reasons.push(`younger than ${olderThan} days`);
  if (candidate.branch === "detached") reasons.push("branch is detached or unknown");

  const status = await run(process, "git", ["-C", candidate.path, "status", "--porcelain", "--untracked-files=all"]);
  if (status.kind !== "ok") reasons.push("working tree status is unknown");
  else if (status.value.trim() !== "") reasons.push("working tree has uncommitted changes");

  const dispatchStatesForPath = openByPath.get(candidate.path) ?? [];
  const unknownDispatch = dispatchStatesForPath.find((state) => !dispatchStates.includes(state as typeof dispatchStates[number]));
  if (unknownDispatch !== undefined) reasons.push(`dispatch state is unknown: ${unknownDispatch}`);
  else if (dispatchStatesForPath.some((state) => openDispatchStates.includes(state as typeof openDispatchStates[number]))) reasons.push("an open dispatch uses this worktree");

  const upstream = candidate.branch === "detached" ? failed("detached") : await run(process, "git", ["-C", candidate.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", `${candidate.branch}@{upstream}`]);
  if (upstream.kind !== "ok" || upstream.value.trim() === "") reasons.push("upstream status is unknown");
  else {
    const ahead = await run(process, "git", ["-C", candidate.path, "rev-list", "--count", `${upstream.value.trim()}..${candidate.branch}`]);
    if (ahead.kind !== "ok" || !/^\d+$/.test(ahead.value.trim())) reasons.push("unpushed commit count is unknown");
    else if (Number(ahead.value.trim()) > 0) reasons.push("branch has unpushed commits");
  }

  let base: string | undefined;
  const parent = await run(process, "git", ["-C", candidate.repo, "config", "--get", `branch.${candidate.branch}.megabrain-parent`]);
  if (parent.kind === "ok" && parent.value.trim() !== "") base = parent.value.trim();
  if (base === undefined) {
    const remoteDefault = await run(process, "git", ["-C", candidate.repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (remoteDefault.kind === "ok" && remoteDefault.value.trim() !== "") base = remoteDefault.value.trim().replace(/^origin\//, "");
  }
  if (base === undefined) {
    const configured = await run(process, "git", ["-C", candidate.repo, "config", "--get", "init.defaultBranch"]);
    if (configured.kind === "ok" && configured.value.trim() !== "") base = configured.value.trim();
  }
  if (base === undefined || (await run(process, "git", ["-C", candidate.repo, "rev-parse", "--verify", `${base}^{commit}`])).kind !== "ok") reasons.push("base branch is unknown");
  else {
    const merged = await run(process, "git", ["-C", candidate.repo, "branch", "--merged", base]);
    if (merged.kind !== "ok") reasons.push("merge status is unknown");
    else if (!merged.value.split("\n").some((line) => line.trim().replace(/^[*+]\s*/, "").trim() === candidate.branch)) reasons.push(`branch is not merged into ${base}`);
  }

  return {
    ...candidate, createdAt, ageDays, sizeBytes, purpose: record?.purpose ?? null,
    origin: record?.origin ?? "discovered", createdByMegabrain: record?.origin === "created",
    eligible: reasons.length === 0, reason: reasons.length === 0 ? "eligible" : reasons.join("; "),
  };
}

export async function executeWorktreePrune(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const parsed = parseWorktreePruneArgs(args);
  if (parsed.kind !== "ok") return parsed;
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("worktree-prune"));
  const database = openDatabase(environment);
  if (database.kind !== "ok") return database;
  const records = new Map<string, WorktreeRecord>();
  const dispatches = new Map<string, string[]>();
  try {
    for (const record of listWorktrees(database.value.db)) records.set(record.path, record);
    const rows = database.value.db.query<{ worktree_path: string | null; state: string }>("SELECT worktree_path, state FROM dispatches WHERE worktree_path IS NOT NULL AND archived_at IS NULL").all();
    for (const row of rows) if (row.worktree_path !== null) dispatches.set(row.worktree_path, [...(dispatches.get(row.worktree_path) ?? []), row.state]);
  } catch (cause: unknown) {
    database.value.close();
    return failed(`could not read worktree registry or dispatch state: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  database.value.close();
  const discovered = await discoverCandidates(process, environment, parsed.value.repo);
  if (discovered.kind !== "ok") return discovered;
  const now = Date.now();
  const candidates: Candidate[] = [];
  for (const candidate of discovered.value) candidates.push(await assess(process, candidate, records.get(candidate.path), dispatches, parsed.value.olderThan, now));
  const removed: Array<{ path: string; branch: string; verified: boolean; branchDeleted: boolean }> = [];
  if (parsed.value.yes && !parsed.value.dryRun) {
    for (const candidate of candidates.filter((item) => item.eligible)) {
      const freshDb = openDatabase(environment);
      if (freshDb.kind !== "ok") {
        candidate.eligible = false;
        candidate.reason = `dispatch state could not be rechecked: ${freshDb.error}`;
        continue;
      }
      let freshDispatches = new Map<string, string[]>();
      try {
        for (const row of freshDb.value.db.query<{ worktree_path: string | null; state: string }>("SELECT worktree_path, state FROM dispatches WHERE worktree_path IS NOT NULL AND archived_at IS NULL").all()) {
          if (row.worktree_path !== null) freshDispatches.set(row.worktree_path, [...(freshDispatches.get(row.worktree_path) ?? []), row.state]);
        }
      } catch (cause: unknown) {
        freshDb.value.close();
        candidate.eligible = false;
        candidate.reason = `dispatch state could not be rechecked: ${cause instanceof Error ? cause.message : String(cause)}`;
        continue;
      }
      freshDb.value.close();
      const fresh = await assess(process, candidate, records.get(candidate.path), freshDispatches, parsed.value.olderThan, Date.now());
      if (!fresh.eligible) {
        candidate.eligible = false;
        candidate.reason = fresh.reason;
        continue;
      }
      const finish = await executeWorktreeFinish([candidate.path, "--delete-branch", "--base", await defaultBaseForPrune(process, candidate), "--json"], environment, process);
      const gitList = await run(process, "git", ["-C", candidate.repo, "worktree", "list", "--porcelain"]);
      const stillListed = gitList.kind !== "ok" || parseGitWorktrees(gitList.value, candidate.repo).some((item) => item.path === candidate.path);
      const stillExists = await stat(candidate.path).then(() => true).catch((cause: unknown) => {
        return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT" ? false : null;
      });
      if (!stillListed && stillExists === false) {
        const markDb = openDatabase(environment);
        if (markDb.kind === "ok") {
          try { withWrite(markDb.value, (db) => finishWorktree(db, candidate.path, new Date().toISOString())); }
          finally { markDb.value.close(); }
        }
        let branchDeleted = false;
        const branchExists = await run(process, "git", ["-C", candidate.repo, "show-ref", "--verify", "--quiet", `refs/heads/${candidate.branch}`]);
        if (branchExists.kind === "ok") {
          const deletion = await run(process, "git", ["-C", candidate.repo, "branch", "-d", candidate.branch]);
          branchDeleted = deletion.kind === "ok";
        } else branchDeleted = branchExists.exitCode === 1;
        removed.push({ path: candidate.path, branch: candidate.branch, verified: true, branchDeleted });
      }
      else {
        const message = stillExists === null ? "filesystem removal status is unknown" : finish.kind === "failed" ? finish.error : "worktree removal could not be verified";
        candidate.eligible = false;
        candidate.reason = message;
      }
    }
  }
  const response = { dryRun: !parsed.value.yes || parsed.value.dryRun, olderThan: parsed.value.olderThan, candidates, removed };
  if (parsed.value.json) return ok(`${JSON.stringify(response, null, 2)}\n`);
  const lines = [`Worktree prune (${response.dryRun ? "dry run" : "confirmed"}; older than ${parsed.value.olderThan} days)`];
  for (const item of candidates) lines.push(`${item.eligible ? "eligible" : "kept"}: ${item.path} (${item.ageDays === null ? "age unknown" : `${item.ageDays} days`}, ${item.sizeBytes === null ? "size unknown" : `${item.sizeBytes} bytes`}, ${item.purpose ?? "no purpose"}) — ${item.reason}`);
  for (const item of removed) lines.push(`removed: ${item.path} (${item.branch})`);
  return ok(`${lines.join("\n")}\n`);
}

async function defaultBaseForPrune(process: ProcessAdapter, candidate: Candidate): Promise<string> {
  const parent = await run(process, "git", ["-C", candidate.repo, "config", "--get", `branch.${candidate.branch}.megabrain-parent`]);
  if (parent.kind === "ok" && parent.value.trim() !== "") return parent.value.trim();
  const remoteDefault = await run(process, "git", ["-C", candidate.repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteDefault.kind === "ok" && remoteDefault.value.trim() !== "") return remoteDefault.value.trim().replace(/^origin\//, "");
  const configured = await run(process, "git", ["-C", candidate.repo, "config", "--get", "init.defaultBranch"]);
  return configured.kind === "ok" && configured.value.trim() !== "" ? configured.value.trim() : "main";
}
