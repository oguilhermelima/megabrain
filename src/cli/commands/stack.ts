import { dirname, resolve } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { openDatabase, withWrite } from "../../db/db.js";
import { listWorktrees } from "../../db/queries/worktrees.js";
import { executeWorktreeCreate } from "./worktree-write.js";

type Environment = Readonly<Record<string, string | undefined>>;
type Provider = "github" | "gitlab";
type Worktree = ReturnType<typeof listWorktrees>[number];
type GitHubPull = { number: number; headRefName: string; baseRefName: string; url?: string; state?: string; reviewDecision?: string; statusCheckRollup?: unknown[] };
type GitHubStack = { number: number; pull_requests: Array<{ number: number; head?: { ref?: string } }> };
type StackData = { repo: string; slug: string; defaultBranch: string; branches: Worktree[] };
type GitLabMR = { iid: number; source_branch: string; target_branch: string; state: string; web_url?: string; detailed_merge_status?: string; head_pipeline?: { status?: string } };

async function run(process: ProcessAdapter, command: string, args: readonly string[], cwd?: string) {
  return process.run(command, args, cwd === undefined ? undefined : { cwd });
}

async function git(process: ProcessAdapter, repo: string, args: readonly string[]) {
  return run(process, "git", ["-C", repo, ...args]);
}

function output(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function repoFromCwd(process: ProcessAdapter, cwd: string): Promise<Result<string>> {
  const result = await git(process, cwd, ["rev-parse", "--show-toplevel"]);
  if (result.kind !== "ok") return failed("not inside a git worktree");
  const top = result.value.stdout.trim();
  const common = await git(process, top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.kind !== "ok") return failed("could not locate the repository for this worktree");
  const commonDir = common.value.stdout.trim();
  return ok(commonDir.endsWith("/.git") || commonDir.endsWith("\\.git") ? dirname(commonDir) : top);
}

function slugFromRemote(remote: string): string | undefined {
  const value = remote.trim();
  const ssh = value.match(/^[^@]+@[^:]+:(.+)$/);
  let path = ssh?.[1];
  if (path === undefined) {
    try { path = new URL(value).pathname.replace(/^\//, ""); }
    catch { return undefined; }
  }
  const clean = path.replace(/\.git$/, "").replace(/\/$/, "");
  return clean.includes("/") ? clean : undefined;
}

async function repositorySlug(process: ProcessAdapter, repo: string): Promise<Result<string>> {
  const remote = await git(process, repo, ["remote", "get-url", "origin"]);
  if (remote.kind !== "ok") return failed("origin remote is missing");
  const slug = slugFromRemote(remote.value.stdout);
  return slug === undefined ? failed(`could not read owner/repository from origin URL: ${remote.value.stdout.trim()}`) : ok(slug);
}

async function defaultBranch(process: ProcessAdapter, repo: string): Promise<string> {
  const symbolic = await git(process, repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolic.kind === "ok") return symbolic.value.stdout.trim().replace(/^origin\//, "");
  for (const candidate of ["main", "master"]) {
    const exists = await git(process, repo, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (exists.kind === "ok") return candidate;
  }
  const current = await git(process, repo, ["branch", "--show-current"]);
  return current.kind === "ok" ? current.value.stdout.trim() : "main";
}

function orderedBranches(rows: Worktree[], base: string): Worktree[] {
  const byParent = new Map<string, Worktree[]>();
  for (const row of rows.filter((item) => item.finishedAt === null && item.parentBranch !== null && item.parentBranch !== undefined)) {
    const children = byParent.get(row.parentBranch!) ?? [];
    children.push(row);
    byParent.set(row.parentBranch!, children);
  }
  let children = byParent.get(base) ?? [];
  if (children.length === 0) return [];
  if (children.length > 1) return [];
  const result: Worktree[] = [];
  while (children.length === 1) {
    const next = children[0]!;
    result.push(next);
    children = byParent.get(next.branch) ?? [];
    if (children.length > 1) return [];
  }
  return result;
}

function parseOptions(args: readonly string[]): Result<{ action: string; values: string[]; yes: boolean; draft: boolean; repo?: string; provider?: Provider }> {
  const values: string[] = [];
  let yes = false;
  let draft = false;
  let repo: string | undefined;
  let provider: Provider | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--yes") yes = true;
    else if (arg === "--draft") draft = true;
    else if (arg === "--repo" || arg === "--provider") {
      const value = args[++i];
      if (!value) return failed(`${arg} requires a value`, 2);
      if (arg === "--repo") repo = value;
      else if (value === "github" || value === "gitlab") provider = value;
      else return failed("--provider must be github or gitlab", 2);
    } else values.push(arg);
  }
  return ok({ action: values.shift() ?? "show", values, yes, draft, ...(repo ? { repo } : {}), ...(provider ? { provider } : {}) });
}

async function dataFor(process: ProcessAdapter, environment: Environment, repoOption?: string): Promise<Result<StackData>> {
  const cwdRepo = repoOption === undefined ? await repoFromCwd(process, environment.PWD ?? ".") : ok(resolve(repoOption));
  if (cwdRepo.kind !== "ok") return cwdRepo;
  const repo = cwdRepo.value;
  const slug = await repositorySlug(process, repo);
  if (slug.kind !== "ok") return slug;
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error);
  try {
    const branches = orderedBranches(listWorktrees(opened.value.db, repo), await defaultBranch(process, repo));
    return ok({ repo, slug: slug.value, defaultBranch: await defaultBranch(process, repo), branches });
  } finally { opened.value.close(); }
}

async function detectProvider(process: ProcessAdapter, repo: string, override?: Provider): Promise<Result<Provider>> {
  if (override !== undefined) return ok(override);
  const remote = await git(process, repo, ["remote", "get-url", "origin"]);
  if (remote.kind !== "ok") return failed("origin remote is missing");
  if (/github\.[^/:]+[:/]/i.test(remote.value.stdout)) return ok("github");
  if (/gitlab\.[^/:]+[:/]/i.test(remote.value.stdout)) return ok("gitlab");
  return failed(`unsupported forge in origin URL: ${remote.value.stdout.trim()} (use --provider github|gitlab)`);
}

async function gh(process: ProcessAdapter, repo: string, args: readonly string[]) {
  const auth = await run(process, "gh", ["auth", "status"], repo);
  if (auth.kind !== "ok") return failed(auth.error.includes("not found") ? "gh CLI is not installed" : "gh CLI is not authenticated");
  return run(process, "gh", args, repo);
}

async function glab(process: ProcessAdapter, repo: string, args: readonly string[]) {
  const auth = await run(process, "glab", ["auth", "status"], repo);
  if (auth.kind !== "ok") return failed(auth.error.includes("not found") ? "glab CLI is not installed" : "glab CLI is not authenticated");
  return run(process, "glab", args, repo);
}

function encodedProject(slug: string): string { return encodeURIComponent(slug); }

async function listGitLabMRs(process: ProcessAdapter, repo: string): Promise<Result<GitLabMR[]>> {
  const result = await glab(process, repo, ["mr", "list", "--state", "all", "--output", "json", "--per-page", "100"]);
  if (result.kind !== "ok") return failed(result.error);
  try {
    const parsed = JSON.parse(result.value.stdout) as GitLabMR[];
    return Array.isArray(parsed) ? ok(parsed) : failed("glab mr list returned invalid JSON");
  } catch { return failed("glab mr list returned invalid JSON"); }
}

async function gitLabProject(process: ProcessAdapter, data: StackData): Promise<{ id: number | string; merge_trains_enabled?: boolean } | undefined> {
  const result = await glab(process, data.repo, ["api", `projects/${encodedProject(data.slug)}`]);
  if (result.kind !== "ok") return undefined;
  try { return JSON.parse(result.value.stdout) as { id: number | string; merge_trains_enabled?: boolean }; }
  catch { return undefined; }
}

async function gitLabDependenciesAvailable(process: ProcessAdapter, data: StackData, mr: GitLabMR): Promise<boolean> {
  const result = await glab(process, data.repo, ["api", `projects/${encodedProject(data.slug)}/merge_requests/${mr.iid}/blocks`]);
  return result.kind === "ok";
}

async function gitLabShow(process: ProcessAdapter, data: StackData): Promise<Result<string>> {
  const list = await listGitLabMRs(process, data.repo);
  if (list.kind !== "ok") return list;
  const project = await gitLabProject(process, data);
  const entries = data.branches.map((branch, index) => ({
    index: index + 1,
    branch: branch.branch,
    parent: branch.parentBranch,
    mergeRequest: list.value.find((mr) => mr.source_branch === branch.branch) ?? null,
  }));
  const firstMR = entries.find((entry) => entry.mergeRequest !== null)?.mergeRequest;
  const dependenciesAvailable = firstMR === undefined || firstMR === null
    ? false
    : await gitLabDependenciesAvailable(process, data, firstMR);
  return ok(output({ provider: "gitlab", defaultBranch: data.defaultBranch, mergeTrains: project?.merge_trains_enabled ?? "unknown",
    mergeRequestDependencies: dependenciesAvailable ? "available" : "unavailable on this project or account", branches: entries }));
}

async function gitLabPR(process: ProcessAdapter, data: StackData, draft: boolean): Promise<Result<string>> {
  const listed = await listGitLabMRs(process, data.repo);
  if (listed.kind !== "ok") return listed;
  const merged: GitLabMR[] = [];
  for (const [index, branch] of data.branches.entries()) {
    const target = branch.parentBranch ?? data.defaultBranch;
    const description = `Stack: ${index + 1}/${data.branches.length}\n\nDepends on ${target}.`;
    const existing = listed.value.find((mr) => mr.source_branch === branch.branch && mr.state === "opened");
    let mr: GitLabMR;
    if (existing !== undefined) {
      const updated = await glab(process, data.repo, ["mr", "update", String(existing.iid), "--target-branch", target, "--description", description]);
      if (updated.kind !== "ok") return failed(`could not update MR for ${branch.branch}: ${updated.error}`);
      mr = { ...existing, target_branch: target };
    } else {
      const created = await glab(process, data.repo, ["mr", "create", "--source-branch", branch.branch, "--target-branch", target,
        "--title", branch.branch, "--description", description, "--yes", ...(draft ? ["--draft"] : [])]);
      if (created.kind !== "ok") return failed(`could not create MR for ${branch.branch}: ${created.error}`);
      const iid = Number(created.value.stdout.match(/merge_requests\/(\d+)/)?.[1]);
      if (!Number.isInteger(iid) || iid < 1) return failed(`glab mr create did not return an MR number for ${branch.branch}`);
      mr = { iid, source_branch: branch.branch, target_branch: target, state: "opened", web_url: created.value.stdout.trim() };
    }
    merged.push(mr);
  }
  let dependencies = false;
  if (merged.length > 1) dependencies = await gitLabDependenciesAvailable(process, data, merged[1]!);
  if (dependencies) {
    for (let i = 1; i < merged.length; i++) {
      const child = merged[i]!;
      const parent = merged[i - 1]!;
      const result = await glab(process, data.repo, ["api", "--method", "POST",
        `projects/${encodedProject(data.slug)}/merge_requests/${child.iid}/blocks`, `--field=blocking_merge_request_iid=${parent.iid}`]);
      if (result.kind !== "ok") return failed(`could not record MR dependency ${parent.iid} -> ${child.iid}: ${result.error}`);
    }
  }
  return ok(output({ provider: "gitlab", mergeRequestDependencies: dependencies, mergeRequests: merged }));
}

async function nativeStacks(process: ProcessAdapter, repo: string, slug: string): Promise<{ available: boolean; stacks: GitHubStack[]; error?: string }> {
  const result = await gh(process, repo, ["api", `repos/${slug}/stacks`]);
  if (result.kind !== "ok") {
    if (/403|forbidden|401|unauthorized/i.test(result.error)) return { available: false, stacks: [], error: result.error };
    return { available: false, stacks: [] };
  }
  try {
    const parsed = JSON.parse(result.value.stdout) as GitHubStack[];
    if (!Array.isArray(parsed)) return { available: false, stacks: [], error: "GitHub stacks API returned an invalid response" };
    return { available: true, stacks: parsed };
  } catch { return { available: false, stacks: [], error: "GitHub stacks API returned invalid JSON" }; }
}

async function listPulls(process: ProcessAdapter, repo: string): Promise<Result<GitHubPull[]>> {
  const result = await gh(process, repo, ["pr", "list", "--state", "all", "--json", "number,headRefName,baseRefName,url,state,reviewDecision,statusCheckRollup", "--limit", "100"]);
  if (result.kind !== "ok") return failed(result.error);
  try { return ok(JSON.parse(result.value.stdout) as GitHubPull[]); }
  catch { return failed("gh pr list returned invalid JSON"); }
}

async function createPulls(process: ProcessAdapter, data: StackData, draft: boolean, pulls: GitHubPull[]): Promise<Result<GitHubPull[]>> {
  const created: GitHubPull[] = [];
  for (let i = 0; i < data.branches.length; i++) {
    const branch = data.branches[i]!;
    const parent = branch.parentBranch ?? data.defaultBranch;
    const body = `Stack: ${i + 1}/${data.branches.length}\n\nDepends on ${parent}.`;
    const existing = pulls.find((item) => item.headRefName === branch.branch && item.state?.toUpperCase() !== "CLOSED");
    const command = existing === undefined
      ? ["pr", "create", "--head", branch.branch, "--base", parent, "--title", branch.branch, "--body", body, ...(draft ? ["--draft"] : [])]
      : ["pr", "edit", branch.branch, "--base", parent, "--body", body];
    const result = await gh(process, data.repo, command);
    if (result.kind !== "ok") return failed(`could not create or update PR for ${branch.branch}: ${result.error}`);
    if (existing !== undefined) created.push(existing);
    else {
      const url = result.value.stdout.trim();
      const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
      if (!Number.isFinite(number) || number <= 0) return failed(`gh pr create did not return a pull request number for ${branch.branch}`);
      created.push({ number, headRefName: branch.branch, baseRefName: parent, url, state: "OPEN" });
    }
  }
  return ok(created);
}

async function createNativeStack(process: ProcessAdapter, data: StackData, pulls: GitHubPull[], existingStacks: GitHubStack[]): Promise<Result<null>> {
  const numbers = pulls.map((pull) => String(pull.number));
  const current = existingStacks.find((stack) => stack.pull_requests.some((pull) => pull.number === pulls[0]?.number));
  const missing = current === undefined ? numbers : numbers.filter((number) => !current.pull_requests.some((pull) => pull.number === Number(number)));
  if (missing.length === 0) return ok(null);
  const endpoint = current === undefined ? `repos/${data.slug}/stacks` : `repos/${data.slug}/stacks/${current.number}/add`;
  const args = ["api", "--method", "POST", endpoint, ...missing.map((number) => `--field=pull_requests[]=${number}`)];
  const result = await gh(process, data.repo, args);
  return result.kind === "ok" ? ok(null) : failed(`GitHub could not create the native pull request stack: ${result.error}`);
}

async function show(process: ProcessAdapter, environment: Environment, repoOption: string | undefined, override?: Provider): Promise<Result<string>> {
  const data = await dataFor(process, environment, repoOption);
  if (data.kind !== "ok") return data;
  const provider = await detectProvider(process, data.value.repo, override);
  if (provider.kind !== "ok") return provider;
  if (provider.value === "gitlab") return gitLabShow(process, data.value);
  const capability = await nativeStacks(process, data.value.repo, data.value.slug);
  if (capability.error !== undefined) return failed(capability.error);
  const pulls = await listPulls(process, data.value.repo);
  if (pulls.kind !== "ok") return pulls;
  const entries = data.value.branches.map((branch, index) => ({
    index: index + 1,
    branch: branch.branch,
    parent: branch.parentBranch,
    behindParent: undefined as number | undefined,
    pullRequest: pulls.value.find((pull) => pull.headRefName === branch.branch) ?? null,
  }));
  for (const entry of entries) {
    const behind = await git(process, data.value.repo, ["rev-list", "--count", `${entry.branch}..${entry.parent ?? data.value.defaultBranch}`]);
    if (behind.kind === "ok") entry.behindParent = Number(behind.value.stdout.trim());
  }
  const extensions = await gh(process, data.value.repo, ["extension", "list"]);
  const ghStackInstalled = extensions.kind === "ok" && /github\/gh-stack/.test(extensions.value.stdout);
  return ok(output({ provider: provider.value, nativeStacks: capability.available, ghStackInstalled, defaultBranch: data.value.defaultBranch, branches: entries }));
}

async function pr(process: ProcessAdapter, environment: Environment, repoOption: string | undefined, draft: boolean, override?: Provider): Promise<Result<string>> {
  const data = await dataFor(process, environment, repoOption);
  if (data.kind !== "ok") return data;
  if (data.value.branches.length === 0) return failed("no registered stack branches were found");
  const provider = await detectProvider(process, data.value.repo, override);
  if (provider.kind !== "ok") return provider;
  if (provider.value === "gitlab") return gitLabPR(process, data.value, draft);
  const capability = await nativeStacks(process, data.value.repo, data.value.slug);
  if (capability.error !== undefined) return failed(capability.error);
  const pulls = await listPulls(process, data.value.repo);
  if (pulls.kind !== "ok") return pulls;
  const created = await createPulls(process, data.value, draft, pulls.value);
  if (created.kind !== "ok") return created;
  if (capability.available) {
    const stacked = await createNativeStack(process, data.value, created.value, capability.stacks);
    if (stacked.kind !== "ok") return stacked;
  }
  return ok(output({ provider: provider.value, nativeStacks: capability.available, pullRequests: created.value }));
}

async function plan(process: ProcessAdapter, data: StackData, action: string, yes: boolean): Promise<Result<string>> {
  const lines = data.branches.map((item, i) => `${i + 1}. ${action} ${item.branch} on ${item.parentBranch ?? data.defaultBranch}`);
  const text = `${lines.join("\n")}\n`;
  if (!yes) return failed(`${text}No changes made. Repeat with --yes to confirm.`);
  return ok(text);
}

async function sync(process: ProcessAdapter, environment: Environment, repoOption: string | undefined, yes: boolean, override?: Provider): Promise<Result<string>> {
  const data = await dataFor(process, environment, repoOption);
  if (data.kind !== "ok") return data;
  if (data.value.branches.length === 0) return failed("no registered stack branches were found");
  const shown = await plan(process, data.value, "rebase and push", yes);
  if (shown.kind !== "ok") return shown;
  const provider = await detectProvider(process, data.value.repo, override);
  if (provider.kind !== "ok") return provider;
  const targetByBranch = new Map<string, string>();
  if (provider.value === "gitlab") {
    const listed = await listGitLabMRs(process, data.value.repo);
    if (listed.kind !== "ok") return listed;
    for (const branch of data.value.branches) {
      const parent = branch.parentBranch ?? data.value.defaultBranch;
      const parentMR = listed.value.find((mr) => mr.source_branch === parent);
      const target = parentMR?.state === "merged" ? data.value.defaultBranch : parent;
      targetByBranch.set(branch.branch, target);
      const mr = listed.value.find((item) => item.source_branch === branch.branch && item.state === "opened");
      if (mr !== undefined && mr.target_branch !== target) {
        const updated = await glab(process, data.value.repo, ["mr", "update", String(mr.iid), "--target-branch", target]);
        if (updated.kind !== "ok") return failed(`could not retarget MR !${mr.iid} to ${target}: ${updated.error}`);
      }
    }
  }
  const refs = [data.value.defaultBranch, ...data.value.branches.map((item) => item.branch)];
  const refspecs = [...new Set(refs)].map((ref) => `+refs/heads/${ref}:refs/remotes/origin/${ref}`);
  const fetched = await git(process, data.value.repo, ["fetch", "origin", ...refspecs]);
  if (fetched.kind !== "ok") return failed(`could not fetch origin: ${fetched.error}`);
  for (const branch of data.value.branches) {
    const parent = targetByBranch.get(branch.branch) ?? branch.parentBranch ?? data.value.defaultBranch;
    const parentRemote = await git(process, data.value.repo, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${parent}`]);
    const base = parentRemote.kind === "ok" ? `origin/${parent}` : `origin/${data.value.defaultBranch}`;
    const rebased = await git(process, branch.path, ["rebase", base]);
    if (rebased.kind !== "ok") {
      const status = await git(process, branch.path, ["diff", "--name-only", "--diff-filter=U"]);
      const files = status.kind === "ok" ? status.value.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
      await git(process, branch.path, ["rebase", "--abort"]);
      return failed(`rebase stopped on ${branch.branch}; resolve conflicts in: ${files.join(", ") || "unknown files"}`);
    }
    const pushed = await git(process, branch.path, ["push", "--force-with-lease", "origin", `${branch.branch}:${branch.branch}`]);
    if (pushed.kind !== "ok") return failed(`could not push ${branch.branch} with --force-with-lease: ${pushed.error}`);
  }
  return ok(`${shown.value}Stack synced.\n`);
}

async function assertPushed(process: ProcessAdapter, data: StackData): Promise<Result<null>> {
  for (const branch of data.branches) {
    const upstream = await git(process, data.repo, ["rev-parse", "--verify", `refs/remotes/origin/${branch.branch}`]);
    if (upstream.kind !== "ok") return failed(`cannot merge ${branch.branch}: origin/${branch.branch} is missing; push it first`);
    const ahead = await git(process, branch.path, ["rev-list", `origin/${branch.branch}..${branch.branch}`]);
    if (ahead.kind !== "ok") return failed(`cannot compare local and remote commits for ${branch.branch}`);
    if (ahead.value.stdout.trim()) return failed(`cannot merge: ${branch.branch} has unpushed local commits`);
  }
  return ok(null);
}

async function waitForGitLabMerge(process: ProcessAdapter, environment: Environment, repo: string, iid: number): Promise<Result<null>> {
  const timeout = Number(environment.MEGABRAIN_STACK_MERGE_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + Math.max(1_000, timeout);
  while (Date.now() < deadline) {
    const result = await glab(process, repo, ["mr", "view", String(iid), "--output", "json"]);
    if (result.kind !== "ok") return failed(`could not check MR !${iid}: ${result.error}`);
    let mr: GitLabMR;
    try { mr = JSON.parse(result.value.stdout) as GitLabMR; }
    catch { return failed(`glab mr view returned invalid JSON for !${iid}`); }
    if (mr.state === "merged") return ok(null);
    if (mr.state === "closed") return failed(`MR !${iid} was closed without merging`);
    globalThis.process.stderr.write(`GitLab MR !${iid} is waiting for its pipeline or merge train.\n`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  return failed(`GitLab MR !${iid} is still pending; check its pipeline and merge train`);
}

async function mergeGitLab(process: ProcessAdapter, environment: Environment, data: StackData): Promise<Result<string>> {
  const project = await gitLabProject(process, data);
  if (project === undefined || project.id === undefined) return failed("could not read GitLab project settings");
  const listed = await listGitLabMRs(process, data.repo);
  if (listed.kind !== "ok") return listed;
  const open = data.branches.map((branch) => {
    const mr = listed.value.find((item) => item.source_branch === branch.branch && item.state === "opened");
    return { branch, mr };
  });
  const absent = open.find((item) => item.mr === undefined);
  if (absent !== undefined) return failed(`no open merge request found for ${absent.branch.branch}`);
  for (let index = 0; index < open.length; index++) {
    const entry = open[index]!;
    const mr = entry.mr!;
    if (project.merge_trains_enabled) {
      const queued = await glab(process, data.repo, ["api", "--method", "POST", `projects/${project.id}/merge_trains/merge_requests/${mr.iid}`]);
      if (queued.kind !== "ok") return failed(`could not add MR !${mr.iid} to the GitLab merge train: ${queued.error}`);
    } else {
      const merged = await glab(process, data.repo, ["mr", "merge", String(mr.iid), "--yes"]);
      if (merged.kind !== "ok") return failed(`could not merge MR !${mr.iid}: ${merged.error}`);
    }
    const completed = await waitForGitLabMerge(process, environment, data.repo, mr.iid);
    if (completed.kind !== "ok") return completed;
    const next = open[index + 1];
    if (next !== undefined) {
      const latest = await listGitLabMRs(process, data.repo);
      if (latest.kind !== "ok") return latest;
      const current = latest.value.find((item) => item.iid === next.mr!.iid);
      if (current !== undefined && current.target_branch !== data.defaultBranch) {
        const retargeted = await glab(process, data.repo, ["mr", "update", String(current.iid), "--target-branch", data.defaultBranch]);
        if (retargeted.kind !== "ok") return failed(`MR !${mr.iid} merged, but could not retarget !${current.iid} to ${data.defaultBranch}: ${retargeted.error}`);
      }
    }
  }
  return ok(project.merge_trains_enabled ? "Merge requests were added bottom-up to the GitLab merge train and completed.\n" : "Merge requests completed bottom-up.\n");
}

async function merge(process: ProcessAdapter, environment: Environment, repoOption: string | undefined, yes: boolean, override?: Provider): Promise<Result<string>> {
  const data = await dataFor(process, environment, repoOption);
  if (data.kind !== "ok") return data;
  if (data.value.branches.length === 0) return failed("no registered stack branches were found");
  const shown = await plan(process, data.value, "merge", yes);
  if (shown.kind !== "ok") return shown;
  const pushed = await assertPushed(process, data.value);
  if (pushed.kind !== "ok") return pushed;
  const provider = await detectProvider(process, data.value.repo, override);
  if (provider.kind !== "ok") return provider;
  if (provider.value === "gitlab") return mergeGitLab(process, environment, data.value);
  const pulls = await listPulls(process, data.value.repo);
  if (pulls.kind !== "ok") return pulls;
  const top = data.value.branches.at(-1)!;
  const pull = pulls.value.find((item) => item.headRefName === top.branch);
  if (!pull) return failed(`no pull request found for ${top.branch}`);
  const capability = await nativeStacks(process, data.value.repo, data.value.slug);
  if (capability.error !== undefined) return failed(capability.error);
  if (!capability.available) {
    for (const branch of data.value.branches) {
      const current = pulls.value.find((item) => item.headRefName === branch.branch);
      if (!current) return failed(`no pull request found for ${branch.branch}`);
      const merged = await gh(process, data.value.repo, ["pr", "merge", String(current.number), "--squash"]);
      if (merged.kind !== "ok") return failed(`could not merge ${branch.branch}: ${merged.error}`);
      const next = data.value.branches[data.value.branches.indexOf(branch) + 1];
      if (next) {
        const edited = await gh(process, data.value.repo, ["pr", "edit", next.branch, "--base", data.value.defaultBranch]);
        if (edited.kind !== "ok") return failed(`merged ${branch.branch}, but could not retarget ${next.branch}: ${edited.error}`);
      }
    }
    return ok(`${shown.value}Stack merged bottom-up.\n`);
  }
  const requested = await gh(process, data.value.repo, ["api", "--method", "PUT", `repos/${data.value.slug}/pulls/${pull.number}/merge-async`, "--field=merge_method=squash"]);
  if (requested.kind !== "ok") return failed(`could not start asynchronous stack merge: ${requested.error}`);
  let response: { status?: string; details?: { uuid?: string; message?: string } };
  try { response = JSON.parse(requested.value.stdout) as typeof response; }
  catch { return failed("GitHub returned invalid asynchronous merge status"); }
  if (response.status === "merged" || response.status === "enqueued") return ok(`${shown.value}GitHub stack merge status: ${response.status}.\n`);
  const uuid = response.details?.uuid;
  if (!uuid) return failed(`GitHub accepted the stack merge without a status UUID; inspect PR #${pull.number}`);
  const timeout = Number(environment.MEGABRAIN_STACK_MERGE_TIMEOUT_MS ?? 120_000);
  const deadline = Date.now() + Math.max(1_000, timeout);
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    const polled = await gh(process, data.value.repo, ["api", `repos/${data.value.slug}/pulls/${pull.number}/merge-async/${uuid}`]);
    if (polled.kind !== "ok") return failed(`could not poll GitHub stack merge ${uuid}: ${polled.error}`);
    try { response = JSON.parse(polled.value.stdout) as typeof response; }
    catch { return failed("GitHub returned invalid asynchronous merge status"); }
    if (response.status === "merged") return ok(`${shown.value}GitHub stack merge completed.\n`);
    if (response.status === "enqueued") return ok(`${shown.value}GitHub stack was added to the merge queue.\n`);
    if (response.status === "failed") return failed(`GitHub stack merge failed: ${response.details?.message ?? "check the pull request"}`);
    globalThis.process.stderr.write(`GitHub stack merge is pending (PR #${pull.number}).\n`);
  }
  return failed(`GitHub stack merge is still pending; inspect PR #${pull.number} (request ${uuid})`);
}

export async function executeStack(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const parsed = parseOptions(args);
  if (parsed.kind !== "ok") return parsed;
  const { action, values, yes, draft, repo: repoOption, provider } = parsed.value;
  if (action === "create") {
    const branch = values[0];
    let parent: string | undefined;
    const on = values.indexOf("--on");
    if (on >= 0) parent = values[on + 1];
    if (!branch || !parent) return failed("Usage: megabrain stack create <branch> --on <parent> [--repo <path>]", 2);
    const repo = await dataFor(process, environment, repoOption);
    if (repo.kind !== "ok") return repo;
    const created = await executeWorktreeCreate(["--repo", repo.value.repo, "--branch", branch, "--parent", `branch:${parent}`, "--base", parent, "--json"], environment, process);
    if (created.kind !== "ok") return created;
    const opened = openDatabase(environment);
    if (opened.kind !== "ok") return failed(opened.error);
    try {
      const saved = withWrite(opened.value, (db) => db.run("UPDATE worktrees SET parent_branch = ? WHERE branch = ? AND repo = ?", [parent, branch, repo.value.repo]));
      if (saved.kind !== "ok") return failed(saved.error);
    } finally { opened.value.close(); }
    return created;
  }
  if (action === "show") return show(process, environment, repoOption, provider);
  if (action === "pr") return pr(process, environment, repoOption, draft, provider);
  if (action === "sync") return sync(process, environment, repoOption, yes, provider);
  if (action === "merge") return merge(process, environment, repoOption, yes, provider);
  return failed(`unknown stack action: ${action}`, 2);
}
