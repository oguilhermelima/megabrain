import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { addFact, editFact, emptyStore, formatFactList, removeFact, validateStore, type Fact, type FactStore } from "../../core/facts.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";

export type Environment = Readonly<Record<string, string | undefined>>;
const usages: Record<string, string> = {
  fact: "fact list|add|edit|remove ...", list: "fact list [--json]",
  add: "fact add <id> --measurement <text> --who <name> --when <timestamp> --command <command> [--scope global|repository] [--repository <id>] [--json]",
  edit: "fact edit <id> [--json]", remove: "fact remove <id> [--json]",
};
const usage = (kind: keyof typeof usages): Result<string> => ok("Usage: megabrain " + usages[kind] + "\n");
const error = (message: string, code = 1): Result<string> => failed(message, code);

function pathFor(environment: Environment): string { return environment.MEGABRAIN_FACTS_FILE ?? resolve(resolveStateDirectory(environment), "facts.json"); }
async function readStore(path: string): Promise<Result<FactStore>> {
  try {
    let raw: string;
    try { raw = await readFile(path, "utf8"); } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return ok(emptyStore());
      throw cause;
    }
    const value: unknown = JSON.parse(raw); const valid = validateStore(value);
    return valid.kind === "valid" ? ok(value as FactStore) : error(valid.message);
  } catch (cause: unknown) { return error(cause instanceof Error ? cause.message : "could not read fact store"); }
}
async function writeStore(path: string, store: FactStore): Promise<Result<void>> {
  const valid = validateStore(store); if (valid.kind !== "valid") return error(valid.message);
  try {
    await mkdir(dirname(path), { recursive: true }); const temporary = path + ".tmp-" + process.pid;
    await writeFile(temporary, JSON.stringify(store, null, 2) + "\n"); await rename(temporary, path);
    return ok(undefined);
  } catch (cause: unknown) { return error(cause instanceof Error ? cause.message : "could not write fact store"); }
}
async function repositoryId(processAdapter: ProcessAdapter): Promise<string | undefined> {
  const remote = await processAdapter.run("git", ["config", "--get", "remote.origin.url"]);
  if (remote.kind === "ok" && remote.value.stdout.trim()) return remote.value.stdout.trim();
  const common = await processAdapter.run("git", ["rev-parse", "--git-common-dir"]);
  if (common.kind !== "ok" || !common.value.stdout.trim()) return undefined;
  const path = common.value.stdout.trim(); return path.startsWith("/") ? path : resolve(process.cwd(), path);
}
function json(value: unknown): string { return JSON.stringify(value) + "\n"; }
function optionValue(args: readonly string[], index: number, arg: string): { value: string; index: number } | Result<string> {
  const value = args[index + 1] ?? ""; return value.length === 0 ? error(arg + " requires a value", 2) : { value, index: index + 1 };
}

async function list(args: readonly string[], environment: Environment): Promise<Result<string>> {
  let asJson = false;
  for (const arg of args) { if (arg === "--json") asJson = true; else if (arg === "-h" || arg === "--help") return usage("list"); else return error("unknown fact list option: " + arg, 2); }
  const store = await readStore(pathFor(environment)); return store.kind !== "ok" ? store : ok(asJson ? json(store.value.facts) : formatFactList(store.value));
}
async function add(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const id = args[0] ?? ""; if (id === "-h" || id === "--help") return usage("add"); if (!id) return usage("add");
  let measurement = "", who = "", when = "", command = "", scopeType = "global", repository = "", asJson = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (["--measurement", "--measured", "--who", "--measured-by", "--when", "--measured-at", "--command", "--scope", "--repository", "--repo"].includes(arg)) {
      const parsed = optionValue(args, index, arg); if ("kind" in parsed) return parsed; index = parsed.index;
      if (arg === "--measurement" || arg === "--measured") measurement = parsed.value;
      else if (arg === "--who" || arg === "--measured-by") who = parsed.value;
      else if (arg === "--when" || arg === "--measured-at") when = parsed.value;
      else if (arg === "--command") command = parsed.value;
      else if (arg === "--scope") scopeType = parsed.value;
      else { repository = parsed.value; scopeType = "repository"; }
    } else if (arg === "--json") asJson = true; else if (arg === "-h" || arg === "--help") return usage("add"); else return error("unknown fact add option: " + arg, 2);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return error("invalid fact id: " + id);
  if (scopeType === "repository" && !repository) repository = await repositoryId(processAdapter) ?? "";
  if (scopeType === "repository" && !repository) return error("could not determine repository identity for repository-scoped fact");
  if (scopeType !== "global" && scopeType !== "repository") return error("fact scope must be global or repository");
  if (scopeType === "global" && repository) return error("global facts cannot specify a repository");
  const current = await readStore(pathFor(environment)); if (current.kind !== "ok") return current;
  const entry: Fact = { id, measurement, scope: scopeType === "global" ? { type: "global" } : { type: "repository", repository }, provenance: { who, when, command } };
  const result = addFact(current.value, entry); if (result.kind !== "ok") return error(result.message);
  const written = await writeStore(pathFor(environment), result.value); return written.kind !== "ok" ? written : ok(asJson ? JSON.stringify(entry, null, 2) + "\n" : "fact added: " + id + "\n");
}
async function edit(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const id = args[0] ?? ""; if (id === "-h" || id === "--help") return usage("edit"); if (!id) return usage("edit");
  let asJson = false; for (const arg of args.slice(1)) { if (arg === "--json") asJson = true; else if (arg === "-h" || arg === "--help") return usage("edit"); else return error("unknown fact edit option: " + arg, 2); }
  const path = pathFor(environment); const current = await readStore(path); if (current.kind !== "ok") return current; if (!current.value.facts.some((entry) => entry.id === id)) return error("fact not found: " + id);
  const temporary = path + ".edit-" + process.pid; await mkdir(dirname(path), { recursive: true }); await writeFile(temporary, JSON.stringify(current.value, null, 2) + "\n");
  const editor = environment.EDITOR ?? "vi"; const edited = await processAdapter.run(editor, [temporary]); const raw = await readFile(temporary).catch(() => ""); await rm(temporary, { force: true });
  if (edited.kind !== "ok") return error("editor failed while editing fact " + id);
  let value: unknown; try { value = JSON.parse(raw); } catch { return error("invalid fact store: expected version 1 and a facts array"); }
  const valid = validateStore(value); if (valid.kind !== "valid") return error(valid.message);
  const result = editFact(current.value, id, value as FactStore); if (result.kind !== "ok") return error(result.message); const written = await writeStore(path, result.value);
  if (written.kind !== "ok") return written; return ok(asJson ? json(result.value.facts.find((entry) => entry.id === id)) : "fact edited: " + id + "\n");
}
async function remove(args: readonly string[], environment: Environment): Promise<Result<string>> {
  const id = args[0] ?? ""; if (id === "-h" || id === "--help") return usage("remove"); if (!id) return usage("remove");
  let asJson = false; for (const arg of args.slice(1)) { if (arg === "--json") asJson = true; else if (arg === "-h" || arg === "--help") return usage("remove"); else return error("unknown fact remove option: " + arg, 2); }
  const path = pathFor(environment); const current = await readStore(path); if (current.kind !== "ok") return current; const result = removeFact(current.value, id); if (result.kind !== "ok") return error(result.message);
  const written = await writeStore(path, result.value); return written.kind !== "ok" ? written : ok(asJson ? json({ removed: true, id }) : "fact removed: " + id + "\n");
}
export async function executeFact(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return list(rest, environment); if (subcommand === "add") return add(rest, environment, processAdapter); if (subcommand === "edit") return edit(rest, environment, processAdapter); if (subcommand === "remove" || subcommand === "delete") return remove(rest, environment);
  if (subcommand === "-h" || subcommand === "--help" || subcommand === undefined || subcommand.length === 0) return usage("fact"); return error("unknown fact command: " + subcommand, 2);
}
