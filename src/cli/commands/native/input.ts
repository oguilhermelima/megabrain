import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessAdapter } from "../../../adapters/proc.js";
import { resolveStateDirectory } from "../../../core/state.js";
import { failed, ok, type Result } from "../../../core/result.js";
import { usageText } from "../../../core/usage.js";
import { SIMULATOR_UDID, simCandidates } from "./index.js";
import { appium, appiumHttpFailure, appiumResponse, createAppiumSession, appiumInputSessionCapabilities } from "./session.js";
import type { Environment } from "./index.js";


async function mjpegFrame(port: number): Promise<Buffer> {
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok || response.body === null) throw new Error(`MJPEG stream returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  let bytes = Buffer.alloc(0);
  try {
    while (bytes.length < 8_000_000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes = Buffer.concat([bytes, Buffer.from(chunk.value)]);
      const start = bytes.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) continue;
      const end = bytes.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end >= 0) return bytes.subarray(start, end + 2);
    }
    throw new Error("MJPEG stream did not contain a complete JPEG frame");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

type RecordEntry = { udid: string; session: string; platform: "iOS" | "tvOS"; pointWidth?: number; pointHeight?: number };
async function windowSize(process: ProcessAdapter, env: Environment, session: string): Promise<{ width: number; height: number } | undefined> {
  for (const path of ["/window/rect", "/window/size"]) {
    const result = await request(process, env, session, "GET", path);
    if (result.kind !== "ok") continue;
    try {
      const size = (JSON.parse(result.value) as { value?: { width?: number; height?: number } }).value;
      if (size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width! > 0 && size.height! > 0)
        return { width: size.width!, height: size.height! };
    } catch { /* try the other W3C/Appium window-size route */ }
  }
  return undefined;
}
const stateFile = (env: Environment) => join(resolveStateDirectory(env), "native-input-sessions.json");
function records(env: Environment): RecordEntry[] {
  try { const parsed = JSON.parse(readFileSync(stateFile(env), "utf8")) as { version?: number; sessions?: RecordEntry[] }; return parsed.version === 1 && Array.isArray(parsed.sessions) ? parsed.sessions : []; } catch { return []; }
}
function save(env: Environment, entries: RecordEntry[]): void {
  const file = stateFile(env); mkdirSync(resolveStateDirectory(env), { recursive: true });
  const tmp = `${file}.${globalThis.process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions: entries }, null, 2)}\n`, { mode: 0o600 }); renameSync(tmp, file);
}
async function request(process: ProcessAdapter, env: Environment, session: string, method: string, path: string, body?: unknown): Promise<Result<string>> {
  const args = ["-sS", "-w", "\n%{http_code}", "-X", method, `http://127.0.0.1:${env.MEGABRAIN_APPIUM_PORT ?? "4723"}/session/${session}${path}`, "-H", "Content-Type: application/json"];
  if (body !== undefined) args.push("-d", JSON.stringify(body));
  const response = await process.run("curl", args);
  if (response.kind !== "ok") return failed(response.error);
  const parsed = appiumResponse(response.value.stdout);
  if (parsed === undefined) return failed("Appium response did not include an HTTP status");
  if (parsed.status < 200 || parsed.status >= 300) return failed(appiumHttpFailure("Appium input failed", parsed));
  return ok(parsed.body);
}
export async function nativeInput(args: readonly string[], env: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return ok(`${usageText("native-input")}\nCoordinates use device points; frames report image pixels and pixels per point.\n`);
  const [verb, udid, ...rawRest] = args.filter((arg) => arg !== "--json");
  const durationIndex = rawRest.indexOf("--duration");
  const duration = durationIndex >= 0 ? Number(rawRest[durationIndex + 1]) : 500;
  const rest = durationIndex >= 0 ? rawRest.filter((_, index) => index !== durationIndex && index !== durationIndex + 1) : rawRest;
  if (!verb || !udid || !SIMULATOR_UDID.test(udid)) return failed("native input requires start|stop|tap|swipe|scroll|type|key|button|frame and a simulator UDID", 2);
  const all = records(env); const old = all.find((entry) => entry.udid === udid);
  if (verb !== "stop") { const { activeRunForDevice } = await import("../maestro.js"); const activeRun = activeRunForDevice(env, udid); if (activeRun) return failed(`simulator ${udid} is being driven by Maestro run ${activeRun}`); }
  if (verb === "stop") {
    if (old) { await request(process, env, old.session, "DELETE", "").catch(() => undefined); save(env, all.filter((entry) => entry.udid !== udid)); }
    return ok(`${JSON.stringify({ udid, stopped: true })}\n`);
  }
  if (verb === "start") {
    const phones = await simCandidates(process, "phone");
    const tvs = await simCandidates(process, "tv");
    const candidate = [...(phones.kind === "ok" ? phones.value : []), ...(tvs.kind === "ok" ? tvs.value : [])].find((d) => d.udid === udid);
    if (!candidate) return failed(`unknown simulator: ${udid}`);
    const platform = phones.kind === "ok" && phones.value.some((d) => d.udid === udid) ? "iOS" : "tvOS";
    if (old) {
      const live = await request(process, env, old.session, "GET", "");
      if (live.kind === "ok") {
        const size = await windowSize(process, env, old.session);
        const updated = { ...old, ...(size ? { pointWidth: size.width, pointHeight: size.height } : {}) };
        save(env, [...all.filter((entry) => entry.udid !== udid), updated]);
        return ok(`${JSON.stringify({ udid, session: old.session, port: Number(env.MEGABRAIN_APPIUM_PORT ?? 4723) })}\n`);
      }
    }
    if ((await appium(["status"], env, process)).kind !== "ok") { const started = await appium(["start"], env, process); if (started.kind !== "ok") return started; }
    const port = Number(env.MEGABRAIN_APPIUM_PORT ?? 4723);
    const created = await createAppiumSession(process, { udid, bundleId: platform === "iOS" ? "com.apple.springboard" : "com.apple.TVHomeScreen" }, platform, appiumInputSessionCapabilities(platform, udid), port);
    if (created.kind !== "ok") return created;
    const size = await windowSize(process, env, created.value);
    save(env, [...all.filter((entry) => entry.udid !== udid), { udid, session: created.value, platform, ...(size ? { pointWidth: size.width, pointHeight: size.height } : {}) }]);
    return ok(`${JSON.stringify({ udid, session: created.value, port: Number(env.MEGABRAIN_APPIUM_PORT ?? 4723) })}\n`);
  }
  if (!old) return failed(`no input session for ${udid}; run native input start ${udid} first`);
  const started = Date.now(); let route = ""; let body: unknown;
  const nums = rest.slice(0, 6).map(Number);
  if (verb === "tap" && nums.length === 2) { route = "/execute/sync"; body = { script: "mobile: tap", args: [{ x: nums[0], y: nums[1] }] }; }
  else if (verb === "swipe" && nums.length === 4 && Number.isFinite(duration) && duration > 0) { route = "/actions"; body = pointerGesture(nums[0]!, nums[1]!, nums[2]!, nums[3]!, duration); }
  else if (verb === "scroll" && nums.length === 4) { route = "/actions"; body = pointerGesture(nums[0]!, nums[1]!, nums[0]! + nums[2]!, nums[1]! + nums[3]!, 400); }
  else if (verb === "type" && rest.length) { route = "/wda/keys"; body = { value: [...rest.join(" ")] }; }
  else if (verb === "key" && rest.length === 1) { const map: Record<string, string> = { return: "\n", delete: "\u0008", tab: "\t", escape: "\u001b", up: "\uF700", down: "\uF701", left: "\uF702", right: "\uF703", space: " " }; if (!map[rest[0]!.toLowerCase()]) return failed(`unknown input key: ${rest[0]}`, 2); route = "/wda/keys"; body = { value: [map[rest[0]!.toLowerCase()]] }; }
  else if (verb === "button" && rest.length === 1) { const supported = old.platform === "tvOS" ? ["up", "down", "left", "right", "select", "menu", "play-pause", "home"] : ["home", "lock", "volume-up", "volume-down", "siri"]; if (!supported.includes(rest[0]!)) return failed(`unsupported ${old.platform} button: ${rest[0]}`, 2); const appiumName = ({ "volume-up": "volumeUp", "volume-down": "volumeDown", "play-pause": "playPause" } as Record<string, string>)[rest[0]!] ?? rest[0]; route = "/execute/sync"; body = { script: "mobile: pressButton", args: [{ name: appiumName }] }; }
  else if (verb === "frame") {
    let image: string; let width: number; let height: number;
    try {
      const port = appiumInputSessionCapabilities(old.platform, udid)["appium:mjpegServerPort"] as number;
      const jpeg = await mjpegFrame(port);
      const size = old.pointWidth && old.pointHeight
        ? { width: old.pointWidth, height: old.pointHeight }
        : await windowSize(process, env, old.session);
      if (!size) return failed("could not read simulator point dimensions from Appium");
      if (size.width <= 0 || size.height <= 0) return failed("Appium returned invalid screenshot dimensions");
      // WDA's stream is JPEG; the data URL keeps its actual format for the device view.
      image = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      width = 0; height = 0;
      for (let offset = 2; offset + 9 < jpeg.length;) {
        if (jpeg[offset] !== 0xff) { offset += 1; continue; }
        const marker = jpeg[offset + 1]!;
        const length = jpeg.readUInt16BE(offset + 2);
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          height = jpeg.readUInt16BE(offset + 5); width = jpeg.readUInt16BE(offset + 7); break;
        }
        if (length < 2) break;
        offset += length + 2;
      }
      if (width <= 0 || height <= 0) throw new Error("MJPEG frame did not contain image dimensions");
      return ok(`${JSON.stringify({ image, width, height, scale: width / size.width, ms: Date.now() - started })}\n`);
    } catch (streamError) {
      const shot = await request(process, env, old.session, "GET", "/screenshot");
      if (shot.kind !== "ok") return failed(`MJPEG failed (${streamError instanceof Error ? streamError.message : String(streamError)}); Appium screenshot failed (${shot.error})`);
      let data: string;
      try { data = (JSON.parse(shot.value) as { value?: string }).value ?? ""; }
      catch { return failed("Appium screenshot response was not valid JSON"); }
      const png = Buffer.from(data, "base64");
      if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return failed("Appium screenshot did not contain a valid PNG");
      const size = old.pointWidth && old.pointHeight ? { width: old.pointWidth, height: old.pointHeight } : await windowSize(process, env, old.session);
      if (!size) return failed("could not read simulator point dimensions from Appium");
      const width = png.readUInt32BE(16); const height = png.readUInt32BE(20);
      return ok(`${JSON.stringify({ image: `data:image/png;base64,${data}`, width, height, scale: width / size.width, ms: Date.now() - started })}\n`);
    }
  }
  else return failed(`invalid native input ${verb} arguments`, 2);
  const result = await request(process, env, old.session, "POST", route, body); if (result.kind !== "ok") return result;
  return ok(`${JSON.stringify({ ok: true, ms: Date.now() - started })}\n`);
}

function pointerGesture(x1: number, y1: number, x2: number, y2: number, duration: number): unknown {
  return { actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: [
    { type: "pointerMove", duration: 0, x: x1, y: y1 },
    { type: "pointerDown", button: 0 },
    { type: "pointerMove", duration, x: x2, y: y2 },
    { type: "pointerUp", button: 0 },
  ] }] };
}

export async function endNativeInputSession(env: Environment, process: ProcessAdapter, udid: string): Promise<Result<void>> {
  const all = records(env); const entry = all.find((candidate) => candidate.udid === udid);
  if (!entry) return ok(undefined);
  const deleted = await request(process, env, entry.session, "DELETE", "");
  if (deleted.kind !== "ok") return deleted;
  save(env, all.filter((candidate) => candidate.udid !== udid));
  return ok(undefined);
}

