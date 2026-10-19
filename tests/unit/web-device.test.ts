import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { executeWebDevice, readWebDevices, webDeviceInputOperation } from "../../src/core/web-device.js";
import { nativeInput } from "../../src/cli/commands/native/input.js";
import { executeMaestro, listFlows } from "../../src/cli/commands/maestro.js";
import { ok } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

const dirs: string[] = [];
async function fixture() { const path = await mkdtemp(join(tmpdir(), "mb-web-device-")); dirs.push(path); return path; }
afterEach(async () => { while (dirs.length) { const path = dirs.pop(); if (path) await rm(path, { recursive: true, force: true }); } });

describe("web device records and input scenarios", () => {
  test("reads valid records and ignores malformed or mismatched records", async () => {
    const state = await fixture();
    const records = join(state, "web-devices");
    const { mkdir } = await import("node:fs/promises"); await mkdir(records);
    const id = "web-11111111-1111-4111-8111-111111111111";
    await writeFile(join(records, `${id}.json`), JSON.stringify({ id, kind: "web", url: "https://example.com", title: "Example", width: 390, height: 844, scale: 1, streamUrl: "http://127.0.0.1:19111/", pid: process.pid }));
    await writeFile(join(records, "web-bad.json"), "{");
    await writeFile(join(records, "web-22222222-2222-4222-8222-222222222222.json"), JSON.stringify({ id: "web-33333333-3333-4333-8333-333333333333", kind: "web" }));
    expect(readWebDevices({ MEGABRAIN_STATE_DIR: state })).toMatchObject([{ id, width: 390, height: 844, scale: 1 }]);
  });

  test.each([
    [["tap", "12", "34"], { action: "tap", args: [12, 34] }],
    [["swipe", "1", "2", "30", "40", "--ms", "250"], { action: "swipe", args: [1, 2, 30, 40], ms: 250 }],
    [["scroll", "10", "20", "0", "-40"], { action: "scroll", args: [10, 20, 0, -40] }],
    [["type", "hello", "web"], { action: "type", text: "hello web" }],
    [["key", "Enter"], { action: "key", key: "Enter" }],
    [["navigate", "https://example.org"], { action: "navigate", url: "https://example.org" }],
    [["viewport", "iphone16", "--landscape"], { action: "viewport", slug: "iphone16", landscape: true }],
    [["back"], { action: "back" }], [["forward"], { action: "forward"}], [["reload"], { action: "reload"}],
  ] as const)("maps input argv %j", (args, expected) => {
    expect(webDeviceInputOperation(args)).toEqual(expected);
  });

  test.each([[[]], [["tap", "-1", "2"]], [["swipe", "1", "2", "3", "4", "--ms", "0"]]] as const)("rejects invalid input argv %j", (args) => {
    expect(webDeviceInputOperation(args)).toBeUndefined();
  });

  test("resizes the existing device, keeps its id and returns the updated record", async () => {
    const state = await fixture();
    const id = "web-11111111-1111-4111-8111-111111111111";
    const received: unknown[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id, kind: "web", url: "https://example.com", title: "Example", width: 844, height: 390, scale: 1, streamUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/` }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(state, "web-devices"));
    await writeFile(join(state, "web-devices", `${id}.json`), JSON.stringify({ id, kind: "web", url: "https://example.com", title: "Example", width: 390, height: 844, scale: 1, streamUrl: `http://127.0.0.1:${port}/`, pid: process.pid }));
    try {
      const result = await executeWebDevice(["input", id, "viewport", "iphone16", "--landscape", "--json"], { MEGABRAIN_STATE_DIR: state }, { async run() { throw new Error("unexpected process"); }, async startDetached() { throw new Error("unexpected process"); }, invocationCount() { return 0; } });
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ id, width: 844, height: 390, scale: 1 });
      expect(received).toEqual([{ action: "viewport", slug: "iphone16", landscape: true }]);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe("native simulator stream reporting", () => {
  test("returns the existing WDA MJPEG endpoint and display geometry", async () => {
    const state = await fixture();
    await writeFile(join(state, "native-input-sessions.json"), JSON.stringify({ version: 1, sessions: [{ udid: "11111111-1111-4111-8111-111111111111", session: "sess-1", platform: "iOS", pointWidth: 393, pointHeight: 852 }] }));
    const process: ProcessAdapter = { async run() { return ok({ stdout: "", stderr: "", exitCode: 0 }); }, async startDetached() { throw new Error("unexpected process"); }, invocationCount() { return 0; } };
    const originalFetch = globalThis.fetch;
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x09, 0xfc, 0x04, 0x9b, 0x03, 0x01, 0x11, 0x00, 0xff, 0xd9]);
    globalThis.fetch = async () => new Response(Buffer.concat([Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"), jpeg, Buffer.from("\r\n")]), { status: 200 });
    let result;
    try { result = await nativeInput(["stream", "11111111-1111-4111-8111-111111111111", "--json"], { MEGABRAIN_STATE_DIR: state }, process); }
    finally { globalThis.fetch = originalFetch; }
    expect(result.kind).toBe("ok");
    expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toEqual({ streamUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/), width: 1179, height: 2556, scale: 3 });
  });
});

describe("Maestro web flow discovery and execution", () => {
  test("identifies url headers as web flows", async () => {
    const worktree = await fixture();
    const { mkdir } = await import("node:fs/promises"); await mkdir(join(worktree, ".maestro"));
    await writeFile(join(worktree, ".maestro", "site.yaml"), "url: https://example.com\nname: Site smoke\n---\n- assertVisible: Example\n");
    expect(listFlows(worktree)).toContainEqual({ path: ".maestro/site.yaml", name: "Site smoke", appId: null, kind: "web", url: "https://example.com" });
  });

  // Real browser contract: no visible window; skip if this installation has no Chromium binary.
  test("streams two complete JPEG frames from headless Chromium", async () => {
    const root = process.env.MEGABRAIN_PLAYWRIGHT_ROOT ?? join(process.env.HOME ?? "", ".megabrain", "playwright");
    const { chromium } = await import(new URL(`file://${root}/node_modules/playwright/index.mjs`).href).catch(() => ({ chromium: undefined }));
    if (!chromium) return;
    let browser;
    try { browser = await chromium.launch({ headless: true }); } catch { return; }
    const page = await browser.newPage();
    await page.goto("data:text/html,<title>Web device</title><body>frame</body>");
    const session = await page.context().newCDPSession(page);
    let resolveFirst!: () => void; const firstFrame = new Promise<void>((resolve) => { resolveFirst = resolve; });
    let resolveFrames!: () => void; const twoFrames = new Promise<void>((resolve) => { resolveFrames = resolve; });
    const frames: Buffer[] = [];
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=megabrain-frame" });
      if (frames.length >= 2) { for (const frame of frames.slice(0, 2)) { response.write(Buffer.from(`--megabrain-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`)); response.write(frame); response.write(Buffer.from("\r\n")); } response.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    session.on("Page.screencastFrame", ({ data, sessionId }: { data: string; sessionId: number }) => {
      frames.push(Buffer.from(data, "base64")); if (frames.length === 1) resolveFirst(); if (frames.length >= 2) resolveFrames(); void session.send("Page.screencastFrameAck", { sessionId });
    });
    await session.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
    await Promise.race([firstFrame, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out receiving first frame")), 3000))]);
    await page.evaluate(() => { document.body.textContent = "next frame"; });
    await Promise.race([twoFrames, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out receiving screencast frames")), 3000))]);
    const response = await fetch(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/`, { signal: AbortSignal.timeout(3000) });
    const reader = response.body!.getReader(); let bytes = Buffer.alloc(0);
    while (!response.body!.locked || bytes.length < 2) { const chunk = await reader.read(); if (chunk.done) break; bytes = Buffer.concat([bytes, Buffer.from(chunk.value)]); }
    await session.send("Page.stopScreencast"); await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
    const payload = bytes.toString("binary");
    expect((payload.match(/\xff\xd8/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((payload.match(/\xff\xd9/g) ?? []).length).toBeGreaterThanOrEqual(2);
  }, 10000);
});
