import { backupDatabase, inspectDatabase, openDatabase, withWrite } from "../../db/db.js";
import { failed, ok, type Result } from "../../core/result.js";
import type { StateEnvironment } from "../../core/state.js";
import { usageText } from "../../core/usage.js";
import { parseJsonState, applyJsonStateImport } from "../../db/import/json-state.js";

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

export async function executeDatabase(args: readonly string[], environment: StateEnvironment): Promise<Result<string>> {
  const [verb, ...options] = args;
  if (verb === undefined || verb === "-h" || verb === "--help") return ok("Usage: megabrain db <check|backup|import|show> ...\n");
  if (verb !== "check" && verb !== "backup" && verb !== "import") return failed(`unknown db command: ${verb}`, 2);
  if (options.includes("-h") || options.includes("--help")) return ok(usageText(verb === "import" ? "db-import" : verb === "check" ? "db-check" : "db-backup"));
  if (verb === "import") return importState(options, environment);
  const parsed = parseJson(options);
  if (parsed.kind !== "ok") return failed(`${parsed.error}\n${usageText(verb === "check" ? "db-check" : "db-backup").trimEnd()}`, parsed.exitCode);
  return verb === "check" ? check(environment, parsed.value) : backup(environment, parsed.value);
}

async function importState(args: readonly string[], environment: StateEnvironment): Promise<Result<string>> {
  let source: string | undefined;
  let replace = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--replace") replace = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("-") || source !== undefined) return failed(`unexpected argument: ${arg}\n${usageText("db-import").trimEnd()}`, 2);
    else source = arg;
  }
  if (source === undefined) return failed(usageText("db-import").trimEnd(), 2);
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try {
    const parsed = await parseJsonState(source);
    const result = withWrite(opened.value, (db) => applyJsonStateImport(db, parsed, replace));
    if (result.kind !== "ok") return failed(result.error, result.exitCode);
    const report = result.value;
    if (report.malformed.length > 0) return failed(`malformed input:\n${report.malformed.map(({ path, reason }) => `  ${path}: ${reason}`).join("\n")}`);
    if (report.conflicts.length > 0) return failed(`conflicting records: ${report.conflicts.join(", ")}`);
    const summary = { imported: report.imported, skippedIdentical: report.skippedIdentical, replaced: report.replaced, malformed: report.malformed };
    return ok(json ? `${JSON.stringify(summary, null, 2)}\n` : `imported ${countRecords(report.imported)}, skipped identical ${countRecords(report.skippedIdentical)}, replaced ${countRecords(report.replaced)}, malformed ${report.malformed.length}\n`);
  } catch (error: unknown) {
    return failed(`import failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    opened.value.close();
  }
}

function countRecords(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

