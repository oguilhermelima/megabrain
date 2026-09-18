import { basename } from "node:path";
import { failed, ok, type Result } from "../../core/result.js";
import { type ProcessAdapter } from "../../adapters/proc.js";

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
  if (command.kind !== "ok")
    return failed("repo must be a git path when orca is not installed");
  const listed = await run(process, "orca", ["repo", "list", "--json"]);
  if (listed.kind !== "ok")
    return failed(`could not resolve repo selector '${selector}': orca did not respond; pass a Git path instead`);
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
    if (!Array.isArray(repos)) return failed(`repo not found: ${selector}`);
    const wanted = selector.toLocaleLowerCase();
    for (const item of repos) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      const displayName = typeof record.displayName === "string" ? record.displayName : "";
      const path = typeof record.path === "string" ? record.path : "";
      if (path.length > 0 && (wanted === displayName.toLocaleLowerCase() || wanted === basename(path).toLocaleLowerCase())) {
        return ok(path);
      }
    }
    return failed(`repo not found: ${selector}`);
  } catch {
    return failed(`repo not found: ${selector}`);
  }
}
