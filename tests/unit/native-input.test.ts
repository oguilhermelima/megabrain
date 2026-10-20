import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { nativeInput } from "../../src/cli/commands/native/input.js";
import { ok, failed } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

const directories: string[] = [];
const helpers: Array<() => Promise<void>> = [];
const udid = "11111111-1111-4111-8111-111111111111";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 9, 252, 4, 155, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]);
async function fakeHelper(readinessDelayMs = 0) {
  const server = createServer((request, response) => {
    if (request.url !== "/stream.mjpeg") { response.writeHead(404).end(); return; }
    if (Date.now() < readyAt) { response.writeHead(503).end("starting"); return; }
    response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    const writeFrame = () => response.write(Buffer.concat([Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n"), jpeg, Buffer.from("\r\n")]));
    writeFrame(); const timer = setInterval(writeFrame, 30); request.on("close", () => clearInterval(timer));
  });
  const readyAt = Date.now() + readinessDelayMs;
  const ws = new WebSocketServer({ server }); const messages: Buffer[] = [];
  ws.on("connection", (socket) => socket.on("message", (message) => messages.push(Buffer.from(message))));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fake helper failed to bind");
  const helper = { pid: 456, port: address.port, device: udid, url: `http://127.0.0.1:${address.port}`, streamUrl: `http://127.0.0.1:${address.port}/stream.mjpeg`, wsUrl: `ws://127.0.0.1:${address.port}` };
  helpers.push(() => new Promise<void>((resolve, reject) => ws.close((error) => error ? reject(error) : server.close(() => resolve()))));
  return { helper, messages };
}
async function fixture(helper: Awaited<ReturnType<typeof fakeHelper>>["helper"]) { const directory = await mkdtemp(join(tmpdir(), "native-input-")); directories.push(directory); await writeFile(join(directory, "native-input-sessions.json"), JSON.stringify({ version: 1, sessions: [{ ...helper, udid, session: String(helper.pid), platform: "iOS", pointWidth: 393, pointHeight: 852 }] })); return directory; }
async function emptyFixture() { const directory = await mkdtemp(join(tmpdir(), "native-input-")); directories.push(directory); return directory; }
function fakeProcess(helper?: Awaited<ReturnType<typeof fakeHelper>>["helper"]) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const process: ProcessAdapter = {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === "kill" && args[0] === "-0") return ok({ stdout: "", stderr: "", exitCode: 0 });
      if (command === "xcrun") return ok({ stdout: JSON.stringify({ devices: { "iOS 18": [{ udid, state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
      if (command === "serve-sim" && args[0] === "--list") return helper ? ok({ stdout: JSON.stringify({ running: true, ...helper }), stderr: "", exitCode: 0 }) : ok({ stdout: JSON.stringify({ running: false, device: udid }), stderr: "", exitCode: 0 });
      if (command === "serve-sim" && args[0] === "--detach") return helper ? ok({ stdout: JSON.stringify(helper), stderr: "", exitCode: 0 }) : failed("fake helper missing");
      if (command === "serve-sim" && args[0] === "--kill") return ok({ stdout: JSON.stringify({ disconnected: true, device: udid }), stderr: "", exitCode: 0 });
      if (command === "serve-sim" && args[0] === "type") return ok({ stdout: "", stderr: "", exitCode: 0 });
      return failed("unexpected process");
    },
    async startDetached() { return failed("not expected"); },
    invocationCount() { return calls.length; },
  };
  return { process, calls };
}

afterEach(async () => { while (helpers.length) await helpers.pop()!(); while (directories.length) { const directory = directories.pop(); if (directory) await rm(directory, { recursive: true, force: true }); } });

describe("native input scenarios", () => {
  test("starts and records the serve-sim helper once for a booted simulator", async () => {
    const fake = await fakeHelper(); const state = await emptyFixture(); const { process } = fakeProcess(fake.helper);
    const result = await nativeInput(["start", udid, "--worker", "--json"], { MEGABRAIN_STATE_DIR: state }, process);
    expect(result.kind).toBe("ok");
    expect(JSON.parse((result as { value: string }).value)).toMatchObject({ udid, session: "456", port: fake.helper.port });
    expect(JSON.parse(await readFile(join(state, "native-input-sessions.json"), "utf8")).sessions[0]).toMatchObject({ pid: 456, streamUrl: fake.helper.streamUrl, wsUrl: fake.helper.wsUrl });
    expect(process.calls.some((call) => call.command === "serve-sim" && call.args.includes("--detach"))).toBe(false);
  });

  test("does not report the helper ready before its framebuffer stream responds", async () => {
    const fake = await fakeHelper(200); const state = await emptyFixture(); const { process } = fakeProcess(fake.helper);
    const started = Date.now();
    const result = await nativeInput(["start", udid, "--worker", "--json"], { MEGABRAIN_STATE_DIR: state }, process);
    expect(result.kind).toBe("ok");
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  test("reuses a live helper and does not start a second process", async () => {
    const fake = await fakeHelper(); const state = await fixture(fake.helper); const { process, calls } = fakeProcess(fake.helper);
    const result = await nativeInput(["start", udid, "--json"], { MEGABRAIN_STATE_DIR: state }, process);
    expect(result.kind).toBe("ok");
    expect(JSON.parse((result as { value: string }).value)).toMatchObject({ session: "456", port: fake.helper.port });
    expect(calls.filter((call) => call.command === "serve-sim" && call.args[0] === "--detach")).toHaveLength(0);
  });

  test("starts asynchronously and joins concurrent starts for one UDID", async () => {
    const state = await emptyFixture(); const { process } = fakeProcess(); let launches = 0;
    process.startDetached = async () => { launches += 1; return ok({ pid: 123 }); };
    const env = { MEGABRAIN_STATE_DIR: state };
    const starts = await Promise.all([
      nativeInput(["start", udid, "--json"], env, process),
      nativeInput(["start", udid, "--json"], env, process),
    ]);
    expect(launches).toBe(1);
    for (const result of starts) expect(JSON.parse((result as { value: string }).value)).toMatchObject({ udid, state: "starting" });
    const status = await nativeInput(["status", udid, "--json"], env, process);
    expect(JSON.parse((status as { value: string }).value)).toMatchObject({ udid, state: "starting", phase: expect.any(String), startedAt: expect.any(String) });
  });

  test("compiled-style argv starts the input worker through the real executable", async () => {
    const state = await emptyFixture(); const { process } = fakeProcess();
    let launched: { command: string; args: readonly string[] } | undefined;
    process.startDetached = async (command, args) => { launched = { command, args }; return ok({ pid: 123 }); };
    const original = [...globalThis.process.argv];
    try {
      globalThis.process.argv.splice(0, globalThis.process.argv.length, process.execPath, "/$bunfs/root/megabrain");
      await nativeInput(["start", udid], { MEGABRAIN_STATE_DIR: state }, process);
      expect(launched).toEqual({ command: globalThis.process.execPath, args: ["native", "input", "start", udid, "--worker", "--watch"] });
    } finally { globalThis.process.argv.splice(0, globalThis.process.argv.length, ...original); }
  });

  test("source-style argv starts the input worker through the script", async () => {
    const state = await emptyFixture(); const { process } = fakeProcess();
    let launched: { command: string; args: readonly string[] } | undefined;
    process.startDetached = async (command, args) => { launched = { command, args }; return ok({ pid: 123 }); };
    const original = [...globalThis.process.argv];
    try {
      globalThis.process.argv.splice(0, globalThis.process.argv.length, process.execPath, "/repo/src/cli.ts");
      await nativeInput(["start", udid], { MEGABRAIN_STATE_DIR: state }, process);
      expect(launched).toEqual({ command: globalThis.process.execPath, args: ["/repo/src/cli.ts", "native", "input", "start", udid, "--worker", "--watch"] });
    } finally { globalThis.process.argv.splice(0, globalThis.process.argv.length, ...original); }
  });

  test("fails input start for a shutdown simulator without booting it", async () => {
    const state = await emptyFixture(); const { process, calls } = fakeProcess();
    const run = process.run.bind(process);
    process.run = async (command, args) => {
      if (command === "xcrun") {
        calls.push({ command, args: [...args] });
        return ok({ stdout: JSON.stringify({ devices: { "iOS 18": [{ udid, state: "Shutdown", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
      }
      return run(command, args);
    };

    const result = await nativeInput(["start", udid, "--worker"], { MEGABRAIN_STATE_DIR: state }, process);

    expect(result.kind).toBe("failed");
    expect((result as { error: string }).error).toContain("not booted");
    expect(calls.some((call) => call.command === "xcrun" && call.args.includes("boot"))).toBe(false);
    const status = await nativeInput(["status", udid, "--json"], { MEGABRAIN_STATE_DIR: state }, process);
    expect(JSON.parse((status as { value: string }).value)).toMatchObject({ udid, state: "failed", error: expect.stringContaining("not booted") });
  });

  test("fails input immediately with starting state while session setup is in progress", async () => {
    const state = await emptyFixture(); const { process } = fakeProcess();
    process.startDetached = async () => ok({ pid: 123 });
    await nativeInput(["start", udid, "--json"], { MEGABRAIN_STATE_DIR: state }, process);
    const action = await nativeInput(["tap", udid, "2", "3", "--json"], { MEGABRAIN_STATE_DIR: state }, process);
    expect(action.kind).toBe("failed");
    expect((action as { error: string }).error).toContain("state starting");
  });

  test("kills the helper and clears the session when its megabrain owner exits", async () => {
    const fake = await fakeHelper(); const state = await emptyFixture(); const { process, calls } = fakeProcess(fake.helper);
    const run = process.run.bind(process);
    process.run = async (command, args, options) => {
      if (command === "kill" && args[0] === "-0" && args[1] === "98765") { calls.push({ command, args: [...args] }); return failed("owner process exited"); }
      return run(command, args, options);
    };
    const result = await nativeInput(["start", udid, "--worker", "--watch", "--json"], { MEGABRAIN_STATE_DIR: state, MEGABRAIN_NATIVE_INPUT_OWNER_PID: "98765" }, process);
    expect(result.kind).toBe("ok");
    expect(calls.some((call) => call.command === "serve-sim" && call.args[0] === "--kill" && call.args[1] === udid)).toBe(true);
    expect(JSON.parse(await readFile(join(state, "native-input-sessions.json"), "utf8")).sessions).toEqual([]);
    expect(JSON.parse(await readFile(join(state, "native-input", `${udid}.json`), "utf8"))).toMatchObject({ state: "none", phase: "owner exited" });
  });

  test("reuses its helper for gestures, text, buttons, frame, stream and stop", async () => {
    const fake = await fakeHelper(); const state = await fixture(fake.helper); const { process, calls } = fakeProcess(fake.helper); const env = { MEGABRAIN_STATE_DIR: state };
    const start = await nativeInput(["start", udid, "--json"], env, process);
    expect(start.kind).toBe("ok");
    expect(JSON.parse((start as { value: string }).value)).toMatchObject({ session: "456", port: fake.helper.port });
    const tap = await nativeInput(["tap", udid, "21", "42", "--json"], env, process);
    expect(tap.kind).toBe("ok");
    const tapEvents = fake.messages.filter((message) => message[0] === 3).slice(0, 2).map((message) => JSON.parse(message.subarray(1).toString()));
    expect(tapEvents).toEqual([{ type: "begin", x: 21 / 393, y: 42 / 852 }, { type: "end", x: 21 / 393, y: 42 / 852 }]);
    await nativeInput(["swipe", udid, "1", "2", "3", "4", "--duration", "250", "--json"], env, process);
    expect(fake.messages.some((message) => message[0] === 3 && JSON.parse(message.subarray(1).toString()).type === "end")).toBe(true);
    await nativeInput(["scroll", udid, "10", "20", "0", "-30", "--json"], env, process);
    expect(fake.messages.filter((message) => message[0] === 3).length).toBeGreaterThanOrEqual(6);
    await nativeInput(["type", udid, "hello", "world", "--json"], env, process);
    expect(calls.some((call) => call.command === "serve-sim" && call.args[0] === "type" && call.args[1] === "hello world")).toBe(true);
    await nativeInput(["key", udid, "return", "--json"], env, process);
    expect(fake.messages.some((message) => message[0] === 6 && JSON.parse(message.subarray(1).toString()).usage === 40)).toBe(true);
    await nativeInput(["button", udid, "home", "--json"], env, process);
    expect(fake.messages.some((message) => message[0] === 4 && JSON.parse(message.subarray(1).toString()).button === "home")).toBe(true);
    const frame = await nativeInput(["frame", udid, "--json"], env, process);
    expect(JSON.parse((frame as { value: string }).value)).toMatchObject({ width: 1179, height: 2556, scale: 3, image: expect.stringContaining("data:image/jpeg;base64,") });
    const stream = await nativeInput(["stream", udid, "--json"], env, process);
    expect(JSON.parse((stream as { value: string }).value)).toMatchObject({ streamUrl: fake.helper.streamUrl, width: 1179, height: 2556 });
    await nativeInput(["stop", udid, "--json"], env, process);
    expect(JSON.parse(await readFile(join(state, "native-input-sessions.json"), "utf8")).sessions).toEqual([]);
  });

  test("fails a tap when the helper control connection cannot open", async () => {
    const fake = await fakeHelper(); const unavailable = { ...fake.helper, port: 1, wsUrl: "ws://127.0.0.1:1" }; const state = await fixture(unavailable);
    const result = await nativeInput(["tap", udid, "21", "42", "--json"], { MEGABRAIN_STATE_DIR: state }, fakeProcess(unavailable).process);
    expect(result.kind).toBe("failed");
    expect((result as { error: string }).error).toMatch(/websocket|connect/i);
  });

  test("rotates the existing helper and reports point dimensions", async () => {
    const fake = await fakeHelper(); const state = await fixture(fake.helper); const { process } = fakeProcess(fake.helper);
    const result = await nativeInput(["rotate", udid, "landscape", "--json"], { MEGABRAIN_STATE_DIR: state }, process);
    expect(result.kind).toBe("ok");
    expect(fake.messages.some((message) => message[0] === 7 && JSON.parse(message.subarray(1).toString()).orientation === "landscape_left")).toBe(true);
    expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toEqual({ ok: true, orientation: "landscape", width: 393, height: 852 });
  });

  test("rejects input while Maestro owns the simulator and names the active run", async () => {
    const fake = await fakeHelper(); const state = await fixture(fake.helper); const worktree = "/tmp/input-maestro-worktree";
    const key = createHash("sha256").update(worktree).digest("hex").slice(0, 16);
    const runDir = join(state, "maestro", key, "20261017-run");
    const { mkdir } = await import("node:fs/promises"); await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), JSON.stringify({ runId: "active-run-7", flow: "flow.yaml", worktree, device: udid, pid: process.pid, state: "running", startedAt: new Date().toISOString() }));
    const result = await nativeInput(["tap", udid, "2", "3", "--json"], { MEGABRAIN_STATE_DIR: state }, fakeProcess(fake.helper).process);
    expect(result.kind).toBe("failed");
    expect((result as { error: string }).error).toContain("active-run-7");
  });
});
