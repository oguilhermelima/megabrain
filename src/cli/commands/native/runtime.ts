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

import { Environment, Config, ExpoApp, NativeCaptureScreen, error, refusalCode, normalizeJsonResult, nativeWorktreeRoot, nativeConfigFile, config, setting, simCandidates, parseKind, optionValue, crashReportsDirectory, nativeBuildUsage, buildConfigError, readExpoApp, generatedWorkspace, nativeBuild, nativeCrashes, nativeList, SIMULATOR_UDID, nativeScreenshot, nativeEnsure, nativeReload, runtimeValue, formatEvaluation, cdpArguments, nativeEval, routerModuleExpression, logBoxExpression, devLoadingViewExpression, routeInfoExpression, navigationQueueExpression, navigationExpression, RouteSnapshot, NativeNavigationResult, routeSnapshot, routeChanged, nativeNavigationResult, pendingNavigationCount, nativeNavigate, nativeCaptureScreens, uniqueCaptureScreens, captureOptionNames, validateCaptureOptions, terminateNativeCaptureApp, resetNativeCaptureApp, captureNativeFrame, NativeSettledFrame, settleNativeFrame, NativeLogBoxStatus, NativeDevLoadingViewStatus, NativeResetOverlayStatus, silenceNativeLogBox, preventNativeDevLoadingView, silenceNativeOverlays, nativeOverlaySummary, nativeDevLoadingViewSummary, captureNavigationArgs, nativeCapture, appium, executeNative } from "./index.js";

export function runtimePlatform(value: string): Result<NativePlatform> {
  if (value === "ios" || value === "iOS") return ok("iOS");
  if (value === "tvos" || value === "tvOS") return ok("tvOS");
  return error(`expected platform iOS or tvOS, got: ${value}`, 2);
}

export async function installedRuntimes(processAdapter: ProcessAdapter): Promise<Result<NativeRuntime[]>> {
  const result = await processAdapter.run("xcrun", ["simctl", "list", "runtimes", "--json"]);
  if (result.kind !== "ok") return error("failed to list runtimes with simctl");
  try { return runtimesFromSimctl(JSON.parse(result.value.stdout)); } catch { return error("simctl returned invalid runtime data"); }
}

export async function nativeRuntimeList(args: readonly string[], processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeUsage("runtime-list"));
  let installed = false, available = false, platform: NativePlatform | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--installed") installed = true;
    else if (arg === "--available") available = true;
    else if (arg === "--json") continue;
    else if (!platform && !arg.startsWith("-")) { const parsed = runtimePlatform(arg); if (parsed.kind !== "ok") return parsed; platform = parsed.value; }
    else return error(`unknown native runtime list option: ${arg}`, 2);
  }
  if (installed === available) return error("native runtime list requires exactly one of --installed or --available", 2);
  if (available) return error("listing downloadable runtimes is not supported; use native runtime install <ios|tvos> <version>", 2);
  const json = args.includes("--json");
  if (installed) {
    const result = await installedRuntimes(processAdapter); if (result.kind !== "ok") return result;
    const runtimes = platform ? result.value.filter((runtime) => runtime.platform === platform) : result.value;
    return ok(json ? `${JSON.stringify({ platform: platform ?? "all", runtimes, available: [] })}\n` : runtimes.map((runtime) => `${runtime.platform}\t${runtime.version}\t${runtime.build}\t${runtime.identifier}`).join("\n") + "\n");
  }
  return error("listing downloadable runtimes is not supported; use native runtime install <ios|tvos> <version>", 2);
}

export async function nativeRuntimeInstall(args: readonly string[], processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeUsage("runtime-install"));
  let platform: NativePlatform | undefined, version = "", json = false;
  for (const arg of args) { if (arg === "--json") json = true; else if (!platform) { const parsed = runtimePlatform(arg); if (parsed.kind !== "ok") return parsed; platform = parsed.value; } else if (!version) version = arg; else return error(`unknown native runtime install option: ${arg}`, 2); }
  if (!platform || !version) return error("native runtime install requires <platform> <version>", 2);
  const download = await processAdapter.run("xcodebuild", ["-downloadPlatform", platform, "-buildVersion", version], { timeoutMs: 60 * 60_000 });
  if (download.kind !== "ok") return error(`failed to download ${platform} ${version}: ${download.error}`);
  const installed = await installedRuntimes(processAdapter); if (installed.kind !== "ok") return installed;
  const match = installed.value.find((runtime) => runtime.platform === platform && runtime.version === version);
  if (!match) return error(`runtime download reported success, but simctl does not list ${platform} ${version}`);
  return ok(json ? `${JSON.stringify({ platform, version, build: match.build, identifier: match.identifier })}\n` : `installed ${platform} ${version} (${match.build})\n`);
}
