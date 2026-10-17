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
import { nativeReload } from "./app.js";
import { nativeList, SIMULATOR_UDID, nativeScreenshot, nativeEnsure } from "./sim.js";
import { nativeBuildUsage, buildConfigError, readExpoApp, generatedWorkspace, nativeBuild } from "./build.js";
import { nativeCrashes } from "./crashes.js";
import { runtimePlatform, installedRuntimes, nativeRuntimeList, nativeRuntimeInstall } from "./runtime.js";

import { Environment, Config, ExpoApp, NativeCaptureScreen, error, refusalCode, normalizeJsonResult, nativeWorktreeRoot, nativeConfigFile, config, setting, simCandidates, parseKind, optionValue, crashReportsDirectory, nativeCaptureScreens, uniqueCaptureScreens, captureOptionNames, validateCaptureOptions, terminateNativeCaptureApp, resetNativeCaptureApp, captureNativeFrame, NativeSettledFrame, settleNativeFrame, NativeLogBoxStatus, NativeDevLoadingViewStatus, NativeResetOverlayStatus, silenceNativeLogBox, preventNativeDevLoadingView, silenceNativeOverlays, nativeOverlaySummary, nativeDevLoadingViewSummary, captureNavigationArgs, nativeCapture, appium, executeNative } from "./index.js";

export function runtimeValue(value: unknown): string {
  if (value === undefined) return "undefined\n";
  try { return `${JSON.stringify(value)}\n`; } catch { return `${String(value)}\n`; }
}

export function formatEvaluation(evaluation: MetroEvaluation, json: boolean): Result<string> {
  if (json) {
    const value = evaluation.kind === "value" ? evaluation.value : null;
    const exception = evaluation.kind === "exception" ? evaluation.message : null;
    return ok(`${JSON.stringify({ value, exception })}\n`);
  }
  return evaluation.kind === "exception" ? ok(`expression threw: ${evaluation.message}\n`) : ok(runtimeValue(evaluation.value));
}

export function cdpArguments(args: readonly string[], environment: Environment): Result<{ kind: NativeKind; timeoutMs: number; expression: string }> {
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  const timeoutRaw = optionValue(args, "--timeout") ?? environment.MEGABRAIN_NATIVE_DEFAULT_TIMEOUT ?? "30";
  const timeout = validateTimeout(timeoutRaw); if (timeout.kind !== "ok") return timeout;
  const expressionParts: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if ((arg === "--timeout" || arg === "--metro-port") && args[index + 1] !== undefined) { index += 1; continue; }
    if (arg.startsWith("--")) return error(`unknown native CDP option: ${arg}`, 2);
    expressionParts.push(arg);
  }
  if (expressionParts.length === 0) return error("native eval requires an expression");
  return ok({ kind: kind.value, timeoutMs: timeout.value * 1000, expression: expressionParts.join(" ") });
}

export async function nativeEval(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("native-eval"));
  const parsed = cdpArguments(args, environment); if (parsed.kind !== "ok") return parsed;
  const root = await nativeWorktreeRoot(environment, processAdapter);
  const loaded = config(root); if (loaded.kind !== "ok") return loaded;
  const portRaw = optionValue(args, "--metro-port") ?? setting(loaded.value, parsed.value.kind, "metroPort");
  const validPort = validateMetroPort(portRaw); if (validPort.kind !== "ok") return validPort;
  if (validPort.value === "" || validPort.value === "none") return error(`Metro port is required for ${parsed.value.kind}; pass --metro-port`);
  const connection = await connectMetroInspector(Number(validPort.value), parsed.value.timeoutMs);
  if (connection.kind !== "ok") return connection;
  try {
    const evaluation = await connection.value.evaluate(parsed.value.expression, parsed.value.timeoutMs);
    if (evaluation.kind !== "ok") return evaluation;
    return formatEvaluation(evaluation.value, args.includes("--json"));
  } finally {
    connection.value.close();
  }
}

export const routerModuleExpression = `(() => {
  const resolver = globalThis.__r;
  if (resolver === undefined || typeof resolver.getModules !== "function") throw new Error("Metro module registry is unavailable");
  const find = (modulePath, exportName) => {
    for (const [id, metadata] of resolver.getModules()) {
      const name = typeof metadata === "string" ? metadata : metadata?.verboseName;
      if (typeof name !== "string" || (name !== modulePath && !name.endsWith("/" + modulePath))) continue;
      const module = resolver(id);
      if (module === null || (typeof module !== "object" && typeof module !== "function") || !(exportName in module)) throw new Error("required Expo Router export " + exportName + " is unavailable from " + modulePath);
      return module[exportName];
    }
    throw new Error("required Expo Router module " + modulePath + " is unavailable (expected export " + exportName + ")");
  };
  const router = find("expo-router/build/imperative-api.js", "router");
  const store = find("expo-router/build/global-state/router-store.js", "store");
  const routingQueue = find("expo-router/build/global-state/routingQueue.js", "routingQueue");
  if (store === null || (typeof store !== "object" && typeof store !== "function") || typeof store.getRouteInfo !== "function") throw new Error("required Expo Router export getRouteInfo is unavailable from expo-router/build/global-state/router-store.js export store");
  if (routingQueue === null || (typeof routingQueue !== "object" && typeof routingQueue !== "function") || typeof routingQueue.snapshot !== "function") throw new Error("required Expo Router export snapshot is unavailable from expo-router/build/global-state/routingQueue.js export routingQueue");
  return { router, store, routingQueue };
})()`;

export const logBoxExpression = `(() => {
  const resolver = globalThis.__r;
  if (resolver === undefined || typeof resolver.getModules !== "function") return { present: false };
  for (const [id, metadata] of resolver.getModules()) {
    const name = typeof metadata === "string" ? metadata : metadata?.verboseName;
    if (typeof name !== "string" || (!name.endsWith("/Libraries/LogBox/LogBox.js") && !name.endsWith("/Libraries/LogBox/LogBox"))) continue;
    const module = resolver(id);
    const logBox = module?.LogBox ?? module?.default;
    if (logBox === null || (typeof logBox !== "object" && typeof logBox !== "function") || typeof logBox.ignoreAllLogs !== "function") return { present: false };
    logBox.ignoreAllLogs();
    return { present: true };
  }
  return { present: false };
})() /* megabrain:logbox */`;

export const devLoadingViewExpression = `(() => {
  const resolver = globalThis.__r;
  if (resolver === undefined || typeof resolver.getModules !== "function") return { present: false };
  for (const [id, metadata] of resolver.getModules()) {
    const name = typeof metadata === "string" ? metadata : metadata?.verboseName;
    if (typeof name !== "string" || !name.endsWith("/Libraries/Utilities/DevLoadingView.js")) continue;
    const module = resolver(id);
    const devLoadingView = module?.DevLoadingView ?? module?.default ?? module;
    if (devLoadingView === null || (typeof devLoadingView !== "object" && typeof devLoadingView !== "function") || typeof devLoadingView.showMessage !== "function" || typeof devLoadingView.hide !== "function") return { present: false };
    const noOp = () => {};
    let prevented = false;
    try {
      devLoadingView.showMessage = noOp;
      prevented = devLoadingView.showMessage === noOp;
    } catch {}
    devLoadingView.hide();
    return { present: true, prevented };
  }
  return { present: false };
})() /* megabrain:dev-loading-view */`;

export const routeInfoExpression = `(() => {
  const modules = ${routerModuleExpression};
  const route = modules.store.getRouteInfo();
  return { pathname: route.pathname, params: route.params };
})() /* megabrain:route-info */`;

export const navigationQueueExpression = `(() => {
  const modules = ${routerModuleExpression};
  const queue = modules.routingQueue.snapshot();
  return Array.isArray(queue) ? queue.length : -1;
})() /* megabrain:navigation-queue */`;

export function navigationExpression(path: string): string {
  return `(() => {
    const modules = ${routerModuleExpression};
    if (modules.router.canDismiss()) modules.router.dismissAll();
    modules.router.navigate(${JSON.stringify(path)});
  })() /* megabrain:navigate */`;
}

export type RouteSnapshot = Readonly<{ pathname: string; params: unknown }>;

export type NativeNavigationResult = Readonly<{ after: RouteSnapshot }>;

export function routeSnapshot(value: unknown): RouteSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as { pathname?: unknown; params?: unknown };
  if (typeof item.pathname !== "string") return undefined;
  return { pathname: item.pathname, params: item.params ?? {} };
}

export function routeChanged(before: RouteSnapshot, after: RouteSnapshot): boolean {
  return before.pathname !== after.pathname || JSON.stringify(before.params) !== JSON.stringify(after.params);
}

export function nativeNavigationResult(value: string): Result<NativeNavigationResult> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return error("native navigate returned invalid JSON");
    const after = routeSnapshot((parsed as { after?: unknown }).after);
    return after === undefined ? error("native navigate returned invalid route data") : ok({ after });
  } catch {
    return error("native navigate returned invalid JSON");
  }
}

export function pendingNavigationCount(message: string): number | undefined {
  const match = /\((\d+) pending actions\)/.exec(message);
  return match === null ? undefined : Number(match[1]);
}

export async function nativeNavigate(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("native-navigate"));
  const parsed = cdpArguments(args, environment); if (parsed.kind !== "ok") return parsed;
  const path = parsed.value.expression;
  if (!path.startsWith("/")) return error(`native navigate requires an absolute route path: ${path}`, 2);
  const root = await nativeWorktreeRoot(environment, processAdapter);
  const loaded = config(root); if (loaded.kind !== "ok") return loaded;
  const portRaw = optionValue(args, "--metro-port") ?? setting(loaded.value, parsed.value.kind, "metroPort");
  const validPort = validateMetroPort(portRaw); if (validPort.kind !== "ok") return validPort;
  if (validPort.value === "" || validPort.value === "none") return error(`Metro port is required for ${parsed.value.kind}; pass --metro-port`);
  const deadline = Date.now() + parsed.value.timeoutMs;
  const connectionBudget = deadline - Date.now();
  if (connectionBudget <= 0) return error("native navigate timed out before connecting to Metro");
  const connection = await connectMetroInspector(Number(validPort.value), connectionBudget);
  if (connection.kind !== "ok") return connection;
  try {
    const remaining = () => deadline - Date.now();
    const beforeBudget = remaining();
    if (beforeBudget <= 0) return error("native navigate timed out before reading the current route");
    const before = await connection.value.evaluate(routeInfoExpression, beforeBudget);
    if (before.kind !== "ok") return before;
    if (before.value.kind === "exception") return error(`could not read current route: ${before.value.message}`);
    const beforeRoute = routeSnapshot(before.value.value);
    if (beforeRoute === undefined) return error("could not read current route: inspector returned invalid route state");
    const navigateBudget = remaining();
    if (navigateBudget <= 0) return error("native navigate timed out before requesting navigation");
    const navigate = await connection.value.evaluate(navigationExpression(path), navigateBudget);
    if (navigate.kind !== "ok") return navigate;
    if (navigate.value.kind === "exception") return error(`navigation expression threw: ${navigate.value.message}`);
    let afterRoute: RouteSnapshot | undefined;
    let queueLength: number | undefined;
    let observedPendingWork = false;
    while (remaining() > 0) {
      const routeBudget = remaining();
      const after = await connection.value.evaluate(routeInfoExpression, routeBudget);
      let changed = false;
      if (after.kind === "ok" && after.value.kind === "value") {
        afterRoute = routeSnapshot(after.value.value);
        changed = afterRoute !== undefined && routeChanged(beforeRoute, afterRoute);
      }
      const queueBudget = remaining();
      if (queueBudget <= 0) break;
      const queue = await connection.value.evaluate(navigationQueueExpression, queueBudget);
      const inspectedQueueLength = queue.kind === "ok" && queue.value.kind === "value" && typeof queue.value.value === "number" && Number.isInteger(queue.value.value) && queue.value.value >= 0
        ? queue.value.value
        : undefined;
      if (inspectedQueueLength !== undefined) {
        queueLength = inspectedQueueLength;
        if (queueLength > 0) observedPendingWork = true;
        if (!changed && queueLength === 0 && !observedPendingWork) return error(`navigation route did not change: pathname remained ${beforeRoute.pathname} with params ${JSON.stringify(beforeRoute.params)}; navigation was not queued (navigation queue is empty)`);
      }
      if (changed) break;
      const waitBudget = remaining();
      if (waitBudget <= 0) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(50, waitBudget)));
    }
    if (afterRoute === undefined || !routeChanged(beforeRoute, afterRoute)) {
      if (queueLength !== undefined && queueLength > 0) return error(`navigation route did not change: pathname remained ${beforeRoute.pathname} with params ${JSON.stringify(beforeRoute.params)}; navigation was queued but not applied (${queueLength} pending actions)`);
      if (queueLength === 0 && !observedPendingWork) return error(`navigation route did not change: pathname remained ${beforeRoute.pathname} with params ${JSON.stringify(beforeRoute.params)}; navigation was not queued (navigation queue is empty)`);
      if (queueLength === 0 && observedPendingWork) return error(`navigation route did not change: pathname remained ${beforeRoute.pathname} with params ${JSON.stringify(beforeRoute.params)}; navigation queue drained but the route was not applied`);
      return error(`navigation route did not change: pathname remained ${beforeRoute.pathname} with params ${JSON.stringify(beforeRoute.params)}; navigation queue could not be inspected`);
    }
    const output = { ok: true, kind: parsed.value.kind, path, before: beforeRoute, after: afterRoute, changed: true };
    return args.includes("--json") ? ok(`${JSON.stringify(output)}\n`) : ok(`navigated ${path}: route changed\n`);
  } finally {
    connection.value.close();
  }
}
