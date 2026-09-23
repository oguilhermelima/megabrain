import {
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

type Environment = Readonly<Record<string, string | undefined>>;
async function run(
  process: ProcessAdapter,
  command: string,
  args: readonly string[],
): Promise<Result<{ stdout: string; stderr: string }>> {
  const result = await process.run(command, args);
  return result.kind === "ok"
    ? ok(result.value)
    : failed(result.error, result.exitCode);
}
async function localBranchExists(
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
async function removeCreatedBranch(
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
async function root(
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
async function repositoryRoot(
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
async function pathFor(
  process: ProcessAdapter,
  target: string,
  shared: string,
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
  if (shared) {
    let entries: string[];
    try {
      entries = await readdir(shared);
    } catch {
      return failed(`worktree not found: ${target}`);
    }
    for (const entry of entries) {
      const candidate = join(shared, entry);
      const top = await run(process, "git", [
        "-C",
        candidate,
        "rev-parse",
        "--show-toplevel",
      ]);
      if (top.kind !== "ok") continue;
      const branch = await run(process, "git", [
        "-C",
        candidate,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      if (
        branch.kind === "ok" &&
        (branch.value.stdout.trim() === target ||
          entry === target ||
          entry === target.replaceAll("/", "-"))
      )
        return ok(
          await realpath(top.value.stdout.trim()).catch(() => candidate),
        );
    }
    return failed(`worktree not found: ${target}`);
  }
  const listed = await run(process, "git", ["worktree", "list", "--porcelain"]);
  if (listed.kind !== "ok") return failed(`worktree not found: ${target}`);
  let path = "";
  for (const line of listed.value.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    if (
      line === `branch refs/heads/${target}` ||
      (line.startsWith("branch ") && path.endsWith(`/${target}`))
    )
      return ok(path);
  }
  return failed(`worktree not found: ${target}`);
}
async function defaultBase(
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
async function createBase(
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
async function parentBranch(
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
type FinishBase = {
  readonly ref: string;
  readonly source: string;
  readonly warning?: string;
};
type Workspace = {
  readonly id?: string;
  readonly path: string;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function workspaceRecords(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  if (!isRecord(value)) return [];
  const workspaces = value.workspaces;
  if (Array.isArray(workspaces)) return workspaceRecords(workspaces);
  if (isRecord(workspaces)) return workspaceRecords(workspaces);
  return workspaceRecords(value.result);
}
function stringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    let value: unknown = record;
    for (const part of key.split(".")) {
      if (!isRecord(value)) {
        value = undefined;
        break;
      }
      value = value[part];
    }
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
async function hasCommand(
  process: ProcessAdapter,
  command: string,
): Promise<boolean> {
  const result = await run(process, "sh", ["-c", "command -v " + command]);
  return result.kind === "ok";
}
async function workspaceForTarget(
  process: ProcessAdapter,
  target: string,
): Promise<Result<Workspace | undefined>> {
  if (!(await hasCommand(process, "superset"))) return ok(undefined);
  const listed = await run(process, "superset", [
    "workspaces",
    "list",
    "--local",
    "--json",
  ]);
  if (listed.kind !== "ok") return ok(undefined);
  let payload: unknown;
  try {
    payload = JSON.parse(listed.value.stdout);
  } catch {
    return ok(undefined);
  }
  for (const record of workspaceRecords(payload)) {
    const branch = stringField(record, ["branch", "git.branch"])?.replace(
      /^refs\/heads\//,
      "",
    );
    const path = stringField(record, [
      "worktreePath",
      "path",
      "worktree.path",
    ]);
    const name = stringField(record, ["name"]);
    if (target !== branch && target !== path && target !== name) continue;
    if (path === undefined) return ok(undefined);
    return ok({
      path,
      id: stringField(record, ["id", "workspaceId", "workspace.id"]),
    });
  }
  return ok(undefined);
}
function projectRecords(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  if (!isRecord(value)) return [];
  const projects = value.projects;
  if (Array.isArray(projects)) return projectRecords(projects);
  if (isRecord(projects)) return projectRecords(projects);
  return projectRecords(value.result);
}
async function projectIdForPath(
  process: ProcessAdapter,
  repoPath: string,
): Promise<string | undefined> {
  const listed = await run(process, "superset", ["projects", "list", "--json"]);
  if (listed.kind !== "ok") return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(listed.value.stdout);
  } catch {
    return undefined;
  }
  for (const record of projectRecords(payload)) {
    const path = stringField(record, ["path", "localPath", "repoPath"]);
    if (path === repoPath) return stringField(record, ["id", "projectId", "project.id"]);
  }
  return undefined;
}
async function projectNameForPath(
  process: ProcessAdapter,
  repoPath: string,
): Promise<string> {
  const listed = await run(process, "orca", ["repo", "list", "--json"]);
  if (listed.kind === "ok") {
    try {
      const payload: unknown = JSON.parse(listed.value.stdout);
      const result = isRecord(payload) && isRecord(payload.result) ? payload.result : {};
      const repos = Array.isArray(result.repos) ? result.repos : [];
      for (const entry of repos) {
        if (isRecord(entry) && entry.path === repoPath) {
          const name = stringField(entry, ["displayName"]);
          if (name !== undefined) return name;
        }
      }
    } catch {
      // Falls through to the repo directory's basename below.
    }
  }
  return basename(repoPath);
}
type SupersetProject = { readonly id: string };
// Mirrors the retired shell's megabrain_ensure_superset_project: reuse a Superset project already
// registered for this repository path, or register one (importing the repo under its Orca display
// name, falling back to the directory's own basename).
async function ensureSupersetProject(
  process: ProcessAdapter,
  repoPath: string,
): Promise<Result<SupersetProject>> {
  const existing = await projectIdForPath(process, repoPath);
  if (existing !== undefined) return ok({ id: existing });
  const name = await projectNameForPath(process, repoPath);
  const created = await run(process, "superset", [
    "projects",
    "create",
    "--local",
    "--import",
    repoPath,
    "--name",
    name,
    "--json",
  ]);
  let id: string | undefined;
  if (created.kind === "ok") {
    try {
      const payload: unknown = JSON.parse(created.value.stdout);
      if (isRecord(payload))
        id = stringField(payload, ["result.project.id", "result.id", "project.id", "id"]);
    } catch {
      // Falls through to a fresh lookup below.
    }
  }
  if (id === undefined) id = await projectIdForPath(process, repoPath);
  if (id === undefined) return failed(`could not register Superset project for ${repoPath}`);
  return ok({ id });
}
async function workspaceIdForTarget(
  process: ProcessAdapter,
  target: string,
): Promise<string | undefined> {
  const listed = await run(process, "superset", ["workspaces", "list", "--local", "--json"]);
  if (listed.kind !== "ok") return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(listed.value.stdout);
  } catch {
    return undefined;
  }
  for (const record of workspaceRecords(payload)) {
    const branch = stringField(record, ["branch", "git.branch"])?.replace(/^refs\/heads\//, "");
    const path = stringField(record, ["worktreePath", "path", "worktree.path"]);
    const name = stringField(record, ["name"]);
    if (target === branch || target === path || target === name)
      return stringField(record, ["id", "workspaceId", "workspace.id"]);
  }
  return undefined;
}
async function updateWorkspaceTag(
  process: ProcessAdapter,
  id: string,
  tag: string,
): Promise<boolean> {
  const updated = await run(process, "superset", ["workspaces", "update", id, "--tag", tag, "--json"]);
  return updated.kind === "ok";
}
type WorkspaceRegistration = {
  readonly id: string;
  readonly tagSet: boolean;
  readonly tagError: string | null;
};
// Mirrors the retired shell's megabrain_workspace_create: an existing workspace for this branch
// that also needs a parent tag is only re-tagged (never re-created); otherwise a fresh workspace
// is opened against the branch, then tagged if a parent grouping was requested.
async function registerSupersetWorkspace(
  process: ProcessAdapter,
  project: SupersetProject,
  branch: string,
  slug: string,
  options: { readonly tag?: string; readonly pr?: string },
): Promise<Result<WorkspaceRegistration>> {
  const existingId = await workspaceIdForTarget(process, branch);
  if (existingId !== undefined && options.tag !== undefined) {
    const tagSet = await updateWorkspaceTag(process, existingId, options.tag);
    return ok({
      id: existingId,
      tagSet,
      tagError: tagSet ? null : `Superset workspace tag was not set for ${existingId}`,
    });
  }
  // --pr opens the workspace against the pull request instead of the branch (the two are
  // mutually exclusive on the Superset side, matching the retired shell's megabrain_workspace_create).
  const created = await run(process, "superset", [
    "workspaces",
    "create",
    "--local",
    "--project",
    project.id,
    ...(options.pr !== undefined ? ["--pr", options.pr] : ["--branch", branch]),
    "--name",
    slug,
    "--json",
  ]);
  let id: string | undefined;
  if (created.kind === "ok") {
    try {
      const payload: unknown = JSON.parse(created.value.stdout);
      if (isRecord(payload))
        id = stringField(payload, ["result.workspace.id", "result.id", "workspace.id", "id"]);
    } catch {
      // Falls through to a fresh lookup below.
    }
  }
  if (id === undefined) id = await workspaceIdForTarget(process, branch);
  if (id === undefined) return failed("could not create Superset workspace");
  if (options.tag === undefined) return ok({ id, tagSet: false, tagError: null });
  const tagSet = await updateWorkspaceTag(process, id, options.tag);
  return ok({
    id,
    tagSet,
    tagError: tagSet ? null : `Superset workspace tag was not set for ${branch}`,
  });
}
function removalReason(error: string): string {
  const compact = error.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  try {
    const parsed: unknown = JSON.parse(error);
    if (isRecord(parsed)) {
      const nested = parsed.error;
      if (typeof nested === "string" && nested.length > 0) return nested;
      if (isRecord(nested)) {
        const message = stringField(nested, ["message", "code"]);
        if (message !== undefined) return message;
      }
      const message = stringField(parsed, ["message", "code"]);
      if (message !== undefined) return message;
    }
  } catch {
    // The host remover may return plain text instead of JSON.
  }
  return compact.length > 0 ? compact : "the remover gave no reason";
}
async function resolveFinishBase(
  process: ProcessAdapter,
  repo: string,
  path: string,
  branch: string,
  value: FinishOptions,
): Promise<Result<FinishBase>> {
  if (value.base !== undefined)
    return ok({ ref: value.base, source: "explicit" });
  if (!value.deleteBranch || branch.length === 0)
    return ok({ ref: "", source: "" });
  const parent = await parentBranch(process, path, branch);
  const fallback = await defaultBase(process, repo);
  if (parent !== undefined) {
    const exists = await localBranchExists(process, repo, parent);
    if (exists.kind === "ok" && exists.value)
      return ok({ ref: parent, source: "recorded-parent" });
    return ok({
      ref: fallback,
      source: "repository-default",
      warning:
        "recorded parent branch no longer exists: " +
        parent +
        "; judging against repository default base " +
        fallback,
    });
  }
  return ok({ ref: fallback, source: "repository-default" });
}
function finishRefusal(
  json: boolean,
  message: string,
  code: string,
  exitCode = 1,
): Result<string> {
  if (!json) return failed(message, exitCode);
  return {
    kind: "ok",
    value: finishJson({
      deleted: false,
      refusal: { code, message },
    }),
    exitCode,
    stderr: "megabrain: " + message + "\n",
  };
}
async function removeFinishWorktree(
  process: ProcessAdapter,
  repo: string,
  path: string,
  force: boolean,
  workspace: Workspace | undefined,
): Promise<Result<null>> {
  if (workspace?.id !== undefined) {
    const removed = await run(process, "superset", [
      "workspaces",
      "delete",
      workspace.id,
      "--local",
      "--json",
    ]);
    return removed.kind === "ok"
      ? ok(null)
      : failed(removalReason(removed.error), removed.exitCode);
  }
  if (await hasCommand(process, "orca")) {
    const args = ["worktree", "rm", "--worktree", "path:" + path];
    if (force) args.push("--force");
    args.push("--json");
    const removed = await run(process, "orca", args);
    return removed.kind === "ok"
      ? ok(null)
      : failed(removalReason(removed.error), removed.exitCode);
  }
  const removed = await run(process, "git", [
    "-C",
    repo,
    "worktree",
    "remove",
    ...(force ? ["--force"] : []),
    path,
  ]);
  return removed.kind === "ok"
    ? ok(null)
    : failed(removalReason(removed.error), removed.exitCode);
}
async function resolveParent(
  process: ProcessAdapter,
  repo: string,
  selector: string,
): Promise<Result<{ branch: string; tag: string }>> {
  const match = /^(branch|path):(.*)$/.exec(selector);
  if (!match || !match[2])
    return failed(
      `parent worktree could not be resolved: ${selector} (use branch:<branch> or path:<path>)`,
    );
  let path = match[1] === "path" ? match[2] : "";
  if (match[1] === "branch") {
    const listed = await run(process, "git", [
      "-C",
      repo,
      "worktree",
      "list",
      "--porcelain",
    ]);
    if (listed.kind !== "ok")
      return failed(`parent worktree could not be resolved: ${selector}`);
    let current = "";
    for (const line of listed.value.stdout.split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice(9);
      if (line === `branch refs/heads/${match[2]}`) {
        path = current;
        break;
      }
    }
    // WHY: git treats `-C ""` as no -C at all, so an unmatched branch selector must refuse here
    // rather than let the calls below silently run against the caller's own cwd instead of the
    // (nonexistent) parent worktree.
    if (path === "") return failed(`parent worktree could not be resolved: ${selector}`);
  }
  const top = await run(process, "git", [
    "-C",
    path,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (top.kind !== "ok")
    return failed(`parent worktree could not be resolved: ${selector}`);
  const branch = await run(process, "git", [
    "-C",
    path,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (branch.kind !== "ok" || !branch.value.stdout.trim())
    return failed(`parent worktree is detached: ${selector}`);
  const name = branch.value.stdout.trim();
  return ok({ branch: name, tag: name.replaceAll("/", "-") });
}
function output(value: unknown, json: boolean): string {
  return json
    ? `${JSON.stringify(value, null, 2)}\n`
    : `worktree: ${(value as { worktree: string }).worktree}\nbranch: ${(value as { branch: string }).branch}\nbase: ${(value as { base: string }).base}\nbase commit: ${(value as { baseCommit: string }).baseCommit}\n`;
}
function isEnvFile(name: string): boolean {
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}
async function copyEnvFiles(
  sourceRoot: string,
  destinationRoot: string,
): Promise<Result<null>> {
  async function walk(relativeDirectory: string): Promise<Result<null>> {
    const sourceDirectory = join(sourceRoot, relativeDirectory);
    let entries;
    try {
      entries = await readdir(sourceDirectory, { withFileTypes: true });
    } catch {
      return failed(`could not read directory for ${relativeDirectory || "."}`);
    }
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      if (relativeDirectory === "" && entry.name === ".git") continue;
      if (entry.isDirectory()) {
        const nested = await walk(relativePath);
        if (nested.kind !== "ok") return nested;
        continue;
      }
      if (!isEnvFile(entry.name) || (!entry.isFile() && !entry.isSymbolicLink()))
        continue;
      const sourceFile = join(sourceRoot, relativePath);
      const destinationFile = join(destinationRoot, relativePath);
      try {
        await mkdir(dirname(destinationFile), { recursive: true });
        const metadata = await lstat(sourceFile);
        if (metadata.isSymbolicLink()) {
          await symlink(await readlink(sourceFile), destinationFile);
        } else {
          await copyFile(sourceFile, destinationFile);
          await chmod(destinationFile, metadata.mode);
          await utimes(destinationFile, metadata.atime, metadata.mtime);
        }
      } catch {
        return failed(`could not copy ${relativePath}`);
      }
    }
    return ok(null);
  }
  return walk("");
}
export async function executeWorktreeCreate(
  args: readonly string[],
  environment: Environment,
  process = createProcessAdapter(),
): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help"))
    return ok(
      "Usage: megabrain worktree create --repo <name|path> --branch <branch> [--from <ref>] [--base <ref>] [--parent <branch:branch|path:path>] [--no-parent] [--issue <number>] [--linear-issue <identifier-or-url>] [--pr <number>] [--name <slug>] [--agent <id>] [--model <id>] [--effort <level>] [--prompt <text>] [--label <text>] [--tmux true|false] [--json]\n",
    );
  const options = parseCreateOptions(args);
  if (options.kind !== "ok") return options;
  const value: CreateOptions = options.value;
  const shared = await root(environment);
  if (shared.kind !== "ok") return shared;
  const repo = await repoFromOrca(process, value.repo as string);
  if (repo.kind !== "ok") return repo;
  const branch = value.branch as string;
  // Validated before anything is created: an unresolvable --parent must refuse with nothing left
  // behind, not fail after `git worktree add` has already created the branch and worktree.
  let resolvedParent: { branch: string; tag: string } | undefined;
  if (value.parent !== undefined) {
    const resolved = await resolveParent(process, repo.value, value.parent);
    if (resolved.kind !== "ok") return resolved;
    resolvedParent = resolved.value;
  }
  const resolvedBase = await createBase(process, repo.value, value.from ?? value.base);
  if (resolvedBase.kind !== "ok") return resolvedBase;
  const base = resolvedBase.value.ref;
  const name = value.name ?? createName(branch);
  if (!name) return failed("branch cannot produce a safe slug");
  const path = join(shared.value, name);
  // WHY: only a branch absent before this invocation may be removed on add failure.
  const branchBefore = await localBranchExists(process, repo.value, branch);
  if (branchBefore.kind !== "ok")
    return failed(`could not check whether branch exists: ${branch}`);
  await mkdir(shared.value, { recursive: true });
  const added = await run(process, "git", [
    "-C",
    repo.value,
    "worktree",
    "add",
    path,
    "-b",
    branch,
    base,
  ]);
  if (added.kind !== "ok") {
    const removed = await removeCreatedBranch(
      process,
      repo.value,
      branch,
      branchBefore.value,
    );
    return removed.kind === "ok"
      ? failed("could not create git worktree")
      : failed(`could not create git worktree; ${removed.error}`);
  }
  const copied = await copyEnvFiles(repo.value, path);
  if (copied.kind !== "ok") return copied;
  // A caller running inside a Superset terminal registers the new worktree as a Superset
  // workspace, the way the retired shell's megabrain_worktree_create did for both plain
  // `worktree create` and `orchestrate spawn`'s own worktree-creation path. A requested parent
  // tags the new workspace into the same Superset grouping as its parent worktree.
  const caller = await resolveCaller(environment, process);
  let workspaceId: string | null = null;
  let grouping: { set: boolean; error: string | null } = { set: false, error: null };
  if (caller.host === "superset") {
    const project = await ensureSupersetProject(process, repo.value);
    if (project.kind !== "ok") return project;
    const registered = await registerSupersetWorkspace(process, project.value, branch, name, {
      tag: resolvedParent?.tag,
      pr: value.pr,
    });
    if (registered.kind !== "ok") return registered;
    workspaceId = registered.value.id;
    if (resolvedParent !== undefined)
      grouping = { set: registered.value.tagSet, error: registered.value.tagError };
  }
  let parent: {
    requested: boolean;
    selector?: string;
    branch?: string;
    tag?: string;
    metadata?: { set: boolean; error: string | null };
    lineage?: { set: boolean; error: string | null };
    grouping?: { set: boolean; error: string | null };
  } = { requested: false };
  let links: {
    issue: string | null;
    linearIssue: string | null;
    set: boolean;
    error: string | null;
  } = {
    issue: value.issue ?? null,
    linearIssue: value.linearIssue ?? null,
    set: false,
    error: null,
  };
  if (resolvedParent !== undefined) {
    const metadata = await run(process, "git", [
      "-C",
      path,
      "config",
      `branch.${branch}.megabrain-parent`,
      resolvedParent.branch,
    ]);
    parent = {
      requested: true,
      selector: value.parent,
      branch: resolvedParent.branch,
      tag: resolvedParent.tag,
      metadata: {
        set: metadata.kind === "ok",
        error:
          metadata.kind === "ok"
            ? null
            : `Git stack parent metadata was not recorded for ${branch}`,
      },
      lineage: { set: false, error: null },
      grouping,
    };
  }
  if (
    value.parent !== undefined ||
    value.issue !== undefined ||
    value.linearIssue !== undefined
  ) {
    const setArgs = ["worktree", "set", "--worktree", `path:${path}`];
    if (value.parent !== undefined)
      setArgs.push("--parent-worktree", value.parent);
    if (value.issue !== undefined) setArgs.push("--issue", value.issue);
    if (value.linearIssue !== undefined)
      setArgs.push("--linear-issue", value.linearIssue);
    setArgs.push("--json");
    const configured = await run(process, "orca", setArgs);
    if (value.parent !== undefined)
      parent = {
        ...parent,
        lineage: {
          set: configured.kind === "ok",
          error:
            configured.kind === "ok"
              ? null
              : `Orca parent lineage was not set for ${value.parent}`,
        },
      };
    if (value.issue !== undefined || value.linearIssue !== undefined)
      links = {
        ...links,
        set: configured.kind === "ok",
        error:
          configured.kind === "ok" ? null : "Orca issue links were not set",
      };
  }
  const result = {
    worktree: path,
    branch,
    workspace: workspaceId,
    reused: false,
    base,
    baseCommit: resolvedBase.value.commit,
    baseSource: resolvedBase.value.source,
    parent,
    links,
  };
  return ok(output(result, value.json));
}
export async function executeWorktreeFinish(
  args: readonly string[],
  environment: Environment,
  process = createProcessAdapter(),
): Promise<Result<string>> {
  const parsed = parseFinishOptions(args);
  if (parsed.kind !== "ok")
    return args.includes("--json")
      ? finishRefusal(true, parsed.error, "invalid-arguments", parsed.exitCode)
      : parsed;
  const value: FinishOptions = parsed.value;
  if (!value.target)
    return finishRefusal(
      value.json,
      "Usage: megabrain worktree finish <path|branch|slug> [--delete-branch] [--base <ref>] [--force] [--json]",
      "invalid-arguments",
      2,
    );
  const shared = await root(environment, true);
  if (shared.kind !== "ok") return shared;
  const workspace = await workspaceForTarget(process, value.target);
  if (workspace.kind !== "ok") return workspace;
  const found =
    workspace.value?.path !== undefined
      ? ok(workspace.value.path)
      : await pathFor(process, value.target, shared.value);
  if (found.kind !== "ok")
    return finishRefusal(value.json, found.error, "worktree-not-found");
  const path = found.value;
  const repo = await repositoryRoot(process, path);
  if (repo.kind !== "ok") return repo;
  const branchResult = await run(process, "git", [
    "-C",
    path,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const branch =
    branchResult.kind === "ok" ? branchResult.value.stdout.trim() : "";
  const base = await resolveFinishBase(
    process,
    repo.value,
    path,
    branch,
    value,
  );
  if (base.kind !== "ok") return base;
  const baseRef = base.value.ref;
  const baseSource = base.value.source;
  const baseWarning = base.value.warning;
  const warning = baseWarning === undefined ? "" : baseWarning + "\n";
  if (value.deleteBranch && branch && !value.force) {
    const merged = await run(process, "git", [
      "-C",
      repo.value,
      "branch",
      "--merged",
      baseRef,
    ]);
    if (
      merged.kind !== "ok" ||
      !merged.value.stdout.split("\n").some(
        (line) =>
          line
            .trim()
            .replace(/^[*+]\s*/, "")
            .trim() === branch,
      )
    ) {
      const message =
        "refusing to delete unmerged branch: " +
        branch +
        " against base " +
        baseRef +
        " (use --force to override)";
      if (value.json) {
        return {
          kind: "ok",
          value: finishJson({
            deleted: false,
            branch,
            path,
            base: baseRef,
            baseSource,
            baseWarning,
            refusal: { code: "unmerged-branch", message },
          }),
          exitCode: 1,
          stderr: warning + "megabrain: " + message + "\n",
        };
      }
      if (warning.length > 0)
        return {
          kind: "ok",
          value: "",
          exitCode: 1,
          stderr: warning + "megabrain: " + message + "\n",
        };
      return failed(message);
    }
  }
  const removed = await removeFinishWorktree(
    process,
    repo.value,
    path,
    value.force,
    workspace.value,
  );
  if (removed.kind !== "ok") {
    const reason = removalReason(removed.error);
    const message = "could not remove worktree " + path + ": " + reason;
    return value.json
      ? {
          kind: "ok",
          value: finishJson({
            deleted: false,
            branch,
            path,
            base: baseRef || undefined,
            baseSource: baseSource || undefined,
            baseWarning,
            error: reason,
          }),
          exitCode: removed.exitCode,
          stderr: warning + "megabrain: " + message + "\n",
        }
      : failed(message, removed.exitCode);
  }
  let branchDeleted: boolean | undefined;
  let branchOutput = "";
  if (value.deleteBranch && branch) {
    const exists = await localBranchExists(process, repo.value, branch);
    if (exists.kind === "ok" && exists.value) {
      const deleted = await run(process, "git", [
        "-C",
        repo.value,
        "branch",
        "-D",
        branch,
      ]);
      if (deleted.kind === "ok") {
        branchDeleted = true;
        branchOutput = deleted.value.stdout.trim();
      } else {
        const reason = removalReason(deleted.error);
        const message =
          "could not delete branch: " + branch + ": " + reason;
        return value.json
          ? {
              kind: "ok",
              value: finishJson({
                deleted: true,
                branch,
                path,
                base: baseRef || undefined,
                baseSource: baseSource || undefined,
                baseWarning,
                branchDeleted: false,
                error: reason,
              }),
              exitCode: deleted.exitCode,
              stderr: warning + "megabrain: " + message + "\n",
            }
          : failed(message, deleted.exitCode);
      }
    } else {
      branchDeleted = false;
    }
  }
  if (value.json)
    return {
      kind: "ok",
      value: finishJson({
        deleted: true,
        branch,
        path,
        base: baseRef || undefined,
        baseSource: baseSource || undefined,
        baseWarning,
        branchDeleted,
      }),
      stderr: warning.length > 0 ? warning : undefined,
    };
  let human = "removed: " + path + "\n";
  if (value.deleteBranch && branch) {
    human +=
      "judged branch " +
      branch +
      " against base " +
      baseRef +
      " (" +
      baseSource +
      ")\n";
    if (branchDeleted === false)
      human += "branch already absent: " + branch + "\n";
    else if (branchOutput.length > 0) human += branchOutput + "\n";
  }
  return ok(human);
}
export async function executeWorktreePr(
  args: readonly string[],
  environment: Environment,
  process = createProcessAdapter(),
): Promise<Result<string>> {
  const parsed = parsePullRequestOptions(args);
  if (parsed.kind !== "ok") return parsed;
  const value: PullRequestOptions = parsed.value;
  if (!value.target)
    return failed(
      "Usage: megabrain worktree pr <path|branch|slug> [--base <ref>] [--title <text>] [--body <text>] [--json]",
      2,
    );
  const shared = await root(environment, true);
  if (shared.kind !== "ok") return shared;
  const path = await pathFor(process, value.target, shared.value);
  if (path.kind !== "ok") return path;
  const branch = await run(process, "git", [
    "-C",
    path.value,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (branch.kind !== "ok" || !branch.value.stdout.trim())
    return failed(
      `cannot open a pull request from detached worktree: ${path.value}`,
    );
  const name = branch.value.stdout.trim();
  const repo = path.value;
  let base = value.base;
  if (!base)
    base =
      (await parentBranch(process, repo, name)) ??
      (await defaultBase(process, repo));
  const title = value.title ?? name;
  const gh = await run(process, "gh", ["auth", "status"]);
  if (gh.kind !== "ok") {
    return failed(
      gh.error.includes("not found") ||
        gh.error.includes("No such file") ||
        gh.error.includes("Executable")
        ? "gh CLI is not installed"
        : "gh CLI is not authenticated",
    );
  }
  const verified = await run(process, "git", [
    "-C",
    repo,
    "rev-parse",
    "--verify",
    `${base}^{commit}`,
  ]);
  if (verified.kind !== "ok")
    return failed(`pull request base does not exist: ${base}`);
  const ahead = await run(process, "git", [
    "-C",
    repo,
    "rev-list",
    "--count",
    `${base}..${name}`,
  ]);
  if (ahead.kind !== "ok" || Number(ahead.value.stdout.trim()) === 0)
    return failed(
      `refusing to open a pull request: no commits ahead of base ${base}`,
    );
  const created = await run(process, "gh", [
    "pr",
    "create",
    "--base",
    base,
    "--head",
    name,
    "--title",
    title,
    "--body",
    value.body ?? "",
  ]);
  if (created.kind !== "ok")
    return failed(`could not open a pull request: ${created.error}`);
  return ok(
    value.json
      ? `${JSON.stringify({ worktree: path.value, branch: name, base, title, body: value.body ?? "", url: created.value.stdout.trim() })}\n`
      : created.value.stdout,
  );
}
