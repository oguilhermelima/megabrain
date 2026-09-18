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
  return ok((await realpath(resolve(raw))) || resolve(raw));
}
async function repoFromOrca(
  process: ProcessAdapter,
  selector: string,
): Promise<Result<string>> {
  const direct = await run(process, "git", [
    "-C",
    selector,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (direct.kind === "ok") {
    const common = await run(process, "git", [
      "-C",
      selector,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const commonPath = common.kind === "ok" ? common.value.stdout.trim() : "";
    if (commonPath.endsWith("/.git")) {
      const canonical = await run(process, "git", [
        "-C",
        commonPath.slice(0, -5),
        "rev-parse",
        "--show-toplevel",
      ]);
      if (canonical.kind === "ok") return ok(canonical.value.stdout.trim());
    }
    return ok(direct.value.stdout.trim());
  }
  // WHY: a failed registry call is an unknown orchestrator state, not proof that Orca is absent.
  const command = await run(process, "sh", ["-c", "command -v orca"]);
  if (command.kind !== "ok")
    return failed("repo must be a git path when orca is not installed");
  const listed = await run(process, "orca", ["repo", "list", "--json"]);
  if (listed.kind !== "ok")
    return failed(`could not resolve repo selector '${selector}': orca did not respond; pass a Git path instead`);
  try {
    const payload = JSON.parse(listed.value.stdout) as {
      result?: { repos?: Array<{ displayName?: string; path?: string }> };
    };
    const wanted = selector.toLocaleLowerCase();
    const match = (payload.result?.repos ?? []).find((repo) => {
      const path = repo.path ?? "";
      return (
        wanted === (repo.displayName ?? "").toLocaleLowerCase() ||
        wanted === basename(path).toLocaleLowerCase()
      );
    });
    return match?.path ? ok(match.path) : failed(`repo not found: ${selector}`);
  } catch {
    return failed(`repo not found: ${selector}`);
  }
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
        return ok((await realpath(top.value.stdout.trim())) ?? candidate);
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
): Promise<Result<{ ref: string; commit: string }>> {
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
  const resolvedBase = await createBase(process, repo.value, value.from ?? value.base);
  if (resolvedBase.kind !== "ok") return resolvedBase;
  const base = resolvedBase.value.ref;
  const name = value.name ?? createName(branch);
  if (!name) return failed("branch cannot produce a safe slug");
  const path = join(shared.value, name);
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
  if (added.kind !== "ok") return failed("could not create git worktree");
  const copied = await copyEnvFiles(repo.value, path);
  if (copied.kind !== "ok") return copied;
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
  if (value.parent !== undefined) {
    const resolved = await resolveParent(process, repo.value, value.parent);
    if (resolved.kind !== "ok") return resolved;
    const metadata = await run(process, "git", [
      "-C",
      path,
      "config",
      `branch.${branch}.megabrain-parent`,
      resolved.value.branch,
    ]);
    parent = {
      requested: true,
      selector: value.parent,
      branch: resolved.value.branch,
      tag: resolved.value.tag,
      metadata: {
        set: metadata.kind === "ok",
        error:
          metadata.kind === "ok"
            ? null
            : `Git stack parent metadata was not recorded for ${branch}`,
      },
      lineage: { set: false, error: null },
      grouping: { set: false, error: null },
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
    workspace: null,
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
  if (parsed.kind !== "ok") return parsed;
  const value: FinishOptions = parsed.value;
  if (!value.target)
    return value.json
      ? ok(
          finishJson({
            deleted: false,
            refusal: {
              code: "invalid-arguments",
              message:
                "Usage: megabrain worktree finish <path|branch|slug> [--delete-branch] [--base <ref>] [--force] [--json]",
            },
          }),
        )
      : failed(
          "Usage: megabrain worktree finish <path|branch|slug> [--delete-branch] [--base <ref>] [--force] [--json]",
          2,
        );
  const shared = await root(environment, true);
  if (shared.kind !== "ok") return shared;
  const found = await pathFor(process, value.target, shared.value);
  if (found.kind !== "ok")
    return value.json
      ? ok(
          finishJson({
            deleted: false,
            refusal: { code: "worktree-not-found", message: found.error },
          }),
        )
      : found;
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
  const base = value.base ?? (await defaultBase(process, repo.value));
  if (value.deleteBranch && branch && !value.force) {
    const merged = await run(process, "git", [
      "-C",
      repo.value,
      "branch",
      "--merged",
      base,
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
      const message = `refusing to delete unmerged branch: ${branch} against base ${base} (use --force to override)`;
      return value.json
        ? ok(
            finishJson({
              deleted: false,
              branch,
              path,
              base,
              baseSource: "repository-default",
              refusal: { code: "unmerged-branch", message },
            }),
          )
        : failed(message);
    }
  }
  const removed = await run(process, "git", [
    "-C",
    repo.value,
    "worktree",
    "remove",
    ...(value.force ? ["--force"] : []),
    path,
  ]);
  if (removed.kind !== "ok")
    return value.json
      ? ok(finishJson({ deleted: false, branch, path, error: removed.error }))
      : failed(`could not remove worktree ${path}: ${removed.error}`);
  let branchDeleted: boolean | undefined;
  if (value.deleteBranch && branch) {
    const deleted = await run(process, "git", [
      "-C",
      repo.value,
      "branch",
      "-D",
      branch,
    ]);
    branchDeleted = deleted.kind === "ok";
    if (!branchDeleted && deleted.error.includes("not found"))
      branchDeleted = false;
    else if (!branchDeleted)
      return value.json
        ? ok(
            finishJson({
              deleted: true,
              branch,
              path,
              base,
              branchDeleted: false,
              error: deleted.error,
            }),
          )
        : failed(`could not delete branch: ${branch}: ${deleted.error}`);
  }
  return value.json
    ? ok(finishJson({ deleted: true, branch, path, base, branchDeleted }))
    : ok(`removed: ${path}\n`);
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
