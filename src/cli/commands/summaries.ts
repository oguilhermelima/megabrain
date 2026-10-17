import { join } from "node:path";
import { failed, ok, type Result } from "../../core/result.js";
import { usageMessage, usageText } from "../../core/usage.js";
import { listSummaries, searchEntries, showEntry, summariesContext } from "../../chat/summary-library.js";

type Environment = Readonly<Record<string, string | undefined>>;
type Flags = { positional: string[]; values: Record<string, string>; json: boolean };

const VALUE_FLAGS = ["--repo", "--branch", "--limit", "--cwd"];

function stateDir(environment: Environment): string { return environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain"); }
function print(value: unknown): Result<string> { return ok(`${JSON.stringify(value, null, 2)}\n`); }
function usage(): Result<string> { return failed(usageMessage("summaries"), 2); }

function parse(args: readonly string[]): Flags | null {
  const flags: Flags = { positional: [], values: {}, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") flags.json = true;
    else if (VALUE_FLAGS.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return null;
      flags.values[arg] = value;
      index += 1;
    } else if (arg.startsWith("--")) return null;
    else flags.positional.push(arg);
  }
  return flags;
}

function limitOf(flags: Flags, fallback: number): number | null {
  const raw = flags.values["--limit"];
  if (raw === undefined) return fallback;
  const number = Number(raw);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function filterOf(flags: Flags, limit: number): { repo?: string; branch?: string; limit: number } {
  return { ...(flags.values["--repo"] !== undefined ? { repo: flags.values["--repo"] } : {}), ...(flags.values["--branch"] !== undefined ? { branch: flags.values["--branch"] } : {}), limit };
}

/** The summaries verbs. Every one reads plain files, so none needs the chat daemon. */
export async function executeSummaries(args: readonly string[], environment: Environment): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("summaries"));
  const [verb, ...rest] = args;
  const flags = parse(rest);
  if (flags === null) return usage();
  const dir = stateDir(environment);
  if (verb === "list" && flags.positional.length === 0) {
    const limit = limitOf(flags, 20);
    if (limit === null) return usage();
    const { projects } = await listSummaries(dir, filterOf(flags, limit));
    if (flags.json) return print({ projects });
    return ok(projects.map((project) => [`${project.project} (${project.repo})`, ...project.branches.flatMap((branch) => [`  ${branch.branch}${branch.live ? "" : " (worktree removed)"}`, ...branch.summaries.map((entry) => `    ${entry.createdAt.slice(0, 10)} ${entry.id} ${entry.title ?? ""}`)])].join("\n")).join("\n").concat(projects.length > 0 ? "\n" : ""));
  }
  if (verb === "search" && flags.positional.length > 0) {
    const limit = limitOf(flags, 20);
    if (limit === null) return usage();
    const { results } = await searchEntries(dir, flags.positional.join(" "), filterOf(flags, limit));
    if (flags.json) return print({ results });
    return ok(results.map((entry) => `${entry.score} ${entry.project}/${entry.branch} ${entry.id}\n  ${entry.title ?? ""}: ${entry.text}\n`).join(""));
  }
  if (verb === "show" && flags.positional.length === 1) {
    const entry = await showEntry(dir, flags.positional[0] ?? "");
    if (entry === null) return failed(`unknown summary: ${flags.positional[0]}`, 1);
    return flags.json ? print(entry) : ok(`${entry.project}/${entry.branch} ${entry.createdAt}\n${entry.title ?? ""}\n\n${entry.text}\n`);
  }
  if (verb === "context" && flags.positional.length === 0 && flags.values["--cwd"] !== undefined) {
    const limit = limitOf(flags, 3);
    if (limit === null) return usage();
    const context = await summariesContext(dir, flags.values["--cwd"], limit);
    return flags.json ? print({ context }) : ok(context);
  }
  return usage();
}
