import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "../../../core/package-root.js";
import type { ProcessAdapter } from "../../../adapters/proc.js";
import { resolveStateDirectory } from "../../../core/state.js";
import { selfInvocation } from "../../../core/self-invocation.js";
import { failed, ok, type Result } from "../../../core/result.js";
import { usageText } from "../../../core/usage.js";
import WebSocket from "ws";
import { SIMULATOR_UDID, simCandidates } from "./index.js";
import type { Environment } from "./index.js";

type RecordEntry = { udid: string; session: string; platform: "iOS" | "tvOS"; pid: number; ownerPid?: number; watchdogPid?: number; port: number; streamUrl: string; wsUrl: string; pointWidth?: number; pointHeight?: number };
type InputStatus = { udid: string; state: "none" | "starting" | "ready" | "failed"; phase: string; startedAt?: string; error?: string; session?: string; port?: number; ownerPid?: number; watchdogPid?: number };
const stateFile = (env: Environment) => join(resolveStateDirectory(env), "native-input-sessions.json");
const statusFile = (env: Environment, udid: string) => join(resolveStateDirectory(env), "native-input", `${udid}.json`);
const lockFile = (env: Environment, udid: string) => join(resolveStateDirectory(env), "native-input", `${udid}.lock`);
function readStatus(env: Environment, udid: string): InputStatus | undefined {
  try { const value = JSON.parse(readFileSync(statusFile(env, udid), "utf8")) as InputStatus; return value.udid === udid ? value : undefined; } catch { return undefined; }
}
function writeStatus(env: Environment, value: InputStatus): void {
  const file = statusFile(env, value.udid); mkdirSync(join(resolveStateDirectory(env), "native-input"), { recursive: true });
  const prior = readStatus(env, value.udid);
  const merged = { ...prior, ...value, ownerPid: value.ownerPid ?? prior?.ownerPid, watchdogPid: value.watchdogPid ?? prior?.watchdogPid };
  const tmp = `${file}.${globalThis.process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify(merged)}\n`, { mode: 0o600 }); renameSync(tmp, file);
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
  const stopped = await runServeSim(process, _env, ["--kill", udid]);
  return stopped.kind === "ok" ? ok(undefined) : failed(stopped.error);
}
async function runServeSim(process: ProcessAdapter, env: Environment, args: readonly string[], options?: { readonly env?: Readonly<Record<string, string>> }) {
  const onPath = await process.run("serve-sim", args, options);
  if (onPath.kind === "ok" || !onPath.error.includes("executable not found")) return onPath;
  const roots = [globalThis.process.cwd()];
  try { roots.push(resolvePackageRoot(import.meta.url, env.MEGABRAIN_ROOT)); } catch { /* use cwd */ }
  const script = roots.map((root) => join(root, "node_modules", "serve-sim", "dist", "serve-sim.js")).find(existsSync);
  return script ? process.run("node", [script, ...args], options) : onPath;
}
async function helperState(process: ProcessAdapter, env: Environment, udid: string) {
  const result = await runServeSim(process, env, ["--list", udid]);
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
async function watchInputOwner(env: Environment, process: ProcessAdapter, entry: RecordEntry): Promise<Result<string>> {
  const ownerPid = entry.ownerPid;
  if (!ownerPid || !Number.isInteger(ownerPid)) return failed("native input watchdog has no valid owner PID");
  while (true) {
    const owner = await process.run("kill", ["-0", String(ownerPid)]);
    if (owner.kind !== "ok") {
      const stopped = await runServeSim(process, env, ["--kill", entry.udid]);
      if (stopped.kind !== "ok") { await new Promise((resolve) => setTimeout(resolve, 500)); continue; }
      save(env, records(env).filter((candidate) => candidate.udid !== entry.udid));
      writeStatus(env, { udid: entry.udid, state: "none", phase: "owner exited", startedAt: startedAt(env, entry.udid), ownerPid });
      return ok(`${JSON.stringify({ udid: entry.udid, stopped: true, reason: "owner exited" })}\n`);
    }
    const checked = await runServeSim(process, env, ["--list", entry.udid]);
    if (checked.kind !== "ok") { await new Promise((resolve) => setTimeout(resolve, 500)); continue; }
    const helper = parseHelper(checked.value.stdout, entry.udid);
    if (!helper) {
      save(env, records(env).filter((candidate) => candidate.udid !== entry.udid));
      writeStatus(env, { udid: entry.udid, state: "none", phase: "simulator stopped", startedAt: startedAt(env, entry.udid), ownerPid });
      return ok(`${JSON.stringify({ udid: entry.udid, stopped: true, reason: "simulator stopped" })}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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
  return sendWsSequence(url, [{ type, value }]);
}
async function sendWsSequence(url: string, events: readonly { type: number; value?: unknown }[], gapMs = 0): Promise<void> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    let sent = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let gapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); if (closeTimer) clearTimeout(closeTimer); if (gapTimer) clearTimeout(gapTimer);
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
      if (error) reject(error); else resolve();
    };
    const onError = () => finish(new Error(sent === 0 ? "could not connect to serve-sim control socket" : `serve-sim control socket failed after sending ${sent} of ${events.length} events`));
    const onClose = () => { if (sent < events.length) finish(new Error(`serve-sim control socket closed after sending ${sent} of ${events.length} events`)); };
    const sendNext = () => {
      if (socket.readyState !== WebSocket.OPEN) { finish(new Error(`serve-sim control socket closed before sending event ${sent + 1} of ${events.length}`)); return; }
      try {
        const event = events[sent]!;
        const body = event.value === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(event.value));
        const message = Buffer.allocUnsafe(body.length + 1); message[0] = event.type; Buffer.from(body).copy(message, 1);
        socket.send(message, (error) => {
          if (error) { finish(new Error(`could not send event ${sent + 1} to serve-sim: ${error.message}`)); return; }
          sent += 1;
          if (sent === events.length) closeTimer = setTimeout(() => finish(), 50);
          else gapTimer = setTimeout(sendNext, gapMs);
        });
      } catch (cause) { finish(new Error(`could not send event ${sent + 1} to serve-sim: ${cause instanceof Error ? cause.message : String(cause)}`)); return; }
    };
    const onOpen = () => { clearTimeout(timeout); sendNext(); };
    timeout = setTimeout(() => finish(new Error("timed out connecting to serve-sim control socket")), 2_000);
    socket.once("open", onOpen); socket.on("error", onError); socket.on("close", onClose);
  });
}
function startedAt(env: Environment, udid: string) { return readStatus(env, udid)?.startedAt ?? new Date().toISOString(); }

export async function nativeInput(args: readonly string[], env: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return ok(`${usageText("native-input")}\n${usageText("native-input-stream")}\n${usageText("native-input-rotate")}\nCoordinates use device points; frames report image pixels and pixels per point.\n`);
  const [verb, udid, ...rawRest] = args.filter((arg) => arg !== "--json");
  const worker = rawRest.includes("--worker");
  const watchOwner = rawRest.includes("--watch");
  const durationIndex = rawRest.indexOf("--duration");
  const duration = durationIndex >= 0 ? Number(rawRest[durationIndex + 1]) : 500;
  const rest = durationIndex >= 0 ? rawRest.filter((_, index) => index !== durationIndex && index !== durationIndex + 1) : rawRest;
  if (!verb || !udid || !SIMULATOR_UDID.test(udid)) return failed("native input requires start|status|stop|tap|swipe|scroll|type|key|button|frame|stream|rotate and a simulator UDID", 2);
  const all = records(env); let old = all.find((entry) => entry.udid === udid);
  if (verb === "status") {
    const helper = old ? await helperState(process, env, udid) : undefined;
    if (old && !helper) { save(env, all.filter((entry) => entry.udid !== udid)); old = undefined; }
    const status = readStatus(env, udid) ?? (old ? { udid, state: "ready" as const, phase: "ready", startedAt: "", session: old.session, port: old.port } : { udid, state: "none" as const, phase: "idle" });
    return ok(`${JSON.stringify(status)}\n`);
  }
  if (verb !== "stop" && verb !== "stream") { const { activeRunForDevice } = await import("../maestro.js"); const activeRun = activeRunForDevice(env, udid); if (activeRun) return failed(`simulator ${udid} is being driven by Maestro run ${activeRun}`); }
  if (verb === "stop") {
    const stopped = await runServeSim(process, env, ["--kill", udid]);
    if (stopped.kind !== "ok") return failed(`failed to stop serve-sim helper: ${stopped.error}`);
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
      const ownerPid = globalThis.process.ppid;
      const child = selfInvocation(globalThis.process.execPath, globalThis.process.argv, ["native", "input", "start", udid, "--worker", "--watch"]);
      const launched = await process.startDetached(child.command, child.args, { env: { MEGABRAIN_STATE_DIR: resolveStateDirectory(env), MEGABRAIN_NATIVE_INPUT_OWNER_PID: String(ownerPid) } });
      if (launched.kind !== "ok") { writeStatus(env, { udid, state: "failed", phase: "launching", startedAt: startedAt(env, udid), error: launched.error }); try { unlinkSync(lockFile(env, udid)); } catch {} return launched; }
      writeStatus(env, { udid, state: "starting", phase: "launching serve-sim helper", startedAt: startedAt(env, udid), ownerPid, watchdogPid: launched.value.pid });
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
      const existing = await helperState(process, env, udid);
      let helper = existing;
      if (!helper) {
        update("starting serve-sim helper");
        const launch = await runServeSim(process, env, ["--detach", "--exit-on-simulator-shutdown", "--quiet", udid], { env: { SERVE_SIM_DISABLE_DEVICE_HUB_KEYBOARD: "1" } });
        if (launch.kind !== "ok") throw new Error(`failed to start serve-sim helper: ${launch.error}`);
        helper = parseHelper(launch.value.stdout, udid) ?? await helperState(process, env, udid);
      }
      if (!helper) throw new Error(`serve-sim did not report a live helper for ${udid}`);
      const ownerPid = Number(env.MEGABRAIN_NATIVE_INPUT_OWNER_PID);
      const entry: RecordEntry = { ...helper, platform, ...(worker && Number.isInteger(ownerPid) && ownerPid > 0 ? { ownerPid } : {}), watchdogPid: readStatus(env, udid)?.watchdogPid };
      save(env, [...all.filter((item) => item.udid !== udid), entry]);
      writeStatus(env, { udid, state: "ready", phase: "ready", startedAt: startedAt(env, udid), session: entry.session, port: entry.port });
      if (watchOwner) return watchInputOwner(env, process, entry);
      return ok(`${JSON.stringify({ udid, session: entry.session, port: entry.port })}\n`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      writeStatus(env, { udid, state: "failed", phase: readStatus(env, udid)?.phase ?? "starting", startedAt: startedAt(env, udid), error: message });
      return failed(message);
    } finally { try { unlinkSync(lock); } catch {} }
  }
  const pending = readStatus(env, udid);
  if (pending?.state === "starting") return failed(`input session for ${udid} state starting (phase: ${pending.phase})`);
  if (!old) return failed(`no input session for ${udid}; run native input start ${udid} first`);
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
      const point = { x: nums[0]! / size.width, y: nums[1]! / size.height };
      await sendWsSequence(old.wsUrl, [{ type: 3, value: { type: "begin", ...point } }, { type: 3, value: { type: "end", ...point } }], 40);
    } else if ((verb === "swipe" || verb === "scroll") && nums.length === 4 && (verb === "scroll" || (Number.isFinite(duration) && duration > 0))) {
      const size = old.pointWidth && old.pointHeight ? { width: old.pointWidth, height: old.pointHeight } : { width: 0, height: 0 };
      if (!size.width) return failed("read a frame before sending point-coordinate input");
      const [x1, y1, x2, y2] = verb === "scroll" ? [nums[0]!, nums[1]!, nums[0]! + nums[2]!, nums[1]! + nums[3]!] : nums;
      await sendWsSequence(old.wsUrl, [{ type: 3, value: { type: "begin", x: x1 / size.width, y: y1 / size.height } }, { type: 3, value: { type: "end", x: x2 / size.width, y: y2 / size.height } }], verb === "scroll" ? 400 : duration);
    } else if (verb === "type" && rest.length) {
      const result = await runServeSim(process, env, ["type", rest.join(" "), "--device", udid]); if (result.kind !== "ok") return failed(result.error);
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
