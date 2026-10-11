import { basename } from "node:path";
import { failed, ok, type Result } from "../../core/result.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { openDatabase } from "../../db/db.js";
import { listWorktrees } from "../../db/queries/worktrees.js";

type Environment = Readonly<Record<string, string | undefined>>;

async function run(
  process: ProcessAdapter,
  command: string,
  args: readonly string[],
): Promise<Result<{ readonly stdout: string; readonly stderr: string }>> {
  const result = await process.run(command, args);
  return result.kind === "ok"
    ? ok(result.value)
    : failed(result.error, result.exitCode);
}

export async function repoFromOrca(
  process: ProcessAdapter,
  selector: string,
  environment: Environment,
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
  const command = await run(process, "sh", ["-c", "command -v orca"]);
  let orcaReason = "Orca is unavailable";
  if (command.kind === "ok") {
    const listed = await run(process, "orca", ["repo", "list", "--json"]);
    if (listed.kind !== "ok") orcaReason = "Orca repository lookup failed";
    else {
      try {
        const payload: unknown = JSON.parse(listed.value.stdout);
        const payloadRecord = typeof payload === "object" && payload !== null
          ? payload as Record<string, unknown>
          : undefined;
        const result = payloadRecord?.result;
        const resultRecord = typeof result === "object" && result !== null
          ? result as Record<string, unknown>
          : undefined;
        const repos = resultRecord?.repos;
        if (!Array.isArray(repos)) orcaReason = "Orca returned no repository list";
        const wanted = selector.toLocaleLowerCase();
        for (const item of Array.isArray(repos) ? repos : []) {
          if (typeof item !== "object" || item === null) continue;
          const record = item as Record<string, unknown>;
          const displayName = typeof record.displayName === "string" ? record.displayName : "";
          const path = typeof record.path === "string" ? record.path : "";
          if (path.length > 0 && (wanted === displayName.toLocaleLowerCase() || wanted === basename(path).toLocaleLowerCase())) {
            return ok(path);
          }
        }
        if (Array.isArray(repos)) orcaReason = `Orca has no repository named '${selector}'`;
      } catch {
        orcaReason = "Orca returned invalid repository data";
      }
    }
  }

  const registry = openDatabase(environment);
  if (registry.kind !== "ok") return failed(`repo not found: ${selector} (${orcaReason}; worktree registry could not be read: ${registry.error})`);
  let matchingPaths: string[];
  try {
    const wanted = selector.toLocaleLowerCase();
    matchingPaths = [...new Set(listWorktrees(registry.value.db)
      .filter((record) => record.repoName.toLocaleLowerCase() === wanted || basename(record.repo).toLocaleLowerCase() === wanted)
      .map((record) => record.repo))];
  } catch (cause: unknown) {
    registry.value.close();
    return failed(`repo not found: ${selector} (${orcaReason}; worktree registry could not be read: ${cause instanceof Error ? cause.message : String(cause)})`);
  }
  registry.value.close();
  const validPaths: string[] = [];
  for (const path of matchingPaths) {
    const top = await run(process, "git", ["-C", path, "rev-parse", "--path-format=absolute", "--show-toplevel"]);
    if (top.kind === "ok") validPaths.push(top.value.stdout.trim());
  }
  const uniquePaths = [...new Set(validPaths)];
  if (uniquePaths.length === 1) return ok(uniquePaths[0] as string);
  if (uniquePaths.length > 1) return failed(`repo name '${selector}' is ambiguous in the worktree registry: ${uniquePaths.join(", ")} (Orca did not resolve it)`);
  return failed(`repo not found: ${selector} (${orcaReason}; worktree registry has no live repository named '${selector}')`);
}
