import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchStates } from "../../core/dispatch-states.js";
import { listDispatches, insertDispatch, type DispatchRecord } from "../queries/dispatches.js";
import { insertMessage, listMessages, type MessageRecord } from "../queries/messages.js";
import { insertDelivery, listDeliveries, type DeliveryRecord } from "../queries/deliveries.js";
import { listLeases, listOutbox } from "../queries/outbox-leases.js";
import { getTerminal, insertInstallState, insertModel, insertTerminal, insertTmuxSession, listInstallState, listModels, listTerminals, listTmuxSessions, type TerminalRecord, type TmuxSessionRecord } from "../queries/aux-state.js";
import { type DatabaseAdapter } from "../queries/types.js";

type Malformed = Readonly<{ path: string; reason: string }>;
type Collision = Readonly<{ id: string; livePath: string; archivedPath: string; kept: "live" }>;
type TmuxAmbiguity = Readonly<{ sessionName: string; stableSessionIds: readonly string[] }>;
type Counts = { dispatches: number; messages: number; deliveries: number; terminals: number; installState: number; models: number; tmuxSessions: number };
export type ImportReport = Readonly<{ inserted: Counts; skippedMalformed: readonly Malformed[]; collisions: readonly Collision[]; tmuxAmbiguities: readonly TmuxAmbiguity[] }>;

type Located<T> = Readonly<{ path: string; value: T; archivedAt: string | null }>;
type ParsedState = Readonly<{
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

async function dispatchDirectories(root: string): Promise<{ live: string[]; archived: { directory: string; month: string }[] }> {
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
  return { live, archived: archived.sort((a, b) => a.directory.localeCompare(b.directory)) };
}

async function parseState(stateDir: string): Promise<ParsedState> {
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
        (childKind === "messages" ? messages : deliveries).push({ path: childPath, value: child, archivedAt: null });
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
  const install = (await readRecord(statePath, malformed)) ?? {};
  const models = (await readRecord(modelPath, malformed)) ?? { version: 1, models: [] };
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
  const parsed = await parseState(stateDir);
  const inserted = emptyCounts();
  for (const record of parsed.dispatches) {
    if (dispatchExists(db, String(record.value.dispatchId))) continue;
    insertDispatch(db, record.value, record.archivedAt);
    inserted.dispatches += 1;
  }
  for (const record of parsed.messages) {
    const dispatchId = typeof record.value.dispatchId === "string" ? record.value.dispatchId : dispatchIdFromPath(record.path);
    if (!dispatchExists(db, dispatchId)) { parsed.malformed.push({ path: record.path, reason: `dispatch not imported: ${dispatchId}` }); continue; }
    const seq = record.value.seq;
    if (!Number.isInteger(seq) || typeof record.value.from !== "string" || typeof record.value.type !== "string" || typeof record.value.text !== "string" || typeof record.value.createdAt !== "string") { parsed.malformed.push({ path: record.path, reason: "message requires integer seq, from, type, text and createdAt fields" }); continue; }
    if (typeof seq !== "number" || db.query<{ found: number }>("SELECT 1 AS found FROM messages WHERE dispatch_id = ? AND seq = ?").get(dispatchId, Number.isInteger(seq) ? seq : -1) !== null) continue;
    try { insertMessage(db, dispatchId, record.value); inserted.messages += 1; }
    catch (error: unknown) { parsed.malformed.push({ path: record.path, reason: error instanceof Error ? error.message : "message violates database constraints" }); }
  }
  for (const record of parsed.deliveries) {
    const dispatchId = typeof record.value.dispatchId === "string" ? record.value.dispatchId : dispatchIdFromPath(record.path);
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
  const source = await parseState(stateDir);
  const mismatches: Record<string, unknown>[] = [];
  const records = {
    dispatches: listDispatches(db, { includeArchived: true }),
    messages: [] as MessageRecord[], deliveries: [] as DeliveryRecord[],
    terminals: listTerminals(db), installState: listInstallState(db), models: listModels(db), tmuxSessions: listTmuxSessions(db),
  };
  const outbox = listOutbox(db);
  const leases = listLeases(db);
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
