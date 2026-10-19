import { appendFileSync, closeSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export type ModelCallKind = "summary" | "curator" | "title";
export class ModelBudgetExceeded extends Error { constructor() { super("daily model-call budget reached"); this.name = "ModelBudgetExceeded"; } }
export type ModelCall = { id: string; time: string; kind: ModelCallKind; project: string; session: string; agent: string; model: string; inputChars: number; outputChars: number; status: "pending" | "ok" | "error" };
const ledger = (stateDir: string) => join(stateDir, "knowledge", "model-calls.jsonl");
const ledgerDays = (stateDir: string) => join(stateDir, "knowledge", "model-calls");
const RETENTION_DAYS = 90;

function parseRows(content: string): ModelCall[] {
  return content.split("\n").filter(Boolean).flatMap((line, index) => { try { const value = JSON.parse(line) as Partial<ModelCall>; return [{ ...value, id: value.id ?? `legacy-${index}`, status: value.status ?? "ok" } as ModelCall]; } catch { return []; } });
}

function rows(stateDir: string, day?: string): ModelCall[] {
  try {
    const path = day === undefined ? ledger(stateDir) : join(ledgerDays(stateDir), `${day}.jsonl`);
    return parseRows(readFileSync(path, "utf8"));
  } catch { return []; }
}

function localDay(at: Date): string { return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`; }

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The lock protects only a ledger operation; model execution never holds it. */
async function withLedgerLock<T>(root: string, action: () => T): Promise<T> {
  const lock = join(root, "model-calls.lock");
  const started = Date.now();
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try { descriptor = openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = statSync(lock);
        const pid = Number(readFileSync(lock, "utf8"));
        if (Date.now() - stat.mtimeMs > 60_000 || Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) {
          // Claim the observed inode before unlinking so concurrent reclaimers cannot remove a newer lock.
          const claim = `${lock}.${process.pid}.${crypto.randomUUID()}.stale`;
          try {
            linkSync(lock, claim);
            const observed = statSync(claim), current = statSync(lock);
            if (observed.dev === current.dev && observed.ino === current.ino) unlinkSync(lock);
          } catch (claimError) {
            if ((claimError as NodeJS.ErrnoException).code !== "ENOENT" && (claimError as NodeJS.ErrnoException).code !== "EEXIST") throw claimError;
          } finally { try { unlinkSync(claim); } catch { /* already removed */ } }
          continue;
        }
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      if (Date.now() - started > 30_000) throw new Error("timed out waiting for the model-call ledger");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    writeSync(descriptor, String(process.pid));
    return action();
  } finally {
    const owned = fstatSync(descriptor);
    closeSync(descriptor);
    try { const current = statSync(lock); if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(lock); } catch { /* stale-lock recovery may have removed it */ }
  }
}

function migrateLedger(stateDir: string, now: Date): void {
  const directory = ledgerDays(stateDir);
  if (statDirectory(directory)) return;
  const temporary = `${directory}.${process.pid}.${crypto.randomUUID()}.tmp`;
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const cutoff = localDay(new Date(now.getTime() - (RETENTION_DAYS - 1) * 86_400_000));
  const retained = rows(stateDir).filter((row) => localDay(new Date(row.time)) >= cutoff);
  const grouped = new Map<string, ModelCall[]>();
  for (const row of retained) {
    const day = localDay(new Date(row.time));
    const entries = grouped.get(day) ?? [];
    entries.push(row);
    grouped.set(day, entries);
  }
  for (const [day, entries] of grouped) writeFileSync(join(temporary, `${day}.jsonl`), `${entries.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  renameSync(temporary, directory);
  try { writeFileSync(ledger(stateDir), retained.map((row) => JSON.stringify(row)).join("\n") + (retained.length === 0 ? "" : "\n"), { mode: 0o600 }); } catch { /* the day files are authoritative after migration */ }
}

function statDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function pruneLedger(stateDir: string, now: Date): void {
  const cutoff = localDay(new Date(now.getTime() - (RETENTION_DAYS - 1) * 86_400_000));
  for (const name of readdirSync(ledgerDays(stateDir))) {
    const day = name.slice(0, -".jsonl".length);
    if (name.endsWith(".jsonl") && /^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) unlinkSync(join(ledgerDays(stateDir), name));
  }
}

function append(root: string, row: ModelCall): void {
  const directory = join(root, "model-calls");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  appendFileSync(join(directory, `${localDay(new Date(row.time))}.jsonl`), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
function callsOnDay(entries: ModelCall[], day: string): Map<string, ModelCall> {
  const calls = new Map<string, ModelCall>();
  for (const row of entries) {
    if (localDay(new Date(row.time)) !== day) continue;
    const previous = calls.get(row.id);
    if (previous === undefined || previous.status === "pending" && row.status !== "pending") calls.set(row.id, row);
  }
  return calls;
}

/** Reserves one budget slot atomically, then executes the model without holding the ledger lock. */
export async function trackedModelCall<T>(options: { stateDir: string; dailyLimit: number; force?: boolean; kind: ModelCallKind; project: string; session: string; agent: string; model: string; prompt: string; now?: () => Date; call: () => Promise<T>; outputChars?: (result: T) => number }): Promise<T> {
  const { stateDir } = options;
  const root = join(stateDir, "knowledge");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const now = (options.now ?? (() => new Date()))();
  const id = crypto.randomUUID();
  const reservation: ModelCall = { id, time: now.toISOString(), kind: options.kind, project: options.project, session: options.session, agent: options.agent, model: options.model, inputChars: options.prompt.length, outputChars: 0, status: "pending" };
  await withLedgerLock(root, () => {
    migrateLedger(stateDir, now);
    pruneLedger(stateDir, now);
    if (callsOnDay(rows(stateDir, localDay(now)), localDay(now)).size >= options.dailyLimit && options.force !== true) throw new ModelBudgetExceeded();
    append(root, reservation);
  });
  let result: T | undefined, failure: unknown, failed = false;
  try { result = await options.call(); } catch (error) { failure = error; failed = true; }
  const completion: ModelCall = { ...reservation, outputChars: failed ? 0 : options.outputChars?.(result as T) ?? (typeof result === "string" ? result.length : 0), status: failed ? "error" : "ok" };
  await withLedgerLock(root, () => { migrateLedger(stateDir, now); append(root, completion); });
  if (failed) throw failure;
  return result as T;
}

export function modelUsage(stateDir: string, days = 7, now = new Date()): { days: Array<{ day: string; calls: number; inputChars: number; outputChars: number; kinds: Record<string, { calls: number; inputChars: number; outputChars: number }> }>; today: string; budgetUsed: number } {
  const cutoff = new Date(now.getTime() - Math.max(0, days - 1) * 86_400_000);
  const from = localDay(cutoff), today = localDay(now);
  const grouped = new Map<string, ModelCall[]>();
  const dayFiles = statDirectory(ledgerDays(stateDir))
    ? readdirSync(ledgerDays(stateDir)).filter((name) => name.endsWith(".jsonl")).map((name) => name.slice(0, -".jsonl".length)).filter((day) => day >= from && day <= today).flatMap((day) => rows(stateDir, day))
    : rows(stateDir);
  for (const row of dayFiles) {
    const day = localDay(new Date(row.time));
    if (day < from || day > today) continue;
    const entries = grouped.get(day) ?? [];
    const index = entries.findIndex((entry) => entry.id === row.id);
    if (index < 0) entries.push(row);
    else if (entries[index]?.status === "pending" && row.status !== "pending") entries[index] = row;
    grouped.set(day, entries);
  }
  return { days: [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([day, entries]) => {
    const kinds: Record<string, { calls: number; inputChars: number; outputChars: number }> = {};
    for (const entry of entries) { const kind = kinds[entry.kind] ?? { calls: 0, inputChars: 0, outputChars: 0 }; kind.calls += 1; kind.inputChars += entry.inputChars; kind.outputChars += entry.outputChars; kinds[entry.kind] = kind; }
    return { day, calls: entries.length, inputChars: entries.reduce((n, entry) => n + entry.inputChars, 0), outputChars: entries.reduce((n, entry) => n + entry.outputChars, 0), kinds };
  }), today, budgetUsed: grouped.get(today)?.length ?? 0 };
}
