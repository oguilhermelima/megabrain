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
import { recordSimulatorOwner } from "../../../core/native-sim-owner.js";
import { executeIdle, recordBooted } from "../native-idle.js";
import { usageText } from "../../../core/usage.js";
import { unknownProcess, unknownMetro, unknownTree, unknownFrame, APPIUM_SESSION_DEFAULTS, appiumSessionCapabilities, AppiumSession, AppiumSessionAttempt, AppiumResponse, appiumResponse, appiumMessage, appiumHttpFailure, createAppiumSession, appiumSession } from "./session.js";
import { nativeHealth } from "./health.js";
import { nativeCrashes } from "./crashes.js";
import { runtimePlatform, installedRuntimes, nativeRuntimeList, nativeRuntimeInstall } from "./runtime.js";

import { Environment, Config, ExpoApp, NativeCaptureScreen, error, refusalCode, normalizeJsonResult, nativeWorktreeRoot, nativeConfigFile, config, setting, simCandidates, parseKind, optionValue, crashReportsDirectory, nativeList, SIMULATOR_UDID, nativeScreenshot, nativeEnsure, nativeReload, runtimeValue, formatEvaluation, cdpArguments, nativeEval, routerModuleExpression, logBoxExpression, devLoadingViewExpression, routeInfoExpression, navigationQueueExpression, navigationExpression, RouteSnapshot, NativeNavigationResult, routeSnapshot, routeChanged, nativeNavigationResult, pendingNavigationCount, nativeNavigate, nativeCaptureScreens, uniqueCaptureScreens, captureOptionNames, validateCaptureOptions, terminateNativeCaptureApp, resetNativeCaptureApp, captureNativeFrame, NativeSettledFrame, settleNativeFrame, NativeLogBoxStatus, NativeDevLoadingViewStatus, NativeResetOverlayStatus, silenceNativeLogBox, preventNativeDevLoadingView, silenceNativeOverlays, nativeOverlaySummary, nativeDevLoadingViewSummary, captureNavigationArgs, nativeCapture, appium, executeNative } from "./index.js";

export function nativeBuildUsage(): string { return usageText("native-build"); }

export function buildConfigError(kind: NativeKind): Result<string> {
  return error(`app path is required for ${kind}; pass surfaces.${kind}.appPath in .megabrain/native.json`);
}

export function readExpoApp(appPath: string): Result<{ scheme: string; bundleId: string }> {
  const file = resolve(appPath, "app.json");
  if (!existsSync(file)) return error(`Expo app.json is required at ${file}`);
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as ExpoApp;
    const scheme = typeof value.expo?.scheme === "string" ? value.expo.scheme : "";
    const bundleId = typeof value.expo?.ios?.bundleIdentifier === "string" ? value.expo.ios.bundleIdentifier : "";
    if (!scheme) return error(`scheme is required in ${file}`);
    if (!bundleId) return error(`ios.bundleIdentifier is required in ${file}`);
    return ok({ scheme, bundleId });
  } catch { return error(`invalid Expo app.json: ${file}`); }
}

export function generatedWorkspace(appPath: string): Result<{ path: string; relative: string; iosPath: string }> {
  const iosPath = resolve(appPath, "ios");
  if (!existsSync(iosPath)) return error(`prebuild did not produce an ios directory at ${iosPath}`);
  const entries = readdirSync(iosPath);
  const workspace = entries.find((entry) => entry.endsWith(".xcworkspace"));
  if (workspace) return ok({ path: resolve(iosPath, workspace), relative: `ios/${workspace}`, iosPath });
  const project = entries.find((entry) => entry.endsWith(".xcodeproj"));
  if (project) return ok({ path: resolve(iosPath, project), relative: `ios/${project}`, iosPath });
  return error(`prebuild did not produce an Xcode project in ${iosPath}`);
}

export async function nativeBuild(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeBuildUsage());
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  let runtime = "";
  let requestedDevice = "";
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--runtime" && args[index + 1]) { runtime = args[++index] as string; continue; }
    if (arg === "--device" && args[index + 1] && !(args[index + 1] as string).startsWith("--")) { requestedDevice = args[++index] as string; continue; }
    if (arg === "--device") return error("--device requires a simulator name or UDID", 2);
    return error(`unknown native build option: ${arg}`, 2);
  }
  const root = await nativeWorktreeRoot(environment, processAdapter);
  const loaded = config(root); if (loaded.kind !== "ok") return loaded;
  requestedDevice = requestedDevice || setting(loaded.value, kind.value, "device");
  const appSetting = setting(loaded.value, kind.value, "appPath"); if (!appSetting) return buildConfigError(kind.value);
  const appPath = resolve(root, appSetting);
  const app = readExpoApp(appPath); if (app.kind !== "ok") return app;
  const runtimes = await installedRuntimes(processAdapter); if (runtimes.kind !== "ok") return runtimes;
  const platform: NativePlatform = kind.value === "tv" ? "tvOS" : "iOS";
  const matchingRuntimes = runtimes.value.filter((item) => item.platform === platform && (!runtime || item.version === runtime));
  if (matchingRuntimes.length === 0) return error(runtime ? `no installed ${platform} runtime matches ${runtime}` : `no installed ${platform} runtime is available`);
  matchingRuntimes.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
  const devices = await processAdapter.run("xcrun", ["simctl", "list", "devices", "--json"]); if (devices.kind !== "ok") return error("failed to list simulators with simctl");
  let simctlData: unknown;
  try { simctlData = JSON.parse(devices.value.stdout); } catch { return error("simctl returned invalid device data"); }
  const runtimeCandidates = matchingRuntimes.map((item) => ({ runtime: item, candidates: candidatesForRuntimeFromSimctl(simctlData, kind.value, item.version) }));
  const candidatesByRuntime = runtimeCandidates.find((item) => item.candidates.kind !== "ok");
  if (candidatesByRuntime?.candidates.kind === "failed") return error(candidatesByRuntime.candidates.error, candidatesByRuntime.candidates.exitCode);
  if (candidatesByRuntime?.candidates.kind === "unknown") return error(candidatesByRuntime.candidates.error, candidatesByRuntime.candidates.exitCode);
  let selectedRuntime: NativeRuntime;
  let selected: Result<NativeCandidate>;
  if (requestedDevice) {
    const candidates = runtimeCandidates.flatMap(({ runtime: itemRuntime, candidates: itemCandidates }) => itemCandidates.kind === "ok" ? itemCandidates.value.map((candidate) => ({ runtime: itemRuntime, candidate })) : []);
    const selection = selectDevice(kind.value, candidates.map(({ candidate }) => candidate), requestedDevice, false);
    if (selection.kind !== "ok") return error(selection.error, selection.exitCode);
    selected = selection;
    const deviceRuntime = candidates.find(({ candidate }) => candidate.udid === selection.value.udid)?.runtime;
    if (!deviceRuntime) return error(`could not determine the runtime for simulator ${selection.value.udid}`);
    selectedRuntime = deviceRuntime;
  } else {
    selectedRuntime = matchingRuntimes[0] as NativeRuntime;
    const runtimeDevices = runtimeCandidates.find(({ runtime: itemRuntime }) => itemRuntime.version === selectedRuntime.version)?.candidates;
    if (!runtimeDevices || runtimeDevices.kind !== "ok") return runtimeDevices ?? error("failed to list simulators with simctl");
    const booted = runtimeDevices.value.filter((candidate) => candidate.state === "Booted");
    if (booted.length === 1) selected = ok(booted[0] as NativeCandidate);
    else if (booted.length === 0 && runtimeDevices.value.length === 1) selected = ok(runtimeDevices.value[0] as NativeCandidate);
    else {
      const names = runtimeDevices.value.map((candidate) => candidate.name).join(", ") || "none";
      return error(`cannot choose a ${platform} simulator automatically; pass --device <name-or-udid> or set surfaces.${kind.value}.device in .megabrain/native.json. Candidates: ${names}`);
    }
  }
  const boot = await processAdapter.run("xcrun", ["simctl", "boot", selected.value.udid]);
  if (boot.kind !== "ok" && !/already booted/i.test(boot.error)) return error(`failed to boot simulator ${selected.value.udid}: ${boot.error}`);
  const ownerNotice = await recordSimulatorOwner(selected.value.udid, undefined, environment, processAdapter, systemClock);
  if (ownerNotice) console.error(ownerNotice);
  const outcomes = {} as Record<NativeBuildStep, { ok: boolean; error?: string }>;
  const prebuild = await processAdapter.run("pnpm", ["exec", "expo", "prebuild"], { cwd: appPath, env: { ...(kind.value === "tv" ? { EXPO_TV: "1" } : {}), REACT_NATIVE_NODE_MODULES_DIR: resolve(appPath, "node_modules") } });
  outcomes.prebuild = prebuild.kind === "ok" ? { ok: true } : { ok: false, error: prebuild.error };
  if (!outcomes.prebuild.ok) return error(`native build failed at prebuild: ${outcomes.prebuild.error}`);
  const generated = generatedWorkspace(appPath); if (generated.kind !== "ok") return generated;
  const pods = await processAdapter.run("pod", ["install"], { cwd: generated.value.iosPath });
  outcomes.pods = pods.kind === "ok" ? { ok: true } : { ok: false, error: pods.error };
  if (!outcomes.pods.ok) return error(`native build failed at pods: ${outcomes.pods.error}`);
  const derivedDataPath = resolve(generated.value.iosPath, "build");
  const xcode = await processAdapter.run("xcodebuild", buildXcodebuildArgs(platform, generated.value.path, app.value.scheme, selectedRuntime.version, selected.value.udid, derivedDataPath), { cwd: appPath });
  outcomes.build = xcode.kind === "ok" ? { ok: true } : { ok: false, error: xcode.error };
  if (!outcomes.build.ok) return error(`native build failed at build: ${outcomes.build.error}`);
  const sdk = platform === "tvOS" ? "appletvsimulator" : "iphonesimulator";
  const appBundle = resolve(derivedDataPath, `Build/Products/Debug-${sdk}/${app.value.scheme}.app`);
  const install = await processAdapter.run("xcrun", ["simctl", "install", selected.value.udid, appBundle]);
  outcomes.install = install.kind === "ok" ? { ok: true } : { ok: false, error: install.error };
  if (!outcomes.install.ok) return error(`native build failed at install: ${outcomes.install.error}`);
  const launch = await processAdapter.run("xcrun", ["simctl", "launch", selected.value.udid, app.value.bundleId]);
  outcomes.launch = launch.kind === "ok" ? { ok: true } : { ok: false, error: launch.error };
  if (!outcomes.launch.ok) return error(`native build failed at launch: ${outcomes.launch.error}`);
  return ok(JSON.stringify({ ok: true, kind: kind.value, runtime: selectedRuntime.version, device: selected.value.udid, bundleId: app.value.bundleId, installed: true, launched: true }) + "\n");
}
