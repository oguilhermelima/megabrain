import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { candidatesFromSimctl, evaluateNativeHealth, formatNativeList, nativeUsage, renderNativeUrl, runtimeFactId, runtimesFromSimctl, selectDevice, validateKind, validateMetroPort, validateTimeout, type NativeCandidate, type NativeHealth, type NativeKind, type NativePlatform, type NativeRuntime } from "../../core/native.js";
import { validateStore, type FactStore } from "../../core/facts.js";
import { failed, ok, type Result } from "../../core/result.js";
import { parseCrashReport, selectCrashReports, validateCrashLast, type CrashInput } from "../../core/crash.js";

export type Environment = Readonly<Record<string, string | undefined>>;
type Config = { readonly surfaces?: Record<string, Record<string, string>> };

function error(message: string, code = 1): Result<string> { return failed(message, code); }
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
function config(environment: Environment): Result<Config> {
  const file = resolve(environment.MEGABRAIN_NATIVE_WORKTREE ?? process.cwd(), ".megabrain/native.json");
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
function runtimeFactPath(environment: Environment): string {
  return environment.MEGABRAIN_FACTS_FILE ?? resolve(environment.MEGABRAIN_ROOT ?? process.cwd(), ".megabrain/facts.json");
}
function knownRuntimeVersions(environment: Environment, platform: NativePlatform): Result<string[]> {
  const path = runtimeFactPath(environment);
  if (!existsSync(path)) return ok([]);
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const valid = validateStore(value);
    if (valid.kind !== "valid") return error(valid.message);
    const prefix = `native-runtime-${platform.toLowerCase()}-`;
    return ok((value as FactStore).facts.filter((fact) => fact.id.startsWith(prefix)).map((fact) => fact.id.slice(prefix.length).replaceAll("-", ".")));
  } catch { return error(`could not read fact store: ${path}`); }
}
async function installedRuntimes(processAdapter: ProcessAdapter): Promise<Result<NativeRuntime[]>> {
  const result = await processAdapter.run("xcrun", ["simctl", "list", "runtimes", "--json"]);
  if (result.kind !== "ok") return error("failed to list runtimes with simctl");
  try { return runtimesFromSimctl(JSON.parse(result.value.stdout)); } catch { return error("simctl returned invalid runtime data"); }
}
async function nativeRuntimeList(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
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
  const platforms: NativePlatform[] = platform ? [platform] : ["iOS", "tvOS"];
  const versions = (await Promise.all(platforms.map(async (item) => ({ platform: item, versions: knownRuntimeVersions(environment, item) }))));
  const bad = versions.find((entry) => entry.versions.kind !== "ok"); if (bad && bad.versions.kind !== "ok") return bad.versions;
  const availableVersions = versions.flatMap((entry) => entry.versions.kind === "ok" ? entry.versions.value.map((version) => ({ platform: entry.platform, version })) : []);
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
function nativeCrashes(args: readonly string[], environment: Environment): Result<string> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeUsage("crashes"));
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  const loaded = config(environment); if (loaded.kind !== "ok") return loaded;
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
const APPIUM_SESSION_DEFAULTS = { "appium:isHeadless": true } as const;
function appiumSessionCapabilities(udid: string, bundleId: string): Record<string, string | boolean> {
  return { platformName: "iOS", ...APPIUM_SESSION_DEFAULTS, "appium:udid": udid, "appium:bundleId": bundleId };
}
async function nativeHealth(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(nativeUsage("health"));
  const kind = parseKind(args); if (kind.kind !== "ok") return kind;
  const loaded = config(environment); if (loaded.kind !== "ok") return loaded;
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
  const session = await processAdapter.run("curl", ["-fsS", "-X", "POST", "http://127.0.0.1:4723/session", "-H", "Content-Type: application/json", "-d", JSON.stringify({ capabilities: { alwaysMatch: appiumSessionCapabilities(udid, bundleId) } })]);
  if (session.kind === "ok") {
    try {
      const value = JSON.parse(session.value.stdout) as { sessionId?: string; value?: { sessionId?: string } };
      const sessionId = value.sessionId ?? value.value?.sessionId;
      if (sessionId) {
        const source = await processAdapter.run("curl", ["-fsS", `http://127.0.0.1:4723/session/${sessionId}/source`]);
        if (source.kind === "ok") tree = { count: (source.value.stdout.match(/<XCUIElementType[A-Za-z0-9]+\b/g) ?? []).length };
        await processAdapter.run("curl", ["-fsS", "-X", "DELETE", `http://127.0.0.1:4723/session/${sessionId}`]);
      }
    } catch { tree = unknownTree("Appium returned invalid session data"); }
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
  const loaded = config(environment); if (loaded.kind !== "ok") return loaded;
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
  const loaded = config(environment); if (loaded.kind !== "ok") return loaded;
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
  else if (family === "runtime" && operation === "list") result = await nativeRuntimeList(rest, environment, processAdapter);
  else if (family === "runtime" && operation === "install") result = await nativeRuntimeInstall(rest, processAdapter);
  else if (family === "sim" && operation === "list") result = await nativeList(rest, processAdapter);
  else if (family === "sim" && operation === "ensure") result = await nativeEnsure(rest, environment, processAdapter);
  else if (family === "health") result = await nativeHealth([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  else if (family === "crashes") result = nativeCrashes([operation ?? "", ...rest].filter((value) => value !== ""), environment);
  else if (family === "app" && operation === "reload") result = await nativeReload(rest, environment, processAdapter);
  else if (family === "sim" && (operation === undefined || operation === "-h" || operation === "--help")) result = ok(`${nativeUsage("list")}${nativeUsage("ensure")}`);
  else if (family === "app" && (operation === undefined || operation === "-h" || operation === "--help")) result = ok(nativeUsage("reload"));
  else result = error(`unknown native command: ${family}`, 2);
  return normalizeJsonResult(result, json);
}
