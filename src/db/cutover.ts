import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { acquireLease, releaseLease, transcriptPath } from "../adapters/state-db.js";
import { resolveStateDirectory, type StateEnvironment } from "../core/state.js";
import { failed, ok, type Result } from "../core/result.js";
import { applyJsonStateImport, parseJsonState, readParsedJsonStateParity, type ParityReport, type ParsedJsonState } from "./import/json-state.js";
import { backupDatabase, openDatabase, vacuumDatabaseFile, withWrite, type DatabaseHandle } from "./db.js";

export type CutoverMethod = "auto" | "migrate" | "import";
export type CutoverMarker = Readonly<{ method: CutoverMethod; completedAt: string; totals: ParityReport["totals"] }>;
export type CutoverSummary = Readonly<{
  migrated: boolean;
  method: CutoverMethod;
  snapshot: string | null;
  totals: ParityReport["totals"];
  parity: Pick<ParityReport, "mismatches" | "skippedMalformed" | "collisions" | "tmuxAmbiguities">;
}>;
type ManifestEntry = Readonly<{ size: number; mtimeMs: number }>;
type Manifest = ReadonlyMap<string, ManifestEntry>;

const markerKey = "cutover";
const leaseKey = "cutover";
const leaseSeconds = 15 * 60;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function stateDirectory(environment: StateEnvironment): Result<string> {
  try {
    return ok(resolve(resolveStateDirectory(environment)));
  } catch (error: unknown) {
    return failed(`resolve failed: ${errorMessage(error)}`);
  }
}

export function readCutoverMarker(handle: DatabaseHandle): Result<CutoverMarker | undefined> {
  try {
    const row = handle.db.query<{ value: string }>("SELECT value FROM settings WHERE key = ?").get(markerKey);
    return ok(row === null ? undefined : JSON.parse(row.value) as CutoverMarker);
  } catch (error: unknown) {
    return failed(`cutover marker read failed: ${errorMessage(error)}`);
  }
}

export function setCutoverMarker(handle: DatabaseHandle, method: CutoverMethod, totals: ParityReport["totals"]): Result<void> {
  const marker: CutoverMarker = { method, completedAt: new Date().toISOString(), totals };
  const result = withWrite(handle, (db) => {
    db.run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING", [markerKey, JSON.stringify(marker), marker.completedAt]);
  });
  return result.kind === "ok" ? ok(undefined) : failed(result.error, result.exitCode);
}

function legacyRoots(directory: string): string[] {
  return ["dispatches", "terminals", "state.json", "models.json", "sessions"].map((name) => join(directory, name));
}

function findMeta(directory: string): boolean {
  if (!existsSync(directory)) return false;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return false; }
  return entries.some((entry) => entry.isFile() && entry.name === "meta.json")
    || entries.some((entry) => entry.isDirectory() && findMeta(join(directory, entry.name)));
}

export function hasLegacyJson(directory: string): boolean {
  return findMeta(join(directory, "dispatches"))
    || ["terminals", "state.json", "models.json"].some((name) => existsSync(join(directory, name)))
    || walkFiles(join(directory, "sessions")).some((path) => path.endsWith(".json"));
}

function walkFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function snapshotManifest(directory: string): Manifest {
  const entries = new Map<string, ManifestEntry>();
  for (const root of legacyRoots(directory)) {
    for (const path of walkFiles(root)) {
      const info = statSync(path);
      entries.set(path, { size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  return entries;
}

function changedManifestPaths(before: Manifest, directory: string): Set<string> {
  const after = snapshotManifest(directory);
  const changed = new Set<string>();
  for (const [path, entry] of after) {
    const old = before.get(path);
    if (old === undefined || old.size !== entry.size || old.mtimeMs !== entry.mtimeMs) changed.add(path);
  }
  return changed;
}

function dispatchIdForPath(path: string, directory: string): string | undefined {
  const parts = relative(directory, path).split(sep);
  const index = parts.indexOf("dispatches");
  if (index < 0) return undefined;
  return parts[index + 1] === "archive" ? parts[index + 3] : parts[index + 1];
}

function onlyStragglers(source: ParsedJsonState, paths: ReadonlySet<string>, directory: string): ParsedJsonState {
  const ids = new Set([...paths].map((path) => dispatchIdForPath(path, directory)).filter((id): id is string => id !== undefined));
  const modelPath = join(directory, "models.json");
  const statePath = join(directory, "state.json");
  return {
    ...source,
    dispatches: source.dispatches.filter(({ path, value }) => paths.has(path) || ids.has(String(value.dispatchId))),
    messages: source.messages.filter(({ path }) => paths.has(path) || ids.has(dispatchIdForPath(path, directory) ?? "")),
    deliveries: source.deliveries.filter(({ path }) => paths.has(path) || ids.has(dispatchIdForPath(path, directory) ?? "")),
    terminals: source.terminals.filter(({ path }) => paths.has(path)),
    install: paths.has(statePath) ? source.install : {},
    models: paths.has(modelPath) ? source.models : { version: 1, models: [] },
    sessions: source.sessions.filter(({ path }) => paths.has(path)),
    malformed: source.malformed.filter(({ path }) => paths.has(path) || ids.has(dispatchIdForPath(path, directory) ?? "")),
    collisions: source.collisions.filter(({ livePath, archivedPath }) => paths.has(livePath) || paths.has(archivedPath)),
    tmuxAmbiguities: source.tmuxAmbiguities,
  };
}

function summarizeParity(parity: ParityReport): CutoverSummary["parity"] {
  return {
    mismatches: parity.mismatches,
    skippedMalformed: parity.skippedMalformed,
    collisions: parity.collisions,
    tmuxAmbiguities: parity.tmuxAmbiguities,
  };
}

function reportPath(directory: string): string {
  let path = join(directory, `migration-report-${timestamp()}.json`);
  for (let index = 1; existsSync(path); index += 1) path = join(directory, `migration-report-${timestamp()}-${index}.json`);
  return path;
}

function writeParityReport(directory: string, parity: ParityReport, method: CutoverMethod, dispatchIds?: readonly string[]): string {
  const path = reportPath(directory);
  const report = {
    method,
    createdAt: new Date().toISOString(),
    totals: parity.totals,
    databaseTotals: parity.databaseTotals,
    mismatches: parity.mismatches,
    skippedMalformed: parity.skippedMalformed,
    collisions: parity.collisions,
    tmuxAmbiguities: parity.tmuxAmbiguities,
    ...(dispatchIds === undefined ? {} : { dispatchIds }),
  };
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

function assertParity(parity: ParityReport): void {
  if (parity.mismatches.length > 0 || parity.skippedMalformed.length > 0) {
    throw new Error("legacy records failed import parity");
  }
}

function moveTranscripts(directory: string, environment: StateEnvironment): number {
  let moved = 0;
  for (const path of walkFiles(join(directory, "dispatches"))) {
    if (basename(path) !== "transcript") continue;
    const id = dispatchIdForPath(path, directory);
    if (id === undefined || id === "" || id === "archive") continue;
    const target = transcriptPath(environment, id);
    if (target.kind !== "ok") throw new Error(target.error);
    mkdirSync(dirname(target.value), { recursive: true });
    if (existsSync(target.value)) throw new Error(`transcript destination already exists: ${target.value}`);
    renameSync(path, target.value);
    moved += 1;
  }
  return moved;
}

function sealLegacy(directory: string): string {
  const snapshot = join(directory, "legacy", `json-${timestamp()}`);
  mkdirSync(dirname(snapshot), { recursive: true });
  mkdirSync(snapshot);
  try {
    for (const name of ["dispatches", "terminals", "state.json", "models.json", "sessions"]) {
      const source = join(directory, name);
      if (!existsSync(source)) continue;
      renameSync(source, join(snapshot, name));
    }
    return snapshot;
  } catch (error: unknown) {
    throw new Error(`legacy snapshot failed at ${snapshot}: ${errorMessage(error)}`, { cause: error });
  }
}

function busyBudgetMs(): number {
  const seconds = Number(process.env.MEGABRAIN_DB_BUSY_SECONDS ?? "30");
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 30) * 1000;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function acquireCutoverLease(handle: DatabaseHandle): Promise<Result<string | undefined>> {
  const holder = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + busyBudgetMs();
  while (true) {
    const acquired = acquireLease(handle, leaseKey, holder, leaseSeconds);
    if (acquired.kind !== "ok") return failed(acquired.error, acquired.exitCode);
    if (acquired.value) return ok(holder);
    const marker = readCutoverMarker(handle);
    if (marker.kind !== "ok") return failed(marker.error, marker.exitCode);
    if (marker.value !== undefined) return ok(undefined);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return failed(`database cutover is already in progress; no cutover marker appeared within ${Math.round(busyBudgetMs() / 1000)} seconds`);
    await wait(Math.min(50, remaining));
  }
}

function importAndCheck(handle: DatabaseHandle, source: ParsedJsonState, stateDirectory: string): Result<ParityReport> {
  let parity: ParityReport | undefined;
  const result = withWrite(handle, (db) => {
    const imported = applyJsonStateImport(db, source);
    if (imported.malformed.length > 0 || imported.conflicts.length > 0) throw new Error(`import rejected ${imported.malformed.length} malformed record(s) and ${imported.conflicts.length} conflict(s)`);
    parity = readParsedJsonStateParity(db, source, { ignoredLeaseKeys: [leaseKey] });
    assertParity(parity);
  });
  if (result.kind !== "ok") return failed(result.error, result.exitCode);
  return parity === undefined ? failed("cutover parity did not produce a report") : ok(parity);
}

async function migrateWithLease(handle: DatabaseHandle, environment: StateEnvironment, directory: string, method: "auto" | "migrate"): Promise<Result<CutoverSummary>> {
  const current = readCutoverMarker(handle);
  if (current.kind !== "ok") return failed(current.error, current.exitCode);
  if (current.value !== undefined) {
    if (method === "migrate") return failed(`database was already migrated at ${current.value.completedAt}`);
    return ok({ migrated: false, method: current.value.method, snapshot: null, totals: current.value.totals, parity: { mismatches: [], skippedMalformed: [], collisions: [], tmuxAmbiguities: [] } });
  }

  const lease = await acquireCutoverLease(handle);
  if (lease.kind !== "ok") return failed(lease.error, lease.exitCode);
  if (lease.value === undefined) {
    const marker = readCutoverMarker(handle);
    if (marker.kind !== "ok" || marker.value === undefined) return failed(marker.kind === "ok" ? "cutover lease was released without a marker" : marker.error);
    if (method === "migrate") return failed(`database was already migrated at ${marker.value.completedAt}`);
    return ok({ migrated: false, method: marker.value.method, snapshot: null, totals: marker.value.totals, parity: { mismatches: [], skippedMalformed: [], collisions: [], tmuxAmbiguities: [] } });
  }

  try {
    const afterLease = readCutoverMarker(handle);
    if (afterLease.kind !== "ok") return failed(afterLease.error, afterLease.exitCode);
    if (afterLease.value !== undefined) {
      if (method === "migrate") return failed(`database was already migrated at ${afterLease.value.completedAt}`);
      return ok({ migrated: false, method: afterLease.value.method, snapshot: null, totals: afterLease.value.totals, parity: { mismatches: [], skippedMalformed: [], collisions: [], tmuxAmbiguities: [] } });
    }

    if (!hasLegacyJson(directory)) {
      const empty = emptyParityTotals();
      const marked = setCutoverMarker(handle, method, empty);
      return marked.kind === "ok"
        ? ok({ migrated: true, method, snapshot: null, totals: empty, parity: { mismatches: [], skippedMalformed: [], collisions: [], tmuxAmbiguities: [] } })
        : failed(marked.error, marked.exitCode);
    }

    const backup = backupDatabase(handle);
    if (backup.kind !== "ok") return failed(backup.error, backup.exitCode);
    const manifest = snapshotManifest(directory);
    const source = await parseJsonState(directory);
    const initial = importAndCheck(handle, source, directory);
    if (initial.kind !== "ok") {
      const parity = parityForFailure(handle, source);
      const report = writeParityReport(directory, parity, method);
      return failed(`legacy migration parity failed; report: ${report}; nothing was changed`);
    }
    let parity = initial.value;
    const stragglers = changedManifestPaths(manifest, directory);
    if (stragglers.size > 0) {
      const latest = await parseJsonState(directory);
      const changed = onlyStragglers(latest, stragglers, directory);
      let retryParity: ParityReport | undefined;
      const retry = withWrite(handle, (db) => {
        const imported = applyJsonStateImport(db, changed, true);
        if (imported.malformed.length > 0 || imported.conflicts.length > 0) throw new Error("straggler import rejected malformed or conflicting records");
        retryParity = readParsedJsonStateParity(db, latest, { ignoredLeaseKeys: [leaseKey] });
        assertParity(retryParity);
      });
      if (retry.kind !== "ok" || retryParity === undefined) {
        const reportParity = retryParity ?? parityForFailure(handle, latest);
        const dispatchIds = [...new Set([...stragglers].map((path) => dispatchIdForPath(path, directory)).filter((id): id is string => id !== undefined))];
        const report = writeParityReport(directory, reportParity, method, dispatchIds);
        return failed(`straggler migration parity failed; report: ${report}; initial import remains committed`);
      }
      parity = retryParity;
    }

    try {
      moveTranscripts(directory, environment);
      const snapshot = sealLegacy(directory);
      const marked = setCutoverMarker(handle, method, parity.totals);
      if (marked.kind !== "ok") return failed(marked.error, marked.exitCode);
      return ok({ migrated: true, method, snapshot, totals: parity.totals, parity: summarizeParity(parity) });
    } catch (error: unknown) {
      return failed(`legacy migration imported into SQLite but could not finish cutover: ${errorMessage(error)}`);
    }
  } catch (error: unknown) {
    return failed(`legacy migration failed: ${errorMessage(error)}`);
  } finally {
    releaseLease(handle, leaseKey, lease.value);
  }
}

function emptyParityTotals(): ParityReport["totals"] {
  return { dispatches: 0, messages: 0, deliveries: 0, terminals: 0, installState: 0, models: 0, tmuxSessions: 0, outbox: 0, leases: 0 };
}

function parityForFailure(handle: DatabaseHandle, source: ParsedJsonState): ParityReport {
  const parity = readParsedJsonStateParity(handle.db, source, { ignoredLeaseKeys: [leaseKey] });
  if (parity.mismatches.length === 0 && parity.skippedMalformed.length === 0) {
    return { ...parity, mismatches: [{ kind: "import", id: "legacy", reason: "import transaction rolled back" }] };
  }
  return parity;
}

export async function ensureAutomaticCutover(environment: StateEnvironment): Promise<Result<CutoverSummary | undefined>> {
  const directory = stateDirectory(environment);
  if (directory.kind !== "ok") return failed(directory.error, directory.exitCode);
  const opened = openDatabase({ ...environment, MEGABRAIN_STATE_DIR: directory.value });
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try {
    const marker = readCutoverMarker(opened.value);
    if (marker.kind !== "ok") return failed(marker.error, marker.exitCode);
    if (marker.value !== undefined) return ok(undefined);
    const result = await migrateWithLease(opened.value, environment, directory.value, "auto");
    return result.kind === "ok" ? ok(result.value.migrated ? result.value : undefined) : failed(result.error, result.exitCode);
  } finally {
    opened.value.close();
  }
}

export async function migrateLegacyState(environment: StateEnvironment): Promise<Result<CutoverSummary>> {
  const directory = stateDirectory(environment);
  if (directory.kind !== "ok") return failed(directory.error, directory.exitCode);
  const opened = openDatabase({ ...environment, MEGABRAIN_STATE_DIR: directory.value });
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  try {
    return await migrateWithLease(opened.value, environment, directory.value, "migrate");
  } finally {
    opened.value.close();
  }
}

export function markExplicitImport(handle: DatabaseHandle, imported: Readonly<Record<string, number>>): Result<void> {
  const totals = { ...emptyParityTotals(), ...imported } as ParityReport["totals"];
  return setCutoverMarker(handle, "import", totals);
}

export async function dryRunLegacyMigration(environment: StateEnvironment): Promise<Result<CutoverSummary>> {
  const directoryResult = stateDirectory(environment);
  if (directoryResult.kind !== "ok") return failed(directoryResult.error, directoryResult.exitCode);
  const directory = directoryResult.value;
  const temporary = await mkdtemp(join(tmpdir(), "megabrain-cutover-dry-run-"));
  let opened: DatabaseHandle | undefined;
  try {
    const sourceDb = join(directory, "megabrain.db");
    const temporaryDb = join(temporary, "megabrain.db");
    if (existsSync(sourceDb)) {
      const copied = vacuumDatabaseFile(sourceDb, temporaryDb);
      if (copied.kind !== "ok") return failed(copied.error, copied.exitCode);
      const copy = openDatabase({ MEGABRAIN_STATE_DIR: temporary });
      if (copy.kind !== "ok") return failed(copy.error, copy.exitCode);
      opened = copy.value;
    } else {
      const fresh = openDatabase({ MEGABRAIN_STATE_DIR: temporary });
      if (fresh.kind !== "ok") return failed(fresh.error, fresh.exitCode);
      opened = fresh.value;
    }
    const marker = readCutoverMarker(opened);
    if (marker.kind !== "ok") return failed(marker.error, marker.exitCode);
    if (marker.value !== undefined) return failed(`database was already migrated at ${marker.value.completedAt}`);
    const source = await parseJsonState(directory);
    const checked = importAndCheck(opened, source, directory);
    if (checked.kind !== "ok") {
      const parity = parityForFailure(opened, source);
      return ok({ migrated: false, method: "migrate", snapshot: null, totals: parity.totals, parity: summarizeParity(parity) });
    }
    return ok({ migrated: false, method: "migrate", snapshot: null, totals: checked.value.totals, parity: summarizeParity(checked.value) });
  } catch (error: unknown) {
    return failed(`migration dry-run failed: ${errorMessage(error)}`);
  } finally {
    opened?.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function databaseDirectory(environment: StateEnvironment): Promise<Result<string>> {
  return stateDirectory(environment);
}
