import { existsSync, mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { expandRepositoryUrl, repositoryCheckout } from "../../core/project-registry.js";
import { projectScripts, setProjectScripts, type SavedProjectScripts } from "../../core/project-scripts.js";
import { detectScriptPort } from "../../core/script-port.js";
import { failed, ok, type Result } from "../../core/result.js";
import { openDatabaseReadOnly, type DatabaseAdapter } from "../../db/db.js";
import { listRepositories, type RepositoryRecord } from "../../db/queries/repositories.js";
import { resolveStateDirectory } from "../../core/state.js";
import { callStateOwner } from "../../db/state-owner.js";
import { executeRepoRun, executeRepoStop, resolveRepositoryPath } from "./repo-run.js";
import { backfillProjectHistory } from "./projects.js";
import { usageText } from "../../core/usage.js";
import { defaultRoots, discoverRepositories } from "../../core/repository-discovery.js";

type Environment = Readonly<Record<string, string | undefined>>;
type GithubRepository = Readonly<{ nameWithOwner: string; url: string; description: string | null; isPrivate: boolean; updatedAt: string | null; primaryLanguage?: { name: string } | null; stargazerCount?: number }>;
/** The signed-in login or one of its organisations: an owner whose repositories `repo github --owner` lists. */
type GithubOwner = Readonly<{ login: string; kind: "user" | "organization"; avatarUrl: string | null }>;
type GithubAccount = Readonly<{ login: string; avatar_url?: string | null }>;

function parseRepository(record: Readonly<{ name: string; path: string; remote: string | null; source: "megabrain" | "import"; addedAt: string }>, json: boolean): string {
  return json ? `${JSON.stringify(record, null, 2)}\n` : `${record.name}\t${record.path}\n`;
}

function databaseRead<T>(environment: Environment, action: (database: DatabaseAdapter) => T): Result<T> {
  const opened = openDatabaseReadOnly(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try { return ok(action(opened.value.db)); }
  catch (cause: unknown) { return failed(cause instanceof Error ? cause.message : String(cause)); }
  finally { opened.value.close(); }
}

async function addRepository(path: string, source: "megabrain" | "import", environment: Environment, process: ProcessAdapter): Promise<Result<RepositoryRecord>> {
  const checkout = await repositoryCheckout(path, process);
  if (checkout.kind !== "ok") return checkout;
  try {
    return { kind: "ok", value: await callStateOwner(resolveStateDirectory(environment), { operation: "repository-register", repository: { ...checkout.value, source, addedAt: new Date().toISOString() } }) as RepositoryRecord };
  } catch (cause: unknown) { return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
}

export async function executeRepository(args: readonly string[], environment: Environment, process = createProcessAdapter()): Promise<Result<string>> {
  const [verb, ...rest] = args;
  if (args.includes("-h") || args.includes("--help")) {
    const key = verb === "list" ? "repo-list" : verb === "add" ? "repo-add" : verb === "clone" ? "repo-clone" : verb === "remove" ? "repo-remove" : verb === "scripts" ? "repo-scripts" : verb === "run" ? "repo-run" : verb === "stop" ? "repo-stop" : verb === "github" ? "repo-github" : verb === "discover" ? "repo-discover" : "repo";
    return ok(usageText(key));
  }
  const json = rest.includes("--json");
  if (verb === "run") return executeRepoRun(rest, environment, process);
  if (verb === "stop") return executeRepoStop(rest, environment, process);
  if (verb === "scripts") {
    let selector: string | undefined;
    const changes: SavedProjectScripts = {};
    const seen = new Set<string>();
    for (let index = 0; index < rest.length; index += 1) {
      const argument = rest[index];
      if (argument === "--json") continue;
      if (argument === "--run" || argument === "--build" || argument === "--install") {
        if (seen.has(argument)) return failed(`${argument} may only be supplied once`, 2);
        seen.add(argument);
        const value = rest[index + 1];
        if (value === undefined || value.startsWith("--")) return failed(`${argument} requires a command (use an empty string to clear it)`, 2);
        changes[argument.slice(2) as keyof SavedProjectScripts] = value;
        index += 1;
        continue;
      }
      if (argument.startsWith("-")) return failed(`unknown option for repo scripts: ${argument}`, 2);
      if (selector !== undefined) return failed(`unexpected repo scripts argument: ${argument}`, 2);
      selector = argument;
    }
    if (selector === undefined) return failed("Usage: megabrain repo scripts <name|path> [--run <cmd>] [--build <cmd>] [--install <cmd>] [--json]", 2);
    const resolved = await resolveRepositoryPath(selector, environment, process);
    if (resolved.kind !== "ok") return resolved;
    const repoPath = resolved.value;
    const scripts = Object.keys(changes).length > 0
      ? await setProjectScripts(repoPath, changes, environment)
      : await projectScripts(repoPath, environment);
    // The port comes from the checkout asked about, since a worktree can carry its own .env.
    const port = detectScriptPort(existsSync(selector) ? resolve(selector) : repoPath, scripts.run?.command);
    return ok(`${JSON.stringify({ repo: repoPath, scripts, port }, null, 2)}\n`);
  }
  const backfilled = await backfillProjectHistory(environment, process);
  if (backfilled.kind !== "ok") return backfilled;
  if (verb === "discover") {
    const rootsIndex = rest.indexOf("--roots");
    const rootsArgument = rootsIndex < 0 ? undefined : rest[rootsIndex + 1];
    if (rootsIndex >= 0 && (rootsArgument === undefined || rootsArgument.startsWith("--"))) return failed("--roots requires a comma-separated list of folders", 2);
    const records = databaseRead(environment, listRepositories);
    if (records.kind !== "ok") return records;
    const registered = records.value.map((record) => record.path);
    const home = environment.HOME ?? "";
    const roots = rootsArgument === undefined
      ? defaultRoots(home, registered)
      : rootsArgument.split(",").map((root) => root.trim()).filter((root) => root !== "").map((root) => resolve(root.replace(/^~(?=$|\/)/, home)));
    const found = await discoverRepositories({ roots, registered }, process);
    return ok(json ? `${JSON.stringify(found, null, 2)}\n` : found.map((repository) => `${repository.name}\t${repository.path}\n`).join(""));
  }
  if (verb === "list") {
    const records = databaseRead(environment, listRepositories);
    if (records.kind !== "ok") return records;
    return ok(json ? `${JSON.stringify(records.value, null, 2)}\n` : records.value.map((record) => parseRepository(record, false)).join(""));
  }
  if (verb === "add") {
    const path = rest.find((argument) => !argument.startsWith("-"));
    if (path === undefined) return failed("Usage: megabrain repo add <path> [--json]", 2);
    const added = await addRepository(path, "import", environment, process);
    return added.kind === "ok" ? ok(parseRepository(added.value, json)) : added;
  }
  if (verb === "clone") {
    const urlArgument = rest.find((argument) => !argument.startsWith("-"));
    const intoIndex = rest.indexOf("--into");
    const into = intoIndex < 0 ? undefined : rest[intoIndex + 1];
    if (urlArgument === undefined || into === undefined || into === "") return failed("Usage: megabrain repo clone <url> --into <dir> [--json]", 2);
    const url = expandRepositoryUrl(urlArgument);
    const name = basename(url.replace(/\.git$/, "").replace(/\/$/, ""));
    if (name === "" || name === "." || name === "/") return failed(`invalid repository URL: ${urlArgument}`, 2);
    const parent = into;
    const destination = join(parent, name);
    if (existsSync(destination)) return failed(`clone destination already exists: ${destination}`);
    try { mkdirSync(parent, { recursive: true }); }
    catch (cause: unknown) { return failed(`could not create clone directory: ${cause instanceof Error ? cause.message : String(cause)}`); }
    const cloned = await process.run("git", ["clone", url, destination], { timeoutMs: 20 * 60_000 });
    if (cloned.kind !== "ok") return failed(`git clone failed: ${cloned.error}`, cloned.exitCode);
    const added = await addRepository(destination, "import", environment, process);
    return added.kind === "ok" ? ok(parseRepository(added.value, json)) : added;
  }
  if (verb === "remove") {
    const selector = rest.find((argument) => !argument.startsWith("-"));
    if (selector === undefined) return failed("Usage: megabrain repo remove <name|path> [--json]", 2);
    const pathSelector = await realpath(selector).catch(() => selector);
    const records = databaseRead(environment, listRepositories);
    if (records.kind !== "ok") return records;
    const exactPath = records.value.find((repository) => repository.path === pathSelector);
    const matches = exactPath === undefined ? records.value.filter((repository) => repository.name === selector) : [exactPath];
    if (matches.length > 1) return failed(`repository name is ambiguous: ${selector}; use a path`);
    if (matches[0] === undefined) return failed(`repository not found: ${selector}`);
    try {
      const removed = await callStateOwner(resolveStateDirectory(environment), { operation: "repository-remove", path: matches[0].path }) as RepositoryRecord | null;
      if (removed === null) return failed(`repository not found: ${selector}`);
      return ok(json ? `${JSON.stringify({ removed }, null, 2)}\n` : `removed ${removed.name} from registry\n`);
    } catch (cause: unknown) { return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  if (verb === "hide" || verb === "unhide") {
    const selector = rest.find((argument) => !argument.startsWith("-"));
    if (selector === undefined) return failed(`Usage: megabrain repo ${verb} <name|path>`, 2);
    const pathSelector = await realpath(selector).catch(() => selector);
    const records = databaseRead(environment, listRepositories);
    if (records.kind !== "ok") return records;
    const exact = records.value.find((repository) => repository.path === pathSelector);
    const matches = exact === undefined ? records.value.filter((repository) => repository.name === selector) : [exact];
    if (matches.length > 1) return failed(`repository name is ambiguous: ${selector}; use a path`);
    const repository = matches[0];
    if (repository === undefined) return failed(`repository not found: ${selector}`);
    try {
      await callStateOwner(resolveStateDirectory(environment), { operation: "hidden-item-write", kind: "repo", path: repository.path, hidden: verb === "hide" });
      return ok(`${verb === "hide" ? "hidden" : "shown"} ${repository.name}\n`);
    } catch (cause: unknown) { return failed(`state owner write failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  if (verb === "github") {
    let owner: string | undefined;
    const ownerIndex = rest.indexOf("--owner");
    if (ownerIndex >= 0) owner = rest[ownerIndex + 1];
    if (ownerIndex >= 0 && (owner === undefined || owner === "")) return failed("--owner requires a GitHub login", 2);
    const auth = await process.run("gh", ["auth", "status"], { timeoutMs: 2_000 });
    if (auth.kind !== "ok") return failed(auth.error.includes("not found") ? "GitHub CLI (gh) is required; install it and sign in with gh auth login" : "GitHub CLI is not signed in; run gh auth login");
    if (rest.includes("--orgs")) {
      const [user, orgs] = await Promise.all([
        process.run("gh", ["api", "user"], { timeoutMs: 2_000 }),
        process.run("gh", ["api", "user/orgs", "--paginate"], { timeoutMs: 2_000 }),
      ]);
      if (user.kind !== "ok") return failed(`could not read the GitHub account: ${user.error}`);
      if (orgs.kind !== "ok") return failed(`could not list GitHub organisations: ${orgs.error}`);
      try {
        const account = JSON.parse(user.value.stdout) as GithubAccount;
        const organisations = JSON.parse(orgs.value.stdout) as GithubAccount[];
        const owners: GithubOwner[] = [
          { login: account.login, kind: "user", avatarUrl: account.avatar_url ?? null },
          ...organisations.map((organisation): GithubOwner => ({ login: organisation.login, kind: "organization", avatarUrl: organisation.avatar_url ?? null })),
        ];
        return ok(json ? `${JSON.stringify(owners, null, 2)}\n` : owners.map((entry) => `${entry.login}\t${entry.kind}\n`).join(""));
      } catch { return failed("gh api returned invalid JSON"); }
    }
    const listed = await process.run("gh", ["repo", "list", ...(owner === undefined ? [] : [owner]), "--json", "nameWithOwner,url,description,isPrivate,updatedAt,primaryLanguage,stargazerCount", "--limit", "1000"], { timeoutMs: 2_000 });
    if (listed.kind !== "ok") return failed(`could not list GitHub repositories: ${listed.error}`);
    try {
      const repositories = JSON.parse(listed.value.stdout) as GithubRepository[];
      return ok(json ? `${JSON.stringify(repositories, null, 2)}\n` : repositories.map((repository) => `${repository.nameWithOwner}\t${repository.url}\n`).join(""));
    } catch { return failed("gh repo list returned invalid JSON"); }
  }
  return failed("Usage: megabrain repo list|add|clone|remove|hide|unhide|scripts|github|discover ...", 2);
}
