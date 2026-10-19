import { appendFileSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePackageRoot } from "./package-root.js";
import { resolveStateDirectory } from "./state.js";
import type { WebDeviceRecord } from "./web-device.js";

type Options = { id: string; url: string; device?: string; env: Readonly<Record<string, string | undefined>> };
const boundary = "megabrain-frame";
function save(state: string, record: WebDeviceRecord) {
  const root = join(state, "web-devices"); mkdirSync(root, { recursive: true });
  const file = join(root, record.id + ".json"); const temp = file + "." + process.pid + ".tmp";
  writeFileSync(temp, JSON.stringify(record) + "\n", { mode: 0o600 }); renameSync(temp, file);
}
function logTo(file: string) {
  mkdirSync(dirname(file), { recursive: true }); const log = file;
  for (const name of ["stdout", "stderr"] as const) {
    const stream = process[name]; const original = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      try { appendFileSync(log, typeof chunk === "string" ? chunk : Buffer.from(chunk)); } catch {}
      return (original as (...args: unknown[]) => boolean)(chunk, ...args);
    }) as typeof stream.write;
  }
}
function respond(res: import("node:http").ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value) + "\n");
}
function body(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = ""; req.setEncoding("utf8");
    req.on("data", (part: string) => { text += part; if (text.length > 65536) { reject(Error("request body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(text)); } catch { reject(Error("invalid JSON")); } });
    req.on("error", reject);
  });
}
function point(x: unknown, y: unknown, width: number, height: number) {
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < width && y < height;
}
async function input(page: any, op: any, width: number, height: number, hasTouch: boolean) {
  const p: number[] = op.args ?? [];
  switch (op.action) {
    case "tap": if (p.length !== 2 || !point(p[0], p[1], width, height)) throw Error("tap coordinates are outside the viewport"); if (hasTouch) await page.touchscreen.tap(p[0], p[1]); else await page.mouse.click(p[0], p[1]); break;
    case "swipe": {
      if (p.length !== 4 || !point(p[0], p[1], width, height)) throw Error("swipe coordinates are outside the viewport");
      if (!point(p[2], p[3], width, height)) throw Error("swipe coordinates are outside the viewport");
      const duration = op.ms ?? 500; const steps = Math.max(1, Math.ceil(duration / 16));
      await page.mouse.move(p[0], p[1]); await page.mouse.down();
      for (let step = 1; step <= steps; step += 1) {
        await page.mouse.move(p[0] + ((p[2] - p[0]) * step) / steps, p[1] + ((p[3] - p[1]) * step) / steps);
        if (step < steps) await page.waitForTimeout(duration / steps);
      }
      await page.mouse.up(); break;
    }
    case "scroll": if (p.length !== 4 || !point(p[0], p[1], width, height)) throw Error("scroll coordinates are outside the viewport"); await page.mouse.move(p[0], p[1]); await page.mouse.wheel(p[2], p[3]); break;
    case "type": await page.keyboard.type(op.text); break;
    case "key": await page.keyboard.press(op.key); break;
    case "navigate": if (!/^https?:\/\//.test(op.url)) throw Error("navigate requires an HTTP URL"); await page.goto(op.url, { waitUntil: "domcontentloaded", timeout: 30000 }); break;
    case "back": await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 }); break;
    case "forward": await page.goForward({ waitUntil: "domcontentloaded", timeout: 30000 }); break;
    case "reload": await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }); break;
    default: throw Error("unsupported input action");
  }
}
export async function startWebDeviceHost(options: Options): Promise<any> {
  const state = resolveStateDirectory(options.env); const logs = join(state, "logs"); mkdirSync(logs, { recursive: true }); logTo(join(logs, "web-device-" + options.id + ".log"));
  const root = options.env.MEGABRAIN_PLAYWRIGHT_ROOT ?? join(options.env.HOME ?? homedir(), ".megabrain", "playwright");
  const packageRoot = resolvePackageRoot(import.meta.url, options.env.MEGABRAIN_ROOT);
  let browser: any; let server: ReturnType<typeof createServer> | undefined; let stopping = false; let resolveStopped = () => {};
  try {
    const [pw, helpers] = await Promise.all([
      import(pathToFileURL(join(root, "node_modules", "playwright", "index.mjs")).href),
      import(pathToFileURL(join(packageRoot, "scripts", "playwright-web.mjs")).href),
    ]);
    const d = options.device ? helpers.resolveDeviceDescriptor({ device: options.device }, pw.devices) : { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
    browser = await pw.chromium.launch({ headless: true, timeout: 20000 });
    const context = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, isMobile: d.isMobile, hasTouch: d.hasTouch, ...(d.userAgent ? { userAgent: d.userAgent } : {}) });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await page.title().catch(() => "");
    const cdp = await context.newCDPSession(page); let frame: Buffer | undefined; let viewers = 0; let lastViewer = Date.now();
    cdp.on("Page.screencastFrame", (event: any) => { frame = Buffer.from(event.data, "base64"); void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {}); });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
    const stop = async () => {
      if (stopping) return; stopping = true; clearInterval(idle);
      try { await cdp.send("Page.stopScreencast"); } catch {}
      try { await browser.close(); } catch {}
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((done) => server!.close(() => done()));
      }
      try { unlinkSync(join(state, "web-devices", options.id + ".json")); } catch {}
      resolveStopped();
    };
    server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/") {
        viewers++; lastViewer = Date.now(); res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=" + boundary, "cache-control": "no-store", connection: "close", "access-control-allow-origin": "*" });
        const emit = () => { if (res.destroyed || !frame) return; res.write("--" + boundary + "\r\nContent-Type: image/jpeg\r\nContent-Length: " + frame.length + "\r\n\r\n"); res.write(frame); res.write("\r\n"); };
        emit(); const timer = setInterval(emit, 80); let closed = false;
        const done = () => { if (closed) return; closed = true; clearInterval(timer); viewers--; if (!viewers) lastViewer = Date.now(); };
        req.once("close", done); res.once("close", done); return;
      }
      if (req.method === "POST" && req.url === "/__stop") { respond(res, 200, { ok: true }); setTimeout(() => { void stop(); }, 25); return; }
      if (req.method === "POST" && req.url === "/__input") {
        const start = Date.now();
        try { await input(page, await body(req), d.viewport.width, d.viewport.height, d.hasTouch); respond(res, 200, { ok: true, ms: Date.now() - start }); }
        catch (e) { respond(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
        return;
      }
      res.writeHead(404); res.end("not found\n");
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw Error("could not bind web device stream");
    save(state, { id: options.id, kind: "web", url: page.url(), title, width: d.viewport.width, height: d.viewport.height, scale: d.deviceScaleFactor, streamUrl: "http://127.0.0.1:" + address.port + "/", pid: process.pid, ...(options.device ? { preset: options.device } : {}) });
    process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
    const idle = setInterval(() => { if (!viewers && Date.now() - lastViewer >= 600000) void stop(); }, 30000);
    await new Promise<void>((resolve) => { resolveStopped = resolve; });
    return { kind: "ok", value: "" };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause); process.stderr.write(message + "\n");
    try { await browser?.close(); } catch {} try { server?.close(); } catch {}
    try { unlinkSync(join(state, "web-devices", options.id + ".json")); } catch {}
    return { kind: "failed", error: message };
  }
}
