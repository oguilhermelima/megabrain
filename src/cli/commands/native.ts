import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { candidatesFromSimctl, formatNativeList, nativeUsage, renderNativeUrl, selectDevice, validateKind, validateMetroPort, validateTimeout, type NativeCandidate, type NativeKind } from "../../core/native.js";
import { failed, ok, type Result } from "../../core/result.js";

export type Environment = Readonly<Record<string, string | undefined>>;
type Config = { readonly surfaces?: Record<string, Record<string, string>> };

function error(message: string, code = 1): Result<string> { return failed(message, code); }
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
  if (family === "appium") return appium([operation ?? "", ...rest].filter((value) => value !== ""), environment, processAdapter);
  if (family === "sim" && operation === "list") return nativeList(rest, processAdapter);
  if (family === "sim" && operation === "ensure") return nativeEnsure(rest, environment, processAdapter);
  if (family === "app" && operation === "reload") return nativeReload(rest, environment, processAdapter);
  if (family === "sim" && (operation === undefined || operation === "-h" || operation === "--help")) return ok(`${nativeUsage("list")}${nativeUsage("ensure")}`);
  if (family === "app" && (operation === undefined || operation === "-h" || operation === "--help")) return ok(nativeUsage("reload"));
  return error(`unknown native command: ${family}`, 2);
}
