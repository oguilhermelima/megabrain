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
import { nativeList, SIMULATOR_UDID, nativeScreenshot, nativeEnsure } from "./sim.js";
import { nativeBuildUsage, buildConfigError, readExpoApp, generatedWorkspace, nativeBuild } from "./build.js";
import { nativeCrashes } from "./crashes.js";
import { runtimePlatform, installedRuntimes, nativeRuntimeList, nativeRuntimeInstall } from "./runtime.js";
import { recordSimulatorOwner } from "../../../core/native-sim-owner.js";

import { Environment, Config, ExpoApp, NativeCaptureScreen, error, refusalCode, normalizeJsonResult, nativeWorktreeRoot, nativeConfigFile, config, setting, simCandidates, parseKind, optionValue, crashReportsDirectory, runtimeValue, formatEvaluation, cdpArguments, nativeEval, routerModuleExpression, logBoxExpression, devLoadingViewExpression, routeInfoExpression, navigationQueueExpression, navigationExpression, RouteSnapshot, NativeNavigationResult, routeSnapshot, routeChanged, nativeNavigationResult, pendingNavigationCount, nativeNavigate, nativeCaptureScreens, uniqueCaptureScreens, captureOptionNames, validateCaptureOptions, terminateNativeCaptureApp, resetNativeCaptureApp, captureNativeFrame, NativeSettledFrame, settleNativeFrame, NativeLogBoxStatus, NativeDevLoadingViewStatus, NativeResetOverlayStatus, silenceNativeLogBox, preventNativeDevLoadingView, silenceNativeOverlays, nativeOverlaySummary, nativeDevLoadingViewSummary, captureNavigationArgs, nativeCapture, appium, executeNative } from "./index.js";

export async function nativeReload(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeUsage("reload"));
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  const timeoutRaw = optionValue(args, "--timeout") ?? environment.MEGABRAIN_NATIVE_DEFAULT_TIMEOUT ?? "30";
  const timeout = validateTimeout(timeoutRaw); if (timeout.kind !== "ok") return timeout;
  const root = await nativeWorktreeRoot(environment, processAdapter);
  const loaded = config(root); if (loaded.kind !== "ok") return loaded;
  const route = optionValue(args, "--route") ?? "";
  const bundleId = optionValue(args, "--bundle-id") ?? setting(loaded.value, kind.value, "bundleId");
  let metroPort = optionValue(args, "--metro-port") ?? setting(loaded.value, kind.value, "metroPort");
  const template = optionValue(args, "--url-template") ?? setting(loaded.value, kind.value, "urlTemplate");
  const device = optionValue(args, "--device") ?? setting(loaded.value, kind.value, "device");
  if (!template) return error(`URL template is required for ${kind.value}; pass --url-template`);
  if (!bundleId) return error(`bundle id is required for ${kind.value}; pass --bundle-id`);
  if (metroPort === "none") metroPort = "";
  const validPort = validateMetroPort(metroPort); if (validPort.kind !== "ok") return validPort;
  const candidates = await simCandidates(processAdapter, kind.value); if (candidates.kind !== "ok") return candidates;
  const selected = selectDevice(kind.value, candidates.value, device, true); if (selected.kind !== "ok") return selected;
  const ownerNotice = await recordSimulatorOwner(selected.value.udid, undefined, environment, processAdapter, systemClock);
  const url = renderNativeUrl(template, route, metroPort, bundleId, selected.value.udid); if (url.kind !== "ok") return url;
  if (metroPort) {
    let ready = false;
    for (let attempt = 0; attempt < timeout.value * 5; attempt += 1) {
      const probe = await processAdapter.run("curl", ["-fsS", "--max-time", "1", `http://127.0.0.1:${metroPort}/status`]);
      if (probe.kind === "ok") { ready = true; break; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    if (!ready) return error(`Metro did not answer on port ${metroPort} within ${timeout.value}s`);
  }
  const terminate = await processAdapter.run("xcrun", ["simctl", "terminate", selected.value.udid, bundleId]);
  if (terminate.kind !== "ok" && !/not running|no such process|does not exist|not found|nothing to terminate/i.test(terminate.error)) return error(`failed to terminate ${bundleId} on simulator ${selected.value.udid}: ${terminate.error}`);
  const open = await processAdapter.run("xcrun", ["simctl", "openurl", selected.value.udid, url.value]);
  if (open.kind !== "ok") return error(`failed to open URL on simulator ${selected.value.udid}: ${url.value}`);
  return args.includes("--json") ? ok(`${JSON.stringify({ ok: true, kind: kind.value, device: selected.value.udid, bundleId, url: url.value, terminated: true, opened: true, renderObserved: false, ...(ownerNotice ? { notice: ownerNotice } : {}) })}\n`) : ok(`reloaded ${bundleId} on simulator ${selected.value.udid}: terminated and opened ${url.value}; app rendering was not observed${ownerNotice ? `\n${ownerNotice}` : ""}\n`);
}
