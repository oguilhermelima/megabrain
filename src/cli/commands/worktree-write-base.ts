import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  utimes,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  createProcessAdapter,
  type ProcessAdapter,
} from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import {
  createName,
  finishJson,
  parseCreateOptions,
  parseFinishOptions,
  parsePullRequestOptions,
  type CreateOptions,
  type FinishOptions,
  type PullRequestOptions,
} from "../../core/worktree-write.js";
import { repoFromOrca } from "./repository-selector.js";
import { resolveCaller } from "./queue-write.js";
import { usageMessage, usageText } from "../../core/usage.js";
import { openDatabaseReadOnly } from "../../db/db.js";
import { insertWorktree, finishWorktree } from "../../db/queries/worktrees.js";
import { listRepositories } from "../../db/queries/repositories.js";
import {
  defaultWorktreeLocation,
  parseWorktreeLocation,
  placementFor,
  worktreeParent,
  type WorktreeLocation,
} from "../../core/worktree-location.js";
import { registerMegabrainRepository } from "../../core/project-registry.js";

export type Environment = Readonly<Record<string, string | undefined>>;
export async function run(
  process: ProcessAdapter,
  command: string,
  args: readonly string[],
): Promise<Result<{ stdout: string; stderr: string }>> {
  const result = await process.run(command, args);
  return result.kind === "ok"
    ? ok(result.value)
    : failed(result.error, result.exitCode);
}
export async function localBranchExists(
  process: ProcessAdapter,
  repo: string,
  branch: string,
): Promise<Result<boolean>> {
  const result = await run(process, "git", [
    "-C",
    repo,
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (result.kind === "ok") return ok(true);
  if (result.kind === "failed" && result.exitCode === 1) return ok(false);
  return failed(
    result.kind === "failed" ? result.error : result.reason,
    result.kind === "failed" ? result.exitCode : 1,
  );
}
export async function removeCreatedBranch(
  process: ProcessAdapter,
  repo: string,
  branch: string,
  existedBefore: boolean,
): Promise<Result<null>> {
  if (existedBefore) return ok(null);
  const existsAfter = await localBranchExists(process, repo, branch);
  if (existsAfter.kind !== "ok")
    return failed(
      `could not check branch ${branch} after worktree creation failed`,
    );
  if (!existsAfter.value) return ok(null);
  const removed = await run(process, "git", [
    "-C",
    repo,
    "branch",
    "-D",
    branch,
  ]);
  return removed.kind === "ok"
    ? ok(null)
    : failed(`could not remove branch ${branch} after worktree creation failed`);
}
export async function root(
  environment: Environment,
  tolerateMissing = false,
): Promise<Result<string>> {
  const state =
    environment.MEGABRAIN_STATE_DIR ??
    join(environment.HOME ?? "", ".megabrain");
  let raw: string;
  try {
    raw = (await readFile(join(state, "worktree-root"), "utf8")).trim();
  } catch {
    return tolerateMissing
      ? ok("")
      : failed(
          `shared worktree root for host 'unknown' is unset; choose one interactively with megabrain worktree create or set ${state}/worktree-root`,
        );
  }
  if (!raw)
    return tolerateMissing
      ? ok("")
      : failed(
          `shared worktree root for host 'unknown' is unset; choose one interactively with megabrain worktree create or set ${state}/worktree-root`,
        );
  const resolved = resolve(raw);
  return ok(await realpath(resolved).catch(() => resolved));
}
export function stateDirectory(environment: Environment): string {
  return environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? "", ".megabrain");
}
export async function readWorktreeLocation(environment: Environment): Promise<WorktreeLocation> {
  try {
    const parsed = parseWorktreeLocation(await readFile(join(stateDirectory(environment), "worktree-location.json"), "utf8"));
    return parsed.kind === "ok" ? parsed.value : defaultWorktreeLocation;
  } catch {
    return defaultWorktreeLocation;
  }
}
// Repo mode hides its folder through the repository's own info/exclude, never a tracked .gitignore.
export async function excludeWorktreesFolder(process: ProcessAdapter, repo: string): Promise<Result<null>> {
  const common = await run(process, "git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.kind !== "ok") return failed("could not locate the repository's git directory");
  const file = join(common.value.stdout.trim(), "info", "exclude");
  const entry = ".worktrees/";
  try {
    const current = await readFile(file, "utf8").catch(() => "");
    if (current.split("\n").includes(entry)) return ok(null);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}${entry}\n`);
  } catch {
    return failed(`could not add ${entry} to ${file}`);
  }
  return ok(null);
}
export async function repositoryRoot(
  process: ProcessAdapter,
  path: string,
): Promise<Result<string>> {
  const common = await run(process, "git", [
    "-C",
    path,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (common.kind !== "ok") return common;
  const commonPath = common.value.stdout.trim();
  const repository = commonPath.endsWith("/.git")
    ? dirname(commonPath)
    : commonPath;
  const canonical = await run(process, "git", [
    "-C",
    repository,
    "rev-parse",
    "--show-toplevel",
  ]);
  return canonical.kind === "ok"
    ? ok(canonical.value.stdout.trim())
    : failed(canonical.error, canonical.exitCode);
}
export async function pathFor(
  process: ProcessAdapter,
  target: string,
  shared: string,
  environment: Environment,
): Promise<Result<string>> {
  const direct = await realpath(target).catch(() => undefined);
  if (direct) {
    const top = await run(process, "git", [
      "-C",
      target,
      "rev-parse",
      "--show-toplevel",
    ]);
    if (top.kind !== "ok")
      return failed(`worktree path is not a Git directory: ${target}`);
    const canonical = await realpath(top.value.stdout.trim());
    if (canonical !== direct)
      return failed(
        `worktree selector points to subdirectory: ${direct}; pass the worktree root ${canonical ?? top.value.stdout.trim()} and put cd ${direct} in the command`,
      );
    return ok(direct);
  }
  const checkouts = await checkoutsNamed(process, target, shared, environment);
  const [only, ...others] = checkouts;
  if (only === undefined) return failed(`worktree not found: ${target}`);
  if (others.length === 0) return ok(only.path);
  return failed(
    `worktree selector is ambiguous: ${target} matches ${checkouts.length} worktrees:\n${checkouts.map((entry) => `  ${entry.path} (${entry.repo})`).join("\n")}\npass --repo <name|path> or the full worktree path`,
  );
}
type NamedCheckout = { path: string; repo: string };
// Repositories to ask git about: every registered one, the current one, and the owner of each folder in the shared root.
async function lookupRepositories(
  process: ProcessAdapter,
  shared: string,
  environment: Environment,
): Promise<string[]> {
  const candidates: string[] = [];
  const registry = openDatabaseReadOnly(environment);
  if (registry.kind === "ok") {
    try {
      for (const item of listRepositories(registry.value.db)) candidates.push(item.path);
    } finally {
      registry.value.close();
    }
  }
  candidates.push(".");
  if (shared) {
    for (const entry of await readdir(shared).catch(() => [] as string[])) candidates.push(join(shared, entry));
  }
  const repositories = new Set<string>();
  for (const candidate of candidates) {
    const repo = await repositoryRoot(process, candidate);
    if (repo.kind === "ok") repositories.add(await realpath(repo.value).catch(() => repo.value));
  }
  return [...repositories];
}
async function checkoutsNamed(
  process: ProcessAdapter,
  target: string,
  shared: string,
  environment: Environment,
): Promise<NamedCheckout[]> {
  const found = new Map<string, NamedCheckout>();
  for (const repo of await lookupRepositories(process, shared, environment)) {
    const listed = await run(process, "git", ["-C", repo, "worktree", "list", "--porcelain"]);
    if (listed.kind !== "ok") continue;
    for (const block of listed.value.stdout.split("\n\n")) {
      let path = "";
      let branch = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice(9);
        if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
      }
      if (path === "") continue;
      const folder = basename(path);
      if (branch !== target && folder !== target && folder !== target.replaceAll("/", "-")) continue;
      const canonical = await realpath(path).catch(() => path);
      found.set(canonical, { path: canonical, repo: basename(repo) });
    }
  }
  return [...found.values()];
}
export async function defaultBase(
  process: ProcessAdapter,
  repo: string,
): Promise<string> {
  const remote = await run(process, "git", [
    "-C",
    repo,
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (remote.kind === "ok" && remote.value.stdout.trim())
    return remote.value.stdout.trim().replace(/^origin\//, "");
  const configured = await run(process, "git", [
    "-C",
    repo,
    "config",
    "--get",
    "init.defaultBranch",
  ]);
  return configured.kind === "ok" && configured.value.stdout.trim()
    ? configured.value.stdout.trim()
    : "main";
}
async function remoteDefaultBranch(
  process: ProcessAdapter,
  repo: string,
): Promise<Result<string>> {
  const response = await run(process, "git", ["-C", repo, "ls-remote", "--symref", "origin", "HEAD"]);
  if (response.kind === "ok") {
    const line = response.value.stdout.split("\n").find((entry) => entry.startsWith("ref: refs/heads/") && entry.endsWith(" HEAD"));
    if (line) return ok(line.slice("ref: refs/heads/".length, -" HEAD".length));
  }
  const heads = await run(process, "git", ["-C", repo, "ls-remote", "--heads", "origin"]);
  if (heads.kind !== "ok") return failed(heads.kind === "failed" ? heads.error : "remote heads could not be queried");
  const branches = heads.value.stdout.split("\n")
    .map((line) => line.match(/\trefs\/heads\/(.+)$/)?.[1])
    .filter((branch): branch is string => branch !== undefined);
  const configured = await run(process, "git", ["-C", repo, "config", "--get", "init.defaultBranch"]);
  const preferred = configured.kind === "ok" && configured.value.stdout.trim()
    ? configured.value.stdout.trim()
    : "main";
  if (branches.includes(preferred)) return ok(preferred);
  if (branches.includes("main")) return ok("main");
  return branches.length === 1
    ? ok(branches[0] as string)
    : failed("remote did not advertise a default branch");
}
export async function createBase(
  process: ProcessAdapter,
  repo: string,
  requested: string | undefined,
): Promise<Result<{ ref: string; commit: string; source: string }>> {
  let ref = requested;
  let source = requested ? "explicit" : "remote";
  if (!ref) {
    const remote = await run(process, "git", [
      "-C", repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD",
    ]);
    if (remote.kind === "ok" && remote.value.stdout.trim()) {
      const branch = remote.value.stdout.trim().replace(/^origin\//, "");
      const fetched = await run(process, "git", ["-C", repo, "fetch", "origin", branch]);
      if (fetched.kind !== "ok") return failed(`could not fetch default base origin/${branch}: ${fetched.error}`);
      ref = `origin/${branch}`;
    } else {
      const origin = await run(process, "git", ["-C", repo, "remote", "get-url", "origin"]);
      if (origin.kind !== "ok") {
        ref = await defaultBase(process, repo);
        source = "local";
      }
      const discovered = ref ? undefined : await remoteDefaultBranch(process, repo);
      if (!ref && discovered === undefined) return failed("could not resolve default base");
      if (discovered && discovered.kind !== "ok") {
        return failed(
          `could not fetch default base: origin/HEAD is missing and the remote default branch could not be resolved (${discovered.error}); run git remote set-head origin -a`,
        );
      }
      if (discovered) {
        const branch = discovered.value;
        const fetched = await run(process, "git", ["-C", repo, "fetch", "origin", branch]);
        if (fetched.kind !== "ok") return failed(`could not fetch default base origin/${branch}: ${fetched.error}`);
        ref = `origin/${branch}`;
      }
    }
  }
  if (ref === undefined) return failed("could not resolve default base");
  const resolved = await run(process, "git", ["-C", repo, "rev-parse", "--verify", `${ref}^{commit}`]);
  return resolved.kind === "ok"
    ? ok({ ref, commit: resolved.value.stdout.trim(), source })
    : failed(`base does not exist: ${ref}`);
}
export async function parentBranch(
  process: ProcessAdapter,
  repo: string,
  branch: string,
): Promise<string | undefined> {
  const configured = await run(process, "git", [
    "-C",
    repo,
    "config",
    "--get",
    `branch.${branch}.megabrain-parent`,
  ]);
  if (configured.kind === "ok" && configured.value.stdout.trim())
    return configured.value.stdout.trim();
  const response = await run(process, "orca", [
    "worktree",
    "show",
    "--worktree",
    `path:${repo}`,
    "--json",
  ]);
  if (response.kind !== "ok") return undefined;
  try {
    const value = JSON.parse(response.value.stdout) as {
      result?: {
        worktree?: {
          parentWorktree?: { branch?: string };
          parent?: { branch?: string };
        };
        parentWorktree?: { branch?: string };
      };
      parentWorktree?: { branch?: string };
    };
    return (
      value.result?.worktree?.parentWorktree?.branch ??
      value.result?.worktree?.parent?.branch ??
      value.result?.parentWorktree?.branch ??
      value.parentWorktree?.branch
    );
  } catch {
    return undefined;
  }
}
