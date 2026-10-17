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
import { NativeResetOverlayStatus, silenceNativeOverlays, nativeOverlaySummary, nativeDevLoadingViewSummary } from "./capture-overlays.js";
import { runtimeValue, formatEvaluation, cdpArguments, nativeEval, routerModuleExpression, logBoxExpression, devLoadingViewExpression, routeInfoExpression, navigationQueueExpression, navigationExpression, RouteSnapshot, NativeNavigationResult, routeSnapshot, routeChanged, nativeNavigationResult, pendingNavigationCount, nativeNavigate } from "./inspector.js";
import { nativeReload } from "./app.js";
import { nativeList, SIMULATOR_UDID, nativeScreenshot, nativeEnsure } from "./sim.js";
import { nativeBuildUsage, buildConfigError, readExpoApp, generatedWorkspace, nativeBuild } from "./build.js";
import { nativeCrashes } from "./crashes.js";
import { runtimePlatform, installedRuntimes, nativeRuntimeList, nativeRuntimeInstall } from "./runtime.js";

import { Environment, Config, ExpoApp, NativeCaptureScreen, error, refusalCode, normalizeJsonResult, nativeWorktreeRoot, nativeConfigFile, config, setting, simCandidates, parseKind, optionValue, crashReportsDirectory, appium, executeNative } from "./index.js";

export function nativeCaptureScreens(args: readonly string[]): Result<NativeCaptureScreen[]> {
  const screensFile = optionValue(args, "--screens");
  if (screensFile !== undefined) {
    let value: unknown;
    try { value = JSON.parse(readFileSync(screensFile, "utf8")); } catch { return error(`screens file is missing or invalid: ${screensFile}`, 2); }
    if (!Array.isArray(value) || value.length === 0) return error("screens file must contain a non-empty array", 2);
    const screens: NativeCaptureScreen[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) return error("each native capture screen needs name and route", 2);
      const item = entry as { name?: unknown; route?: unknown };
      if (typeof item.name !== "string" || item.name.length === 0 || typeof item.route !== "string" || !item.route.startsWith("/")) return error("each native capture screen needs a name and an absolute route", 2);
      screens.push({ name: item.name, route: item.route });
    }
    return uniqueCaptureScreens(screens);
  }
  const name = optionValue(args, "--screen");
  const route = optionValue(args, "--route");
  if (!name || !route) return error("native capture requires --screens FILE, or --screen NAME --route PATH", 2);
  if (!route.startsWith("/")) return error(`native capture requires an absolute route path: ${route}`, 2);
  return uniqueCaptureScreens([{ name, route }]);
}

export function uniqueCaptureScreens(screens: NativeCaptureScreen[]): Result<NativeCaptureScreen[]> {
  const names = new Set<string>();
  for (const screen of screens) {
    if (names.has(screen.name)) return error(`native capture screen names must be unique: ${screen.name}`, 2);
    names.add(screen.name);
  }
  return ok(screens);
}

export function captureOptionNames(): ReadonlySet<string> {
  return new Set(["--screens", "--screen", "--route", "--neutral-route", "--output-root", "--surface", "--capture-id", "--theme", "--viewport", "--device", "--bundle-id", "--metro-port", "--timeout", "--stable-window"]);
}

export function validateCaptureOptions(args: readonly string[]): Result<void> {
  const options = captureOptionNames();
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (options.has(arg)) {
      if (args[index + 1] === undefined || args[index + 1]?.startsWith("--")) return error(`native capture option requires a value: ${arg}`, 2);
      index += 1;
      continue;
    }
    return error(`unknown native capture option: ${arg}`, 2);
  }
  return ok(undefined);
}

export async function terminateNativeCaptureApp(processAdapter: ProcessAdapter, udid: string, bundleId: string): Promise<Result<void>> {
  const terminate = await processAdapter.run("xcrun", ["simctl", "terminate", udid, bundleId]);
  if (terminate.kind !== "ok" && !/not running|no such process|does not exist|not found|nothing to terminate/i.test(terminate.error)) {
    return error(`failed to terminate ${bundleId} on simulator ${udid}: ${terminate.error}`);
  }
  return ok(undefined);
}

export async function resetNativeCaptureApp(processAdapter: ProcessAdapter, udid: string, bundleId: string, metroPort: number, timeoutMs: number, strong = false): Promise<Result<NativeResetOverlayStatus>> {
  const deadline = Date.now() + timeoutMs;
  const terminated = await terminateNativeCaptureApp(processAdapter, udid, bundleId);
  if (terminated.kind !== "ok") return terminated;
  if (strong) await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(50, Math.max(0, deadline - Date.now()))));
  if (Date.now() >= deadline) return error(`failed to reset ${bundleId} on simulator ${udid}: timeout elapsed after termination`);
  const launch = await processAdapter.run("xcrun", ["simctl", "launch", udid, bundleId]);
  if (launch.kind !== "ok") return error(`failed to relaunch ${bundleId} on simulator ${udid}: ${launch.error}`);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return error(`failed to reset ${bundleId} on simulator ${udid}: Metro inspector target was not ready within ${timeoutMs}ms`);
  const target = await waitForMetroInspectorTarget(metroPort, remaining);
  if (target.kind !== "ok") return error(`failed to reset ${bundleId} on simulator ${udid}: ${target.error}`);
  const overlays = await silenceNativeOverlays(processAdapter, metroPort, remaining);
  if (overlays.kind !== "ok") return error(`failed to reset ${bundleId} on simulator ${udid}: ${overlays.error}`);
  return ok(overlays.value);
}

export async function captureNativeFrame(processAdapter: ProcessAdapter, udid: string, path: string): Promise<Result<string>> {
  const capture = await processAdapter.run("xcrun", ["simctl", "io", udid, "screenshot", path]);
  if (capture.kind !== "ok") return error(`failed to capture simulator frame: ${capture.error}`);
  const hash = await processAdapter.run("shasum", ["-a", "256", path]);
  if (hash.kind !== "ok") return error(`failed to hash simulator frame: ${hash.error}`);
  const value = hash.value.stdout.trim().split(/\s+/)[0] ?? "";
  return value.length > 0 ? ok(value) : error("failed to hash simulator frame: shasum returned no hash");
}

export type NativeSettledFrame = Readonly<{
  hash: string;
  stableDurationMs: number;
  sampleCount: number;
}>;

export async function settleNativeFrame(processAdapter: ProcessAdapter, udid: string, path: string, timeoutMs: number, stableWindowMs: number, clock: Clock): Promise<Result<NativeSettledFrame>> {
  const deadline = clock.now() + timeoutMs;
  let previousHash: string | undefined;
  let stableSince: number | undefined;
  let sampleCount = 0;
  while (clock.now() < deadline) {
    const frame = await captureNativeFrame(processAdapter, udid, path);
    if (frame.kind !== "ok") return frame;
    sampleCount += 1;
    const sampledAt = clock.now();
    if (frame.value === previousHash) {
      const stableDurationMs = sampledAt - (stableSince ?? sampledAt);
      if (stableDurationMs >= stableWindowMs) return ok({ hash: frame.value, stableDurationMs, sampleCount });
    } else {
      stableSince = sampledAt;
    }
    previousHash = frame.value;
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;
    await sleep(clock, Math.min(50, remaining));
  }
  return error(`frame did not settle within ${timeoutMs}ms`);
}

export function captureNavigationArgs(kind: NativeKind, route: string, metroPort: string, timeout: string): string[] {
  return [kind, route, "--metro-port", metroPort, "--timeout", timeout];
}

export async function nativeCapture(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter, clock: Clock): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeUsage("capture"));
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  const validOptions = validateCaptureOptions(args); if (validOptions.kind !== "ok") return validOptions;
  const screens = nativeCaptureScreens(args); if (screens.kind !== "ok") return screens;
  const root = await nativeWorktreeRoot(environment, processAdapter);
  const loaded = config(root); if (loaded.kind !== "ok") return loaded;
  const requestedDevice = optionValue(args, "--device") ?? setting(loaded.value, kind.value, "device");
  const bundleId = optionValue(args, "--bundle-id") ?? setting(loaded.value, kind.value, "bundleId");
  if (!bundleId) return error(`bundle id is required for ${kind.value}; pass --bundle-id`);
  const metroPort = optionValue(args, "--metro-port") ?? setting(loaded.value, kind.value, "metroPort");
  const validPort = validateMetroPort(metroPort); if (validPort.kind !== "ok") return validPort;
  if (validPort.value === "" || validPort.value === "none") return error(`Metro port is required for ${kind.value}; pass --metro-port`);
  const timeoutRaw = optionValue(args, "--timeout") ?? environment.MEGABRAIN_NATIVE_DEFAULT_TIMEOUT ?? "30";
  const timeout = validateTimeout(timeoutRaw); if (timeout.kind !== "ok") return timeout;
  const stableWindowRaw = optionValue(args, "--stable-window") ?? String(DEFAULT_NATIVE_STABLE_WINDOW_MS / 1000);
  const stableWindow = validateStableWindow(stableWindowRaw); if (stableWindow.kind !== "ok") return stableWindow;
  const neutralRoute = optionValue(args, "--neutral-route") ?? "/";
  if (!neutralRoute.startsWith("/")) return error(`native capture requires an absolute neutral route: ${neutralRoute}`, 2);
  const candidates = await simCandidates(processAdapter, kind.value); if (candidates.kind !== "ok") return candidates;
  const selected = selectDevice(kind.value, candidates.value, requestedDevice, true); if (selected.kind !== "ok") return selected;
  const commit = await processAdapter.run("git", ["-C", root, "rev-parse", "HEAD"]);
  if (commit.kind !== "ok" || commit.value.stdout.trim().length === 0) return error(`could not determine repository commit: ${commit.kind === "failed" ? commit.error : "git returned no commit"}`);

  const outputRoot = resolve(root, optionValue(args, "--output-root") ?? "native-captures");
  const surface = optionValue(args, "--surface") ?? kind.value;
  const captureId = optionValue(args, "--capture-id") ?? `capture-${new Date().toISOString().replace(/[.:]/g, "-")}`;
  const theme = optionValue(args, "--theme") ?? "light";
  const viewport = optionValue(args, "--viewport") ?? "default";
  let manifestPath = "";
  let tempDirectory = "";
  const outcomeFrames: NativeCaptureRecord[] = [];
  const reportedScreens: NativeCaptureScreenRecord[] = [];
  const screenErrors: string[] = [];
  let previousPendingFailureCount: number | undefined;
  let earlyStopReason: string | undefined;
  const overlayCounts = {
    logBox: { present: 0, absent: 0 },
    devLoadingView: { prevented: 0, fallback: 0, absent: 0 },
  };
  const recordOverlayReset = (reset: NativeResetOverlayStatus): void => {
    if (reset.logBox === "ignored") overlayCounts.logBox.present += 1;
    else overlayCounts.logBox.absent += 1;
    if (reset.devLoadingView === "prevented") overlayCounts.devLoadingView.prevented += 1;
    else if (reset.devLoadingView === "fallback") overlayCounts.devLoadingView.fallback += 1;
    else overlayCounts.devLoadingView.absent += 1;
  };
  const recordScreenFailure = (screen: NativeCaptureScreen, failure: string): void => {
    screenErrors.push(failure);
    reportedScreens.push(buildNativeCaptureFailureRecord({ name: screen.name, requestedRoute: screen.route, failure }));
  };
  const recordNavigationFailure = (screen: NativeCaptureScreen, message: string, remainingScreens: readonly NativeCaptureScreen[]): boolean => {
    recordScreenFailure(screen, `screen ${screen.name}: navigation failed: ${message}`);
    const pendingCount = pendingNavigationCount(message);
    if (pendingCount === undefined) {
      previousPendingFailureCount = undefined;
      return false;
    }
    if (previousPendingFailureCount !== undefined && pendingCount >= previousPendingFailureCount) {
      earlyStopReason = `capture stopped early after screen ${screen.name}: pending navigation queue did not drain (${pendingCount} pending actions; previous failure had ${previousPendingFailureCount}); screens not attempted: ${remainingScreens.length > 0 ? remainingScreens.map((item) => item.name).join(", ") : "none"}`;
      return true;
    }
    previousPendingFailureCount = pendingCount;
    return false;
  };
  try {
    tempDirectory = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const controlPath = join(tempDirectory, "control.png");
    const controlReset = await terminateNativeCaptureApp(processAdapter, selected.value.udid, bundleId);
    if (controlReset.kind !== "ok") return controlReset;
    const control = await captureNativeFrame(processAdapter, selected.value.udid, controlPath);
    if (control.kind !== "ok") return control;
    for (let index = 0; index < screens.value.length; index += 1) {
      const screen = screens.value[index] as NativeCaptureScreen;
      let paths;
      try { paths = buildNativeCapturePaths({ outputRoot, surface, captureId, theme, viewport, screen: screen.name }); }
      catch (cause: unknown) {
        recordScreenFailure(screen, `screen ${screen.name}: ${cause instanceof Error ? cause.message : "invalid output path"}`);
        continue;
      }
      manifestPath = paths.manifest;
      const reset = await resetNativeCaptureApp(processAdapter, selected.value.udid, bundleId, Number(validPort.value), timeout.value * 1000);
      if (reset.kind !== "ok") {
        recordScreenFailure(screen, `screen ${screen.name}: reset failed: ${reset.error}`);
        continue;
      }
      recordOverlayReset(reset.value);
      const navigation = await nativeNavigate([...captureNavigationArgs(kind.value, screen.route, validPort.value, String(timeout.value)), "--json"], environment, processAdapter);
      if (navigation.kind !== "ok") {
        if (recordNavigationFailure(screen, navigation.error, screens.value.slice(index + 1))) break;
        continue;
      }
      previousPendingFailureCount = undefined;
      const navigationResult = nativeNavigationResult(navigation.value);
      if (navigationResult.kind !== "ok") {
        recordScreenFailure(screen, `screen ${screen.name}: navigation failed: ${navigationResult.error}`);
        previousPendingFailureCount = undefined;
        continue;
      }
      let reachedPathname = navigationResult.value.after.pathname;
      let framePath = join(tempDirectory, `screen-${index}.png`);
      let frame = await settleNativeFrame(processAdapter, selected.value.udid, framePath, timeout.value * 1000, stableWindow.value, clock);
      if (frame.kind !== "ok") {
        recordScreenFailure(screen, `screen ${screen.name}: ${frame.error}`);
        continue;
      }
      let hash = frame.value.hash;
      let stableDurationMs = frame.value.stableDurationMs;
      let sampleCount = frame.value.sampleCount;
      const makeRecord = (): NativeCaptureRecord => buildNativeCaptureRecord({ paths, name: screen.name, hash, stableDurationMs, sampleCount, requestedRoute: screen.route, reachedPathname });
      if (hash === control.value) {
        outcomeFrames.push(makeRecord());
        recordScreenFailure(screen, `screen ${screen.name}: frame matches the control frame`);
        continue;
      }
      const previousHash = outcomeFrames.at(-1)?.hash;
      if (previousHash !== undefined && hash === previousHash) {
        const retryReset = await resetNativeCaptureApp(processAdapter, selected.value.udid, bundleId, Number(validPort.value), timeout.value * 1000, true);
        if (retryReset.kind !== "ok") {
          outcomeFrames.push(makeRecord());
          recordScreenFailure(screen, `screen ${screen.name}: duplicate retry failed: ${retryReset.error}`);
          continue;
        }
        recordOverlayReset(retryReset.value);
        const neutralNavigation = await nativeNavigate([...captureNavigationArgs(kind.value, neutralRoute, validPort.value, String(timeout.value)), "--json"], environment, processAdapter);
        if (neutralNavigation.kind !== "ok") {
          outcomeFrames.push(makeRecord());
          recordScreenFailure(screen, `screen ${screen.name}: duplicate retry neutral navigation failed: ${neutralNavigation.error}`);
          continue;
        }
        const neutralNavigationResult = nativeNavigationResult(neutralNavigation.value);
        if (neutralNavigationResult.kind !== "ok") {
          outcomeFrames.push(makeRecord());
          recordScreenFailure(screen, `screen ${screen.name}: duplicate retry neutral navigation failed: ${neutralNavigationResult.error}`);
          continue;
        }
        const retryNavigation = await nativeNavigate([...captureNavigationArgs(kind.value, screen.route, validPort.value, String(timeout.value)), "--json"], environment, processAdapter);
        if (retryNavigation.kind !== "ok") {
          outcomeFrames.push(makeRecord());
          if (recordNavigationFailure(screen, `duplicate retry failed: ${retryNavigation.error}`, screens.value.slice(index + 1))) break;
          continue;
        }
        const retryNavigationResult = nativeNavigationResult(retryNavigation.value);
        if (retryNavigationResult.kind !== "ok") {
          outcomeFrames.push(makeRecord());
          recordScreenFailure(screen, `screen ${screen.name}: duplicate retry navigation failed: ${retryNavigationResult.error}`);
          previousPendingFailureCount = undefined;
          continue;
        }
        reachedPathname = retryNavigationResult.value.after.pathname;
        framePath = join(tempDirectory, `screen-${index}-retry.png`);
        frame = await settleNativeFrame(processAdapter, selected.value.udid, framePath, timeout.value * 1000, stableWindow.value, clock);
        if (frame.kind !== "ok") {
          outcomeFrames.push(makeRecord());
          recordScreenFailure(screen, `screen ${screen.name}: duplicate retry failed: ${frame.error}`);
          continue;
        }
        hash = frame.value.hash;
        stableDurationMs = frame.value.stableDurationMs;
        sampleCount = frame.value.sampleCount;
        if (hash === control.value) {
          outcomeFrames.push(makeRecord());
          recordScreenFailure(screen, `screen ${screen.name}: retry frame matches the control frame`);
          continue;
        }
        if (hash === previousHash) {
          outcomeFrames.push(makeRecord());
          recordScreenFailure(screen, `screen ${screen.name}: frame duplicates the previous screen after retry`);
          continue;
        }
      }
      await mkdir(dirname(paths.image), { recursive: true });
      await rename(framePath, paths.image);
      const record = makeRecord();
      outcomeFrames.push(record);
      reportedScreens.push(record);
    }
    if (earlyStopReason !== undefined) {
      const attempted = reportedScreens.length;
      for (const screen of screens.value.slice(attempted)) {
        recordScreenFailure(screen, `screen ${screen.name}: not attempted: capture stopped early`);
      }
    }
    const outcome = decideCaptureOutcome({ controlHash: control.value, screens: outcomeFrames });
    const logBoxSummary = nativeOverlaySummary("LogBox", "ignored", "LogBox not found in module registry", overlayCounts.logBox);
    const devLoadingViewSummary = nativeDevLoadingViewSummary(overlayCounts.devLoadingView);
    const captureOutcome = earlyStopReason === undefined
      ? { ...outcome, summary: `${outcome.summary}; ${logBoxSummary}; ${devLoadingViewSummary}` }
      : { ...outcome, summary: `${outcome.summary}; ${logBoxSummary}; ${devLoadingViewSummary}; ${earlyStopReason}` };
    const controlReport = { hash: control.value, simulatorState: "application terminated; simulator home screen visible" };
    const summary = captureOutcome.summary;
    const failureReasons = [...outcome.failureReasons, ...(earlyStopReason === undefined ? [] : [earlyStopReason])];
    if (manifestPath.length === 0) {
      const first = buildNativeCapturePaths({ outputRoot, surface, captureId, theme, viewport, screen: screens.value[0]?.name ?? "capture" });
      manifestPath = first.manifest;
    }
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({
      surface,
      captureId,
      theme,
      viewport,
      commit: commit.value.stdout.trim(),
      date: new Date().toISOString(),
      screens: reportedScreens,
      control: controlReport,
      summary,
      failures: failureReasons,
    }, null, 2)}\n`);
    const failedRun = captureOutcome.failed || screenErrors.length > 0;
    const displayFailureReasons = [...failureReasons, ...screenErrors];
    const report = args.includes("--json")
      ? `${JSON.stringify({ ok: !failedRun, ...captureOutcome, summary, control: controlReport, failureReasons, manifest: manifestPath, screens: reportedScreens })}\n`
      : `${summary}\n${displayFailureReasons.map((reason) => `failed: ${reason}`).join("\n")}${displayFailureReasons.length > 0 ? "\n" : ""}`;
    return ok(report, failedRun ? 1 : undefined);
  } finally {
    if (tempDirectory.length > 0) await rm(tempDirectory, { recursive: true, force: true });
  }
}
