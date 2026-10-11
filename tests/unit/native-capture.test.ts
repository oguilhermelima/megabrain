import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeNative } from "../../src/cli/commands/native.js";
import { ok, failed } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { buildNativeCapturePaths, buildNativeCaptureRecord, decideCaptureOutcome } from "../../src/core/native-capture.js";

async function runCaptureFixture(hashes: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "megabrain-native-capture-test-"));
  await mkdir(join(root, ".megabrain"));
  let route = "/";
  let screenshotIndex = 0;
  const calls: string[] = [];
  const navigatedRoutes: string[] = [];
  const screensPath = join(root, "screens.json");
  await writeFile(screensPath, JSON.stringify([{ name: "home", route: "/home" }, { name: "settings", route: "/settings" }]));
  const server = Bun.serve({
    port: 0,
    fetch(request, serverInstance) {
      const url = new URL(request.url);
      if (url.pathname === "/json/list") return Response.json([{ webSocketDebuggerUrl: `ws://127.0.0.1:${serverInstance.port}/inspector` }]);
      if (url.pathname === "/inspector" && serverInstance.upgrade(request)) return undefined;
      return new Response("missing", { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(String(message)) as { id: number; params?: { expression?: string } };
        const expression = request.params?.expression ?? "";
        let value: unknown = undefined;
        if (expression.includes("megabrain:route-info")) value = { pathname: route, params: {} };
        else if (expression.includes("megabrain:navigate")) {
          const match = expression.match(/modules\.router\.navigate\((".*?")\)/);
          if (match?.[1]) {
            route = JSON.parse(match[1]) as string;
            navigatedRoutes.push(route);
          }
          value = undefined;
        } else if (expression.includes("megabrain:navigation-queue")) value = 0;
        else if (expression.includes("megabrain:logbox")) value = { present: false };
        else if (expression.includes("megabrain:dev-loading-view")) value = { present: false };
        else value = 2;
        socket.send(JSON.stringify({ id: request.id, result: { result: { value } } }));
      },
    },
  });
  await writeFile(join(root, ".megabrain", "native.json"), JSON.stringify({ version: 1, surfaces: { phone: { bundleId: "com.example.app", metroPort: String(server.port), device: "phone" } } }));
  const processAdapter: ProcessAdapter = {
    async run(command, args) {
      calls.push([command, ...args].join(" "));
      if (command === "git" && args.includes("--show-toplevel")) return ok({ stdout: `${root}\n`, stderr: "", exitCode: 0 });
      if (command === "git") return ok({ stdout: "abc123\n", stderr: "", exitCode: 0 });
      if (command === "xcrun" && args.join(" ") === "simctl list devices --json") return ok({ stdout: JSON.stringify({ devices: { "iOS-27": [{ udid: "phone", state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
      if (command === "xcrun" && args[0] === "simctl" && args[1] === "terminate") return ok({ stdout: "", stderr: "", exitCode: 0 });
      if (command === "xcrun" && args[0] === "simctl" && args[1] === "launch") return ok({ stdout: "", stderr: "", exitCode: 0 });
      if (command === "xcrun" && args[0] === "simctl" && args[1] === "io" && args[3] === "screenshot") {
        await writeFile(args[4] as string, "fake frame");
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      }
      if (command === "shasum") {
        const hash = hashes[Math.min(screenshotIndex, hashes.length - 1)] ?? "empty";
        screenshotIndex += 1;
        return ok({ stdout: `${hash}  ${args.at(-1)}\n`, stderr: "", exitCode: 0 });
      }
      return failed(`${command} unavailable`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
  try {
    const result = await executeNative(["capture", "phone", "--screens", screensPath, "--output-root", join(root, "captures"), "--capture-id", "test", "--timeout", "2", "--stable-window", "0.001", "--json"], { MEGABRAIN_NATIVE_WORKTREE: root }, processAdapter);
    return { result, calls, screenshotCount: screenshotIndex, navigatedRoutes };
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

describe("native capture distinctness", () => {
  test("fails when two screens share a hash and names both screens", () => {
    const outcome = decideCaptureOutcome({
      controlHash: "control",
      screens: [
        { name: "home", hash: "same" },
        { name: "settings", hash: "same" },
      ],
    });

    expect(outcome.failed).toBe(true);
    expect(outcome.duplicateGroups).toEqual([["home", "settings"]]);
    expect(outcome.failureReasons).toContain("screens share a hash: home, settings");
  });

  test("fails a screen matching the control frame distinctly from a duplicate", () => {
    const outcome = decideCaptureOutcome({
      controlHash: "launch",
      screens: [
        { name: "home", hash: "launch" },
        { name: "settings", hash: "settings" },
      ],
    });

    expect(outcome.failed).toBe(true);
    expect(outcome.controlMatches).toEqual(["home"]);
    expect(outcome.duplicateGroups).toEqual([]);
    expect(outcome.failureReasons).not.toContain("screen matches the control frame: home");
  });

  test("reports exact captured and distinct counts and duplicate groups", () => {
    const outcome = decideCaptureOutcome({
      controlHash: "control",
      screens: [
        { name: "home", hash: "home" },
        { name: "settings", hash: "settings" },
        { name: "profile", hash: "home" },
      ],
    });

    expect(outcome.captured).toBe(3);
    expect(outcome.distinct).toBe(2);
    expect(outcome.summary).toBe("3 captured, 2 distinct, groups: home, profile");
  });

  test("succeeds when every screen is distinct and differs from control", () => {
    const outcome = decideCaptureOutcome({
      controlHash: "control",
      screens: [
        { name: "home", hash: "home" },
        { name: "settings", hash: "settings" },
      ],
    });

    expect(outcome.failed).toBe(false);
    expect(outcome.captured).toBe(2);
    expect(outcome.distinct).toBe(2);
    expect(outcome.duplicateGroups).toEqual([]);
    expect(outcome.summary).toBe("2 captured, 2 distinct");
  });
});

describe("native capture paths", () => {
  test("builds the surface, capture, theme, viewport, and screen layout", () => {
    expect(buildNativeCapturePaths({
      outputRoot: "/tmp/captures",
      surface: "phone",
      captureId: "2026-09-20",
      theme: "dark",
      viewport: "390x844",
      screen: "settings",
    })).toEqual({
      directory: "/tmp/captures/phone/2026-09-20",
      image: "/tmp/captures/phone/2026-09-20/dark/390x844/settings.png",
      manifest: "/tmp/captures/phone/2026-09-20/manifest.json",
    });
  });

  test("builds a complete per-screen record with absolute image path and routes", () => {
    const paths = buildNativeCapturePaths({
      outputRoot: "/tmp/captures",
      surface: "tv",
      captureId: "2026-09-21T00-09-02-595Z",
      theme: "light",
      viewport: "1920x1080",
      screen: "browse",
    });

    expect(buildNativeCaptureRecord({
      paths,
      name: "browse",
      hash: "hash-browse",
      stableDurationMs: 1000,
      sampleCount: 3,
      requestedRoute: "/browse",
      reachedPathname: "/browse",
    })).toEqual({
      name: "browse",
      hash: "hash-browse",
      stableDurationMs: 1000,
      sampleCount: 3,
      image: "/tmp/captures/tv/2026-09-21T00-09-02-595Z/light/1920x1080/browse.png",
      requestedRoute: "/browse",
      reachedPathname: "/browse",
    });
  });
});

describe("native capture loop", () => {
  test("captures control after termination, retries a duplicate through a neutral route, and exits only on distinct screens", async () => {
    const { result, calls, screenshotCount, navigatedRoutes } = await runCaptureFixture(["control", "home", "home", "home", "home", "settings", "settings", "settings", "settings"]);
    expect(result.kind).toBe("ok");
    expect(result.value).toContain('"ok":true');
    const controlScreenshot = calls.findIndex((call) => call.includes("simctl io phone screenshot"));
    const firstTermination = calls.findIndex((call) => call.includes("simctl terminate phone com.example.app"));
    expect(firstTermination).toBeLessThan(controlScreenshot);
    expect(calls.filter((call) => call.includes("simctl terminate phone com.example.app"))).toHaveLength(4);
    expect(calls.some((call) => call.includes("simctl launch phone com.example.app"))).toBe(true);
    expect(navigatedRoutes).toEqual(["/home", "/settings", "/", "/settings"]);
    expect(screenshotCount).toBeGreaterThanOrEqual(7);
  });

  test("fails the capture when control comparison or retry still finds a duplicate", async () => {
    const controlMatch = await runCaptureFixture(["control", "control", "control", "control", "other", "other", "other"]);
    expect(controlMatch.result.kind).toBe("ok");
    expect(controlMatch.result.exitCode).toBe(1);
    expect(controlMatch.result.value).toContain("control frame");

    const duplicate = await runCaptureFixture(["control", "same", "same", "same", "same", "same", "same", "same", "same", "same", "same", "same", "same"]);
    expect(duplicate.result.kind).toBe("ok");
    expect(duplicate.result.exitCode).toBe(1);
    expect(duplicate.result.value).toContain("duplicates the previous screen");
  });
});
