import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { buildXcodebuildArgs, candidatesForRuntimeFromSimctl, candidatesFromSimctl, evaluateNativeHealth, formatNativeList, nativeBuildStepFailure, nativeUsage, renderNativeUrl, runtimesFromSimctl, selectDevice, validateKind, validateMetroPort, validateTimeout, type NativeBuildStep, type NativeCandidate, type NativeHealth, type NativeKind, type NativePlatform, type NativeRuntime } from "../../core/native.js";
import { failed, ok, type Result } from "../../core/result.js";
import { parseCrashReport, selectCrashReports, validateCrashLast, type CrashInput } from "../../core/crash.js";
import { nativeSessionFor, removeNativeSession, replaceNativeSession, type NativeSessionKey } from "../../core/native-session.js";
import { createNativeSessionStore } from "../../adapters/native-session-store.js";
import { connectMetroInspector, waitForMetroInspectorTarget, type MetroEvaluation } from "../../core/native-cdp.js";
import { buildNativeCapturePaths, buildNativeCaptureRecord, decideCaptureOutcome, type NativeCaptureRecord } from "../../core/native-capture.js";

export type Environment = Readonly<Record<string, string | undefined>>;
type Config = { readonly surfaces?: Record<string, Record<string, string>> };
type ExpoApp = { readonly expo?: { readonly scheme?: unknown; readonly ios?: { readonly bundleIdentifier?: unknown } } };
type NativeCaptureScreen = Readonly<{ name: string; route: string }>;

function error<T = string>(message: string, code = 1): Result<T> { return failed(message, code); }
function refusalCode(exitCode: number): string { return exitCode === 2 ? "invalid-arguments" : "native-error"; }
function normalizeJsonResult(result: Result<string>, json: boolean): Result<string> {
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
async function nativeWorktreeRoot(environment: Environment, processAdapter: ProcessAdapter): Promise<string> {
  const path = environment.MEGABRAIN_NATIVE_WORKTREE ?? process.cwd();
  const result = await processAdapter.run("git", ["-C", path, "rev-parse", "--show-toplevel"]);
  if (result.kind !== "ok") return path;
  const root = result.value.stdout.trim();
  return root.length > 0 ? root : path;
}
function nativeConfigFile(root: string): string { return resolve(root, ".megabrain/native.json"); }
function config(root: string): Result<Config> {
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
function setting(loaded: Config, kind: NativeKind, key: string): string { return loaded.surfaces?.[kind]?.[key] ?? ""; }
async function simCandidates(processAdapter: ProcessAdapter, kind: NativeKind): Promise<Result<NativeCandidate[]>> {
  const result = await processAdapter.run("xcrun", ["simctl", "list", "devices", "--json"]);
  if (result.kind !== "ok") return error("failed to list simulators with simctl");
  try { return candidatesFromSimctl(JSON.parse(result.value.stdout), kind); } catch { return error("simctl returned invalid device data"); }
}
function parseKind(args: readonly string[]): Result<NativeKind> { return validateKind(args[0] ?? ""); }
function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function crashReportsDirectory(environment: Environment): string {
  return environment.MEGABRAIN_NATIVE_CRASH_REPORTS_DIR ?? resolve(environment.HOME ?? process.env.HOME ?? "", "Library/Logs/DiagnosticReports");
}

function runtimePlatform(value: string): Result<NativePlatform> {
  if (value === "ios" || value === "iOS") return ok("iOS");
  if (value === "tvos" || value === "tvOS") return ok("tvOS");
  return error(`expected platform iOS or tvOS, got: ${value}`, 2);
}
async function installedRuntimes(processAdapter: ProcessAdapter): Promise<Result<NativeRuntime[]>> {
  const result = await processAdapter.run("xcrun", ["simctl", "list", "runtimes", "--json"]);
  if (result.kind !== "ok") return error("failed to list runtimes with simctl");
  try { return runtimesFromSimctl(JSON.parse(result.value.stdout)); } catch { return error("simctl returned invalid runtime data"); }
}

function nativeBuildUsage(): string { return "Usage: megabrain native build <phone|tv> [--runtime <version>] [--json]\n"; }
function buildConfigError(kind: NativeKind): Result<string> {
  return error(`app path is required for ${kind}; pass surfaces.${kind}.appPath in .megabrain/native.json`);
}
function readExpoApp(appPath: string): Result<{ scheme: string; bundleId: string }> {
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
function generatedWorkspace(appPath: string): Result<{ path: string; relative: string; iosPath: string }> {
  const iosPath = resolve(appPath, "ios");
  if (!existsSync(iosPath)) return error(`prebuild did not produce an ios directory at ${iosPath}`);
  const entries = readdirSync(iosPath);
  const workspace = entries.find((entry) => entry.endsWith(".xcworkspace"));
  if (workspace) return ok({ path: resolve(iosPath, workspace), relative: `ios/${workspace}`, iosPath });
  const project = entries.find((entry) => entry.endsWith(".xcodeproj"));
  if (project) return ok({ path: resolve(iosPath, project), relative: `ios/${project}`, iosPath });
  return error(`prebuild did not produce an Xcode project in ${iosPath}`);
}
async function nativeBuild(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeBuildUsage());
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  let runtime = "";
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--runtime" && args[index + 1]) { runtime = args[++index] as string; continue; }
    return error(`unknown native build option: ${arg}`, 2);
  }
  const root = await nativeWorktreeRoot(environment, processAdapter);
  const loaded = config(root); if (loaded.kind !== "ok") return loaded;
  const appSetting = setting(loaded.value, kind.value, "appPath"); if (!appSetting) return buildConfigError(kind.value);
  const appPath = resolve(root, appSetting);
  const app = readExpoApp(appPath); if (app.kind !== "ok") return app;
  const runtimes = await installedRuntimes(processAdapter); if (runtimes.kind !== "ok") return runtimes;
  const platform: NativePlatform = kind.value === "tv" ? "tvOS" : "iOS";
  const matchingRuntimes = runtimes.value.filter((item) => item.platform === platform && (!runtime || item.version === runtime));
  if (matchingRuntimes.length === 0) return error(runtime ? `no installed ${platform} runtime matches ${runtime}` : `no installed ${platform} runtime is available`);
  matchingRuntimes.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
  const selectedRuntime = matchingRuntimes[0] as NativeRuntime;
  const devices = await processAdapter.run("xcrun", ["simctl", "list", "devices", "--json"]); if (devices.kind !== "ok") return error("failed to list simulators with simctl");
  let candidates: Result<NativeCandidate[]>;
  try { candidates = candidatesForRuntimeFromSimctl(JSON.parse(devices.value.stdout), kind.value, selectedRuntime.version); } catch { return error("simctl returned invalid device data"); }
  if (candidates.kind !== "ok") return candidates;
  const selected = selectDevice(kind.value, candidates.value, "", false); if (selected.kind !== "ok") return selected;
  const boot = await processAdapter.run("xcrun", ["simctl", "boot", selected.value.udid]);
  if (boot.kind !== "ok" && !/already booted/i.test(boot.error)) return error(`failed to boot simulator ${selected.value.udid}: ${boot.error}`);
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
async function nativeRuntimeList(args: readonly string[], processAdapter: ProcessAdapter): Promise<Result<string>> {
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
  const json = args.includes("--json");
  if (installed) {
    const result = await installedRuntimes(processAdapter); if (result.kind !== "ok") return result;
    const runtimes = platform ? result.value.filter((runtime) => runtime.platform === platform) : result.value;
    return ok(json ? `${JSON.stringify({ platform: platform ?? "all", runtimes, available: [] })}\n` : runtimes.map((runtime) => `${runtime.platform}\t${runtime.version}\t${runtime.build}\t${runtime.identifier}`).join("\n") + "\n");
  }
  const availableVersions: { platform: NativePlatform; version: string }[] = [];
  return ok(json ? `${JSON.stringify({ platform: platform ?? "all", runtimes: [], available: availableVersions })}\n` : availableVersions.length === 0 ? "no known runtime versions are available for download\n" : availableVersions.map((entry) => `${entry.platform}\t${entry.version}`).join("\n") + "\n");
}
async function nativeRuntimeInstall(args: readonly string[], processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeUsage("runtime-install"));
  let platform: NativePlatform | undefined, version = "", json = false;
  for (const arg of args) { if (arg === "--json") json = true; else if (!platform) { const parsed = runtimePlatform(arg); if (parsed.kind !== "ok") return parsed; platform = parsed.value; } else if (!version) version = arg; else return error(`unknown native runtime install option: ${arg}`, 2); }
  if (!platform || !version) return error("native runtime install requires <platform> <version>", 2);
  const download = await processAdapter.run("xcodebuild", ["-downloadPlatform", platform, "-buildVersion", version]);
  if (download.kind !== "ok") return error(`failed to download ${platform} ${version}: ${download.error}`);
  const installed = await installedRuntimes(processAdapter); if (installed.kind !== "ok") return installed;
  const match = installed.value.find((runtime) => runtime.platform === platform && runtime.version === version);
  if (!match) return error(`runtime download reported success, but simctl does not list ${platform} ${version}`);
  return ok(json ? `${JSON.stringify({ platform, version, build: match.build, identifier: match.identifier })}\n` : `installed ${platform} ${version} (${match.build})\n`);
}
async function nativeCrashes(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
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
  const inputs: CrashInput[] = [];
  const parseErrors: string[] = [];
  for (const file of files) {
    const path = resolve(directory, file);
    try {
      const contents = readFileSync(path, "utf8");
      inputs.push({ path, contents, modifiedAt: statSync(path).mtimeMs });
      const parsed = parseCrashReport(contents, target);
      if (parsed.kind === "invalid") parseErrors.push(`${file}: ${parsed.reason}`);
    } catch (cause) { parseErrors.push(`${file}: ${cause instanceof Error ? cause.message : "could not read file"}`); }
  }
  const selected = selectCrashReports(inputs, target, last.value);
  const stderr = parseErrors.map((message) => `megabrain: ${message}\n`).join("");
  if (selected.length === 0) return { kind: "ok", value: args.includes("--json") ? `${JSON.stringify({ reports: [], noReports: true })}\n` : `no crash reports found for ${target}\n`, stderr };
  if (args.includes("--json")) return { kind: "ok", value: `${JSON.stringify({ reports: selected.map((entry) => ({ file: entry.path, ...entry.value })), noReports: false })}\n`, stderr };
  const value = selected.map((entry) => {
    const report = entry.value;
    return `${entry.path}\n${report.exceptionType}${report.signal ? ` (${report.signal})` : ""}${report.termination ? `\n${report.termination}` : ""}\n${report.frames.slice(0, 5).map((frame) => `  ${frame}`).join("\n")}\n`;
  }).join("\n");
  return { kind: "ok", value, stderr };
}
function unknownProcess(reason: string): NativeHealth["process"] { return { state: "unknown", reason }; }
function unknownMetro(reason: string): NativeHealth["metro"] { return { state: "unknown", reason }; }
function unknownTree(reason: string): NativeHealth["tree"] { return { count: null, reason }; }
function unknownFrame(reason: string): NativeHealth["frame"] { return { state: "unknown", reason }; }
const APPIUM_SESSION_DEFAULTS = {
  "appium:automationName": "XCUITest",
  "appium:isHeadless": true,
  "appium:newCommandTimeout": 60,
} as const;
function appiumSessionCapabilities(platform: NativePlatform, udid: string, bundleId: string): Record<string, string | boolean | number> {
  return { platformName: platform, ...APPIUM_SESSION_DEFAULTS, "appium:udid": udid, "appium:bundleId": bundleId };
}
type AppiumSession = Readonly<{ sessionId: string; stored: boolean }>;
type AppiumSessionAttempt = Readonly<{ session?: AppiumSession; reason?: string }>;
type AppiumResponse = Readonly<{ status: number; body: string }>;
function appiumResponse(stdout: string): AppiumResponse | undefined {
  const status = stdout.match(/(?:^|\n)(\d{3})\s*$/);
  if (status === null || status.index === undefined) return undefined;
  return { status: Number(status[1]), body: stdout.slice(0, status.index) };
}
function appiumMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; value?: { message?: unknown } };
    const message = parsed.value?.message ?? parsed.message;
    return typeof message === "string" && message.length > 0 ? message : undefined;
  } catch {
    const message = body.trim();
    return message.length > 0 ? message : undefined;
  }
}
function appiumHttpFailure(action: string, response: AppiumResponse): string {
  const message = appiumMessage(response.body);
  return `${action} (HTTP ${response.status})${message ? `: ${message}` : ""}`;
}
async function createAppiumSession(processAdapter: ProcessAdapter, key: NativeSessionKey, platform: NativePlatform): Promise<Result<string>> {
  const session = await processAdapter.run("curl", ["-sS", "-w", "\n%{http_code}", "-X", "POST", "http://127.0.0.1:4723/session", "-H", "Content-Type: application/json", "-d", JSON.stringify({ capabilities: { alwaysMatch: appiumSessionCapabilities(platform, key.udid, key.bundleId) } })]);
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
async function appiumSession(environment: Environment, processAdapter: ProcessAdapter, key: NativeSessionKey, platform: NativePlatform): Promise<Result<AppiumSessionAttempt>> {
  const store = createNativeSessionStore(environment);
  if (!store.available) {
    const sessionId = await createAppiumSession(processAdapter, key, platform);
    return sessionId.kind === "ok" ? ok({ session: { sessionId: sessionId.value, stored: false } }) : ok({ reason: sessionId.error });
  }
  return store.update<AppiumSessionAttempt>(async (sessions) => {
    const recorded = nativeSessionFor(sessions, key);
    let current = sessions;
    if (recorded !== undefined) {
      const probe = await processAdapter.run("curl", ["-fsS", `http://127.0.0.1:4723/session/${recorded.sessionId}`]);
      if (probe.kind === "ok") return { sessions, value: { sessionId: recorded.sessionId, stored: true } };
      current = removeNativeSession(sessions, key);
    }
    const sessionId = await createAppiumSession(processAdapter, key, platform);
    if (sessionId.kind !== "ok") return { sessions: current, value: { reason: sessionId.error } };
    return { sessions: replaceNativeSession(current, { ...key, sessionId: sessionId.value }), value: { session: { sessionId: sessionId.value, stored: true } } };
  });
}
async function nativeHealth(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
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
    const source = await processAdapter.run("curl", ["-sS", "-w", "\n%{http_code}", `http://127.0.0.1:4723/session/${activeSession.sessionId}/source`]);
    if (source.kind !== "ok") tree = unknownTree(`Appium source request failed: ${source.error}`);
    else {
      const response = appiumResponse(source.value.stdout);
      if (response === undefined) tree = unknownTree("Appium source request failed: response did not include an HTTP status");
      else if (response.status < 200 || response.status >= 300) tree = unknownTree(appiumHttpFailure("Appium source request", response));
      else tree = { count: (response.body.match(/<XCUIElementType[A-Za-z0-9]+\b/g) ?? []).length };
    }
    if (!activeSession.stored) await processAdapter.run("curl", ["-fsS", "-X", "DELETE", `http://127.0.0.1:4723/session/${activeSession.sessionId}`]);
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
  return args.includes("--json") ? ok(`${JSON.stringify(result)}\n`) : ok(`${result.status}: ${result.reason}\nprocess=${result.process.state}; metro=${result.metro.state}; tree=${result.tree.count ?? "unknown"}; frame=${result.frame.state}\n`);
}
async function nativeList(args: readonly string[], processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(nativeUsage("list"));
  let json = false;
  for (const arg of args.slice(1)) { if (arg === "--json") json = true; else if (arg === "-h" || arg === "--help") return ok(nativeUsage("list")); else return error(`unknown native sim list option: ${arg}`, 2); }
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  const candidates = await simCandidates(processAdapter, kind.value); if (candidates.kind !== "ok") return candidates;
  return ok(formatNativeList(kind.value, candidates.value, json));
}
async function nativeEnsure(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
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
  }
  for (let attempt = 0; attempt < timeout.value * 5; attempt += 1) {
    const current = await simCandidates(processAdapter, kind.value); if (current.kind !== "ok") return current;
    const state = current.value.find((candidate) => candidate.udid === selected.value.udid)?.state;
    if (state === "Booted") return args.includes("--json") ? ok(`${JSON.stringify({ ok: true, kind: kind.value, device: selected.value.udid, state: "Booted" })}\n`) : ok(`simulator ${selected.value.udid} is booted\n`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  return error(`timed out waiting for simulator ${selected.value.udid} to become booted`);
}
async function nativeReload(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
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
  return args.includes("--json") ? ok(`${JSON.stringify({ ok: true, kind: kind.value, device: selected.value.udid, bundleId, url: url.value, terminated: true, opened: true, renderObserved: false })}\n`) : ok(`reloaded ${bundleId} on simulator ${selected.value.udid}: terminated and opened ${url.value}; app rendering was not observed\n`);
}

function runtimeValue(value: unknown): string {
  if (value === undefined) return "undefined\n";
  try { return `${JSON.stringify(value)}\n`; } catch { return `${String(value)}\n`; }
}
function formatEvaluation(evaluation: MetroEvaluation, json: boolean): Result<string> {
  if (json) {
    const value = evaluation.kind === "value" ? evaluation.value : null;
    const exception = evaluation.kind === "exception" ? evaluation.message : null;
    return ok(`${JSON.stringify({ value, exception })}\n`);
  }
  return evaluation.kind === "exception" ? ok(`expression threw: ${evaluation.message}\n`) : ok(runtimeValue(evaluation.value));
}
function cdpArguments(args: readonly string[], environment: Environment): Result<{ kind: NativeKind; timeoutMs: number; expression: string }> {
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
async function nativeEval(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok("Usage: megabrain native eval <phone|tv> <expression> [--metro-port <p>] [--timeout <s>] [--json]\n");
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
const routerModuleExpression = `(() => {
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
const routeInfoExpression = `(() => {
  const modules = ${routerModuleExpression};
  const route = modules.store.getRouteInfo();
  return { pathname: route.pathname, params: route.params };
})() /* megabrain:route-info */`;
const navigationQueueExpression = `(() => {
  const modules = ${routerModuleExpression};
  const queue = modules.routingQueue.snapshot();
  return Array.isArray(queue) ? queue.length : -1;
})() /* megabrain:navigation-queue */`;
function navigationExpression(path: string): string {
  return `(() => {
    const modules = ${routerModuleExpression};
    if (modules.router.canDismiss()) modules.router.dismissAll();
    modules.router.navigate(${JSON.stringify(path)});
  })() /* megabrain:navigate */`;
}
type RouteSnapshot = Readonly<{ pathname: string; params: unknown }>;
type NativeNavigationResult = Readonly<{ after: RouteSnapshot }>;
function routeSnapshot(value: unknown): RouteSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as { pathname?: unknown; params?: unknown };
  if (typeof item.pathname !== "string") return undefined;
  return { pathname: item.pathname, params: item.params ?? {} };
}
function routeChanged(before: RouteSnapshot, after: RouteSnapshot): boolean {
  return before.pathname !== after.pathname || JSON.stringify(before.params) !== JSON.stringify(after.params);
}
function nativeNavigationResult(value: string): Result<NativeNavigationResult> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return error("native navigate returned invalid JSON");
    const after = routeSnapshot((parsed as { after?: unknown }).after);
    return after === undefined ? error("native navigate returned invalid route data") : ok({ after });
  } catch {
    return error("native navigate returned invalid JSON");
  }
}
function pendingNavigationCount(message: string): number | undefined {
  const match = /\((\d+) pending actions\)/.exec(message);
  return match === null ? undefined : Number(match[1]);
}
async function nativeNavigate(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok("Usage: megabrain native navigate <phone|tv> <path> [--metro-port <p>] [--timeout <s>] [--json]\n");
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

function nativeCaptureScreens(args: readonly string[]): Result<NativeCaptureScreen[]> {
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

function uniqueCaptureScreens(screens: NativeCaptureScreen[]): Result<NativeCaptureScreen[]> {
  const names = new Set<string>();
  for (const screen of screens) {
    if (names.has(screen.name)) return error(`native capture screen names must be unique: ${screen.name}`, 2);
    names.add(screen.name);
  }
  return ok(screens);
}

function captureOptionNames(): ReadonlySet<string> {
  return new Set(["--screens", "--screen", "--route", "--output-root", "--surface", "--capture-id", "--theme", "--viewport", "--device", "--bundle-id", "--metro-port", "--timeout"]);
}

function validateCaptureOptions(args: readonly string[]): Result<void> {
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

async function resetNativeCaptureApp(processAdapter: ProcessAdapter, udid: string, bundleId: string, metroPort: number, timeoutMs: number): Promise<Result<void>> {
  const deadline = Date.now() + timeoutMs;
  const terminate = await processAdapter.run("xcrun", ["simctl", "terminate", udid, bundleId]);
  if (terminate.kind !== "ok" && !/not running|no such process|does not exist|not found|nothing to terminate/i.test(terminate.error)) {
    return error(`failed to terminate ${bundleId} on simulator ${udid}: ${terminate.error}`);
  }
  const launch = await processAdapter.run("xcrun", ["simctl", "launch", udid, bundleId]);
  if (launch.kind !== "ok") return error(`failed to relaunch ${bundleId} on simulator ${udid}: ${launch.error}`);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return error(`failed to reset ${bundleId} on simulator ${udid}: Metro inspector target was not ready within ${timeoutMs}ms`);
  const target = await waitForMetroInspectorTarget(metroPort, remaining);
  if (target.kind !== "ok") return error(`failed to reset ${bundleId} on simulator ${udid}: ${target.error}`);
  return ok(undefined);
}

async function captureNativeFrame(processAdapter: ProcessAdapter, udid: string, path: string): Promise<Result<string>> {
  const capture = await processAdapter.run("xcrun", ["simctl", "io", udid, "screenshot", path]);
  if (capture.kind !== "ok") return error(`failed to capture simulator frame: ${capture.error}`);
  const hash = await processAdapter.run("shasum", ["-a", "256", path]);
  if (hash.kind !== "ok") return error(`failed to hash simulator frame: ${hash.error}`);
  const value = hash.value.stdout.trim().split(/\s+/)[0] ?? "";
  return value.length > 0 ? ok(value) : error("failed to hash simulator frame: shasum returned no hash");
}

async function settleNativeFrame(processAdapter: ProcessAdapter, udid: string, path: string, timeoutMs: number): Promise<Result<string>> {
  const deadline = Date.now() + timeoutMs;
  let previousHash: string | undefined;
  while (Date.now() < deadline) {
    const frame = await captureNativeFrame(processAdapter, udid, path);
    if (frame.kind !== "ok") return frame;
    if (frame.value === previousHash) return frame;
    previousHash = frame.value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(50, remaining)));
  }
  return error(`frame did not settle within ${timeoutMs}ms`);
}

function captureNavigationArgs(kind: NativeKind, route: string, metroPort: string, timeout: string): string[] {
  return [kind, route, "--metro-port", metroPort, "--timeout", timeout];
}

async function nativeCapture(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
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
  const frameRecords: NativeCaptureRecord[] = [];
  const screenErrors: string[] = [];
  let previousPendingFailureCount: number | undefined;
  let earlyStopReason: string | undefined;
  const recordNavigationFailure = (screen: NativeCaptureScreen, message: string, remainingScreens: readonly NativeCaptureScreen[]): boolean => {
    screenErrors.push(`screen ${screen.name}: navigation failed: ${message}`);
    const pendingCount = pendingNavigationCount(message);
    if (pendingCount === undefined) {
      previousPendingFailureCount = undefined;
      return false;
    }
    if (previousPendingFailureCount !== undefined && pendingCount >= previousPendingFailureCount) {
      earlyStopReason = `capture stopped early after screen ${screen.name}: pending navigation queue did not drain (${pendingCount} pending actions; previous failure had ${previousPendingFailureCount}); screens not attempted: ${remainingScreens.length > 0 ? remainingScreens.map((item) => item.name).join(", ") : "none"}`;
      screenErrors.push(earlyStopReason);
      return true;
    }
    previousPendingFailureCount = pendingCount;
    return false;
  };
  try {
    tempDirectory = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const controlPath = join(tempDirectory, "control.png");
    const control = await captureNativeFrame(processAdapter, selected.value.udid, controlPath);
    if (control.kind !== "ok") return control;
    for (let index = 0; index < screens.value.length; index += 1) {
      const screen = screens.value[index] as NativeCaptureScreen;
      let paths;
      try { paths = buildNativeCapturePaths({ outputRoot, surface, captureId, theme, viewport, screen: screen.name }); }
      catch (cause: unknown) { screenErrors.push(`screen ${screen.name}: ${cause instanceof Error ? cause.message : "invalid output path"}`); continue; }
      manifestPath = paths.manifest;
      const reset = await resetNativeCaptureApp(processAdapter, selected.value.udid, bundleId, Number(validPort.value), timeout.value * 1000);
      if (reset.kind !== "ok") { screenErrors.push(`screen ${screen.name}: reset failed: ${reset.error}`); continue; }
      const navigation = await nativeNavigate([...captureNavigationArgs(kind.value, screen.route, validPort.value, String(timeout.value)), "--json"], environment, processAdapter);
      if (navigation.kind !== "ok") {
        if (recordNavigationFailure(screen, navigation.error, screens.value.slice(index + 1))) break;
        continue;
      }
      previousPendingFailureCount = undefined;
      const navigationResult = nativeNavigationResult(navigation.value);
      if (navigationResult.kind !== "ok") { screenErrors.push(`screen ${screen.name}: navigation failed: ${navigationResult.error}`); previousPendingFailureCount = undefined; continue; }
      let reachedPathname = navigationResult.value.after.pathname;
      let framePath = join(tempDirectory, `screen-${index}.png`);
      let frame = await settleNativeFrame(processAdapter, selected.value.udid, framePath, timeout.value * 1000);
      if (frame.kind !== "ok") { screenErrors.push(`screen ${screen.name}: ${frame.error}`); continue; }
      let hash = frame.value;
      if (hash === control.value) {
        frameRecords.push(buildNativeCaptureRecord({ paths, name: screen.name, hash, requestedRoute: screen.route, reachedPathname }));
        screenErrors.push(`screen ${screen.name}: frame matches the control frame`);
        continue;
      }
      const previousHash = frameRecords.at(-1)?.hash;
      if (previousHash !== undefined && hash === previousHash) {
        const retryReset = await resetNativeCaptureApp(processAdapter, selected.value.udid, bundleId, Number(validPort.value), timeout.value * 1000);
        if (retryReset.kind !== "ok") { frameRecords.push(buildNativeCaptureRecord({ paths, name: screen.name, hash, requestedRoute: screen.route, reachedPathname })); screenErrors.push(`screen ${screen.name}: duplicate retry failed: ${retryReset.error}`); continue; }
        const retryNavigation = await nativeNavigate([...captureNavigationArgs(kind.value, screen.route, validPort.value, String(timeout.value)), "--json"], environment, processAdapter);
        if (retryNavigation.kind !== "ok") {
          frameRecords.push(buildNativeCaptureRecord({ paths, name: screen.name, hash, requestedRoute: screen.route, reachedPathname }));
          if (recordNavigationFailure(screen, `duplicate retry failed: ${retryNavigation.error}`, screens.value.slice(index + 1))) break;
          continue;
        }
        const retryNavigationResult = nativeNavigationResult(retryNavigation.value);
        if (retryNavigationResult.kind !== "ok") { frameRecords.push(buildNativeCaptureRecord({ paths, name: screen.name, hash, requestedRoute: screen.route, reachedPathname })); screenErrors.push(`screen ${screen.name}: duplicate retry navigation failed: ${retryNavigationResult.error}`); previousPendingFailureCount = undefined; continue; }
        reachedPathname = retryNavigationResult.value.after.pathname;
        framePath = join(tempDirectory, `screen-${index}-retry.png`);
        frame = await settleNativeFrame(processAdapter, selected.value.udid, framePath, timeout.value * 1000);
        if (frame.kind !== "ok") { frameRecords.push(buildNativeCaptureRecord({ paths, name: screen.name, hash, requestedRoute: screen.route, reachedPathname })); screenErrors.push(`screen ${screen.name}: duplicate retry failed: ${frame.error}`); continue; }
        hash = frame.value;
        if (hash === control.value) {
          frameRecords.push(buildNativeCaptureRecord({ paths, name: screen.name, hash, requestedRoute: screen.route, reachedPathname }));
          screenErrors.push(`screen ${screen.name}: retry frame matches the control frame`);
          continue;
        }
        if (hash === previousHash) {
          frameRecords.push(buildNativeCaptureRecord({ paths, name: screen.name, hash, requestedRoute: screen.route, reachedPathname }));
          screenErrors.push(`screen ${screen.name}: frame duplicates the previous screen after retry`);
          continue;
        }
      }
      await mkdir(dirname(paths.image), { recursive: true });
      await rename(framePath, paths.image);
      frameRecords.push(buildNativeCaptureRecord({ paths, name: screen.name, hash, requestedRoute: screen.route, reachedPathname }));
    }
    const outcome = decideCaptureOutcome({ controlHash: control.value, screens: frameRecords });
    const captureOutcome = earlyStopReason === undefined ? outcome : { ...outcome, summary: `${outcome.summary}; ${earlyStopReason}` };
    const failureReasons = [...outcome.failureReasons, ...screenErrors];
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
      screens: frameRecords,
      summary: captureOutcome.summary,
      failures: failureReasons,
    }, null, 2)}\n`);
    const failedRun = captureOutcome.failed || screenErrors.length > 0;
    const report = args.includes("--json")
      ? `${JSON.stringify({ ok: !failedRun, ...captureOutcome, failureReasons, manifest: manifestPath, screens: frameRecords })}\n`
      : `${captureOutcome.summary}\n${failureReasons.map((reason) => `failed: ${reason}`).join("\n")}${failureReasons.length > 0 ? "\n" : ""}`;
    return ok(report, failedRun ? 1 : undefined);
  } finally {
    if (tempDirectory.length > 0) await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function appium(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
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
export async function executeNative(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  const [family, operation, ...rest] = args;
  if (family === "-h" || family === "--help" || family === undefined) return ok(nativeUsage("native"));
  const json = args.includes("--json");
  let result: Result<string>;
  if (family === "appium") result = await appium([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "build") result = await nativeBuild([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "runtime" && operation === "list") result = await nativeRuntimeList(rest, processAdapter);
  else if (family === "runtime" && operation === "install") result = await nativeRuntimeInstall(rest, processAdapter);
  else if (family === "sim" && operation === "list") result = await nativeList(rest, processAdapter);
  else if (family === "sim" && operation === "ensure") result = await nativeEnsure(rest, environment, processAdapter);
  else if (family === "health") result = await nativeHealth([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "crashes") result = await nativeCrashes([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "eval") result = await nativeEval([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "navigate") result = await nativeNavigate([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "capture") result = await nativeCapture([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "app" && operation === "reload") result = await nativeReload(rest, environment, processAdapter);
  else if (family === "sim" && (operation === undefined || operation === "-h" || operation === "--help")) result = ok(`${nativeUsage("list")}${nativeUsage("ensure")}`);
  else if (family === "app" && (operation === undefined || operation === "-h" || operation === "--help")) result = ok(nativeUsage("reload"));
  else result = error(`unknown native command: ${family}`, 2);
  return normalizeJsonResult(result, json);
}
