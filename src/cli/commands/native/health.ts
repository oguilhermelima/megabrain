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
import { recordSimulatorOwner } from "../../../core/native-sim-owner.js";
import { unknownProcess, unknownMetro, unknownTree, unknownFrame, APPIUM_SESSION_DEFAULTS, APPIUM_REQUEST_TIMEOUT_MS, appiumSessionCapabilities, AppiumSession, AppiumSessionAttempt, AppiumResponse, appiumResponse, appiumMessage, appiumHttpFailure, createAppiumSession, appiumSession } from "./session.js";

import { Environment, Config, ExpoApp, NativeCaptureScreen, error, refusalCode, normalizeJsonResult, nativeWorktreeRoot, nativeConfigFile, config, setting, simCandidates, parseKind, optionValue, crashReportsDirectory, runtimePlatform, installedRuntimes, nativeBuildUsage, buildConfigError, readExpoApp, generatedWorkspace, nativeBuild, nativeRuntimeList, nativeRuntimeInstall, nativeCrashes, nativeList, SIMULATOR_UDID, nativeScreenshot, nativeEnsure, nativeReload, runtimeValue, formatEvaluation, cdpArguments, nativeEval, routerModuleExpression, logBoxExpression, devLoadingViewExpression, routeInfoExpression, navigationQueueExpression, navigationExpression, RouteSnapshot, NativeNavigationResult, routeSnapshot, routeChanged, nativeNavigationResult, pendingNavigationCount, nativeNavigate, nativeCaptureScreens, uniqueCaptureScreens, captureOptionNames, validateCaptureOptions, terminateNativeCaptureApp, resetNativeCaptureApp, captureNativeFrame, NativeSettledFrame, settleNativeFrame, NativeLogBoxStatus, NativeDevLoadingViewStatus, NativeResetOverlayStatus, silenceNativeLogBox, preventNativeDevLoadingView, silenceNativeOverlays, nativeOverlaySummary, nativeDevLoadingViewSummary, captureNavigationArgs, nativeCapture, appium, executeNative } from "./index.js";

export async function nativeHealth(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeUsage("health"));
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  const root = await nativeWorktreeRoot(environment, processAdapter);
  const loaded = config(root); if (loaded.kind !== "ok") return loaded;
  const bundleId = optionValue(args, "--bundle-id") ?? setting(loaded.value, kind.value, "bundleId");
  const requested = optionValue(args, "--device") ?? setting(loaded.value, kind.value, "device");
  const metroPort = optionValue(args, "--metro-port") ?? setting(loaded.value, kind.value, "metroPort");
  const controlFrame = optionValue(args, "--control-frame") ?? setting(loaded.value, kind.value, "controlFrame");
  if (!bundleId) return error(`bundle id is required for ${kind.value}; pass --bundle-id`);
  const candidates = await simCandidates(processAdapter, kind.value); if (candidates.kind !== "ok") return candidates;
  const selected = selectDevice(kind.value, candidates.value, requested, true); if (selected.kind !== "ok") return selected;
  const ownerNotice = await recordSimulatorOwner(selected.value.udid, undefined, environment, processAdapter, systemClock);
  if (ownerNotice) console.error(ownerNotice);
  const udid = selected.value.udid;

  let process: NativeHealth["process"];
  const processResult = await processAdapter.run("xcrun", ["simctl", "spawn", udid, "launchctl", "list"]);
  if (processResult.kind !== "ok") process = unknownProcess("could not inspect simulator processes");
  else process = processResult.value.stdout.includes(bundleId) ? { state: "running" } : { state: "not-running", reason: "process is not running" };

  let metro: NativeHealth["metro"];
  if (!metroPort || metroPort === "none") metro = unknownMetro("Metro port was not configured; attachment cannot be determined");
  else {
    const metroResult = await processAdapter.run("curl", ["-fsS", "--max-time", "2", `http://127.0.0.1:${metroPort}/json/list`]);
    if (metroResult.kind !== "ok") metro = unknownMetro(`Metro /json/list was unavailable on port ${metroPort}`);
    else {
      try {
        const targets: unknown = JSON.parse(metroResult.value.stdout);
        const attached = Array.isArray(targets) && targets.some((target) => typeof target === "object" && target !== null && Object.values(target as Record<string, unknown>).some((value) => typeof value === "string" && value.includes(bundleId)));
        metro = attached ? { state: "attached" } : { state: "not-attached", reason: "Metro has no target for this app" };
      } catch { metro = unknownMetro("Metro /json/list returned invalid data"); }
    }
  }

  let tree: NativeHealth["tree"] = unknownTree("accessibility tree could not be consulted");
  const platform: NativePlatform = kind.value === "phone" ? "iOS" : "tvOS";
  const session = await appiumSession(environment, processAdapter, { udid, bundleId }, platform);
  if (session.kind !== "ok") tree = unknownTree(`could not acquire Appium session: ${session.error}`);
  else if (session.value.reason !== undefined) tree = unknownTree(session.value.reason);
  else if (session.value.session !== undefined) {
    const activeSession = session.value.session;
    const source = await processAdapter.run("curl", ["-sS", "-w", "\n%{http_code}", `http://127.0.0.1:4723/session/${activeSession.sessionId}/source`], { timeoutMs: APPIUM_REQUEST_TIMEOUT_MS });
    if (source.kind !== "ok") tree = unknownTree(`Appium source request failed: ${source.error}`);
    else {
      const response = appiumResponse(source.value.stdout);
      if (response === undefined) tree = unknownTree("Appium source request failed: response did not include an HTTP status");
      else if (response.status < 200 || response.status >= 300) tree = unknownTree(appiumHttpFailure("Appium source request", response));
      else {
        const elements = response.body.match(/<XCUIElementType[A-Za-z0-9]+\b/g) ?? [];
        tree = { count: elements.length, loadingOnly: elements.length === 1 && /<XCUIElementTypeActivityIndicator\b/.test(response.body) };
      }
    }
    if (!activeSession.stored) await processAdapter.run("curl", ["-fsS", "-X", "DELETE", `http://127.0.0.1:4723/session/${activeSession.sessionId}`], { timeoutMs: APPIUM_REQUEST_TIMEOUT_MS });
  }

  let frame: NativeHealth["frame"] = unknownFrame(controlFrame ? `control frame could not be read: ${controlFrame}` : "no control frame configured");
  if (controlFrame) {
    const controlHash = await processAdapter.run("shasum", ["-a", "256", controlFrame]);
    const capturePath = `/tmp/megabrain-native-health-${Date.now()}.png`;
    const capture = await processAdapter.run("xcrun", ["simctl", "io", udid, "screenshot", capturePath]);
    const liveHash = await processAdapter.run("shasum", ["-a", "256", capturePath]);
    if (controlHash.kind === "ok" && capture.kind === "ok" && liveHash.kind === "ok") frame = { state: liveHash.value.stdout.split(/\s+/)[0] === controlHash.value.stdout.split(/\s+/)[0] ? "identical" : "differs", reason: "screenshot hashes compared" };
    else frame = unknownFrame("screenshot or control frame hash could not be obtained");
  }
  const result = evaluateNativeHealth({ process, metro, tree, frame });
  const warning = session.kind === "ok" ? session.value.warning : undefined;
  const reported = warning === undefined ? result : { ...result, warning };
  return args.includes("--json") ? ok(`${JSON.stringify(reported)}\n`) : ok(`${result.status}: ${result.reason}\nprocess=${result.process.state}; metro=${result.metro.state}; tree=${result.tree.count ?? "unknown"}; frame=${result.frame.state}${warning === undefined ? "" : `; warning=${warning}`}\n`);
}
