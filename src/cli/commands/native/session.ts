import { createHash } from "node:crypto";
import { nativeUsage, validateTimeout } from "../../../core/native.js";
import { type ProcessAdapter } from "../../../adapters/proc.js";
import { type NativeHealth, type NativePlatform } from "../../../core/native.js";
import { failed, ok, type Result } from "../../../core/result.js";
import { nativeSessionFor, removeNativeSession, replaceNativeSession, type NativeSessionKey } from "../../../core/native-session.js";
import { createNativeSessionStore } from "../../../adapters/native-session-store.js";

import { Environment, Config, ExpoApp, NativeCaptureScreen, error, refusalCode, normalizeJsonResult, nativeWorktreeRoot, nativeConfigFile, config, setting, simCandidates, parseKind, optionValue, crashReportsDirectory, runtimePlatform, installedRuntimes, nativeBuildUsage, buildConfigError, readExpoApp, generatedWorkspace, nativeBuild, nativeRuntimeList, nativeRuntimeInstall, nativeCrashes, nativeList, SIMULATOR_UDID, nativeScreenshot, nativeEnsure, nativeReload, runtimeValue, formatEvaluation, cdpArguments, nativeEval, routerModuleExpression, logBoxExpression, devLoadingViewExpression, routeInfoExpression, navigationQueueExpression, navigationExpression, RouteSnapshot, NativeNavigationResult, routeSnapshot, routeChanged, nativeNavigationResult, pendingNavigationCount, nativeNavigate, nativeCaptureScreens, uniqueCaptureScreens, captureOptionNames, validateCaptureOptions, terminateNativeCaptureApp, resetNativeCaptureApp, captureNativeFrame, NativeSettledFrame, settleNativeFrame, NativeLogBoxStatus, NativeDevLoadingViewStatus, NativeResetOverlayStatus, silenceNativeLogBox, preventNativeDevLoadingView, silenceNativeOverlays, nativeOverlaySummary, nativeDevLoadingViewSummary, captureNavigationArgs, nativeCapture, executeNative } from "./index.js";

export function unknownProcess(reason: string): NativeHealth["process"] { return { state: "unknown", reason }; }
export function unknownMetro(reason: string): NativeHealth["metro"] { return { state: "unknown", reason }; }
export function unknownTree(reason: string): NativeHealth["tree"] { return { count: null, reason }; }
export function unknownFrame(reason: string): NativeHealth["frame"] { return { state: "unknown", reason }; }
export const APPIUM_SESSION_DEFAULTS = {
  "appium:automationName": "XCUITest",
  "appium:isHeadless": true,
  "appium:newCommandTimeout": 60,
} as const;
export function appiumSessionCapabilities(platform: NativePlatform, udid: string, bundleId: string): Record<string, string | boolean | number> {
  return { platformName: platform, ...APPIUM_SESSION_DEFAULTS, "appium:udid": udid, "appium:bundleId": bundleId };
}
export function appiumInputSessionCapabilities(platform: NativePlatform, udid: string): Record<string, string | boolean | number> {
  const bundleId = platform === "iOS" ? "com.apple.springboard" : "com.apple.TVHomeScreen";
  // WDA listens on localhost and Appium forwards to it. A stable per-device port lets multiple
  // simulators own sessions at once without all of them competing for WDA's default 8100.
  const hash = createHash("sha256").update(udid).digest("hex");
  const wdaLocalPort = 10000 + Number.parseInt(hash.slice(0, 8), 16) % 50000;
  const mjpegServerPort = 10000 + Number.parseInt(hash.slice(8, 16), 16) % 50000;
  return {
    ...appiumSessionCapabilities(platform, udid, bundleId),
    "appium:autoLaunch": false,
    "appium:forceAppLaunch": false,
    "appium:noReset": true,
    "appium:wdaLocalPort": wdaLocalPort,
    "appium:wdaLaunchTimeout": 120_000,
    "appium:wdaConnectionTimeout": 120_000,
    "appium:mjpegServerPort": mjpegServerPort,
  };
}
export type AppiumSession = Readonly<{ sessionId: string; stored: boolean }>;
export type AppiumSessionAttempt = Readonly<{ session?: AppiumSession; reason?: string; warning?: string }>;
export type AppiumResponse = Readonly<{ status: number; body: string }>;
export function appiumResponse(stdout: string): AppiumResponse | undefined {
  const status = stdout.match(/(?:^|\n)(\d{3})\s*$/);
  if (status === null || status.index === undefined) return undefined;
  return { status: Number(status[1]), body: stdout.slice(0, status.index) };
}
export function appiumMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; value?: { message?: unknown } };
    const message = parsed.value?.message ?? parsed.message;
    return typeof message === "string" && message.length > 0 ? message : undefined;
  } catch {
    const message = body.trim();
    return message.length > 0 ? message : undefined;
  }
}
export function appiumHttpFailure(action: string, response: AppiumResponse): string {
  const message = appiumMessage(response.body);
  return `${action} (HTTP ${response.status})${message ? `: ${message}` : ""}`;
}
export async function createAppiumSession(processAdapter: ProcessAdapter, key: NativeSessionKey, platform: NativePlatform, capabilities = appiumSessionCapabilities(platform, key.udid, key.bundleId), port = 4723): Promise<Result<string>> {
  const session = await processAdapter.run("curl", ["-sS", "--max-time", "120", "-w", "\n%{http_code}", "-X", "POST", `http://127.0.0.1:${port}/session`, "-H", "Content-Type: application/json", "-d", JSON.stringify({ capabilities: { alwaysMatch: capabilities } })]);
  if (session.kind !== "ok") return failed(`Appium server was unreachable: ${session.error}`);
  const response = appiumResponse(session.value.stdout);
  if (response === undefined) return failed("Appium session response did not include an HTTP status");
  if (response.status < 200 || response.status >= 300) return failed(appiumHttpFailure("Appium server rejected session", response));
  try {
    const value = JSON.parse(response.body) as { sessionId?: string; value?: { sessionId?: string } };
    const sessionId = value.sessionId ?? value.value?.sessionId;
    return typeof sessionId === "string" && sessionId.length > 0 ? ok(sessionId) : failed("Appium session response did not include a session id");
  } catch {
    return failed("Appium session response was not valid JSON");
  }
}
// WHY: the TypeScript path reuses verified sessions; the unchanged shell path keeps its
// create/read/destroy behavior because both paths return identical health output.
export async function appiumSession(environment: Environment, processAdapter: ProcessAdapter, key: NativeSessionKey, platform: NativePlatform): Promise<Result<AppiumSessionAttempt>> {
  const store = createNativeSessionStore(environment);
  if (!store.available) {
    if (store.error !== undefined) return failed(`native session database could not open: ${store.error}`);
    const sessionId = await createAppiumSession(processAdapter, key, platform);
    return sessionId.kind === "ok" ? ok({ session: { sessionId: sessionId.value, stored: false } }) : ok({ reason: sessionId.error });
  }
  const initialSnapshot = store.read();
  if (initialSnapshot.kind !== "ok") return failed(`could not read native session store: ${initialSnapshot.error}`);
  const initiallyRecorded = nativeSessionFor(initialSnapshot.value, key);
  if (initiallyRecorded !== undefined) {
    const probe = await processAdapter.run("curl", ["-fsS", `http://127.0.0.1:4723/session/${initiallyRecorded.sessionId}`]);
    if (probe.kind === "ok") return ok({ session: { sessionId: initiallyRecorded.sessionId, stored: true } });
  }

  const created = await createAppiumSession(processAdapter, key, platform);
  if (created.kind !== "ok") {
    if (initiallyRecorded !== undefined) {
      const removed = store.update((sessions) => {
        const current = nativeSessionFor(sessions, key);
        return current?.sessionId === initiallyRecorded.sessionId
          ? { sessions: removeNativeSession(sessions, key), value: undefined }
          : { sessions, value: undefined };
      });
      if (removed.kind !== "ok") return failed(`could not clear dead native session: ${removed.error}; ${created.error}`);
    }
    return ok({ reason: created.error });
  }

  const sessionId = created.value;
  const sessionUrl = `http://127.0.0.1:4723/session/${sessionId}`;
  const discardCreated = async (): Promise<string | undefined> => {
    const removed = await processAdapter.run("curl", ["-fsS", "-X", "DELETE", sessionUrl]);
    return removed.kind === "ok" ? undefined : `could not delete losing Appium session ${sessionId}: ${removed.error}`;
  };

  while (true) {
    const snapshot = store.read();
    if (snapshot.kind !== "ok") {
      const warning = await discardCreated();
      return failed(`could not re-read native session store: ${snapshot.error}${warning === undefined ? "" : `; ${warning}`}`);
    }
    const current = nativeSessionFor(snapshot.value, key);
    if (current !== undefined && current.sessionId !== initiallyRecorded?.sessionId) {
      const probe = await processAdapter.run("curl", ["-fsS", `http://127.0.0.1:4723/session/${current.sessionId}`]);
      if (probe.kind === "ok") {
        const confirmed = store.update((sessions) => {
          const latest = nativeSessionFor(sessions, key);
          return latest?.sessionId === current.sessionId
            ? { sessions, value: true }
            : { sessions, value: false };
        });
        if (confirmed.kind !== "ok") {
          const warning = await discardCreated();
          return failed(`could not confirm concurrent native session: ${confirmed.error}${warning === undefined ? "" : `; ${warning}`}`);
        }
        if (confirmed.value) {
          const warning = await discardCreated();
          return ok({ session: { sessionId: current.sessionId, stored: true }, ...(warning === undefined ? {} : { warning }) });
        }
        continue;
      }
    }

    const saved = store.update((sessions) => {
      const latest = nativeSessionFor(sessions, key);
      if (latest?.sessionId !== current?.sessionId) return { sessions, value: false };
      return { sessions: replaceNativeSession(sessions, { ...key, sessionId }), value: true };
    });
    if (saved.kind !== "ok") {
      const warning = await discardCreated();
      return failed(`could not store Appium session: ${saved.error}${warning === undefined ? "" : `; ${warning}`}`);
    }
    if (saved.value) return ok({ session: { sessionId, stored: true } });
  }
}

export async function appium(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") return ok(nativeUsage("appium"));
  if (args.includes("-h") || args.includes("--help")) return ok(nativeUsage("appium"));
  if (args.length > 1) return error(`unknown native appium option: ${args[1]}`, 2);
  const operation = args[0]; const port = environment.MEGABRAIN_APPIUM_PORT ?? "4723";
  if (operation === "status") {
    const found = await processAdapter.run("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"]);
    const pid = found.kind === "ok" ? found.value.stdout.trim().split("\n")[0] ?? "" : "";
    if (!pid) return error(`appium: down (port ${port})`);
    const ps = await processAdapter.run("ps", ["-p", pid, "-o", "command="]); const command = ps.kind === "ok" ? ps.value.stdout : "";
    return command.includes("appium") ? ok(`appium: up (port ${port}, pid ${pid})\n`) : error(`appium: occupied (port ${port}, pid ${pid})`);
  }
  if (operation !== "start" && operation !== "stop") return error(`unknown appium operation: ${operation}`, 2);
  if (operation === "start") {
    const started = await processAdapter.startDetached("appium", ["--port", port, "--log-level", "error"]);
    if (started.kind !== "ok") return error(`failed to start appium: ${started.error}`);
    const timeout = validateTimeout(environment.MEGABRAIN_NATIVE_DEFAULT_TIMEOUT ?? "30");
    if (timeout.kind !== "ok") return timeout;
    for (let attempt = 0; attempt < timeout.value * 5; attempt += 1) {
      const probe = await processAdapter.run("curl", ["-fsS", "--max-time", "1", `http://127.0.0.1:${port}/status`]);
      if (probe.kind === "ok") {
        const status = await appium(["status"], environment, processAdapter);
        if (status.kind === "ok") return status;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    return error(`appium did not start on port ${port}; the server did not answer readiness checks`);
  }
  const found = await processAdapter.run("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"]);
  const pid = found.kind === "ok" ? found.value.stdout.trim().split("\n")[0] ?? "" : "";
  if (!pid) return ok("appium: already stopped\n");
  const ps = await processAdapter.run("ps", ["-p", pid, "-o", "command="]);
  const command = ps.kind === "ok" ? ps.value.stdout : "";
  if (!command.includes("appium")) return error(`appium: occupied (port ${port}, pid ${pid})`);
  const stopped = await processAdapter.run("kill", [pid]);
  if (stopped.kind !== "ok") return error(`failed to stop appium (pid ${pid}): ${stopped.error}`);
  return ok(`appium: stopped (pid ${pid})\n`);
}
