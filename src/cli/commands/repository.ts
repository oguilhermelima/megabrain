import { existsSync, mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { expandRepositoryUrl, repositoryCheckout } from "../../core/project-registry.js";
import { failed, ok, type Result } from "../../core/result.js";
import { openDatabase, withWrite, type DatabaseAdapter, type Synchronous } from "../../db/db.js";
import { listRepositories, registerRepository, removeRepository, type RepositoryRecord } from "../../db/queries/repositories.js";
import { backfillProjectHistory } from "./projects.js";
import { usageText } from "../../core/usage.js";

type Environment = Readonly<Record<string, string | undefined>>;
type GithubRepository = Readonly<{ nameWithOwner: string; url: string; description: string | null; isPrivate: boolean; updatedAt: string | null }>;

function parseRepository(record: Readonly<{ name: string; path: string; remote: string | null; source: "megabrain" | "import"; addedAt: string }>, json: boolean): string {
  return json ? `${JSON.stringify(record, null, 2)}\n` : `${record.name}\t${record.path}\n`;
}

function databaseAction<T>(environment: Environment, action: Synchronous<T>): Result<T> {
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try {
    return withWrite(opened.value, action);
  } finally { opened.value.close(); }
}

function databaseRead<T>(environment: Environment, action: (database: DatabaseAdapter) => T): Result<T> {
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try { return ok(action(opened.value.db)); }
  catch (cause: unknown) { return failed(cause instanceof Error ? cause.message : String(cause)); }
  finally { opened.value.close(); }
}

async function addRepository(path: string, source: "megabrain" | "import", environment: Environment, process: ProcessAdapter): Promise<Result<RepositoryRecord>> {
  const checkout = await repositoryCheckout(path, process);
  if (checkout.kind !== "ok") return checkout;
  return databaseAction(environment, (db) => registerRepository(db, { ...checkout.value, source, addedAt: new Date().toISOString() }));
}

export async function executeRepository(args: readonly string[], environment: Environment, process = createProcessAdapter()): Promise<Result<string>> {
  const [verb, ...rest] = args;
  if (args.includes("-h") || args.includes("--help")) {
    const key = verb === "list" ? "repo-list" : verb === "add" ? "repo-add" : verb === "clone" ? "repo-clone" : verb === "remove" ? "repo-remove" : verb === "github" ? "repo-github" : "repo";
    return ok(usageText(key));
  }
  const json = rest.includes("--json");
  const backfilled = await backfillProjectHistory(environment, process);
  if (backfilled.kind !== "ok") return backfilled;
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
    const cloned = await process.run("git", ["clone", url, destination]);
    if (cloned.kind !== "ok") return failed(`git clone failed: ${cloned.error}`, cloned.exitCode);
    const added = await addRepository(destination, "import", environment, process);
    return added.kind === "ok" ? ok(parseRepository(added.value, json)) : added;
  }
  if (verb === "remove") {
    const selector = rest.find((argument) => !argument.startsWith("-"));
    if (selector === undefined) return failed("Usage: megabrain repo remove <name|path> [--json]", 2);
    const pathSelector = await realpath(selector).catch(() => selector);
    const removed = databaseAction(environment, (db) => {
      const exactPath = listRepositories(db).find((repository) => repository.path === pathSelector);
      const matches = exactPath === undefined ? listRepositories(db).filter((repository) => repository.name === selector) : [exactPath];
      if (matches.length > 1) throw new Error(`repository name is ambiguous: ${selector}; use a path`);
      return matches[0] === undefined ? undefined : removeRepository(db, matches[0].path);
    });
    if (removed.kind !== "ok") return removed;
    if (removed.value === undefined) return failed(`repository not found: ${selector}`);
    return ok(json ? `${JSON.stringify({ removed: removed.value }, null, 2)}\n` : `removed ${removed.value.name} from registry\n`);
  }
  if (verb === "github") {
    let owner: string | undefined;
    const ownerIndex = rest.indexOf("--owner");
    if (ownerIndex >= 0) owner = rest[ownerIndex + 1];
    if (ownerIndex >= 0 && (owner === undefined || owner === "")) return failed("--owner requires a GitHub login", 2);
    const auth = await process.run("gh", ["auth", "status"]);
    if (auth.kind !== "ok") return failed(auth.error.includes("not found") ? "GitHub CLI (gh) is required; install it and sign in with gh auth login" : "GitHub CLI is not signed in; run gh auth login");
    const listed = await process.run("gh", ["repo", "list", ...(owner === undefined ? [] : [owner]), "--json", "nameWithOwner,url,description,isPrivate,updatedAt", "--limit", "200"]);
    if (listed.kind !== "ok") return failed(`could not list GitHub repositories: ${listed.error}`);
    try {
      const repositories = JSON.parse(listed.value.stdout) as GithubRepository[];
      return ok(json ? `${JSON.stringify(repositories, null, 2)}\n` : repositories.map((repository) => `${repository.nameWithOwner}\t${repository.url}\n`).join(""));
    } catch { return failed("gh repo list returned invalid JSON"); }
  }
  return failed("Usage: megabrain repo list|add|clone|remove|github ...", 2);
}
