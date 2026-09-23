import { ok, unknown, type Result } from "./result.js";
import { dispatchStates, processStates, terminalStates, type DispatchStateValue, type ProcessStateValue, type TerminalStateValue } from "./dispatch-states.js";
import { ownsDispatch, type CallerIdentity } from "./context.js";

export type JsonRecord = { readonly [key: string]: unknown };
export type UnknownField = { readonly kind: "unknown"; readonly value: string };
export type DispatchState = DispatchStateValue | UnknownField;
export type ProcessState = ProcessStateValue | UnknownField;
export type TerminalState = TerminalStateValue | UnknownField;

export type DispatchRecord = {
  readonly raw: JsonRecord;
  readonly dispatchId?: string;
  readonly parentSessionId?: string;
  readonly parentHost?: string;
  readonly worktreePath?: string;
  readonly state?: DispatchState;
  readonly processState?: ProcessState;
  readonly terminalState?: TerminalState;
};

export type DispatchListOptions = Readonly<{ all: boolean; orphans: boolean; uncertain: boolean }>;
export type DispatchCaller = Readonly<{ id: string; host: string }>;
export type DecoratedDispatch = JsonRecord & Readonly<{ ownedByCaller: boolean; orphan: boolean; uncertain: boolean; reconcileResult: unknown }>;

function field<T extends string>(value: unknown, known: readonly T[]): T | UnknownField | undefined {
  if (typeof value !== "string") return undefined;
  return (known as readonly string[]).includes(value) ? value as T : { kind: "unknown", value };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseDispatchRecord(value: unknown): Result<DispatchRecord> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return unknown("dispatch metadata is not a JSON object");
  const raw = value as JsonRecord;
  return ok({
    raw,
    dispatchId: stringField(raw.dispatchId),
    parentSessionId: stringField(raw.parentSessionId),
    parentHost: stringField(raw.parentHost),
    worktreePath: stringField(raw.worktreePath),
    state: field(raw.state, dispatchStates),
    processState: field(raw.processState, processStates),
    terminalState: field(raw.terminalState, terminalStates),
  });
}

function isKnown<T extends string>(value: T | UnknownField | undefined, expected: T): boolean {
  return value === expected;
}

export function decorateDispatchRecord(record: DispatchRecord, caller: DispatchCaller): DecoratedDispatch {
  // DispatchCaller only carries id/host, not a terminal handle, so ownsDispatch's legacy
  // terminal-handle fallback is inert here (padded to null) — the id/host comparison it also
  // does is the same one this used to do inline.
  const identity: CallerIdentity = { id: caller.id, host: caller.host, terminalId: null, tmuxSession: null, tmuxPane: null };
  const ownedByCaller = ownsDispatch(identity, { parentHost: record.parentHost ?? "", parentSessionId: record.parentSessionId ?? "" });
  const orphan = isKnown(record.state, "orphaned");
  const uncertain = record.processState === "start-unproven" || record.processState === "stop-unproven" || record.processState === "abandoned" || record.processState === "exited";
  return { ...record.raw, ownedByCaller, orphan, uncertain, reconcileResult: record.raw.reconcileOutcome ?? "unchanged" };
}

export function filterDispatchRecords(records: readonly DispatchRecord[], options: DispatchListOptions, caller: DispatchCaller): DispatchRecord[] {
  return records.filter((record) => {
    const decorated = decorateDispatchRecord(record, caller);
    return (options.all || options.orphans || options.uncertain || decorated.ownedByCaller === true) &&
      (!options.orphans || decorated.orphan === true) && (!options.uncertain || decorated.uncertain === true);
  });
}

function display(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function formatDispatchList(records: readonly DecoratedDispatch[], json: boolean): string {
  if (json) return `${JSON.stringify(records, null, 2)}\n`;
  const lines = [`${"DISPATCH".padEnd(38)} ${"STATE".padEnd(20)} ${"PROCESS".padEnd(18)} ${"TERMINAL".padEnd(12)} ${"OWNERSHIP".padEnd(10)} WORKTREE`];
  for (const record of records) {
    const ownership = record.ownedByCaller === true ? "owned" : "not-owned";
    lines.push(`${display(record.dispatchId).padEnd(38)} ${display(record.state).padEnd(20)} ${display(record.processState, "unknown").padEnd(18)} ${display(record.terminalState, "unknown").padEnd(12)} ${ownership.padEnd(10)} ${display(record.worktreePath)}`);
  }
  return `${lines.join("\n")}\n`;
}
