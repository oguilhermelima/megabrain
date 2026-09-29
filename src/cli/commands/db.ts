import { backupDatabase, inspectDatabase, openDatabase, readSnapshot, withWrite } from "../../db/db.js";
import { failed, ok, type Result } from "../../core/result.js";
import type { StateEnvironment } from "../../core/state.js";
import { usageText } from "../../core/usage.js";
import { parseJsonState, applyJsonStateImport } from "../../db/import/json-state.js";
import { getDispatch, type DispatchRow } from "../../db/queries/dispatches.js";
import { listMessages } from "../../db/queries/messages.js";
import { listDeliveries } from "../../db/queries/deliveries.js";
import { getInstallState, getTerminal, getTmuxSession, listInstallState, listModels } from "../../db/queries/aux-state.js";
import { dryRunLegacyMigration, markExplicitImport, migrateLegacyState } from "../../db/cutover.js";

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
  if (verb === undefined || verb === "-h" || verb === "--help") return ok("Usage: megabrain db <check|backup|import|migrate|show> ...\n");
  if (verb !== "check" && verb !== "backup" && verb !== "import" && verb !== "migrate" && verb !== "show") return failed(`unknown db command: ${verb}`, 2);
  if (options.includes("-h") || options.includes("--help")) return ok(usageText(verb === "import" ? "db-import" : verb === "migrate" ? "db-migrate" : verb === "show" ? "db-show" : verb === "check" ? "db-check" : "db-backup"));
  if (verb === "import") return importState(options, environment);
  if (verb === "migrate") return migrateState(options, environment);
  if (verb === "show") return showState(options, environment);
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
    const marked = markExplicitImport(opened.value, report.imported);
    if (marked.kind !== "ok") return failed(marked.error, marked.exitCode);
    const summary = { imported: report.imported, skippedIdentical: report.skippedIdentical, replaced: report.replaced, malformed: report.malformed };
    return ok(json ? `${JSON.stringify(summary, null, 2)}\n` : `imported ${countRecords(report.imported)}, skipped identical ${countRecords(report.skippedIdentical)}, replaced ${countRecords(report.replaced)}, malformed ${report.malformed.length}\n`);
  } catch (error: unknown) {
    return failed(`import failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    opened.value.close();
  }
}

async function migrateState(args: readonly string[], environment: StateEnvironment): Promise<Result<string>> {
  let dryRun = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else return failed(`unexpected argument: ${arg}\n${usageText("db-migrate").trimEnd()}`, 2);
  }
  const result = dryRun ? await dryRunLegacyMigration(environment) : await migrateLegacyState(environment);
  if (result.kind !== "ok") return failed(result.error, result.exitCode);
  const summary = result.value;
  if (json) return ok(`${JSON.stringify(summary, null, 2)}\n`);
  const state = summary.migrated ? "migrated" : dryRun ? "dry run complete" : "already migrated";
  const snapshot = summary.snapshot === null ? "" : `; legacy snapshot: ${summary.snapshot}`;
  return ok(`${state}; dispatches ${summary.totals.dispatches}, messages ${summary.totals.messages}, deliveries ${summary.totals.deliveries}${snapshot}\n`);
}

function countRecords(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function showState(args: readonly string[], environment: StateEnvironment): Result<string> {
  let id: string | undefined;
  let mode: "dispatch" | "terminal" | "install" | "models" | "tmux-session" = "dispatch";
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--terminal") mode = "terminal";
    else if (arg === "--install-state") mode = "install";
    else if (arg === "--models") mode = "models";
    else if (arg === "--tmux-session") mode = "tmux-session";
    else if (arg.startsWith("-") || id !== undefined) return failed(`unexpected argument: ${arg}\n${usageText("db-show").trimEnd()}`, 2);
    else id = arg;
  }
  if (!validShowRequest(mode, id)) return failed(usageText("db-show").trimEnd(), 2);
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try {
    const result = readSnapshot(opened.value, (db) => {
      if (mode === "install") return { kind: "found" as const, value: listInstallState(db) };
      if (mode === "models") return { kind: "found" as const, value: listModels(db) };
      if (mode === "terminal") {
        const value = getTerminal(db, id as string);
        return value === undefined ? { kind: "missing" as const } : { kind: "found" as const, value };
      }
      if (mode === "tmux-session") {
        const value = getTmuxSession(db, id as string);
        return value === undefined ? { kind: "missing" as const } : { kind: "found" as const, value };
      }
      const meta = getDispatch(db, id as string);
      if (meta === undefined) return { kind: "missing" as const };
      const row = db.query<Pick<DispatchRow, "archived_at">>("SELECT archived_at FROM dispatches WHERE id = ?").get(id as string);
      const nudges = db.query<{ id: number; dispatch_id: string; pointer: string; outcome: string; reason: string; created_at: string }>("SELECT id, dispatch_id, pointer, outcome, reason, created_at FROM nudge_events WHERE dispatch_id = ? ORDER BY id").all(id as string)
        .map((nudge) => ({ id: nudge.id, dispatchId: nudge.dispatch_id, pointer: nudge.pointer, outcome: nudge.outcome, reason: nudge.reason, createdAt: nudge.created_at }));
      return { kind: "found" as const, value: { meta, messages: listMessages(db, id as string), deliveries: listDeliveries(db, id as string), nudges, archived: row?.archived_at !== null && row?.archived_at !== undefined } };
    });
    if (result.kind !== "ok") return failed(result.error, result.exitCode);
    if (result.value.kind === "missing") return failed(`${mode === "terminal" ? "terminal" : mode === "tmux-session" ? "tmux session" : "dispatch"} not found: ${id}`);
    if (json) return ok(`${JSON.stringify(result.value.value, null, 2)}\n`);
    if (mode === "dispatch") {
      const value = result.value.value as { meta: Record<string, unknown>; messages: unknown[]; deliveries: unknown[]; nudges: unknown[]; archived: boolean };
      return ok(`${String(value.meta.dispatchId)}: ${String(value.meta.state)}; ${value.messages.length} messages, ${value.deliveries.length} deliveries, ${value.nudges.length} nudges${value.archived ? "; archived" : ""}\n`);
    }
    if (mode === "terminal") return ok(`terminal ${id} found\n`);
    if (mode === "tmux-session") return ok(`tmux session ${id} found\n`);
    return ok(mode === "models" ? `models: ${(result.value.value as { models: unknown[] }).models.length} records\n` : `install state: ${Object.keys(result.value.value as Record<string, unknown>).length} modules\n`);
  } finally {
    opened.value.close();
  }
}

function validShowRequest(mode: string, id: string | undefined): boolean {
  return (mode === "install" || mode === "models") ? id === undefined : id !== undefined;
}
