import { backupDatabase, inspectDatabase, openDatabase } from "../../db/db.js";
import { failed, ok, type Result } from "../../core/result.js";
import type { StateEnvironment } from "../../core/state.js";
import { usageText } from "../../core/usage.js";

function parseJson(args: readonly string[]): Result<boolean> {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return failed("help requested", 2);
    else return failed(`unexpected argument: ${arg}`, 2);
  }
  return ok(json);
}

function check(environment: StateEnvironment, json: boolean): Result<string> {
  const result = inspectDatabase(environment);
  if (result.kind !== "ok") return failed(result.error, result.exitCode);
  const report = result.value;
  if (report === undefined) return failed("database check failed: database file does not exist");
  const value = json
    ? `${JSON.stringify(report, null, 2)}\n`
    : report.clean
      ? `ok: ${report.path} (user_version ${report.userVersion})\n`
      : `problems: ${report.path} (user_version ${report.userVersion})\n${report.quickCheck.filter((line) => line !== "ok").map((line) => `quick_check: ${line}\n`).join("")}${report.foreignKeyViolations.map((row) => `foreign_key_check: ${JSON.stringify(row)}\n`).join("")}`;
  return ok(value, report.clean ? 0 : 1);
}

function backup(environment: StateEnvironment, json: boolean): Result<string> {
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try {
    const result = backupDatabase(opened.value);
    if (result.kind !== "ok") return failed(result.error, result.exitCode);
    return ok(json ? `${JSON.stringify({ path: result.value })}\n` : `${result.value}\n`);
  } finally {
    opened.value.close();
  }
}

export function executeDatabase(args: readonly string[], environment: StateEnvironment): Result<string> {
  const [verb, ...options] = args;
  if (verb === undefined || verb === "-h" || verb === "--help") return ok("Usage: megabrain db <check|backup> [--json]\n");
  if (verb !== "check" && verb !== "backup") return failed(`unknown db command: ${verb}`, 2);
  if (options.includes("-h") || options.includes("--help")) return ok(usageText(verb === "check" ? "db-check" : "db-backup"));
  const parsed = parseJson(options);
  if (parsed.kind !== "ok") return failed(`${parsed.error}\n${usageText(verb === "check" ? "db-check" : "db-backup").trimEnd()}`, parsed.exitCode);
  return verb === "check" ? check(environment, parsed.value) : backup(environment, parsed.value);
}
