import { readFile } from "node:fs/promises";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveStateDirectory } from "./state.js";
import { openDatabaseReadOnly } from "../db/db.js";
import { listRepositories } from "../db/queries/repositories.js";
import type { ProcessAdapter } from "../adapters/proc.js";
import type { Clock } from "./clock.js";
import { resolve } from "node:path";

export type SimulatorOwner = { worktree: string; since: string };
export type SimulatorOwners = Record<string, SimulatorOwner>;

/** Return the registered main checkout for a project root or one of its git worktrees. */
export async function registeredProjectForWorktree(worktree: string, environment: Readonly<Record<string, string | undefined>>, processAdapter: ProcessAdapter): Promise<string | undefined> {
  const opened = openDatabaseReadOnly(environment);
  if (opened.kind !== "ok") return undefined;
  try {
    for (const repository of listRepositories(opened.value.db)) {
      const listed = await processAdapter.run("git", ["-C", repository.path, "worktree", "list", "--porcelain"]);
      if (listed.kind !== "ok") continue;
      const paths = listed.value.stdout.split(/\n(?=worktree )/).map((entry) => /^worktree (.+)$/m.exec(entry)?.[1]).filter((path): path is string => path !== undefined);
      if (paths.some((path) => resolve(path) === resolve(worktree))) return resolve(repository.path);
    }
  } finally { opened.value.close(); }
  return undefined;
}

/** Record the first project owner. Existing claims are deliberately left to explicit `sim claim`. */
export async function recordSimulatorOwner(udid: string, explicitWorktree: string | undefined, environment: Readonly<Record<string, string | undefined>>, processAdapter: ProcessAdapter, clock: Clock): Promise<string | undefined> {
  const git = explicitWorktree === undefined
    ? await processAdapter.run("git", ["rev-parse", "--show-toplevel"])
    : await processAdapter.run("git", ["-C", explicitWorktree, "rev-parse", "--show-toplevel"]);
  if (git.kind !== "ok" || !git.value.stdout.trim()) return undefined;
  const worktree = resolve(git.value.stdout.trim());
  if (await registeredProjectForWorktree(worktree, environment, processAdapter) === undefined) return undefined;
  const owners = await readSimulatorOwners(environment);
  const existing = owners[udid];
  if (existing !== undefined) return existing.worktree === worktree ? undefined : `simulator ${udid} is owned by ${existing.worktree}; use native sim claim to move it`;
  owners[udid] = { worktree, since: new Date(clock.now()).toISOString() };
  await writeSimulatorOwners(environment, owners);
  return undefined;
}

const ownersFile = (environment: Readonly<Record<string, string | undefined>>) => join(resolveStateDirectory(environment), "native", "sim-owners.json");

export async function readSimulatorOwners(environment: Readonly<Record<string, string | undefined>>): Promise<SimulatorOwners> {
  try {
    const value: unknown = JSON.parse(await readFile(ownersFile(environment), "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, SimulatorOwner] => {
      const owner = entry[1];
      return typeof owner === "object" && owner !== null && typeof (owner as SimulatorOwner).worktree === "string" && typeof (owner as SimulatorOwner).since === "string";
    }));
  } catch { return {}; }
}

export async function writeSimulatorOwners(environment: Readonly<Record<string, string | undefined>>, owners: SimulatorOwners): Promise<void> {
  const file = ownersFile(environment);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(owners, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
