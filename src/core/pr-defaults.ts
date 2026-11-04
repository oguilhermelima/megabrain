import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { failed, ok, type Result } from "./result.js";

export type PrDefaults = { draft: boolean };
export const defaultPrDefaults: PrDefaults = { draft: false };

export function parsePrDefaults(raw: string): Result<PrDefaults> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("pr-defaults: not valid JSON", 2); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return failed('pr-defaults: expected { "draft": boolean }', 2);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "draft") || typeof record.draft !== "boolean") return failed('pr-defaults: expected { "draft": boolean }', 2);
  return ok({ draft: record.draft });
}

type Environment = Readonly<Record<string, string | undefined>>;

export async function readPrDefaults(environment: Environment): Promise<PrDefaults> {
  const directory = environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain");
  try {
    const parsed = parsePrDefaults(await readFile(join(directory, "pr-defaults.json"), "utf8"));
    return parsed.kind === "ok" ? parsed.value : defaultPrDefaults;
  } catch { return defaultPrDefaults; }
}
