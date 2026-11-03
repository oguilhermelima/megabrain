import { describe, expect, test } from "bun:test";
import { planWeb } from "../../src/core/web.js";
import { executeWeb } from "../../src/cli/commands/web.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

describe("planWeb", () => {
  test.each([
    [{ stdinIsTTY: false, stdoutIsTTY: true }, {}],
    [{ stdinIsTTY: true, stdoutIsTTY: false }, {}],
    [{ stdinIsTTY: true, stdoutIsTTY: true }, { MEGABRAIN_DISPATCH_ID: "dispatch-test" }],
  ] as const)("refuses session save for terminal context %j", async (terminal, environment) => {
    let invoked = false;
    const processAdapter: ProcessAdapter = {
      async run() { invoked = true; return { kind: "ok", value: { stdout: "", stderr: "", exitCode: 0 } }; },
      async startDetached() { return { kind: "ok", value: undefined }; }, invocationCount() { return 0; },
    };
    const result = await executeWeb(["session", "save"], environment, processAdapter, terminal);
    expect(result.kind).toBe("failed");
    expect(invoked).toBe(false);
  });

  test("allows session save in an interactive terminal", async () => {
    let invoked = false;
    const processAdapter: ProcessAdapter = {
      async run() { invoked = true; return { kind: "ok", value: { stdout: "", stderr: "", exitCode: 0 } }; },
      async startDetached() { return { kind: "ok", value: undefined }; }, invocationCount() { return 0; },
    };
    const result = await executeWeb(["session", "save"], {}, processAdapter, { stdinIsTTY: true, stdoutIsTTY: true });
    expect(result.kind).toBe("ok");
    expect(invoked).toBe(true);
  });

  test("refuses session save from a dispatch", async () => {
    let invoked = false;
    const processAdapter: ProcessAdapter = {
      async run() { invoked = true; return { kind: "ok", value: { stdout: "", stderr: "", exitCode: 0 } }; },
      async startDetached() { return { kind: "ok", value: undefined }; }, invocationCount() { return 0; },
    };
    const result = await executeWeb(["session", "save"], { MEGABRAIN_DISPATCH_ID: "dispatch-test" }, processAdapter);
    expect(result).toMatchObject({ kind: "failed", error: expect.stringContaining("web capture/measure --storage-state") });
    expect(invoked).toBe(false);
  });
  test.each([
    [["devices", "list"], { command: "device-list", args: ["--filter", ""] }],
    [["devices", "list", "--json"], { command: "device-list", args: ["--filter", "", "--json"] }],
    [["devices", "iphone"], { command: "device-list", args: ["--filter", "iphone"] }],
    [["devices", "list", "--orientation", "landscape"], { command: "device-list", args: ["--filter", "", "--orientation", "landscape"] }],
    [["devices", "add", "studio", "--viewport", "1280x720", "--source", "test"], { command: "device-add", args: ["studio", "--viewport", "1280x720", "--source", "test"] }],
    [["devices", "remove", "studio"], { command: "device-remove", args: ["studio"] }],
    [["viewport", "set", "--browser", "chromium", "--width", "390", "--height", "844"], { command: "viewport-set", args: ["--browser", "chromium", "--width", "390", "--height", "844"] }],
    [["viewport", "show", "--browser", "firefox"], { command: "viewport-show", args: ["--browser", "firefox"] }],
    [["userscript", "install", "hello.user.js", "--device", "iphone15"], { command: "userscript-install", args: ["--file", "hello.user.js", "--device", "iphone15"] }],
    [["userscript", "list"], { command: "userscript-list", args: [] }],
    [["userscript", "remove", "hello.user.js"], { command: "userscript-remove", args: ["--file", "hello.user.js"] }],
    [["capture", "--url", "https://example.com", "--screen", "home"], { command: "capture", args: ["--url", "https://example.com", "--screen", "home"] }],
    [["capture", "--url", "http://fixture.test", "--screen", "home", "--settle", "scroll"], { command: "capture", args: ["--url", "http://fixture.test", "--screen", "home", "--settle", "scroll"] }],
    [["measure", "--url", "http://fixture.test", "--screen", "home", "--settle", "scroll"], { command: "measure", args: ["--url", "http://fixture.test", "--screen", "home", "--settle", "scroll"] }],
    [["session", "save", "--url", "https://example.com", "--output", "state.json"], { command: "session-save", args: ["--url", "https://example.com", "--output", "state.json"] }],
  ] as const)("assembles %j", (input, expected) => {
    expect(planWeb(input)).toEqual({ kind: "run", ...expected });
  });

  test("supports the shorthand viewport flags", () => {
    expect(planWeb(["--category", "mobile"])).toEqual({ kind: "run", command: "viewport-set", args: ["--category", "mobile"] });
  });

  test.each([
    [["unknown"], "unknown web command: unknown"],
    [["viewport", "set", "--orientation"], "Usage: megabrain web-viewport-set"],
    [["userscript", "install"], "Usage: megabrain web-userscript-install"],
    [["userscript", "list", "extra"], "Usage: megabrain web-userscript-list"],
    [["session", "nope"], "Usage: megabrain web-session"],
  ] as const)("rejects %j", (input, message) => {
    expect(planWeb(input)).toEqual({ kind: "usage", message });
  });

  test("returns help without spawning", () => {
    expect(planWeb(["--help"])).toEqual({ kind: "help" });
  });

  test("formats device presets as the web device page contract", async () => {
    const moduleUrl = new URL("../../scripts/playwright-web.mjs", import.meta.url).href;
    const { formatDevicePresets } = await import(moduleUrl);
    expect(formatDevicePresets([
      { slug: "iphone16", label: "iPhone 16", kind: "registry", registry: "iPhone 16", category: "mobile", viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true },
      { slug: "office", label: "office", kind: "custom", category: "desktop", viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2, isMobile: false },
    ])).toEqual({ devices: [
      { slug: "iphone16", label: "iPhone 16", category: "mobile", origin: "registry:iPhone 16", width: 393, height: 852, scale: 3, mobile: true },
      { slug: "office", label: "office", category: "desktop", origin: "custom", width: 1512, height: 982, scale: 2, mobile: false },
    ] });
  });

  test("keeps registry scale and rotates custom presets in landscape", async () => {
    const moduleUrl = new URL("../../scripts/playwright-web.mjs", import.meta.url).href;
    const { listDevicePresets, resolveDeviceDescriptor } = await import(moduleUrl);
    expect(listDevicePresets({ "iPhone 17": { viewport: { width: 402, height: 681 }, deviceScaleFactor: 3, isMobile: true } }, { filter: "iphone17" })[0]).toMatchObject({ deviceScaleFactor: 3, isMobile: true });
    expect(resolveDeviceDescriptor({ device: "office", orientation: "landscape" }, {}, { office: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false, source: "test" } }).viewport).toEqual({ width: 720, height: 1280 });
  });
});
