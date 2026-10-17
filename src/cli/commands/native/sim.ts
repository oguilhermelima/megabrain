import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../../adapters/proc.js";
import { buildXcodebuildArgs, candidatesForRuntimeFromSimctl, candidatesFromSimctl, DEFAULT_NATIVE_STABLE_WINDOW_MS, evaluateNativeHealth, nativeBuildStepFailure, nativeUsage, renderNativeUrl, runtimesFromSimctl, selectDevice, validateKind, validateMetroPort, validateStableWindow, validateTimeout, type NativeBuildStep, type NativeCandidate, type NativeHealth, type NativeKind, type NativePlatform, type NativeRuntime } from "../../../core/native.js";
import { sleep, systemClock, type Clock } from "../../../core/clock.js";
import { failed, ok, type Result } from "../../../core/result.js";
import { parseCrashReport, selectCrashReports, validateCrashLast, type CrashInput } from "../../../core/crash.js";
import { nativeSessionFor, removeNativeSession, replaceNativeSession, type NativeSessionKey } from "../../../core/native-session.js";
import { createNativeSessionStore } from "../../../adapters/native-session-store.js";
import { connectMetroInspector, waitForMetroInspectorTarget, type MetroEvaluation } from "../../../core/native-cdp.js";
import { buildNativeCaptureFailureRecord, buildNativeCapturePaths, buildNativeCaptureRecord, decideCaptureOutcome, type NativeCaptureRecord, type NativeCaptureScreenRecord } from "../../../core/native-capture.js";
import { resolveStateDirectory } from "../../../core/state.js";
import { readSimulatorOwners, writeSimulatorOwners } from "../../../core/native-sim-owner.js";
import { executeIdle, recordBooted } from "../native-idle.js";
import { usageText } from "../../../core/usage.js";
import { unknownProcess, unknownMetro, unknownTree, unknownFrame, APPIUM_SESSION_DEFAULTS, appiumSessionCapabilities, AppiumSession, AppiumSessionAttempt, AppiumResponse, appiumResponse, appiumMessage, appiumHttpFailure, createAppiumSession, appiumSession } from "./session.js";
import { nativeHealth } from "./health.js";
import { nativeBuildUsage, buildConfigError, readExpoApp, generatedWorkspace, nativeBuild } from "./build.js";
import { nativeCrashes } from "./crashes.js";
import { runtimePlatform, installedRuntimes, nativeRuntimeList, nativeRuntimeInstall } from "./runtime.js";

import { Environment, Config, ExpoApp, NativeCaptureScreen, error, refusalCode, normalizeJsonResult, nativeWorktreeRoot, nativeConfigFile, config, setting, simCandidates, parseKind, optionValue, crashReportsDirectory, nativeReload, runtimeValue, formatEvaluation, cdpArguments, nativeEval, routerModuleExpression, logBoxExpression, devLoadingViewExpression, routeInfoExpression, navigationQueueExpression, navigationExpression, RouteSnapshot, NativeNavigationResult, routeSnapshot, routeChanged, nativeNavigationResult, pendingNavigationCount, nativeNavigate, nativeCaptureScreens, uniqueCaptureScreens, captureOptionNames, validateCaptureOptions, terminateNativeCaptureApp, resetNativeCaptureApp, captureNativeFrame, NativeSettledFrame, settleNativeFrame, NativeLogBoxStatus, NativeDevLoadingViewStatus, NativeResetOverlayStatus, silenceNativeLogBox, preventNativeDevLoadingView, silenceNativeOverlays, nativeOverlaySummary, nativeDevLoadingViewSummary, captureNavigationArgs, nativeCapture, appium, executeNative } from "./index.js";

export async function nativeList(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(nativeUsage("list"));
  const bootedOnly = args[0] === "--booted";
  let json = false;
  for (const arg of args.slice(1)) { if (arg === "--json") json = true; else if (arg === "-h" || arg === "--help") return ok(nativeUsage("list")); else return error(`unknown native sim list option: ${arg}`, 2); }
  if (bootedOnly && args.length > 2) return error(`unknown native sim list option: ${args[2]}`, 2);
  const kind = bootedOnly ? undefined : parseKind(args);
  if (kind !== undefined && kind.kind !== "ok") return kind;
  const listed = await listAllCandidates(processAdapter);
  if (listed.kind !== "ok") return listed;
  let rows = listed.value.filter((device) => (kind?.kind !== "ok" || device.kind === kind.value) && (!bootedOnly || device.state === "Booted"));
  const owners = await readSimulatorOwners(environment);
  const live = new Set(listed.value.filter((device) => device.state === "Booted").map((device) => device.udid));
  let stale = false;
  for (const udid of Object.keys(owners)) if (!live.has(udid)) { delete owners[udid]; stale = true; }
  if (stale) await writeSimulatorOwners(environment, owners);
  if (bootedOnly) rows = rows.map((device) => ({ ...device, worktree: owners[device.udid]?.worktree ?? null }));
  if (json) return ok(`${JSON.stringify({ ...(bootedOnly ? {} : { kind: kind!.value }), devices: rows })}\n`);
  return ok(rows.map((row) => `${row.name}\t${row.state}\t${row.udid}\n`).join(""));
}

export async function nativeShutdown(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(`${usageText("native-sim-shutdown")}\n`);
  const udid = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!SIMULATOR_UDID.test(udid)) return error(`native sim shutdown needs a simulator udid: ${udid}`, 2);
  const listed = await listAllCandidates(processAdapter);
  if (listed.kind !== "ok") return listed;
  const device = listed.value.find((candidate) => candidate.udid === udid);
  if (!device) return error(`unknown simulator udid: ${udid}`);
  const stopped = await processAdapter.run("xcrun", ["simctl", "shutdown", udid]);
  if (stopped.kind !== "ok" && device.state !== "Shutdown") return error(`failed to shut down simulator ${udid}: ${stopped.error}`);
  const owners = await readSimulatorOwners(environment);
  if (owners[udid]) { delete owners[udid]; await writeSimulatorOwners(environment, owners); }
  return ok(`${JSON.stringify({ udid, state: "Shutdown" })}\n`);
}

export async function nativeSimClaim(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter, clock: Clock): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(`${usageText("native-sim-claim")}\n`);
  const udid = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!SIMULATOR_UDID.test(udid)) return error(`native sim claim needs a simulator udid: ${udid}`, 2);
  const worktree = optionValue(args, "--worktree");
  if (!worktree?.trim() || worktree.startsWith("--")) return error("native sim claim needs --worktree <path>", 2);
  const listed = await listAllCandidates(processAdapter);
  if (listed.kind !== "ok") return listed;
  if (!listed.value.some((device) => device.udid === udid && device.state === "Booted")) return error(`simulator ${udid} must be booted before it can be claimed`);
  const path = resolve(worktree);
  const owners = await readSimulatorOwners(environment);
  owners[udid] = { worktree: path, since: new Date(clock.now()).toISOString() };
  await writeSimulatorOwners(environment, owners);
  return ok(`${JSON.stringify({ udid, worktree: path })}\n`);
}

export async function nativeSimRelease(args: readonly string[], environment: Environment): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(`${usageText("native-sim-release")}\n`);
  const udid = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!SIMULATOR_UDID.test(udid)) return error(`native sim release needs a simulator udid: ${udid}`, 2);
  const owners = await readSimulatorOwners(environment);
  delete owners[udid];
  await writeSimulatorOwners(environment, owners);
  return ok(`${JSON.stringify({ udid, worktree: null })}\n`);
}

export async function nativeSimRename(args: readonly string[], processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(`${usageText("native-sim-rename")}\n`);
  const positional = args.filter((arg) => arg !== "--json" && arg !== "-h" && arg !== "--help");
  const [udid, name] = positional;
  if (!udid || !SIMULATOR_UDID.test(udid)) return error(`native sim rename needs a simulator udid: ${udid ?? ""}`, 2);
  if (!name?.trim()) return error("simulator name must not be empty", 2);
  if ([...name].length > 64) return error("simulator name must be 64 characters or fewer", 2);
  const renamed = await processAdapter.run("xcrun", ["simctl", "rename", udid, name]);
  if (renamed.kind !== "ok") return error(`failed to rename simulator ${udid}: ${renamed.error}`);
  return ok(`${JSON.stringify({ udid, name })}\n`);
}

async function listAllCandidates(processAdapter: ProcessAdapter): Promise<Result<Array<NativeCandidate & { kind: NativeKind; runtime: string }>>> {
  const result = await processAdapter.run("xcrun", ["simctl", "list", "devices", "--json"]);
  if (result.kind !== "ok") return error("failed to list simulators with simctl");
  try {
    const value = JSON.parse(result.value.stdout) as { devices?: Record<string, unknown> };
    const candidates: Array<NativeCandidate & { kind: NativeKind; runtime: string }> = [];
    for (const [runtime, entries] of Object.entries(value.devices ?? {})) {
      const kind = runtime.includes("iOS") ? "phone" : runtime.includes("tvOS") ? "tv" : undefined;
      if (!kind || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) continue;
        const item = entry as Record<string, unknown>;
        if (item.isAvailable === true && typeof item.udid === "string" && typeof item.state === "string" && typeof item.name === "string") candidates.push({ udid: item.udid, state: item.state === "Booted" ? "Booted" : "Shutdown", name: item.name, kind, runtime });
      }
    }
    return ok(candidates);
  } catch { return error("simctl returned invalid device data"); }
}

export async function nativeRestart(args: readonly string[], processAdapter: ProcessAdapter, clock: Clock): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(`${usageText("native-sim-restart")}\n`);
  const udid = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!SIMULATOR_UDID.test(udid)) return error(`native sim restart needs a simulator udid: ${udid}`, 2);
  const timeout = validateTimeout(optionValue(args, "--timeout") ?? "30");
  if (timeout.kind !== "ok") return timeout;
  const listed = await listAllCandidates(processAdapter);
  if (listed.kind !== "ok") return listed;
  const device = listed.value.find((candidate) => candidate.udid === udid);
  if (!device) return error(`unknown simulator udid: ${udid}`);
  const stopped = await processAdapter.run("xcrun", ["simctl", "shutdown", udid]);
  if (stopped.kind !== "ok" && device.state !== "Shutdown") return error(`failed to shut down simulator ${udid}: ${stopped.error}`);
  const boot = await processAdapter.run("xcrun", ["simctl", "boot", udid]);
  if (boot.kind !== "ok") return error(`failed to boot simulator ${udid}: ${boot.error}`);
  const waited = await waitUntilBooted(device.kind, udid, timeout.value, processAdapter, clock);
  if (waited.kind !== "ok") return waited;
  return ok(`${JSON.stringify({ udid, state: "Booted", waitedMs: waited.value })}\n`);
}

export const SIMULATOR_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

async function waitUntilBooted(kind: NativeKind, udid: string, timeoutSeconds: number, processAdapter: ProcessAdapter, clock: Clock): Promise<Result<number>> {
  const startedAt = clock.now();
  for (let attempt = 0; attempt < timeoutSeconds * 5; attempt += 1) {
    const current = await simCandidates(processAdapter, kind); if (current.kind !== "ok") return current;
    if (current.value.find((candidate) => candidate.udid === udid)?.state === "Booted") return ok(Math.max(0, clock.now() - startedAt));
    await sleep(clock, 200);
  }
  return error(`timed out waiting for simulator ${udid} to become booted`);
}

/** A headless screenshot of a booted simulator (simctl io, no window), kept as one file per device. */

export async function nativeScreenshot(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(`${usageText("native-sim-screenshot")}\n`);
  const udid = args.find((arg) => !arg.startsWith("--")) ?? "";
  if (!SIMULATOR_UDID.test(udid)) return error(`native sim screenshot needs a simulator udid: ${udid}`, 2);
  const path = join(resolveStateDirectory(environment), "native", "screens", `${udid}.png`);
  await mkdir(dirname(path), { recursive: true });
  const capture = await processAdapter.run("xcrun", ["simctl", "io", udid, "screenshot", path]);
  if (capture.kind !== "ok") return error(`could not capture simulator ${udid}; is it booted? ${capture.error}`);
  return args.includes("--json") ? ok(`${JSON.stringify({ device: udid, path })}\n`) : ok(`${path}\n`);
}

export async function nativeEnsure(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter, clock: Clock): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeUsage("ensure"));
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  const timeoutRaw = optionValue(args, "--timeout") ?? environment.MEGABRAIN_NATIVE_DEFAULT_TIMEOUT ?? "30";
  const timeout = validateTimeout(timeoutRaw); if (timeout.kind !== "ok") return timeout;
  const worktree = optionValue(args, "--worktree");
  if (args.includes("--worktree") && (!worktree?.trim() || worktree.startsWith("--"))) return error("native sim ensure needs a path after --worktree", 2);
  const root = await nativeWorktreeRoot(environment, processAdapter);
  const loaded = config(root); if (loaded.kind !== "ok") return loaded;
  const device = optionValue(args, "--device") ?? setting(loaded.value, kind.value, "device");
  const candidates = await simCandidates(processAdapter, kind.value); if (candidates.kind !== "ok") return candidates;
  const selected = selectDevice(kind.value, candidates.value, device, false); if (selected.kind !== "ok") return selected;
  if (selected.value.state !== "Booted") {
    const boot = await processAdapter.run("xcrun", ["simctl", "boot", selected.value.udid]);
    if (boot.kind !== "ok") return error(`failed to boot simulator ${selected.value.udid}: ${boot.error.replace(/^xcrun exited with status \d+$/, "simctl exited")}`);
    await recordBooted(environment, selected.value.udid, clock.now());
  }
  const waited = await waitUntilBooted(kind.value, selected.value.udid, timeout.value, processAdapter, clock);
  if (waited.kind !== "ok") return waited;
  if (worktree?.trim()) {
    const owners = await readSimulatorOwners(environment);
    owners[selected.value.udid] = { worktree: resolve(worktree), since: new Date(clock.now()).toISOString() };
    await writeSimulatorOwners(environment, owners);
  }
  return args.includes("--json") ? ok(`${JSON.stringify({ ok: true, kind: kind.value, device: selected.value.udid, state: "Booted" })}\n`) : ok(`simulator ${selected.value.udid} is booted\n`);
}
