import { failed, ok, type Result } from "./result.js";

export const DEFAULT_IDLE_MINUTES = 10;

/** Which simulators megabrain booted, when, and which it shut down; `seenAt` is the last time a Device tab showed. */
export type IdleState = { version: 1; booted: Record<string, string>; asleep: string[]; seenAt: number | null };
export type IdleSetting = { version: 1; minutes: number };

export const emptyIdleState: IdleState = { version: 1, booted: {}, asleep: [], seenAt: null };
export const defaultIdleSetting: IdleSetting = { version: 1, minutes: DEFAULT_IDLE_MINUTES };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseIdleState(raw: string): IdleState {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.booted) || !Array.isArray(value.asleep)) return emptyIdleState;
    const booted = Object.fromEntries(Object.entries(value.booted).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return { version: 1, booted, asleep: value.asleep.filter((entry): entry is string => typeof entry === "string"), seenAt: typeof value.seenAt === "number" ? value.seenAt : null };
  } catch { return emptyIdleState; }
}

export function parseIdleSetting(raw: string): Result<IdleSetting> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("device-idle-minutes: not valid JSON", 2); }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "version" && key !== "minutes") || value.version !== 1) return failed("device-idle-minutes: expected { version: 1, minutes }", 2);
  if (typeof value.minutes !== "number" || !Number.isInteger(value.minutes) || value.minutes < 0 || value.minutes > 10_080) return failed("device-idle-minutes: minutes must be a whole number from 0 (never sleep) to 10080", 2);
  return ok({ version: 1, minutes: value.minutes });
}

export const recordBoot = (state: IdleState, udid: string, at: number): IdleState => ({ ...state, booted: { ...state.booted, [udid]: new Date(at).toISOString() }, asleep: state.asleep.filter((entry) => entry !== udid) });

export function forget(state: IdleState, udid: string, asleep: boolean): IdleState {
  const { [udid]: _gone, ...booted } = state.booted;
  return { ...state, booted, asleep: asleep && !state.asleep.includes(udid) ? [...state.asleep, udid] : state.asleep };
}

/** When a simulator sleeps: `minutes` after the later of its boot and the last visible Device tab; null when sleeping is off. */
export function sleepsAt(state: IdleState, udid: string, minutes: number): number | null {
  const bootedAt = state.booted[udid];
  if (minutes === 0 || bootedAt === undefined) return null;
  return Math.max(Date.parse(bootedAt), state.seenAt ?? 0) + minutes * 60_000;
}

/** The simulators to shut down now: those past their time and not running a flow, or every one when the app quits. */
export function dueToSleep(state: IdleState, at: { now: number; minutes: number; running: ReadonlySet<string>; all: boolean }): string[] {
  return Object.keys(state.booted).filter((udid) => {
    if (at.all) return true;
    const due = sleepsAt(state, udid, at.minutes);
    return due !== null && due <= at.now && !at.running.has(udid);
  });
}
