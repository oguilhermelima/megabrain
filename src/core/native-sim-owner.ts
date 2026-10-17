import { readFile } from "node:fs/promises";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveStateDirectory } from "./state.js";

export type SimulatorOwner = { worktree: string; since: string };
export type SimulatorOwners = Record<string, SimulatorOwner>;

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
