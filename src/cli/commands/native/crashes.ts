import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../../adapters/proc.js";
import { buildXcodebuildArgs, candidatesForRuntimeFromSimctl, candidatesFromSimctl, DEFAULT_NATIVE_STABLE_WINDOW_MS, evaluateNativeHealth, formatNativeList, nativeBuildStepFailure, nativeUsage, renderNativeUrl, runtimesFromSimctl, selectDevice, validateKind, validateMetroPort, validateStableWindow, validateTimeout, type NativeBuildStep, type NativeCandidate, type NativeHealth, type NativeKind, type NativePlatform, type NativeRuntime } from "../../../core/native.js";
import { sleep, systemClock, type Clock } from "../../../core/clock.js";
import { failed, ok, type Result } from "../../../core/result.js";
import { selectCrashReportFiles, validateCrashLast } from "../../../core/crash.js";
import { nativeSessionFor, removeNativeSession, replaceNativeSession, type NativeSessionKey } from "../../../core/native-session.js";
import { createNativeSessionStore } from "../../../adapters/native-session-store.js";
import { connectMetroInspector, waitForMetroInspectorTarget, type MetroEvaluation } from "../../../core/native-cdp.js";
import { buildNativeCaptureFailureRecord, buildNativeCapturePaths, buildNativeCaptureRecord, decideCaptureOutcome, type NativeCaptureRecord, type NativeCaptureScreenRecord } from "../../../core/native-capture.js";
import { resolveStateDirectory } from "../../../core/state.js";
import { executeIdle, recordBooted } from "../native-idle.js";
import { usageText } from "../../../core/usage.js";
import { unknownProcess, unknownMetro, unknownTree, unknownFrame, APPIUM_SESSION_DEFAULTS, appiumSessionCapabilities, AppiumSession, AppiumSessionAttempt, AppiumResponse, appiumResponse, appiumMessage, appiumHttpFailure, createAppiumSession, appiumSession } from "./session.js";
import { nativeHealth } from "./health.js";
import { runtimePlatform, installedRuntimes, nativeRuntimeList, nativeRuntimeInstall } from "./runtime.js";

import { Environment, Config, ExpoApp, NativeCaptureScreen, error, refusalCode, normalizeJsonResult, nativeWorktreeRoot, nativeConfigFile, config, setting, simCandidates, parseKind, optionValue, crashReportsDirectory, nativeBuildUsage, buildConfigError, readExpoApp, generatedWorkspace, nativeBuild, nativeList, SIMULATOR_UDID, nativeScreenshot, nativeEnsure, nativeReload, runtimeValue, formatEvaluation, cdpArguments, nativeEval, routerModuleExpression, logBoxExpression, devLoadingViewExpression, routeInfoExpression, navigationQueueExpression, navigationExpression, RouteSnapshot, NativeNavigationResult, routeSnapshot, routeChanged, nativeNavigationResult, pendingNavigationCount, nativeNavigate, nativeCaptureScreens, uniqueCaptureScreens, captureOptionNames, validateCaptureOptions, terminateNativeCaptureApp, resetNativeCaptureApp, captureNativeFrame, NativeSettledFrame, settleNativeFrame, NativeLogBoxStatus, NativeDevLoadingViewStatus, NativeResetOverlayStatus, silenceNativeLogBox, preventNativeDevLoadingView, silenceNativeOverlays, nativeOverlaySummary, nativeDevLoadingViewSummary, captureNavigationArgs, nativeCapture, appium, executeNative } from "./index.js";

export async function nativeCrashes(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeUsage("crashes"));
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  const root = await nativeWorktreeRoot(environment, processAdapter);
  const loaded = config(root); if (loaded.kind !== "ok") return loaded;
  const target = setting(loaded.value, kind.value, "bundleId");
  if (!target) return error(`bundle id is required for ${kind.value}; pass --bundle-id in .megabrain/native.json`);
  const lastRaw = optionValue(args, "--last") ?? "1";
  const last = validateCrashLast(lastRaw); if (last.kind !== "ok") return last;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--last" && args[index + 1] !== undefined) { index += 1; continue; }
    return error(`unknown native crashes option: ${arg}`, 2);
  }
  const directory = crashReportsDirectory(environment);
  let files: string[];
  try { files = readdirSync(directory).filter((file) => file.endsWith(".ips")); }
  catch { return error(`cannot read crash reports directory: ${directory}`); }
  const candidates: Array<{ path: string; modifiedAt: number }> = [];
  const parseErrors: string[] = [];
  for (const file of files) {
    const path = resolve(directory, file);
    try {
      candidates.push({ path, modifiedAt: statSync(path).mtimeMs });
    } catch (cause) { parseErrors.push(`${file}: ${cause instanceof Error ? cause.message : "could not stat file"}`); }
  }
  const selection = selectCrashReportFiles(candidates, target, last.value, (path) => readFileSync(path, "utf8"));
  const selected = selection.reports;
  const stderr = [...parseErrors, ...selection.errors].map((message) => `megabrain: ${message}\n`).join("");
  if (selected.length === 0) return { kind: "ok", value: args.includes("--json") ? `${JSON.stringify({ reports: [], noReports: true })}\n` : `no crash reports found for ${target}\n`, stderr };
  if (args.includes("--json")) return { kind: "ok", value: `${JSON.stringify({ reports: selected.map((entry) => ({ file: entry.path, ...entry.value })), noReports: false })}\n`, stderr };
  const value = selected.map((entry) => {
    const report = entry.value;
    return `${entry.path}\n${report.exceptionType}${report.signal ? ` (${report.signal})` : ""}${report.termination ? `\n${report.termination}` : ""}\n${report.frames.slice(0, 5).map((frame) => `  ${frame}`).join("\n")}\n`;
  }).join("\n");
  return { kind: "ok", value, stderr };
}
