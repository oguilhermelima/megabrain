import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeNative } from "../../src/cli/commands/native.js";
import { openDatabase } from "../../src/db/db.js";
import { listNativeSessions } from "../../src/db/queries/native-sessions.js";
import { ok, failed } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "megabrain-native-session-"));
  fixtures.push(directory);
  return directory;
}

async function seed(directory: string, sessions: readonly { readonly udid: string; readonly bundleId: string; readonly sessionId: string }[]): Promise<void> {
  await writeFile(join(directory, "native-sessions.json"), `${JSON.stringify({ version: 1, sessions })}\n`);
}

function processStub(options: { readonly dead?: ReadonlySet<string>; readonly postDelay?: number; readonly kind?: "phone" | "tv" } = {}): ProcessAdapter & { readonly calls: readonly { readonly command: string; readonly args: readonly string[] }[] } {
  const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  let created = 0;
  const dead = options.dead ?? new Set<string>();
  const kind = options.kind ?? "phone";
  const device = kind === "tv" ? "tv-one" : "one";
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { [kind === "tv" ? "tvOS-1" : "iOS-1"]: [{ udid: device, state: "Booted", name: kind === "tv" ? "Apple TV" : "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
      if (command === "xcrun" && args[1] === "spawn") return ok({ stdout: kind === "tv" ? "com.example.tv" : "com.example.app", stderr: "", exitCode: 0 });
      if (command === "curl" && args.includes("http://127.0.0.1:4723/session")) {
        if (options.postDelay !== undefined) await new Promise((resolve) => setTimeout(resolve, options.postDelay));
        created += 1;
        return ok({ stdout: `${JSON.stringify({ value: { sessionId: `created-${created}` } })}\n200`, stderr: "", exitCode: 0 });
      }
      if (command === "curl" && args.some((arg) => arg.startsWith("http://127.0.0.1:4723/session/")) && !args.some((arg) => arg.endsWith("/source"))) {
        const sessionId = args.find((arg) => arg.startsWith("http://127.0.0.1:4723/session/"))?.slice("http://127.0.0.1:4723/session/".length) ?? "";
        return dead.has(sessionId) ? failed("404 invalid session id") : ok({ stdout: JSON.stringify({ value: { id: sessionId } }), stderr: "", exitCode: 0 });
      }
      if (command === "curl" && args.some((arg) => arg.endsWith("/source"))) return ok({ stdout: "<XCUIElementTypeWindow/><XCUIElementTypeButton/>\n200", stderr: "", exitCode: 0 });
      return failed(`${command} unavailable`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount: () => calls.length,
  };
}

function statefulServerProcessStub(): ProcessAdapter & { readonly calls: readonly { readonly command: string; readonly args: readonly string[] }[] } {
  const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  const live = new Set<string>();
  let created = 0;
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { "iOS-1": [{ udid: "one", state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
      if (command === "xcrun" && args[1] === "spawn") return ok({ stdout: "com.example.app", stderr: "", exitCode: 0 });
      if (command === "curl" && args.includes("http://127.0.0.1:4723/session")) {
        created += 1;
        const sessionId = `created-${created}`;
        live.add(sessionId);
        return ok({ stdout: `${JSON.stringify({ value: { sessionId } })}\n200`, stderr: "", exitCode: 0 });
      }
      if (command === "curl" && args[1] === "-X" && args[2] === "DELETE") {
        const sessionId = args[3]?.slice("http://127.0.0.1:4723/session/".length);
        if (sessionId !== undefined) live.delete(sessionId);
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      }
      if (command === "curl" && args.some((arg) => arg.startsWith("http://127.0.0.1:4723/session/")) && !args.some((arg) => arg.endsWith("/source"))) {
        const sessionId = args.find((arg) => arg.startsWith("http://127.0.0.1:4723/session/"))?.slice("http://127.0.0.1:4723/session/".length) ?? "";
        return live.has(sessionId) ? ok({ stdout: JSON.stringify({ value: { id: sessionId } }), stderr: "", exitCode: 0 }) : failed("404 invalid session id");
      }
      if (command === "curl" && args.some((arg) => arg.endsWith("/source"))) return ok({ stdout: "<XCUIElementTypeWindow/><XCUIElementTypeButton/>\n200", stderr: "", exitCode: 0 });
      return failed(`${command} unavailable`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount: () => calls.length,
  };
}

async function health(directory: string, processAdapter: ProcessAdapter, kind: "phone" | "tv" = "phone"): Promise<void> {
  const result = await executeNative(["health", kind, "--bundle-id", kind === "tv" ? "com.example.tv" : "com.example.app", "--device", kind === "tv" ? "tv-one" : "one"], { MEGABRAIN_STATE_DIR: directory }, processAdapter);
  expect(result.kind).toBe("ok");
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const directory = fixtures.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

describe("native Appium session store", () => {
  test("reuses a verified session without creating another one", async () => {
    const directory = await fixture();
    await seed(directory, [{ udid: "one", bundleId: "com.example.app", sessionId: "live-session" }]);
    const processAdapter = processStub();

    await health(directory, processAdapter);

    const posts = processAdapter.calls.filter((call) => call.command === "curl" && call.args.includes("http://127.0.0.1:4723/session"));
    expect(posts).toHaveLength(0);
    expect(processAdapter.calls.some((call) => call.args[1] === "http://127.0.0.1:4723/session/live-session")).toBe(true);
  });

  test("drops a dead entry, creates a session, and persists only the new id", async () => {
    const directory = await fixture();
    await seed(directory, [{ udid: "one", bundleId: "com.example.app", sessionId: "dead-session" }]);
    const processAdapter = processStub({ dead: new Set(["dead-session"]) });

    await health(directory, processAdapter);

    const posts = processAdapter.calls.filter((call) => call.command === "curl" && call.args.includes("http://127.0.0.1:4723/session"));
    expect(posts).toHaveLength(1);
    const database = openDatabase({ MEGABRAIN_STATE_DIR: directory });
    expect(database).toBeDefined();
    expect(database === undefined ? [] : listNativeSessions(database)).toEqual([{ udid: "one", bundleId: "com.example.app", sessionId: "created-1" }]);
    database?.close();
  });

  test("reuses the session produced by the previous health call", async () => {
    const directory = await fixture();
    const processAdapter = statefulServerProcessStub();

    await health(directory, processAdapter);
    await health(directory, processAdapter);

    const posts = processAdapter.calls.filter((call) => call.command === "curl" && call.args.includes("http://127.0.0.1:4723/session"));
    expect(posts).toHaveLength(1);
  });

  test("sends the complete headless capability set for every new session", async () => {
    const directory = await fixture();
    const processAdapter = processStub();

    await health(directory, processAdapter);

    const post = processAdapter.calls.find((call) => call.command === "curl" && call.args.includes("http://127.0.0.1:4723/session"));
    expect(post).toBeDefined();
    expect(JSON.parse(post?.args.at(-1) ?? "{}")).toEqual({ capabilities: { alwaysMatch: { platformName: "iOS", "appium:automationName": "XCUITest", "appium:isHeadless": true, "appium:newCommandTimeout": 60, "appium:udid": "one", "appium:bundleId": "com.example.app" } } });
  });

  test("sends tvOS for a tv session", async () => {
    const directory = await fixture();
    const processAdapter = processStub({ kind: "tv" });

    await health(directory, processAdapter, "tv");

    const post = processAdapter.calls.find((call) => call.command === "curl" && call.args.includes("http://127.0.0.1:4723/session"));
    expect(post).toBeDefined();
    expect(JSON.parse(post?.args.at(-1) ?? "{}")).toEqual({ capabilities: { alwaysMatch: { platformName: "tvOS", "appium:automationName": "XCUITest", "appium:isHeadless": true, "appium:newCommandTimeout": 60, "appium:udid": "tv-one", "appium:bundleId": "com.example.tv" } } });
  });

  test("serializes concurrent writers so one live session is shared", async () => {
    const directory = await fixture();
    const processAdapter = processStub({ postDelay: 10 });

    await Promise.all([health(directory, processAdapter), health(directory, processAdapter)]);

    const posts = processAdapter.calls.filter((call) => call.command === "curl" && call.args.includes("http://127.0.0.1:4723/session"));
    expect(posts).toHaveLength(1);
    const database = openDatabase({ MEGABRAIN_STATE_DIR: directory });
    expect(database).toBeDefined();
    expect(database === undefined ? [] : listNativeSessions(database)).toHaveLength(1);
    database?.close();
  });

  test("creates and cleans up without reuse when no state directory is resolvable", async () => {
    const directory = await fixture();
    const stateful = processStub();
    const stateless = processStub();
    const statefulResult = await executeNative(["health", "phone", "--bundle-id", "com.example.app", "--device", "one"], { MEGABRAIN_STATE_DIR: directory }, stateful);
    const statelessResult = await executeNative(["health", "phone", "--bundle-id", "com.example.app", "--device", "one"], { MEGABRAIN_STATE_DIR: "", HOME: directory }, stateless);

    expect(statelessResult).toEqual(statefulResult);
    expect(stateless.calls.filter((call) => call.command === "curl" && call.args.includes("http://127.0.0.1:4723/session")).length).toBe(1);
    expect(stateless.calls.some((call) => call.command === "curl" && call.args[1] === "-X" && call.args[2] === "DELETE")).toBe(true);
});
});
