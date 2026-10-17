import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../../adapters/proc.js";
import { buildXcodebuildArgs, candidatesForRuntimeFromSimctl, candidatesFromSimctl, DEFAULT_NATIVE_STABLE_WINDOW_MS, evaluateNativeHealth, formatNativeList, nativeBuildStepFailure, nativeUsage, renderNativeUrl, runtimesFromSimctl, selectDevice, validateKind, validateMetroPort, validateStableWindow, validateTimeout, type NativeBuildStep, type NativeCandidate, type NativeHealth, type NativeKind, type NativePlatform, type NativeRuntime } from "../../../core/native.js";
import { sleep, systemClock, type Clock } from "../../../core/clock.js";
import { failed, ok, type Result } from "../../../core/result.js";
import { parseCrashReport, selectCrashReports, validateCrashLast, type CrashInput } from "../../../core/crash.js";
import { nativeSessionFor, removeNativeSession, replaceNativeSession, type NativeSessionKey } from "../../../core/native-session.js";
import { createNativeSessionStore } from "../../../adapters/native-session-store.js";
import { connectMetroInspector, waitForMetroInspectorTarget, type MetroEvaluation } from "../../../core/native-cdp.js";
import { buildNativeCaptureFailureRecord, buildNativeCapturePaths, buildNativeCaptureRecord, decideCaptureOutcome, type NativeCaptureRecord, type NativeCaptureScreenRecord } from "../../../core/native-capture.js";
import { resolveStateDirectory } from "../../../core/state.js";
import { executeIdle, recordBooted } from "../native-idle.js";
import { usageText } from "../../../core/usage.js";
import { unknownProcess, unknownMetro, unknownTree, unknownFrame, APPIUM_SESSION_DEFAULTS, appiumSessionCapabilities, AppiumSession, AppiumSessionAttempt, AppiumResponse, appiumResponse, appiumMessage, appiumHttpFailure, createAppiumSession, appiumSession } from "./session.js";
import { nativeHealth } from "./health.js";
import { nativeBuildUsage, buildConfigError, readExpoApp, generatedWorkspace, nativeBuild } from "./build.js";
import { nativeCrashes } from "./crashes.js";
import { runtimePlatform, installedRuntimes, nativeRuntimeList, nativeRuntimeInstall } from "./runtime.js";

import { Environment, Config, ExpoApp, NativeCaptureScreen, error, refusalCode, normalizeJsonResult, nativeWorktreeRoot, nativeConfigFile, config, setting, simCandidates, parseKind, optionValue, crashReportsDirectory, nativeReload, runtimeValue, formatEvaluation, cdpArguments, nativeEval, routerModuleExpression, logBoxExpression, devLoadingViewExpression, routeInfoExpression, navigationQueueExpression, navigationExpression, RouteSnapshot, NativeNavigationResult, routeSnapshot, routeChanged, nativeNavigationResult, pendingNavigationCount, nativeNavigate, nativeCaptureScreens, uniqueCaptureScreens, captureOptionNames, validateCaptureOptions, terminateNativeCaptureApp, resetNativeCaptureApp, captureNativeFrame, NativeSettledFrame, settleNativeFrame, NativeLogBoxStatus, NativeDevLoadingViewStatus, NativeResetOverlayStatus, silenceNativeLogBox, preventNativeDevLoadingView, silenceNativeOverlays, nativeOverlaySummary, nativeDevLoadingViewSummary, captureNavigationArgs, nativeCapture, appium, executeNative } from "./index.js";

export async function nativeList(args: readonly string[], processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(nativeUsage("list"));
  let json = false;
  for (const arg of args.slice(1)) { if (arg === "--json") json = true; else if (arg === "-h" || arg === "--help") return ok(nativeUsage("list")); else return error(`unknown native sim list option: ${arg}`, 2); }
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  const candidates = await simCandidates(processAdapter, kind.value); if (candidates.kind !== "ok") return candidates;
  return ok(formatNativeList(kind.value, candidates.value, json));
}

export const SIMULATOR_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

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
  for (let attempt = 0; attempt < timeout.value * 5; attempt += 1) {
    const current = await simCandidates(processAdapter, kind.value); if (current.kind !== "ok") return current;
    const state = current.value.find((candidate) => candidate.udid === selected.value.udid)?.state;
    if (state === "Booted") return args.includes("--json") ? ok(`${JSON.stringify({ ok: true, kind: kind.value, device: selected.value.udid, state: "Booted" })}\n`) : ok(`simulator ${selected.value.udid} is booted\n`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  return error(`timed out waiting for simulator ${selected.value.udid} to become booted`);
}
