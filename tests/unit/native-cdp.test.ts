import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, test } from "bun:test";
import { connectMetroInspector } from "../../src/core/native-cdp.js";
import { executeNative } from "../../src/cli/commands/native.js";
import { failed, ok } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

type FakeTarget = "none" | "probe" | "hang" | "unchanged" | "queued" | "queued-hang" | "changed" | "delayed" | "delayed-queued" | "capture-growing" | "capture-shrinking";
type FakeMetro = {
  readonly port: number;
  readonly origins: string[];
  readonly evaluations: string[];
  readonly routeInfoReads: number;
  readonly navigationCalls: number;
  readonly listRequests: number;
  readonly close: () => Promise<void>;
  readonly setTargets: (targets: FakeTarget) => void;
};

const servers: FakeMetro[] = [];

async function fakeMetro(initialTargets: FakeTarget): Promise<FakeMetro> {
  const http = createServer();
  const sockets = new Set<WebSocket>();
  const wsServer = new WebSocketServer({ noServer: true });
  const origins: string[] = [];
  const evaluations: string[] = [];
  const rawSockets = new Set<Socket>();
  let targets = initialTargets;
  let listRequests = 0;
  let routeInfoReads = 0;
  let navigationCalls = 0;

  const currentRoute = { pathname: "/home", segments: ["(tabs)", "home"], params: {} };
  const changedRoute = { pathname: "/home", segments: ["(tabs)", "home"], params: { filter: "favorites" } };

  const routeInfo = () => {
    const read = routeInfoReads++;
    if (targets === "changed" && read > 0) return changedRoute;
    if ((targets === "delayed" || targets === "delayed-queued") && read > 1) return changedRoute;
    return currentRoute;
  };

  const sendProbeResult = (socket: WebSocket, message: string) => {
    const request = JSON.parse(message) as { id?: number; method?: string; params?: { expression?: string } };
    if (request.method !== "Runtime.evaluate" || request.id === undefined) return;
    const expression = request.params?.expression ?? "";
    evaluations.push(expression);
    if (expression.startsWith("throw")) {
      socket.send(JSON.stringify({ id: request.id, result: { exceptionDetails: { text: "Uncaught Error: boom" } } }));
      return;
    }
    const value = expression === "1+1" ? 2 : expression.includes("megabrain:navigate") ? (navigationCalls += 1, { ok: true }) : expression.includes("megabrain:navigation-queue") && targets !== "queued-hang" ? (
      targets === "queued" ? 3
        : targets === "delayed-queued" ? 2
          : targets === "capture-growing" ? navigationCalls * 2
            : targets === "capture-shrinking" ? Math.max(0, 8 - navigationCalls * 2)
              : 0
    ) : expression.includes("megabrain:route-info") ? routeInfo() : expression.includes("megabrain:navigation-state") ? { key: "same-route", name: "home" } : undefined;
    if (value !== undefined) socket.send(JSON.stringify({ id: request.id, result: { result: { type: typeof value === "number" ? "number" : "object", value } } }));
  };

  wsServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("message", (message) => {
      if (targets !== "none" && targets !== "hang") sendProbeResult(socket, message.toString());
    });
    socket.on("close", () => sockets.delete(socket));
  });

  http.on("request", (request, response) => {
    if (request.url !== "/json/list") {
      response.writeHead(404).end();
      return;
    }
    listRequests += 1;
    const target = targets === "none" ? [] : [{ id: "target", webSocketDebuggerUrl: `ws://127.0.0.1:${(http.address() as { port: number }).port}/inspector/debug?target=target` }];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(target));
  });

  http.on("upgrade", (request: IncomingMessage, socket, head) => {
    rawSockets.add(socket);
    socket.once("close", () => rawSockets.delete(socket));
    const origin = request.headers.origin;
    if (origin === undefined) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    origins.push(origin);
    wsServer.handleUpgrade(request, socket, head, (websocket) => wsServer.emit("connection", websocket, request));
  });

  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const port = (http.address() as { port: number }).port;
  const server: FakeMetro = {
    port,
    origins,
    evaluations,
    get routeInfoReads() { return routeInfoReads; },
    get navigationCalls() { return navigationCalls; },
    get listRequests() { return listRequests; },
    setTargets(value) { targets = value; },
    async close() {
      for (const socket of sockets) socket.terminate();
      for (const socket of rawSockets) socket.destroy();
      wsServer.close();
      http.closeAllConnections();
      if (http.listening) await new Promise<void>((resolve, reject) => http.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
    },
  };
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

describe("Metro inspector transport", () => {
  test("fails within its deadline when the listing has no target", async () => {
    const server = await fakeMetro("none");
    const started = performance.now();

    const result = await connectMetroInspector(server.port, 120);

    expect(result.kind).toBe("failed");
    expect(performance.now() - started).toBeLessThan(600);
    expect(server.listRequests).toBeGreaterThan(0);
  });

  test("fails within its deadline when a socket never answers the runtime probe", async () => {
    const server = await fakeMetro("hang");
    const started = performance.now();

    const result = await connectMetroInspector(server.port, 120);

    expect(result.kind).toBe("failed");
    expect(performance.now() - started).toBeLessThan(600);
    expect(server.listRequests).toBeGreaterThan(0);
  });

  test("sends an accepted Origin and trusts the socket only after 1+1 answers", async () => {
    const server = await fakeMetro("probe");

    const result = await connectMetroInspector(server.port, 500);

    expect(result.kind).toBe("ok");
    expect(server.origins).toEqual([`http://127.0.0.1:${server.port}`]);
    if (result.kind === "ok") result.value.close();
  });

  test("rereads the target listing after an unresponsive target", async () => {
    const server = await fakeMetro("hang");
    setTimeout(() => server.setTargets("probe"), 90);

    const result = await connectMetroInspector(server.port, 700);

    expect(result.kind).toBe("ok");
    expect(server.listRequests).toBeGreaterThan(1);
    if (result.kind === "ok") result.value.close();
  });

  test("keeps an app exception distinct from a transport refusal", async () => {
    const server = await fakeMetro("probe");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-cdp-"));
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    const process: ProcessAdapter = {
      async run(command) { return command === "git" ? failed("git is unavailable") : failed(`${command} should not run`); },
      async startDetached() { return failed("must not start a process"); },
      invocationCount() { return 0; },
    };

    try {
      const value = await executeNative(["eval", "phone", "1+1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree, MEGABRAIN_NATIVE_DEFAULT_TIMEOUT: "1" }, process);
      const exception = await executeNative(["eval", "phone", "throw new Error('boom')", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree, MEGABRAIN_NATIVE_DEFAULT_TIMEOUT: "1" }, process);

      expect(value.kind).toBe("ok");
      expect(exception.kind).toBe("ok");
      if (value.kind === "ok") expect(JSON.parse(value.value)).toMatchObject({ value: 2, exception: null, refusal: null });
      if (exception.kind === "ok") expect(JSON.parse(exception.value)).toMatchObject({ value: null, exception: "Uncaught Error: boom", refusal: null });
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("proves navigation when the reported params change", async () => {
    const server = await fakeMetro("changed");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-cdp-"));
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    const process: ProcessAdapter = {
      async run(command) { return command === "git" ? failed("git is unavailable") : failed(`${command} should not run`); },
      async startDetached() { return failed("must not start a process"); },
      invocationCount() { return 0; },
    };

    try {
      const result = await executeNative(["navigate", "phone", "/home", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree, MEGABRAIN_NATIVE_DEFAULT_TIMEOUT: "1" }, process);

      expect(result.kind).toBe("ok");
      expect(server.routeInfoReads).toBeGreaterThan(1);
      expect(server.evaluations.some((expression) => expression.includes("getRouteInfo"))).toBe(true);
      if (result.kind === "ok") expect(JSON.parse(result.value)).toMatchObject({ before: { pathname: "/home", params: {} }, after: { pathname: "/home", params: { filter: "favorites" } } });
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("reports no route change when the reported route is unchanged", async () => {
    const server = await fakeMetro("unchanged");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-cdp-"));
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    const process: ProcessAdapter = {
      async run(command) { return command === "git" ? failed("git is unavailable") : failed(`${command} should not run`); },
      async startDetached() { return failed("must not start a process"); },
      invocationCount() { return 0; },
    };

    const started = performance.now();
    try {
      const result = await executeNative(["navigate", "phone", "/home"], { MEGABRAIN_NATIVE_WORKTREE: worktree, MEGABRAIN_NATIVE_DEFAULT_TIMEOUT: "1" }, process);

      expect(result.kind).toBe("failed");
      expect(performance.now() - started).toBeLessThan(600);
      expect(server.routeInfoReads).toBeGreaterThan(1);
      expect(server.evaluations.some((expression) => expression.includes("getRouteInfo"))).toBe(true);
      if (result.kind === "failed") {
        expect(result.error).toBe("navigation route did not change: pathname remained /home with params {}; navigation was not queued (navigation queue is empty)");
      }
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("reports when the unchanged route is still queued", async () => {
    const server = await fakeMetro("queued");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-cdp-"));
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    const process: ProcessAdapter = {
      async run(command) { return command === "git" ? failed("git is unavailable") : failed(`${command} should not run`); },
      async startDetached() { return failed("must not start a process"); },
      invocationCount() { return 0; },
    };

    const started = performance.now();
    try {
      const result = await executeNative(["navigate", "phone", "/home"], { MEGABRAIN_NATIVE_WORKTREE: worktree, MEGABRAIN_NATIVE_DEFAULT_TIMEOUT: "1" }, process);

      expect(result.kind).toBe("failed");
      expect(performance.now() - started).toBeLessThan(1250);
      expect(server.evaluations.some((expression) => expression.includes("routingQueue") && expression.includes("snapshot"))).toBe(true);
      if (result.kind === "failed") {
        expect(result.error).toBe("navigation route did not change: pathname remained /home with params {}; navigation was queued but not applied (3 pending actions)");
        expect(result.error).not.toBe("navigation route did not change: pathname remained /home with params {}; navigation was not queued (navigation queue is empty)");
      }
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("keeps the whole navigate operation within its timeout when queue inspection hangs", async () => {
    const server = await fakeMetro("queued-hang");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-cdp-"));
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    const process: ProcessAdapter = {
      async run(command) { return command === "git" ? failed("git is unavailable") : failed(`${command} should not run`); },
      async startDetached() { return failed("must not start a process"); },
      invocationCount() { return 0; },
    };

    const started = performance.now();
    try {
      const result = await executeNative(["navigate", "phone", "/home"], { MEGABRAIN_NATIVE_WORKTREE: worktree, MEGABRAIN_NATIVE_DEFAULT_TIMEOUT: "1" }, process);

      expect(result.kind).toBe("failed");
      expect(performance.now() - started).toBeLessThan(1250);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("polls until the reported route changes", async () => {
    const server = await fakeMetro("delayed");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-cdp-"));
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    const process: ProcessAdapter = {
      async run(command) { return command === "git" ? failed("git is unavailable") : failed(`${command} should not run`); },
      async startDetached() { return failed("must not start a process"); },
      invocationCount() { return 0; },
    };

    try {
      const result = await executeNative(["navigate", "phone", "/home", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree, MEGABRAIN_NATIVE_DEFAULT_TIMEOUT: "1" }, process);

      expect(result.kind).toBe("ok");
      expect(server.routeInfoReads).toBeGreaterThan(2);
      if (result.kind === "ok") expect(JSON.parse(result.value)).toMatchObject({ after: { params: { filter: "favorites" } } });
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("waits with a non-empty queue until the route changes", async () => {
    const server = await fakeMetro("delayed-queued");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-cdp-"));
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    const process: ProcessAdapter = {
      async run(command) { return command === "git" ? failed("git is unavailable") : failed(`${command} should not run`); },
      async startDetached() { return failed("must not start a process"); },
      invocationCount() { return 0; },
    };

    try {
      const result = await executeNative(["navigate", "phone", "/home", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree, MEGABRAIN_NATIVE_DEFAULT_TIMEOUT: "1" }, process);

      expect(result.kind).toBe("ok");
      expect(server.evaluations.filter((expression) => expression.includes("megabrain:navigation-queue")).length).toBeGreaterThan(1);
      if (result.kind === "ok") expect(JSON.parse(result.value)).toMatchObject({ after: { params: { filter: "favorites" } } });
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("stops capture when pending navigation work is not draining", async () => {
    const server = await fakeMetro("capture-growing");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }, { name: "second", route: "/second" }, { name: "third", route: "/third" }]));
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "git") return ok({ stdout: "commit", stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { "iOS-1": [{ udid: "one", state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "io") { await writeFile(args.at(-1) as string, "frame"); return ok({ stdout: "", stderr: "", exitCode: 0 }); }
        if (command === "shasum") return ok({ stdout: "control-hash  frame\n", stderr: "", exitCode: 0 });
        return failed(`${command} should not run`);
      },
      async startDetached() { return failed("must not start a process"); },
      invocationCount() { return 0; },
    };

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      expect(server.navigationCalls).toBe(2);
      if (result.kind === "ok") {
        expect(result.value).toContain("capture stopped early");
        expect(result.value).toContain("screens not attempted: third");
      }
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("continues capture when pending navigation work is draining", async () => {
    const server = await fakeMetro("capture-shrinking");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }, { name: "second", route: "/second" }, { name: "third", route: "/third" }]));
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "git") return ok({ stdout: "commit", stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { "iOS-1": [{ udid: "one", state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "io") { await writeFile(args.at(-1) as string, "frame"); return ok({ stdout: "", stderr: "", exitCode: 0 }); }
        if (command === "shasum") return ok({ stdout: "control-hash  frame\n", stderr: "", exitCode: 0 });
        return failed(`${command} should not run`);
      },
      async startDetached() { return failed("must not start a process"); },
      invocationCount() { return 0; },
    };

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      expect(server.navigationCalls).toBe(3);
      if (result.kind === "ok") expect(result.value).not.toContain("screens not attempted");
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
