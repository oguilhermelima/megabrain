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

export type Environment = Readonly<Record<string, string | undefined>>;
export type Config = { readonly surfaces?: Record<string, Record<string, string>> };
export type ExpoApp = { readonly expo?: { readonly scheme?: unknown; readonly ios?: { readonly bundleIdentifier?: unknown } } };
export type NativeCaptureScreen = Readonly<{ name: string; route: string }>;

export function error<T = string>(message: string, code = 1): Result<T> { return failed(message, code); }
export function refusalCode(exitCode: number): string { return exitCode === 2 ? "invalid-arguments" : "native-error"; }
export function normalizeJsonResult(result: Result<string>, json: boolean): Result<string> {
  if (!json) return result;
  if (result.kind === "failed") return ok(`${JSON.stringify({ refusal: { code: refusalCode(result.exitCode), message: result.error } })}\n`, result.exitCode);
  if (result.kind !== "ok") return result;
  try {
    const value = JSON.parse(result.value);
    if (typeof value === "object" && value !== null && !Array.isArray(value) && !("refusal" in value)) (value as Record<string, unknown>).refusal = null;
    return { ...result, value: `${JSON.stringify(value)}\n` };
  } catch { return result; }
}
// WHY: native config and app paths must not change when the command starts in a subdirectory.
export async function nativeWorktreeRoot(environment: Environment, processAdapter: ProcessAdapter): Promise<string> {
  const path = environment.MEGABRAIN_NATIVE_WORKTREE ?? process.cwd();
  const result = await processAdapter.run("git", ["-C", path, "rev-parse", "--show-toplevel"]);
  if (result.kind !== "ok") return path;
  const root = result.value.stdout.trim();
  return root.length > 0 ? root : path;
}
export function nativeConfigFile(root: string): string { return resolve(root, ".megabrain/native.json"); }
export function config(root: string): Result<Config> {
  const file = nativeConfigFile(root);
  if (!existsSync(file)) return ok({});
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1 || typeof (value as Config).surfaces !== "object") return error(`invalid native simulator config: ${file}`);
    return ok(value as Config);
  } catch {
    return error(`invalid native simulator config: ${file}`);
  }
}
export function setting(loaded: Config, kind: NativeKind, key: string): string { return loaded.surfaces?.[kind]?.[key] ?? ""; }
export async function simCandidates(processAdapter: ProcessAdapter, kind: NativeKind): Promise<Result<NativeCandidate[]>> {
  const result = await processAdapter.run("xcrun", ["simctl", "list", "devices", "--json"]);
  if (result.kind !== "ok") return error("failed to list simulators with simctl");
  try { return candidatesFromSimctl(JSON.parse(result.value.stdout), kind); } catch { return error("simctl returned invalid device data"); }
}
export function parseKind(args: readonly string[]): Result<NativeKind> { return validateKind(args[0] ?? ""); }
export function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
export function crashReportsDirectory(environment: Environment): string {
  return environment.MEGABRAIN_NATIVE_CRASH_REPORTS_DIR ?? resolve(environment.HOME ?? process.env.HOME ?? "", "Library/Logs/DiagnosticReports");
}


import { appium, unknownProcess, unknownMetro, unknownTree, unknownFrame, APPIUM_SESSION_DEFAULTS, appiumSessionCapabilities, AppiumSession, AppiumSessionAttempt, AppiumResponse, appiumResponse, appiumMessage, appiumHttpFailure, createAppiumSession, appiumSession } from "./session.js";

import { nativeHealth } from "./health.js";
import { nativeCapture } from "./capture.js";
export { nativeCaptureScreens, uniqueCaptureScreens, captureOptionNames, validateCaptureOptions, terminateNativeCaptureApp, resetNativeCaptureApp, captureNativeFrame, settleNativeFrame, captureNavigationArgs, nativeCapture } from "./capture.js";
export type { NativeSettledFrame } from "./capture.js";
export { silenceNativeLogBox, preventNativeDevLoadingView, silenceNativeOverlays, nativeOverlaySummary, nativeDevLoadingViewSummary } from "./capture-overlays.js";
export type { NativeLogBoxStatus, NativeDevLoadingViewStatus, NativeResetOverlayStatus } from "./capture-overlays.js";
import { runtimeValue, formatEvaluation, cdpArguments, nativeEval, routerModuleExpression, logBoxExpression, devLoadingViewExpression, routeInfoExpression, navigationQueueExpression, navigationExpression, RouteSnapshot, NativeNavigationResult, routeSnapshot, routeChanged, nativeNavigationResult, pendingNavigationCount, nativeNavigate } from "./inspector.js";
export { runtimeValue, formatEvaluation, cdpArguments, nativeEval, routerModuleExpression, logBoxExpression, devLoadingViewExpression, routeInfoExpression, navigationQueueExpression, navigationExpression, routeSnapshot, routeChanged, nativeNavigationResult, pendingNavigationCount, nativeNavigate } from "./inspector.js";
export type { RouteSnapshot, NativeNavigationResult } from "./inspector.js";
import { nativeReload } from "./app.js";
export { nativeReload } from "./app.js";
import { nativeList, SIMULATOR_UDID, nativeScreenshot, nativeEnsure, nativeShutdown, nativeRestart } from "./sim.js";
export { nativeList, SIMULATOR_UDID, nativeScreenshot, nativeEnsure, nativeShutdown, nativeRestart } from "./sim.js";
import { nativeBuildUsage, buildConfigError, readExpoApp, generatedWorkspace, nativeBuild } from "./build.js";
export { nativeBuildUsage, buildConfigError, readExpoApp, generatedWorkspace, nativeBuild } from "./build.js";
import { nativeCrashes } from "./crashes.js";
export { nativeCrashes } from "./crashes.js";
import { runtimePlatform, installedRuntimes, nativeRuntimeList, nativeRuntimeInstall } from "./runtime.js";
export { runtimePlatform, installedRuntimes, nativeRuntimeList, nativeRuntimeInstall } from "./runtime.js";

export { appium } from "./session.js";

export async function executeNative(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter = createProcessAdapter(), clock: Clock = systemClock): Promise<Result<string>> {
  const [family, operation, ...rest] = args;
  if (family === "-h" || family === "--help" || family === undefined) return ok(nativeUsage("native"));
  const json = args.includes("--json");
  let result: Result<string>;
  if (family === "appium") result = await appium([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "build") result = await nativeBuild([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "runtime" && operation === "list") result = await nativeRuntimeList(rest, processAdapter);
  else if (family === "runtime" && operation === "install") result = await nativeRuntimeInstall(rest, processAdapter);
  else if (family === "sim" && operation === "list") result = await nativeList(rest, processAdapter);
  else if (family === "sim" && operation === "ensure") result = await nativeEnsure(rest, environment, processAdapter, clock);
  else if (family === "sim" && operation === "shutdown") result = await nativeShutdown(rest, processAdapter);
  else if (family === "sim" && operation === "restart") result = await nativeRestart(rest, processAdapter, clock);
  else if (family === "sim" && operation === "idle") result = await executeIdle(rest, environment, processAdapter, clock);
  else if (family === "sim" && operation === "screenshot") result = await nativeScreenshot(rest, environment, processAdapter);
  else if (family === "health") result = await nativeHealth([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "crashes") result = await nativeCrashes([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "eval") result = await nativeEval([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "navigate") result = await nativeNavigate([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "capture") result = await nativeCapture([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter, clock);
  else if (family === "app" && operation === "reload") result = await nativeReload(rest, environment, processAdapter);
  else if (family === "sim" && (operation === undefined || operation === "-h" || operation === "--help")) result = ok(`${nativeUsage("list")}${nativeUsage("ensure")}${usageText("native-sim-shutdown")}\n${usageText("native-sim-restart")}\n`);
  else if (family === "app" && (operation === undefined || operation === "-h" || operation === "--help")) result = ok(nativeUsage("reload"));
  else result = error(`unknown native command: ${family}`, 2);
  return normalizeJsonResult(result, json);
}
