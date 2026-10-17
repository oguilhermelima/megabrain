import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { nativeInput } from "../../src/cli/commands/native/input.js";
import { appiumInputSessionCapabilities } from "../../src/cli/commands/native/session.js";
import { ok, failed } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

const directories: string[] = [];
const udid = "11111111-1111-4111-8111-111111111111";
async function fixture() { const directory = await mkdtemp(join(tmpdir(), "native-input-")); directories.push(directory); await writeFile(join(directory, "native-input-sessions.json"), JSON.stringify({ version: 1, sessions: [{ udid, session: "sess-1", platform: "iOS" }] })); return directory; }
function fakeProcess() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const process: ProcessAdapter = {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === "xcrun") return ok({ stdout: JSON.stringify({ devices: { "iOS 18": [{ udid, state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
      if (args.some((arg) => arg.endsWith("/screenshot"))) { const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(1179, 16); png.writeUInt32BE(2556, 20); return ok({ stdout: `${JSON.stringify({ value: png.toString("base64") })}\n200`, stderr: "", exitCode: 0 }); }
      if (args.some((arg) => arg.endsWith("/window/size"))) return ok({ stdout: '{"value":{"width":393,"height":852}}\n200', stderr: "", exitCode: 0 });
      if (command !== "curl") return failed("unexpected process");
      if (args.includes("-X") && args[args.indexOf("-X") + 1] === "GET") return ok({ stdout: '{"value":{}}\n200', stderr: "", exitCode: 0 });
      if (args.includes("-X") && args[args.indexOf("-X") + 1] === "DELETE") return ok({ stdout: '{"value":null}\n200', stderr: "", exitCode: 0 });
      return ok({ stdout: '{"value":null}\n200', stderr: "", exitCode: 0 });
    },
    async startDetached() { return failed("not expected"); },
    invocationCount() { return calls.length; },
  };
  return { process, calls };
}

afterEach(async () => { while (directories.length) { const directory = directories.pop(); if (directory) await rm(directory, { recursive: true, force: true }); } });

describe("native input scenarios", () => {
  test("assigns each simulator its own WDA port and allows time for a cold WDA launch", () => {
    const first = appiumInputSessionCapabilities("iOS", udid);
    const second = appiumInputSessionCapabilities("iOS", "22222222-2222-4222-8222-222222222222");
    expect(first["appium:wdaLocalPort"]).toEqual(expect.any(Number));
    expect(first["appium:wdaLocalPort"]).not.toBe(second["appium:wdaLocalPort"]);
    expect(first["appium:wdaLaunchTimeout"]).toBeGreaterThanOrEqual(120_000);
    expect(first["appium:mjpegServerPort"]).toEqual(expect.any(Number));
    expect(first["appium:mjpegServerPort"]).not.toBe(second["appium:mjpegServerPort"]);
    expect(first["appium:isHeadless"]).toBe(true);
  });

  test("attaches to the existing iOS and tvOS homescreen without launching an app", () => {
    for (const [platform, udid, bundleId] of [
      ["iOS", "phone"],
      ["tvOS", "tv"],
    ] as const) {
      const capabilities = appiumInputSessionCapabilities(platform, udid);
      expect(capabilities["appium:isHeadless"]).toBe(true);
      expect(capabilities["appium:autoLaunch"]).toBe(false);
      expect(capabilities["appium:forceAppLaunch"]).toBe(false);
      expect(capabilities["appium:noReset"]).toBe(true);
    }
  });

  test("reuses its saved session, sends device point coordinates, and deletes it on stop", async () => {
    const state = await fixture(); const { process, calls } = fakeProcess(); const env = { MEGABRAIN_STATE_DIR: state };
    const start = await nativeInput(["start", udid, "--json"], env, process);
    expect(start.kind).toBe("ok");
    expect(JSON.parse((start as { value: string }).value)).toMatchObject({ session: "sess-1" });
    const tap = await nativeInput(["tap", udid, "21", "42", "--json"], env, process);
    expect(tap.kind).toBe("ok");
    const tapCall = calls.find((call) => call.args.some((arg) => arg.includes("/execute/sync")));
    expect(tapCall?.args.at(-1)).toBe(JSON.stringify({ script: "mobile: tap", args: [{ x: 21, y: 42 }] }));
    await nativeInput(["swipe", udid, "1", "2", "3", "4", "--duration", "250", "--json"], env, process);
    const swipeCall = calls.find((call) => call.args.some((arg) => arg.endsWith("/actions")));
    expect(swipeCall?.args.at(-1)).toBe(JSON.stringify({ actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: [{ type: "pointerMove", duration: 0, x: 1, y: 2 }, { type: "pointerDown", button: 0 }, { type: "pointerMove", duration: 250, x: 3, y: 4 }, { type: "pointerUp", button: 0 }] }] }));
    await nativeInput(["scroll", udid, "10", "20", "0", "-30", "--json"], env, process);
    expect(calls.at(-1)?.args.at(-1)).toBe(JSON.stringify({ actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: [{ type: "pointerMove", duration: 0, x: 10, y: 20 }, { type: "pointerDown", button: 0 }, { type: "pointerMove", duration: 400, x: 10, y: -10 }, { type: "pointerUp", button: 0 }] }] }));
    await nativeInput(["type", udid, "hello", "world", "--json"], env, process);
    expect(calls.at(-1)?.args.at(-1)).toBe(JSON.stringify({ value: ["h", "e", "l", "l", "o", " ", "w", "o", "r", "l", "d"] }));
    await nativeInput(["key", udid, "return", "--json"], env, process);
    expect(calls.at(-1)?.args.at(-1)).toBe(JSON.stringify({ value: ["\n"] }));
    await nativeInput(["button", udid, "home", "--json"], env, process);
    expect(calls.at(-1)?.args.at(-1)).toBe(JSON.stringify({ script: "mobile: pressButton", args: [{ name: "home" }] }));
    const frame = await nativeInput(["frame", udid, "--json"], env, process);
    expect(JSON.parse((frame as { value: string }).value)).toMatchObject({ width: 1179, height: 2556, scale: 3 });
    await nativeInput(["stop", udid, "--json"], env, process);
    expect(JSON.parse(await readFile(join(state, "native-input-sessions.json"), "utf8")).sessions).toEqual([]);
  });

  test("rejects input while Maestro owns the simulator and names the active run", async () => {
    const state = await fixture(); const worktree = "/tmp/input-maestro-worktree";
    const key = createHash("sha256").update(worktree).digest("hex").slice(0, 16);
    const runDir = join(state, "maestro", key, "20261017-run");
    const { mkdir } = await import("node:fs/promises"); await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), JSON.stringify({ runId: "active-run-7", flow: "flow.yaml", worktree, device: udid, pid: process.pid, state: "running", startedAt: new Date().toISOString() }));
    const result = await nativeInput(["tap", udid, "2", "3", "--json"], { MEGABRAIN_STATE_DIR: state }, fakeProcess().process);
    expect(result.kind).toBe("failed");
    expect((result as { error: string }).error).toContain("active-run-7");
  });
});
