import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import type { Clock } from "../../core/clock.js";
import { dueToSleep, defaultIdleSetting, emptyIdleState, forget, parseIdleSetting, parseIdleState, recordBoot, sleepsAt, type IdleState } from "../../core/native-idle.js";
import { candidatesFromSimctl } from "../../core/native.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { usageText } from "../../core/usage.js";
import { activeRunDevices } from "./maestro.js";

type Environment = Readonly<Record<string, string | undefined>>;

const stateFile = (environment: Environment) => join(resolveStateDirectory(environment), "native", "booted.json");

async function readState(environment: Environment): Promise<IdleState> {
  try { return parseIdleState(await readFile(stateFile(environment), "utf8")); } catch { return emptyIdleState; }
}

async function writeState(environment: Environment, state: IdleState): Promise<void> {
  const file = stateFile(environment);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function readMinutes(environment: Environment): Promise<number> {
  try {
    const parsed = parseIdleSetting(await readFile(join(resolveStateDirectory(environment), "device-idle.json"), "utf8"));
    return (parsed.kind === "ok" ? parsed.value : defaultIdleSetting).minutes;
  } catch { return defaultIdleSetting.minutes; }
}

/** Called by `native sim ensure` after it booted a simulator, so only those are ever put to sleep. */
export async function recordBooted(environment: Environment, udid: string, at: number): Promise<void> {
  await writeState(environment, recordBoot(await readState(environment), udid, at));
}

async function bootedNow(processAdapter: ProcessAdapter): Promise<Set<string> | null> {
  const listed = await processAdapter.run("xcrun", ["simctl", "list", "devices", "--json"]);
  if (listed.kind !== "ok") return null;
  try {
    const candidates = candidatesFromSimctl(JSON.parse(listed.value.stdout), "phone");
    const tv = candidatesFromSimctl(JSON.parse(listed.value.stdout), "tv");
    if (candidates.kind !== "ok" || tv.kind !== "ok") return null;
    return new Set([...candidates.value, ...tv.value].filter((candidate) => candidate.state === "Booted").map((candidate) => candidate.udid));
  } catch { return null; }
}

export async function executeIdle(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter, clock: Clock): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(`${usageText("native-sim-idle")}\n`);
  const unknown = args.find((arg) => !["--json", "--sweep", "--all", "--touch"].includes(arg));
  if (unknown !== undefined) return failed(`unknown native sim idle option: ${unknown}`, 2);
  if (args.includes("--all") && !args.includes("--sweep")) return failed("native sim idle --all needs --sweep", 2);
  const now = clock.now();
  const minutes = await readMinutes(environment);
  let state = await readState(environment);
  if (args.includes("--touch")) state = { ...state, seenAt: now };
  let slept: string[] | undefined;
  const running = activeRunDevices(environment);
  const booted = await bootedNow(processAdapter);
  // A simulator someone shut down by hand is no longer ours to track.
  if (booted !== null) for (const udid of Object.keys(state.booted)) if (!booted.has(udid)) state = forget(state, udid, false);
  if (args.includes("--sweep")) {
    slept = [];
    for (const udid of dueToSleep(state, { now, minutes, running, all: args.includes("--all") })) {
      const shutdown = await processAdapter.run("xcrun", ["simctl", "shutdown", udid]);
      if (shutdown.kind !== "ok") continue;
      state = forget(state, udid, true);
      slept.push(udid);
    }
  }
  await writeState(environment, state);
  const devices = Object.entries(state.booted).map(([udid, bootedAt]) => {
    const at = sleepsAt(state, udid, minutes);
    return { udid, bootedAt, sleepsAt: at === null ? null : new Date(at).toISOString(), running: running.has(udid) };
  });
  if (args.includes("--json")) return ok(`${JSON.stringify({ minutes, devices, asleep: state.asleep, ...(slept === undefined ? {} : { slept }) })}\n`);
  const lines = devices.map((device) => `${device.udid} booted ${device.bootedAt}${device.running ? ", running a flow" : device.sleepsAt === null ? "" : `, sleeps ${device.sleepsAt}`}`);
  return ok(`${[...lines, ...(slept ?? []).map((udid) => `${udid} shut down`)].join("\n") || "no simulator booted by megabrain"}\n`);
}
