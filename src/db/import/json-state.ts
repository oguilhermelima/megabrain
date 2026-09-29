import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchStates } from "../../core/dispatch-states.js";
import { getDispatch, listDispatches, insertDispatch, toMeta, type DispatchRecord, type DispatchRow } from "../queries/dispatches.js";
import { insertMessage, listMessages, type MessageRecord } from "../queries/messages.js";
import { insertDelivery, listDeliveries, type DeliveryRecord } from "../queries/deliveries.js";
import { listLeases, listOutbox } from "../queries/outbox-leases.js";
import { getInstallState, getTerminal, getTmuxSession, insertInstallState, insertModel, insertTerminal, insertTmuxSession, listInstallState, listModels, listTerminals, listTmuxSessions, type TerminalRecord, type TmuxSessionRecord } from "../queries/aux-state.js";
import { type DatabaseAdapter } from "../queries/types.js";

type Malformed = Readonly<{ path: string; reason: string }>;
type Collision = Readonly<{ id: string; livePath: string; archivedPath: string; kept: "live" }>;
type TmuxAmbiguity = Readonly<{ sessionName: string; stableSessionIds: readonly string[] }>;
type Counts = { dispatches: number; messages: number; deliveries: number; terminals: number; installState: number; models: number; tmuxSessions: number };
export type ImportReport = Readonly<{ inserted: Counts; skippedMalformed: readonly Malformed[]; collisions: readonly Collision[]; tmuxAmbiguities: readonly TmuxAmbiguity[] }>;

type Located<T> = Readonly<{ path: string; value: T; archivedAt: string | null; dispatchId?: string }>;
export type ParsedJsonState = Readonly<{
  dispatches: Located<Record<string, unknown>>[];
  messages: Located<Record<string, unknown>>[];
  deliveries: Located<Record<string, unknown>>[];
  terminals: Located<Record<string, unknown>>[];
  install: Record<string, unknown>;
  models: Record<string, unknown>;
  sessions: Located<Record<string, unknown>>[];
  malformed: Malformed[];
  collisions: Collision[];
  tmuxAmbiguities: TmuxAmbiguity[];
}>;

export type AtomicImportReport = Readonly<{
  imported: Counts;
  skippedIdentical: Counts;
  replaced: Counts;
  malformed: readonly Malformed[];
  conflicts: readonly string[];
}>;

const emptyCounts = (): Counts => ({ dispatches: 0, messages: 0, deliveries: 0, terminals: 0, installState: 0, models: 0, tmuxSessions: 0 });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => join(directory, entry.name)).sort();
}

async function readRecord(path: string, malformed: Malformed[]): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) throw new TypeError("expected a JSON object");
    return value;
  } catch (error: unknown) {
    malformed.push({ path, reason: error instanceof Error ? error.message : "invalid JSON" });
    return undefined;
  }
}

async function dispatchDirectories(root: string): Promise<{ live: string[]; archived: { directory: string; month: string }[]; single: boolean }> {
  if ((await files(root)).includes(join(root, "meta.json"))) return { live: [root], archived: [], single: true };
  const base = join(root, "dispatches");
  const live = (await readdir(base, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && entry.name !== "archive")
    .map((entry) => join(base, entry.name)).sort();
  const archived: { directory: string; month: string }[] = [];
  const archive = join(base, "archive");
  for (const monthEntry of await readdir(archive, { withFileTypes: true }).catch(() => [])) {
    if (!monthEntry.isDirectory()) continue;
    const month = monthEntry.name;
    for (const entry of await readdir(join(archive, month), { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) archived.push({ directory: join(archive, month, entry.name), month });
  }
  return { live, archived: archived.sort((a, b) => a.directory.localeCompare(b.directory)), single: false };
}

export async function parseJsonState(stateDir: string): Promise<ParsedJsonState> {
  const malformed: Malformed[] = [];
  const dispatches: Located<Record<string, unknown>>[] = [];
  const messages: Located<Record<string, unknown>>[] = [];
  const deliveries: Located<Record<string, unknown>>[] = [];
  const collisions: Collision[] = [];
  const directories = await dispatchDirectories(stateDir);
  const liveIds = new Map<string, string>();
  for (const directory of directories.live) {
    const path = join(directory, "meta.json");
    const value = await readRecord(path, malformed);
    if (value === undefined) continue;
    const id = typeof value.dispatchId === "string" ? value.dispatchId : directory.slice(directory.lastIndexOf("/") + 1);
    if (typeof value.dispatchId !== "string" || value.dispatchId === "") { malformed.push({ path, reason: "dispatchId must be a non-empty string" }); continue; }
    if (!(dispatchStates as readonly string[]).includes(String(value.state))) { malformed.push({ path, reason: `invalid dispatch state: ${String(value.state)}` }); continue; }
    liveIds.set(id, path);
    dispatches.push({ path, value, archivedAt: null });
    for (const childKind of ["messages", "deliveries"] as const) {
      const dir = join(directory, childKind);
      for (const childPath of await files(dir)) {
        const child = await readRecord(childPath, malformed);
        if (child === undefined) continue;
        (childKind === "messages" ? messages : deliveries).push({ path: childPath, value: child, archivedAt: null, ...(directories.single ? { dispatchId: id } : {}) });
      }
    }
  }
  for (const { directory, month } of directories.archived) {
    const path = join(directory, "meta.json");
    const value = await readRecord(path, malformed);
    if (value === undefined) continue;
    const id = typeof value.dispatchId === "string" ? value.dispatchId : directory.slice(directory.lastIndexOf("/") + 1);
    if (liveIds.has(id)) {
      collisions.push({ id, livePath: liveIds.get(id) as string, archivedPath: path, kept: "live" });
      continue;
    }
    if (typeof value.dispatchId !== "string" || value.dispatchId === "") { malformed.push({ path, reason: "dispatchId must be a non-empty string" }); continue; }
    if (!(dispatchStates as readonly string[]).includes(String(value.state))) { malformed.push({ path, reason: `invalid dispatch state: ${String(value.state)}` }); continue; }
    dispatches.push({ path, value, archivedAt: `${month}-01T00:00:00.000Z` });
    for (const childKind of ["messages", "deliveries"] as const) {
      const dir = join(directory, childKind);
      for (const childPath of await files(dir)) {
        const child = await readRecord(childPath, malformed);
        if (child === undefined) continue;
        (childKind === "messages" ? messages : deliveries).push({ path: childPath, value: child, archivedAt: `${month}-01T00:00:00.000Z` });
      }
    }
  }
  const terminals: Located<Record<string, unknown>>[] = [];
  for (const path of await files(join(stateDir, "terminals"))) {
    const value = await readRecord(path, malformed);
    if (value !== undefined) terminals.push({ path, value, archivedAt: null });
  }
  const sessions: Located<Record<string, unknown>>[] = [];
  for (const path of await files(join(stateDir, "sessions"))) {
    const value = await readRecord(path, malformed);
    if (value !== undefined) sessions.push({ path, value, archivedAt: null });
  }
  const statePath = join(stateDir, "state.json");
  const modelPath = join(stateDir, "models.json");
  const optionalRecord = async (path: string, fallback: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try { await access(path); }
    catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return fallback;
      malformed.push({ path, reason: error instanceof Error ? error.message : "cannot read file" });
      return fallback;
    }
    return (await readRecord(path, malformed)) ?? fallback;
  };
  const install = await optionalRecord(statePath, {});
  const models = await optionalRecord(modelPath, { version: 1, models: [] });
  const modelRows = Array.isArray(models.models) ? models.models.filter(isRecord) : [];
  const linked: Map<string, Set<string>> = new Map();
  for (const { value } of dispatches) {
    if (typeof value.tmuxSession !== "string" || typeof value.tmuxSessionId !== "string") continue;
    const ids = linked.get(value.tmuxSession) ?? new Set<string>();
    ids.add(value.tmuxSessionId);
    linked.set(value.tmuxSession, ids);
  }
  const tmuxAmbiguities: TmuxAmbiguity[] = [];
  for (const { value } of sessions) {
    const name = typeof value.tmuxSession === "string" ? value.tmuxSession : "";
    const ids = [...(linked.get(name) ?? [])].sort();
    if (ids.length > 1) tmuxAmbiguities.push({ sessionName: name, stableSessionIds: ids });
  }
  return { dispatches, messages, deliveries, terminals, install, models, sessions, malformed, collisions, tmuxAmbiguities };
}

function exists(db: DatabaseAdapter, sql: string, value: string): boolean {
  const row = db.query<{ found: number }>(sql).get(value);
  return row !== null;
}

function dispatchExists(db: DatabaseAdapter, id: string): boolean {
  return exists(db, "SELECT 1 AS found FROM dispatches WHERE id = ? LIMIT 1", id);
}

export function toModels(registry: Record<string, unknown>, rowValues?: readonly Record<string, unknown>[]): Record<string, unknown> {
  const rows = rowValues ?? (Array.isArray(registry.models) ? registry.models.filter(isRecord) : []);
  return { ...registry, models: rows };
}

export async function importJsonState(db: DatabaseAdapter, stateDir: string): Promise<ImportReport> {
  const parsed = await parseJsonState(stateDir);
  const inserted = emptyCounts();
  for (const record of parsed.dispatches) {
    if (dispatchExists(db, String(record.value.dispatchId))) continue;
    insertDispatch(db, record.value, record.archivedAt);
    inserted.dispatches += 1;
  }
  for (const record of parsed.messages) {
    const dispatchId = typeof record.value.dispatchId === "string" ? record.value.dispatchId : record.dispatchId ?? dispatchIdFromPath(record.path);
    if (!dispatchExists(db, dispatchId)) { parsed.malformed.push({ path: record.path, reason: `dispatch not imported: ${dispatchId}` }); continue; }
    const seq = record.value.seq;
    if (!Number.isInteger(seq) || typeof record.value.from !== "string" || typeof record.value.type !== "string" || typeof record.value.text !== "string" || typeof record.value.createdAt !== "string") { parsed.malformed.push({ path: record.path, reason: "message requires integer seq, from, type, text and createdAt fields" }); continue; }
    if (typeof seq !== "number" || db.query<{ found: number }>("SELECT 1 AS found FROM messages WHERE dispatch_id = ? AND seq = ?").get(dispatchId, Number.isInteger(seq) ? seq : -1) !== null) continue;
    try { insertMessage(db, dispatchId, record.value); inserted.messages += 1; }
    catch (error: unknown) { parsed.malformed.push({ path: record.path, reason: error instanceof Error ? error.message : "message violates database constraints" }); }
  }
  for (const record of parsed.deliveries) {
    const dispatchId = typeof record.value.dispatchId === "string" ? record.value.dispatchId : record.dispatchId ?? dispatchIdFromPath(record.path);
    if (!dispatchExists(db, dispatchId)) { parsed.malformed.push({ path: record.path, reason: `dispatch not imported: ${dispatchId}` }); continue; }
    if (exists(db, "SELECT 1 AS found FROM deliveries WHERE id = ? LIMIT 1", String(record.value.id))) continue;
    try { insertDelivery(db, { ...record.value, dispatchId }); inserted.deliveries += 1; }
    catch (error: unknown) { parsed.malformed.push({ path: record.path, reason: error instanceof Error ? error.message : "delivery violates database constraints" }); }
  }
  for (const record of parsed.terminals) {
    const terminalId = record.value.terminalId;
    if (typeof terminalId !== "string") { parsed.malformed.push({ path: record.path, reason: "terminalId must be a string" }); continue; }
    if (getTerminal(db, terminalId) !== undefined) continue;
    insertTerminal(db, record.value); inserted.terminals += 1;
  }
  for (const [moduleId, value] of Object.entries(parsed.install)) {
    if (exists(db, "SELECT 1 AS found FROM install_state WHERE module_id = ? LIMIT 1", moduleId)) continue;
    const updatedAt = isRecord(value) && typeof value.updatedAt === "string" ? value.updatedAt : "";
    insertInstallState(db, moduleId, value, updatedAt); inserted.installState += 1;
  }
  const modelRecords = Array.isArray(parsed.models.models) ? parsed.models.models.filter(isRecord) : [];
  for (const record of modelRecords) {
    const agent = record.agent; const model = record.model;
    if (typeof agent !== "string" || typeof model !== "string") { parsed.malformed.push({ path: join(stateDir, "models.json"), reason: "each model needs string agent and model fields" }); continue; }
    if (db.query<{ found: number }>("SELECT 1 AS found FROM models WHERE agent = ? AND model = ?").get(agent, model) !== null) continue;
    insertModel(db, record, parsed.models); inserted.models += 1;
  }
  for (const record of parsed.sessions) {
    const name = record.value.tmuxSession;
    if (typeof name !== "string") { parsed.malformed.push({ path: record.path, reason: "tmuxSession must be a string" }); continue; }
    if (exists(db, "SELECT 1 AS found FROM tmux_sessions WHERE session_name = ? LIMIT 1", name)) continue;
    const ids = [...(new Set(parsed.dispatches.flatMap(({ value }) => value.tmuxSession === name && typeof value.tmuxSessionId === "string" ? [value.tmuxSessionId] : [])))].sort();
    insertTmuxSession(db, record.value, ids.length === 1 ? ids[0] : null); inserted.tmuxSessions += 1;
  }
  return { inserted, skippedMalformed: parsed.malformed, collisions: parsed.collisions, tmuxAmbiguities: parsed.tmuxAmbiguities };
}

function legacyMessage(value: Record<string, unknown>): Record<string, unknown> {
  const known = new Set(["seq", "from", "type", "text", "body", "sessionId", "createdAt", "idempotencyKey"]);
  const result: Record<string, unknown> = { ...Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key))) };
  for (const field of ["seq", "from", "type", "text", "createdAt"] as const) result[field] = value[field];
  if (typeof value.sessionId === "string") result.sessionId = value.sessionId;
  if (typeof value.idempotencyKey === "string") result.idempotencyKey = value.idempotencyKey;
  if (Object.hasOwn(value, "body")) result.body = value.body;
  return result;
}

function legacyDelivery(value: Record<string, unknown>, dispatchId: string): Record<string, unknown> {
  const known = new Set(["id", "dispatchId", "messageSeqs", "status", "createdAt", "updatedAt", "recipient", "consumer", "consumerGeneration", "acknowledgedAt", "fencedAt"]);
  const result: Record<string, unknown> = { ...Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key))) };
  result.id = value.id; result.dispatchId = dispatchId;
  result.messageSeqs = Array.isArray(value.messageSeqs) ? value.messageSeqs : [];
  result.status = value.status; result.createdAt = value.createdAt; result.updatedAt = value.updatedAt;
  for (const [input, output] of [["recipient", "recipient"], ["consumer", "consumer"], ["consumerGeneration", "consumerGeneration"], ["acknowledgedAt", "acknowledgedAt"], ["fencedAt", "fencedAt"]] as const) {
    if (Object.hasOwn(value, input)) result[output] = value[input];
  }
  return result;
}

/** Validate the complete source before applying it. Call from one withWrite transaction. */
export function applyJsonStateImport(db: DatabaseAdapter, parsed: ParsedJsonState, replace = false): AtomicImportReport {
  const imported = emptyCounts();
  const skippedIdentical = emptyCounts();
  const replaced = emptyCounts();
  const malformed: Malformed[] = [...parsed.malformed];
  const conflicts: string[] = [];
  const messagesByDispatch = new Map<string, Located<Record<string, unknown>>[]>();
  const deliveriesByDispatch = new Map<string, Located<Record<string, unknown>>[]>();
  const dispatchFor = (item: Located<Record<string, unknown>>): string =>
    typeof item.value.dispatchId === "string" ? item.value.dispatchId : item.dispatchId ?? dispatchIdFromPath(item.path);
  for (const item of parsed.messages) {
    const id = dispatchFor(item);
    messagesByDispatch.set(id, [...(messagesByDispatch.get(id) ?? []), item]);
  }
  for (const item of parsed.deliveries) {
    const id = dispatchFor(item);
    deliveriesByDispatch.set(id, [...(deliveriesByDispatch.get(id) ?? []), item]);
  }
  for (const item of parsed.messages) {
    const value = item.value;
    if (!Number.isInteger(value.seq) || typeof value.from !== "string" || typeof value.type !== "string" || typeof value.text !== "string" || typeof value.createdAt !== "string") malformed.push({ path: item.path, reason: "message requires integer seq, from, type, text and createdAt fields" });
  }
  for (const item of parsed.deliveries) {
    const value = item.value;
    if (typeof value.id !== "string" || typeof value.status !== "string" || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") malformed.push({ path: item.path, reason: "delivery requires id, status, createdAt and updatedAt fields" });
  }
  for (const item of parsed.terminals) if (typeof item.value.terminalId !== "string") malformed.push({ path: item.path, reason: "terminalId must be a string" });
  for (const model of Array.isArray(parsed.models.models) ? parsed.models.models : []) {
    if (!isRecord(model) || typeof model.agent !== "string" || typeof model.model !== "string") malformed.push({ path: join(parsed.dispatches[0]?.path.split("/dispatches/")[0] ?? "", "models.json"), reason: "each model needs string agent and model fields" });
  }
  for (const item of parsed.sessions) if (typeof item.value.tmuxSession !== "string") malformed.push({ path: item.path, reason: "tmuxSession must be a string" });

  const actions: { record: Located<Record<string, unknown>>; current: boolean; same: boolean }[] = [];
  for (const record of parsed.dispatches) {
    const id = String(record.value.dispatchId);
    const row = db.query<DispatchRow>("SELECT * FROM dispatches WHERE id = ?").get(id);
    if (row === null) { actions.push({ record, current: false, same: false }); continue; }
    const expectedMessages = (messagesByDispatch.get(id) ?? []).map(({ value }) => legacyMessage(value)).sort((a, b) => Number(a.seq) - Number(b.seq));
    const expectedDeliveries = (deliveriesByDispatch.get(id) ?? []).map(({ value }) => legacyDelivery(value, id)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const actualMessages = listMessages(db, id);
    const actualDeliveries = listDeliveries(db, id).map((value) => ({ ...value }));
    const same = canonical(toMeta(row)) === canonical(record.value)
      && (row.archived_at !== null) === (record.archivedAt !== null)
      && canonical(expectedMessages) === canonical(actualMessages)
      && canonical(expectedDeliveries) === canonical(actualDeliveries);
    actions.push({ record, current: true, same });
    if (!same && !replace) conflicts.push(id);
  }

  for (const item of parsed.terminals) {
    const id = String(item.value.terminalId ?? "");
    const current = id === "" ? undefined : getTerminal(db, id);
    if (current !== undefined && canonical(current) !== canonical(item.value) && !replace) conflicts.push(id);
  }
  for (const [id, value] of Object.entries(parsed.install)) {
    const current = getInstallState(db, id);
    if (current !== undefined && canonical(current) !== canonical(value) && !replace) conflicts.push(id);
  }
  const registryExtra = Object.fromEntries(Object.entries(parsed.models).filter(([key]) => key !== "models"));
  const modelRows = Array.isArray(parsed.models.models) ? parsed.models.models.filter(isRecord) : [];
  const currentModels = listModels(db);
  for (const model of modelRows) {
    const agent = String(model.agent ?? ""); const name = String(model.model ?? "");
    if (agent === "" || name === "") continue;
    const current = Array.isArray(currentModels.models) ? currentModels.models.find((row) => isRecord(row) && row.agent === agent && row.model === name) : undefined;
    const same = current !== undefined && canonical(current) === canonical(model)
      && canonical(Object.fromEntries(Object.entries(currentModels).filter(([key]) => key !== "models"))) === canonical(registryExtra);
    if (current !== undefined && !same && !replace) conflicts.push(`${agent}/${name}`);
  }
  for (const item of parsed.sessions) {
    const name = String(item.value.tmuxSession ?? "");
    if (name === "") continue;
    const current = getTmuxSession(db, name);
    if (current !== undefined && canonical(current) !== canonical(item.value) && !replace) conflicts.push(name);
  }
  if (malformed.length > 0 || conflicts.length > 0) {
    return { imported, skippedIdentical, replaced, malformed, conflicts: [...new Set(conflicts)].sort() };
  }

  for (const action of actions) {
    const id = String(action.record.value.dispatchId);
    const messages = messagesByDispatch.get(id) ?? [];
    const deliveries = deliveriesByDispatch.get(id) ?? [];
    if (action.current && action.same) {
      skippedIdentical.dispatches += 1; skippedIdentical.messages += messages.length; skippedIdentical.deliveries += deliveries.length;
      continue;
    }
    if (action.current) {
      db.run("DELETE FROM dispatches WHERE id = ?", [id]);
      replaced.dispatches += 1; replaced.messages += messages.length; replaced.deliveries += deliveries.length;
    } else imported.dispatches += 1;
    insertDispatch(db, action.record.value, action.record.archivedAt);
    for (const item of messages) { insertMessage(db, id, item.value); if (!action.current) imported.messages += 1; }
    for (const item of deliveries) { insertDelivery(db, { ...item.value, dispatchId: id }); if (!action.current) imported.deliveries += 1; }
  }
  for (const item of parsed.terminals) {
    const id = String(item.value.terminalId);
    const current = getTerminal(db, id);
    if (current !== undefined && canonical(current) === canonical(item.value)) { skippedIdentical.terminals += 1; continue; }
    if (current !== undefined) { db.run("DELETE FROM terminals WHERE terminal_id = ?", [id]); replaced.terminals += 1; }
    insertTerminal(db, item.value); imported.terminals += 1;
  }
  for (const [id, value] of Object.entries(parsed.install)) {
    const current = getInstallState(db, id);
    if (current !== undefined && canonical(current) === canonical(value)) { skippedIdentical.installState += 1; continue; }
    if (current !== undefined) { db.run("DELETE FROM install_state WHERE module_id = ?", [id]); replaced.installState += 1; }
    const updatedAt = isRecord(value) && typeof value.updatedAt === "string" ? value.updatedAt : "";
    insertInstallState(db, id, value, updatedAt); imported.installState += 1;
  }
  for (const model of modelRows) {
    if (typeof model.agent !== "string" || typeof model.model !== "string") continue;
    const current = db.query<{ found: number }>("SELECT 1 AS found FROM models WHERE agent = ? AND model = ?").get(model.agent, model.model);
    if (current !== null) {
      const existing = listModels(db);
      const old = Array.isArray(existing.models) ? existing.models.find((row) => isRecord(row) && row.agent === model.agent && row.model === model.model) : undefined;
      if (old !== undefined && canonical(old) === canonical(model) && canonical(Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "models"))) === canonical(registryExtra)) { skippedIdentical.models += 1; continue; }
      db.run("DELETE FROM models WHERE agent = ? AND model = ?", [model.agent, model.model]); replaced.models += 1;
    }
    insertModel(db, model, parsed.models); imported.models += 1;
  }
  for (const item of parsed.sessions) {
    const name = String(item.value.tmuxSession ?? "");
    const current = getTmuxSession(db, name);
    if (current !== undefined && canonical(current) === canonical(item.value)) { skippedIdentical.tmuxSessions += 1; continue; }
    if (current !== undefined) { db.run("DELETE FROM tmux_sessions WHERE session_name = ?", [name]); replaced.tmuxSessions += 1; }
    const ids = [...new Set(parsed.dispatches.flatMap(({ value }) => value.tmuxSession === name && typeof value.tmuxSessionId === "string" ? [value.tmuxSessionId] : []))].sort();
    insertTmuxSession(db, item.value, ids.length === 1 ? ids[0] : null); imported.tmuxSessions += 1;
  }
  return { imported, skippedIdentical, replaced, malformed, conflicts: [] };
}

function dispatchIdFromPath(path: string): string {
  const parts = path.split("/");
  const dispatchIndex = parts.lastIndexOf("dispatches");
  return parts[dispatchIndex + 1] === "archive" ? parts[dispatchIndex + 3] ?? "" : parts[dispatchIndex + 1] ?? "";
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function mismatch(kind: string, id: string, expected: unknown, actual: unknown): Record<string, unknown> | undefined {
  return canonical(expected) === canonical(actual) ? undefined : { kind, id, expected, actual };
}

function idSets(expected: readonly string[], actual: readonly string[], kind: string, mismatches: Record<string, unknown>[]): void {
  const left = [...expected].sort(); const right = [...actual].sort();
  const result = mismatch(`${kind}_ids`, kind, left, right);
  if (result !== undefined) mismatches.push(result);
}

export type ParityReport = Readonly<{
  totals: Counts & Readonly<{ outbox: number; leases: number }>;
  databaseTotals: Counts & Readonly<{ outbox: number; leases: number }>;
  mismatches: readonly Record<string, unknown>[];
  skippedMalformed: readonly Malformed[];
  collisions: readonly Collision[];
  tmuxAmbiguities: readonly TmuxAmbiguity[];
  records: Readonly<{ dispatches: DispatchRecord[]; messages: MessageRecord[]; deliveries: DeliveryRecord[]; terminals: TerminalRecord[]; installState: Record<string, unknown>; models: Record<string, unknown>; tmuxSessions: TmuxSessionRecord[] }>;
}>;

export async function readJsonStateParity(db: DatabaseAdapter, stateDir: string): Promise<ParityReport> {
  const source = await parseJsonState(stateDir);
  return readParsedJsonStateParity(db, source);
}

export function readParsedJsonStateParity(
  db: DatabaseAdapter,
  source: ParsedJsonState,
  options: Readonly<{ ignoredLeaseKeys?: readonly string[] }> = {},
): ParityReport {
  const mismatches: Record<string, unknown>[] = [];
  const records = {
    dispatches: listDispatches(db, { includeArchived: true }),
    messages: [] as MessageRecord[], deliveries: [] as DeliveryRecord[],
    terminals: listTerminals(db), installState: listInstallState(db), models: listModels(db), tmuxSessions: listTmuxSessions(db),
  };
  const outbox = listOutbox(db);
  const ignoredLeaseKeys = new Set(options.ignoredLeaseKeys ?? []);
  const leases = listLeases(db).filter((lease) => !ignoredLeaseKeys.has(lease.key));
  const sourceDispatches = source.dispatches.map(({ value }) => value);
  const sourceDispatchById = new Map(sourceDispatches.map((value) => [String(value.dispatchId), value]));
  const actualDispatchById = new Map(records.dispatches.map((value) => [value.dispatchId, value]));
  idSets([...sourceDispatchById.keys()], [...actualDispatchById.keys()], "dispatch", mismatches);
  for (const [id, expected] of sourceDispatchById) {
    const actual = actualDispatchById.get(id);
    if (actual === undefined) continue;
    for (const field of ["state", "parentSessionId"] as const) {
      const diff = mismatch(`dispatch_${field}`, id, expected[field], actual[field]); if (diff !== undefined) mismatches.push(diff);
    }
    const diff = mismatch("dispatch_round_trip", id, expected, actual); if (diff !== undefined) mismatches.push(diff);
  }
  const sourceMessages = source.messages.map(({ value, path }) => ({ ...value, dispatchId: dispatchIdFromPath(path) } as Record<string, unknown> & { dispatchId: string })).filter((value): value is Record<string, unknown> & { dispatchId: string; seq: number } => typeof value.seq === "number" && Number.isInteger(value.seq));
  const sourceDeliveries = source.deliveries.map(({ value, path }) => ({ ...value, dispatchId: typeof value.dispatchId === "string" ? value.dispatchId : dispatchIdFromPath(path) } as Record<string, unknown> & { dispatchId: string })).filter((value): value is Record<string, unknown> & { dispatchId: string; id: string; status: string } => typeof value.id === "string" && typeof value.status === "string");
  for (const dispatch of records.dispatches) {
    records.messages.push(...listMessages(db, dispatch.dispatchId).map((m) => ({ ...m, dispatchId: dispatch.dispatchId })) as MessageRecord[]);
    records.deliveries.push(...listDeliveries(db, dispatch.dispatchId));
  }
  idSets(sourceMessages.map((message) => `${message.dispatchId}:${message.seq}`), records.messages.map((message) => `${(message as Record<string, unknown>).dispatchId}:${message.seq}`), "message", mismatches);
  idSets(sourceDeliveries.map((delivery) => String(delivery.id)), records.deliveries.map((delivery) => delivery.id), "delivery", mismatches);
  for (const [index, expected] of sourceMessages.entries()) {
    const actual = records.messages.find((message) => (message as Record<string, unknown>).dispatchId === expected.dispatchId && message.seq === expected.seq);
    if (actual !== undefined) { const diff = mismatch("message_round_trip", `${expected.dispatchId}:${expected.seq}`, expected, actual); if (diff !== undefined) mismatches.push(diff); }
  }
  for (const expected of sourceDeliveries) {
    const actual = records.deliveries.find((delivery) => delivery.id === expected.id);
    if (actual !== undefined) { const diff = mismatch("delivery_status", String(expected.id), expected.status, actual.status); if (diff !== undefined) mismatches.push(diff); const roundTrip = mismatch("delivery_round_trip", String(expected.id), expected, actual); if (roundTrip !== undefined) mismatches.push(roundTrip); }
  }
  idSets(source.terminals.map(({ value }) => String(value.terminalId)), records.terminals.map((record) => record.terminalId), "terminal", mismatches);
  for (const { value } of source.terminals) { const actual = records.terminals.find((record) => record.terminalId === value.terminalId); if (actual !== undefined) { const diff = mismatch("terminal_round_trip", String(value.terminalId), value, actual); if (diff !== undefined) mismatches.push(diff); } }
  const expectedState = source.install; const actualState = records.installState;
  idSets(Object.keys(expectedState), Object.keys(actualState), "install_state", mismatches);
  for (const [id, expected] of Object.entries(expectedState)) { const diff = mismatch("install_state_round_trip", id, expected, actualState[id]); if (diff !== undefined) mismatches.push(diff); }
  const expectedModels = toModels(source.models);
  const diffModels = mismatch("models_round_trip", "models.json", expectedModels, records.models); if (diffModels !== undefined) mismatches.push(diffModels);
  idSets(source.sessions.map(({ value }) => String(value.tmuxSession)), records.tmuxSessions.map((record) => record.tmuxSession), "tmux_session", mismatches);
  for (const { value } of source.sessions) { const actual = records.tmuxSessions.find((record) => record.tmuxSession === value.tmuxSession); if (actual !== undefined) { const diff = mismatch("tmux_session_round_trip", String(value.tmuxSession), value, actual); if (diff !== undefined) mismatches.push(diff); } }
  const totals = emptyCounts();
  totals.dispatches = source.dispatches.length; totals.messages = source.messages.length; totals.deliveries = source.deliveries.length;
  totals.terminals = source.terminals.length; totals.installState = Object.keys(source.install).length;
  totals.models = Array.isArray(source.models.models) ? source.models.models.length : 0; totals.tmuxSessions = source.sessions.length;
  const databaseTotals = emptyCounts();
  databaseTotals.dispatches = records.dispatches.length; databaseTotals.messages = records.messages.length; databaseTotals.deliveries = records.deliveries.length;
  databaseTotals.terminals = records.terminals.length; databaseTotals.installState = Object.keys(records.installState).length;
  databaseTotals.models = Array.isArray(records.models.models) ? records.models.models.length : 0;
  databaseTotals.tmuxSessions = records.tmuxSessions.length;
  idSets([], outbox.map((item) => item.id), "outbox", mismatches);
  idSets([], leases.map((item) => item.key), "lease", mismatches);
  return {
    totals: { ...totals, outbox: 0, leases: 0 },
    databaseTotals: { ...databaseTotals, outbox: outbox.length, leases: leases.length },
    mismatches, skippedMalformed: source.malformed, collisions: source.collisions, tmuxAmbiguities: source.tmuxAmbiguities, records,
  };
}
