import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessAdapter } from "../../../adapters/proc.js";
import { resolveStateDirectory } from "../../../core/state.js";
import { selfInvocation } from "../../../core/self-invocation.js";
import { failed, ok, type Result } from "../../../core/result.js";
import { usageText } from "../../../core/usage.js";
import { SIMULATOR_UDID, simCandidates } from "./index.js";
import type { Environment } from "./index.js";

type RecordEntry = { udid: string; session: string; platform: "iOS" | "tvOS"; pid: number; port: number; streamUrl: string; wsUrl: string; pointWidth?: number; pointHeight?: number };
type InputStatus = { udid: string; state: "none" | "starting" | "ready" | "failed"; phase: string; startedAt?: string; error?: string; session?: string; port?: number };
const stateFile = (env: Environment) => join(resolveStateDirectory(env), "native-input-sessions.json");
const statusFile = (env: Environment, udid: string) => join(resolveStateDirectory(env), "native-input", `${udid}.json`);
const lockFile = (env: Environment, udid: string) => join(resolveStateDirectory(env), "native-input", `${udid}.lock`);
function readStatus(env: Environment, udid: string): InputStatus | undefined {
  try { const value = JSON.parse(readFileSync(statusFile(env, udid), "utf8")) as InputStatus; return value.udid === udid ? value : undefined; } catch { return undefined; }
}
function writeStatus(env: Environment, value: InputStatus): void {
  const file = statusFile(env, value.udid); mkdirSync(join(resolveStateDirectory(env), "native-input"), { recursive: true });
  const tmp = `${file}.${globalThis.process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 }); renameSync(tmp, file);
}
function records(env: Environment): RecordEntry[] {
  try { const parsed = JSON.parse(readFileSync(stateFile(env), "utf8")) as { version?: number; sessions?: RecordEntry[] }; return parsed.version === 1 && Array.isArray(parsed.sessions) ? parsed.sessions : []; } catch { return []; }
}
function save(env: Environment, entries: RecordEntry[]): void {
  const file = stateFile(env); mkdirSync(resolveStateDirectory(env), { recursive: true });
  const tmp = `${file}.${globalThis.process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions: entries }, null, 2)}\n`, { mode: 0o600 }); renameSync(tmp, file);
}
function parseHelper(stdout: string, udid: string): Omit<RecordEntry, "platform"> | undefined {
  try {
    const value = JSON.parse(stdout) as Partial<RecordEntry> & { device?: string };
    if (value.device !== udid && value.udid !== udid) return undefined;
    if (typeof value.pid !== "number" || typeof value.port !== "number" || typeof value.streamUrl !== "string" || typeof value.wsUrl !== "string") return undefined;
    return { udid, session: String(value.pid), pid: value.pid, port: value.port, streamUrl: value.streamUrl, wsUrl: value.wsUrl };
  } catch { return undefined; }
}

export async function endNativeInputSession(_env: Environment, process: ProcessAdapter, udid: string): Promise<Result<void>> {
  const stopped = await process.run("serve-sim", ["--kill", udid]);
  return stopped.kind === "ok" ? ok(undefined) : failed(stopped.error);
}
async function helperState(process: ProcessAdapter, udid: string) {
  const result = await process.run("serve-sim", ["--list", udid]);
  return result.kind === "ok" ? parseHelper(result.value.stdout, udid) : undefined;
}
async function waitForInput(env: Environment, udid: string, timeoutSeconds: number): Promise<Result<string>> {
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    const status = readStatus(env, udid);
    if (status?.state === "ready") return ok(`${JSON.stringify({ udid, session: status.session, port: status.port })}\n`);
    if (status?.state === "failed") return failed(status.error ?? "native input session failed");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return failed(`timed out waiting for native input session ${udid}`);
}
async function frame(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok || response.body === null) throw new Error(`MJPEG stream returned HTTP ${response.status}`);
  const reader = response.body.getReader(); let bytes = Buffer.alloc(0);
  try {
    while (bytes.length < 8_000_000) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes = Buffer.concat([bytes, Buffer.from(chunk.value)]);
      const start = bytes.indexOf(Buffer.from([0xff, 0xd8]));
      const end = start < 0 ? -1 : bytes.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (start >= 0 && end >= 0) return bytes.subarray(start, end + 2);
    }
    throw new Error("MJPEG stream did not contain a complete JPEG frame");
  } finally { await reader.cancel().catch(() => undefined); }
}
function jpegSize(jpeg: Buffer): { width: number; height: number } | undefined {
  for (let offset = 2; offset + 9 < jpeg.length;) {
    if (jpeg[offset] !== 0xff) { offset += 1; continue; }
    const marker = jpeg[offset + 1]!; const length = jpeg.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) };
    if (length < 2) break; offset += length + 2;
  }
  return undefined;
}
async function sendWs(url: string, type: number, value?: unknown): Promise<void> {
  const socket = new WebSocket(url); socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error("timed out connecting to serve-sim helper")); }, 2_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      const body = value === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(value));
      const message = new Uint8Array(body.length + 1); message[0] = type; message.set(body, 1); socket.send(message);
      setTimeout(() => { socket.close(); resolve(); }, 60);
    }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("could not connect to serve-sim control socket")); }, { once: true });
  });
}
function startedAt(env: Environment, udid: string) { return readStatus(env, udid)?.startedAt ?? new Date().toISOString(); }

export async function nativeInput(args: readonly string[], env: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return ok(`${usageText("native-input")}\n${usageText("native-input-stream")}\n${usageText("native-input-rotate")}\nCoordinates use device points; frames report image pixels and pixels per point.\n`);
  const [verb, udid, ...rawRest] = args.filter((arg) => arg !== "--json");
  const worker = rawRest.includes("--worker");
  const durationIndex = rawRest.indexOf("--duration");
  const duration = durationIndex >= 0 ? Number(rawRest[durationIndex + 1]) : 500;
  const rest = durationIndex >= 0 ? rawRest.filter((_, index) => index !== durationIndex && index !== durationIndex + 1) : rawRest;
  if (!verb || !udid || !SIMULATOR_UDID.test(udid)) return failed("native input requires start|status|stop|tap|swipe|scroll|type|key|button|frame|stream|rotate and a simulator UDID", 2);
  const all = records(env); let old = all.find((entry) => entry.udid === udid);
  if (verb === "status") {
    const helper = old ? await helperState(process, udid) : undefined;
    if (old && !helper) { save(env, all.filter((entry) => entry.udid !== udid)); old = undefined; }
    const status = readStatus(env, udid) ?? (old ? { udid, state: "ready" as const, phase: "ready", startedAt: "", session: old.session, port: old.port } : { udid, state: "none" as const, phase: "idle" });
    return ok(`${JSON.stringify(status)}\n`);
  }
  if (verb !== "stop" && verb !== "stream") { const { activeRunForDevice } = await import("../maestro.js"); const activeRun = activeRunForDevice(env, udid); if (activeRun) return failed(`simulator ${udid} is being driven by Maestro run ${activeRun}`); }
  if (verb === "stop") {
    await process.run("serve-sim", ["--kill", udid]);
    save(env, all.filter((entry) => entry.udid !== udid));
    writeStatus(env, { udid, state: "none", phase: "idle", startedAt: startedAt(env, udid) });
    return ok(`${JSON.stringify({ udid, stopped: true })}\n`);
  }
  if (verb === "start") {
    if (!worker) {
      const prior = readStatus(env, udid);
      if (old && prior?.state !== "starting") return ok(`${JSON.stringify({ udid, state: "ready", session: old.session, port: old.port })}\n`);
      if (prior?.state === "starting") return rest.includes("--wait") ? waitForInput(env, udid, Number(rest[rest.indexOf("--timeout") + 1] ?? 600)) : ok(`${JSON.stringify({ udid, state: "starting" })}\n`);
      mkdirSync(join(resolveStateDirectory(env), "native-input"), { recursive: true });
      try { closeSync(openSync(lockFile(env, udid), "wx", 0o600)); } catch { return failed(`input start for ${udid} is already being claimed`); }
      writeStatus(env, { udid, state: "starting", phase: "launching serve-sim helper", startedAt: new Date().toISOString() });
      const child = selfInvocation(globalThis.process.execPath, globalThis.process.argv, ["native", "input", "start", udid, "--worker"]);
      const launched = await process.startDetached(child.command, child.args, { env: { MEGABRAIN_STATE_DIR: resolveStateDirectory(env) } });
      if (launched.kind !== "ok") { writeStatus(env, { udid, state: "failed", phase: "launching", startedAt: startedAt(env, udid), error: launched.error }); try { unlinkSync(lockFile(env, udid)); } catch {} return launched; }
      return rest.includes("--wait") ? waitForInput(env, udid, Number(rest[rest.indexOf("--timeout") + 1] ?? 600)) : ok(`${JSON.stringify({ udid, state: "starting" })}\n`);
    }
    const lock = lockFile(env, udid); const update = (phase: string) => writeStatus(env, { udid, state: "starting", phase, startedAt: startedAt(env, udid) });
    try {
      update("validating simulator");
      const [phones, tvs] = await Promise.all([simCandidates(process, "phone"), simCandidates(process, "tv")]);
      const candidate = [...(phones.kind === "ok" ? phones.value : []), ...(tvs.kind === "ok" ? tvs.value : [])].find((device) => device.udid === udid);
      if (!candidate) throw new Error(`unknown simulator: ${udid}`);
      if (candidate.state !== "Booted") throw new Error(`simulator ${udid} is not booted (state: ${candidate.state})`);
      const platform = phones.kind === "ok" && phones.value.some((device) => device.udid === udid) ? "iOS" : "tvOS";
      const existing = await helperState(process, udid);
      let helper = existing;
      if (!helper) {
        update("starting serve-sim helper");
        const launch = await process.run("serve-sim", ["--detach", "--exit-on-simulator-shutdown", "--quiet", udid], { env: { SERVE_SIM_DISABLE_DEVICE_HUB_KEYBOARD: "1" } });
        if (launch.kind !== "ok") throw new Error(`failed to start serve-sim helper: ${launch.error}`);
        helper = parseHelper(launch.value.stdout, udid) ?? await helperState(process, udid);
      }
      if (!helper) throw new Error(`serve-sim did not report a live helper for ${udid}`);
      const entry: RecordEntry = { ...helper, platform };
      save(env, [...all.filter((item) => item.udid !== udid), entry]);
      writeStatus(env, { udid, state: "ready", phase: "ready", startedAt: startedAt(env, udid), session: entry.session, port: entry.port });
      return ok(`${JSON.stringify({ udid, session: entry.session, port: entry.port })}\n`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      writeStatus(env, { udid, state: "failed", phase: readStatus(env, udid)?.phase ?? "starting", startedAt: startedAt(env, udid), error: message });
      return failed(message);
    } finally { try { unlinkSync(lock); } catch {} }
  }
  if (!old) return failed(`no input session for ${udid}; run native input start ${udid} first`);
  const pending = readStatus(env, udid);
  if (pending?.state === "starting") return failed(`input session for ${udid} state starting (phase: ${pending.phase})`);
  const started = Date.now();
  if (verb === "stream" || verb === "frame") {
    try {
      const jpeg = await frame(old.streamUrl); const size = jpegSize(jpeg);
      if (!size || size.width <= 0 || size.height <= 0) return failed("MJPEG frame did not contain image dimensions");
      const pointWidth = old.pointWidth ?? size.width / 3; const pointHeight = old.pointHeight ?? size.height / 3;
      old = { ...old, pointWidth, pointHeight }; save(env, [...all.filter((item) => item.udid !== udid), old]);
      if (verb === "stream") return ok(`${JSON.stringify({ streamUrl: old.streamUrl, width: size.width, height: size.height, scale: size.width / pointWidth })}\n`);
      return ok(`${JSON.stringify({ image: `data:image/jpeg;base64,${jpeg.toString("base64")}`, width: size.width, height: size.height, scale: size.width / pointWidth, ms: Date.now() - started })}\n`);
    } catch (cause) { return failed(`could not read simulator MJPEG stream: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  const nums = rest.slice(0, 6).map(Number);
  try {
    if (verb === "tap" && nums.length === 2) {
      const size = old.pointWidth && old.pointHeight ? { width: old.pointWidth, height: old.pointHeight } : { width: 0, height: 0 };
      if (!size.width) return failed("read a frame before sending point-coordinate input");
      await sendWs(old.wsUrl, 3, { type: "begin", x: nums[0]! / size.width, y: nums[1]! / size.height });
      await sendWs(old.wsUrl, 3, { type: "end", x: nums[0]! / size.width, y: nums[1]! / size.height });
    } else if ((verb === "swipe" || verb === "scroll") && nums.length === 4 && (verb === "scroll" || (Number.isFinite(duration) && duration > 0))) {
      const size = old.pointWidth && old.pointHeight ? { width: old.pointWidth, height: old.pointHeight } : { width: 0, height: 0 };
      if (!size.width) return failed("read a frame before sending point-coordinate input");
      const [x1, y1, x2, y2] = verb === "scroll" ? [nums[0]!, nums[1]!, nums[0]! + nums[2]!, nums[1]! + nums[3]!] : nums;
      await sendWs(old.wsUrl, 3, { type: "begin", x: x1 / size.width, y: y1 / size.height });
      await new Promise((resolve) => setTimeout(resolve, verb === "scroll" ? 400 : duration));
      await sendWs(old.wsUrl, 3, { type: "end", x: x2 / size.width, y: y2 / size.height });
    } else if (verb === "type" && rest.length) {
      const result = await process.run("serve-sim", ["type", rest.join(" "), "--device", udid]); if (result.kind !== "ok") return failed(result.error);
    } else if (verb === "key" && rest.length === 1) {
      const keyUsage: Record<string, number> = { return: 40, delete: 42, tab: 43, escape: 41, space: 44, up: 82, down: 81, left: 80, right: 79 };
      const usage = keyUsage[rest[0]!.toLowerCase()]; if (!usage) return failed(`unknown input key: ${rest[0]}`, 2);
      await sendWs(old.wsUrl, 6, { type: "down", usage }); await sendWs(old.wsUrl, 6, { type: "up", usage });
    } else if (verb === "button" && rest.length === 1) {
      const buttons: Record<string, string> = { select: "action", menu: "menu", "play-pause": "play-pause", home: "home", lock: "power", "volume-up": "volume-up", "volume-down": "volume-down", siri: "siri", up: "up", down: "down", left: "left", right: "right" };
      const button = buttons[rest[0]!]; const supported = old.platform === "tvOS" ? ["up", "down", "left", "right", "select", "menu", "play-pause", "home"] : ["home", "lock", "volume-up", "volume-down", "siri"];
      if (!supported.includes(rest[0]!)) return failed(`unsupported ${old.platform} button: ${rest[0]}`, 2);
      await sendWs(old.wsUrl, 4, { button });
    } else if (verb === "rotate") {
      const orientation = rest[0]; if (rest.length !== 1 || (orientation !== "portrait" && orientation !== "landscape")) return failed("usage: megabrain native input rotate <udid> portrait|landscape [--json]", 2);
      await sendWs(old.wsUrl, 7, { orientation: orientation === "portrait" ? "portrait" : "landscape_left" });
      return ok(`${JSON.stringify({ ok: true, orientation, width: old.pointWidth ?? 0, height: old.pointHeight ?? 0 })}\n`);
    } else return failed(`invalid native input ${verb} arguments`, 2);
    return ok(`${JSON.stringify({ ok: true, ms: Date.now() - started })}\n`);
  } catch (cause) { return failed(`serve-sim input failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
}
