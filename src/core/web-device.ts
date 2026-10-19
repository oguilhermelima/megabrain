import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";
import { selfInvocation } from "./self-invocation.js";
import { resolveStateDirectory } from "./state.js";
import { failed, ok, type Result } from "./result.js";
import { usageText } from "./usage.js";

export type WebDevice = Readonly<{ id: string; kind: "web"; url: string; title: string; width: number; height: number; scale: number; streamUrl: string }>;
export type WebDeviceRecord = WebDevice & Readonly<{ pid: number; preset?: string }>;
type Environment = Readonly<Record<string, string | undefined>>;

const directory = (env: Environment) => join(resolveStateDirectory(env), "web-devices");
const recordPath = (env: Environment, id: string) => join(directory(env), `${id}.json`);

export function readWebDevices(env: Environment): WebDeviceRecord[] {
  const root = directory(env);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => /^web-[a-f0-9-]+\.json$/i.test(name)).flatMap((name) => {
    try {
      const item = JSON.parse(readFileSync(join(root, name), "utf8")) as WebDeviceRecord;
      return item.kind === "web" && item.id === name.slice(0, -5) && /^web-[a-f0-9-]+$/i.test(item.id) &&
        typeof item.url === "string" && typeof item.title === "string" && Number.isInteger(item.width) && item.width > 0 &&
        Number.isInteger(item.height) && item.height > 0 && Number.isFinite(item.scale) && item.scale > 0 &&
        Number.isInteger(item.pid) && item.pid > 0 && (item.preset === undefined || typeof item.preset === "string") && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.streamUrl) && processAlive(item.pid) ? [item] : [];
    } catch { return []; }
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function processAlive(pid: number): boolean { try { globalThis.process.kill(pid, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; } }

function writeRecord(env: Environment, record: WebDeviceRecord): void {
  mkdirSync(directory(env), { recursive: true });
  const file = recordPath(env, record.id);
  const temporary = `${file}.${globalThis.process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function webDeviceInputOperation(args: readonly string[]): Record<string, unknown> | undefined {
  const [action, ...rest] = args;
  if (action === "tap" && rest.length === 2 && rest.every(validCoordinate)) return { action, args: rest.map(Number) };
  if (action === "swipe") {
    const durationIndex = rest.indexOf("--ms");
    const coordinates = durationIndex < 0 ? rest : rest.filter((_, i) => i !== durationIndex && i !== durationIndex + 1);
    const duration = durationIndex < 0 ? 500 : Number(rest[durationIndex + 1]);
    if (coordinates.length === 4 && coordinates.every(validCoordinate) && Number.isInteger(duration) && duration > 0 && duration <= 60_000)
      return { action, args: coordinates.map(Number), ms: duration };
  }
  if (action === "scroll" && rest.length === 4 && rest.slice(0, 2).every(validCoordinate) && rest.slice(2).every(validNumber)) return { action, args: rest.map(Number) };
  if (action === "type" && rest.length > 0) return { action, text: rest.join(" ") };
  if (action === "key" && rest.length === 1 && rest[0] !== "") return { action, key: rest[0] };
  if (action === "navigate" && rest.length === 1 && validUrl(rest[0]!)) return { action, url: rest[0] };
  if (["back", "forward", "reload"].includes(action ?? "") && rest.length === 0) return { action };
  return undefined;
}

function validCoordinate(value: string): boolean { const number = Number(value); return value.trim() !== "" && Number.isFinite(number) && number >= 0; }
function validNumber(value: string): boolean { return value.trim() !== "" && Number.isFinite(Number(value)); }
function validUrl(value: string): boolean { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol); } catch { return false; } }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function parseOptions(args: readonly string[], names: readonly string[]): { values: Record<string, string>; positional: string[]; json: boolean } | undefined {
  const values: Record<string, string> = {}; const positional: string[] = []; let outputJson = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") outputJson = true;
    else if (names.includes(arg)) { const value = args[++i]; if (!value || value.startsWith("--")) return undefined; values[arg] = value; }
    else if (arg.startsWith("-")) return undefined;
    else positional.push(arg);
  }
  return { values, positional, json: outputJson };
}

async function waitForDevice(env: Environment, id: string, timeoutMs = 20_000): Promise<WebDeviceRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readWebDevices(env).find((device) => device.id === id);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function post(url: string, value?: unknown): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { method: "POST", ...(value === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }), signal: AbortSignal.timeout(5_000) });
  return { status: response.status, body: await response.text() };
}

export async function executeWebDevice(args: readonly string[], env: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const [verb, ...rest] = args;
  if (verb === undefined || verb === "--help" || verb === "-h") return ok(`${usageText("web-device")}\n`);
  if (rest.includes("--help") || rest.includes("-h")) {
    const key = `web-device-${verb}` as keyof typeof import("./usage.js").USAGE_LINES;
    try { return ok(`${usageText(key)}\n`); } catch { return ok(`${usageText("web-device")}\n`); }
  }
  if (verb === "list") {
    if (rest.some((arg) => arg !== "--json")) return failed("usage: megabrain web device list [--json]", 2);
    const devices = readWebDevices(env).map(({ pid: _pid, ...device }) => device);
    return ok(rest.includes("--json") ? json({ devices }) : `${devices.map((d) => `${d.id}\t${d.title}\t${d.url}`).join("\n")}${devices.length ? "\n" : ""}`);
  }
  if (verb === "start") {
    if (rest.includes("--worker")) return await runWebDeviceWorker(rest.filter((arg) => arg !== "--worker"), env);
    const parsed = parseOptions(rest, ["--url", "--device", "--worktree"]);
    if (!parsed || parsed.positional.length || !parsed.values["--url"] || !validUrl(parsed.values["--url"]!)) return failed("usage: megabrain web device start --url <url> [--device <slug>] [--worktree <path>] [--json]", 2);
    const duplicate = readWebDevices(env).find((item) => item.url === parsed.values["--url"] && item.preset === parsed.values["--device"]);
    if (duplicate) { const { pid: _pid, preset: _preset, ...device } = duplicate; return { kind: "ok", value: parsed.json ? json(device) : `${duplicate.id}\t${duplicate.streamUrl}\n` }; }
    const id = `web-${randomUUID()}`;
    const invocation = selfInvocation(globalThis.process.execPath, globalThis.process.argv, ["web", "device", "start", "--worker", "--id", id, "--url", parsed.values["--url"]!, ...(parsed.values["--device"] ? ["--device", parsed.values["--device"]!] : [])]);
    const started = await process.startDetached(invocation.command, invocation.args, {
      ...(parsed.values["--worktree"] ? { cwd: parsed.values["--worktree"] } : {}),
      env: {
        MEGABRAIN_STATE_DIR: resolveStateDirectory(env),
        ...Object.fromEntries(["HOME", "MEGABRAIN_PLAYWRIGHT_ROOT", "MEGABRAIN_ROOT"].flatMap((key) => env[key] ? [[key, env[key]!]] : [])),
      },
    });
    if (started.kind !== "ok") return failed(`could not start web device: ${started.error}`);
    const record = await waitForDevice(env, id);
    if (!record) { try { globalThis.process.kill(-started.value.pid, "SIGTERM"); } catch { try { globalThis.process.kill(started.value.pid, "SIGTERM"); } catch {} } return failed(`web device ${id} did not become ready within 20 seconds`); }
    const { pid: _pid, preset: _preset, ...device } = record;
    return ok(parsed.json ? json(device) : `${device.id}\t${device.streamUrl}\n`);
  }
  if (verb === "stop" || verb === "input") {
    const id = rest[0];
    if (!id || !/^web-[a-f0-9-]+$/i.test(id)) return failed(`usage: megabrain web device ${verb} <id>${verb === "input" ? " <action> ..." : ""} [--json]`, 2);
    const record = readWebDevices(env).find((item) => item.id === id);
    if (!record) return failed(`web device not found: ${id}`);
    const base = record.streamUrl;
    if (verb === "stop") {
      const stopped = await post(new URL("__stop", base).toString());
      if (stopped.status !== 200) return failed(`could not stop web device ${id}: ${stopped.body}`);
      try { unlinkSync(recordPath(env, id)); } catch {}
      return ok(rest.includes("--json") ? json({ id, stopped: true }) : `stopped ${id}\n`);
    }
    const operation = webDeviceInputOperation(rest.slice(1).filter((arg) => arg !== "--json"));
    if (!operation) return failed("invalid web device input; expected tap|swipe|scroll|type|key|navigate|back|forward|reload", 2);
    const response = await post(new URL("__input", base).toString(), operation);
    if (response.status !== 200) return failed(response.body || `web device input failed (HTTP ${response.status})`);
    return ok(`${response.body.trim()}\n`);
  }
  return failed("web device requires start|list|stop|input", 2);
}

export async function runWebDeviceWorker(args: readonly string[], env: Environment): Promise<Result<string>> {
  const parsed = parseOptions(args, ["--id", "--url", "--device"]);
  if (!parsed || parsed.positional.length || !parsed.values["--id"] || !parsed.values["--url"]) return failed("invalid web device worker arguments", 2);
  const { startWebDeviceHost } = await import("./web-device-host.js");
  return startWebDeviceHost({ id: parsed.values["--id"]!, url: parsed.values["--url"]!, device: parsed.values["--device"], env });
}
