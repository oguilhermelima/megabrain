import { basename, dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { openDatabase, withWrite } from "../db/db.js";
import { registerRepository as insertRepository, type RepositoryRecord, type RepositorySource } from "../db/queries/repositories.js";
import type { ProcessAdapter } from "../adapters/proc.js";
import type { Result } from "./result.js";
import { failed, ok } from "./result.js";

export function expandRepositoryUrl(value: string): string {
  return /^[^/:]+\/[^/]+$/.test(value) ? `https://github.com/${value}` : value;
}

export async function repositoryCheckout(path: string, process: ProcessAdapter): Promise<Result<Readonly<{ name: string; path: string; remote: string | null }>>> {
  const requested = await realpath(path).catch(() => undefined);
  if (requested === undefined) return failed(`not a git repository: ${path}`);
  const common = await process.run("git", ["-C", requested, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.kind !== "ok") return failed(`not a git repository: ${path}`);
  const commonDirectory = await realpath(common.value.stdout.trim()).catch(() => undefined);
  if (commonDirectory === undefined) return failed(`not a git repository: ${path}`);
  const mainPath = await realpath(dirname(commonDirectory)).catch(() => dirname(commonDirectory));
  const root = await process.run("git", ["-C", mainPath, "rev-parse", "--show-toplevel"]);
  if (root.kind !== "ok") return failed(`not a git repository: ${path}`);
  const main = await realpath(root.value.stdout.trim()).catch(() => root.value.stdout.trim());
  const remoteResult = await process.run("git", ["-C", main, "remote", "get-url", "origin"]);
  return ok({ name: basename(main), path: main, remote: remoteResult.kind === "ok" ? remoteResult.value.stdout.trim() : null });
}

export async function registerMegabrainRepository(path: string, environment: Readonly<Record<string, string | undefined>>, process: ProcessAdapter): Promise<Result<RepositoryRecord>> {
  const checkout = await repositoryCheckout(path, process);
  if (checkout.kind !== "ok") return checkout;
  const database = openDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  try {
    const result = withWrite(database.value, (db) => insertRepository(db, { ...checkout.value, source: "megabrain", addedAt: new Date().toISOString() }));
    return result.kind === "ok" ? result : failed(result.error, result.exitCode);
  } finally { database.value.close(); }
}

export function registerImportedRepository(db: Parameters<typeof insertRepository>[0], record: Omit<RepositoryRecord, "source"> & { source?: RepositorySource }): RepositoryRecord {
  return insertRepository(db, { ...record, source: record.source ?? "import" });
}
