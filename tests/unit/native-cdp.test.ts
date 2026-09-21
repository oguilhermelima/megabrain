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

type FakeTarget = "none" | "probe" | "hang" | "unchanged" | "queued" | "queued-hang" | "changed" | "delayed" | "delayed-queued" | "draining" | "capture-growing" | "capture-shrinking" | "reset-delayed" | "logbox-present" | "logbox-react-native-tvos" | "logbox-react-native" | "dev-loading-view-react-native-tvos";
type FakeMetro = {
  readonly port: number;
  readonly origins: string[];
  readonly evaluations: string[];
  readonly routeInfoReads: number;
  readonly navigationCalls: number;
  readonly firstNavigationListRequest: number;
  readonly listRequests: number;
  readonly launches: number;
  readonly logBoxCalls: number;
  readonly ignoreAllLogsCalls: number;
  readonly devLoadingViewCalls: number;
  readonly hideDevLoadingViewCalls: number;
  readonly close: () => Promise<void>;
  readonly markLaunch: () => void;
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
  let firstNavigationListRequest = 0;
  let queueReads = 0;
  let launches = 0;
  let logBoxCalls = 0;
  let ignoreAllLogsCalls = 0;
  let devLoadingViewCalls = 0;
  let hideDevLoadingViewCalls = 0;
  let launched = false;
  let routeReadsSinceLaunch = 0;

  const currentRoute = { pathname: "/home", segments: ["(tabs)", "home"], params: {} };
  const changedRoute = { pathname: "/home", segments: ["(tabs)", "home"], params: { filter: "favorites" } };

  const routeInfo = () => {
    const read = routeInfoReads++;
    routeReadsSinceLaunch += 1;
    if ((targets === "reset-delayed" || targets === "logbox-present" || targets === "logbox-react-native-tvos" || targets === "logbox-react-native" || targets === "dev-loading-view-react-native-tvos") && routeReadsSinceLaunch > 1 && navigationCalls > 0) return changedRoute;
    if (targets === "changed" && read > 0) return changedRoute;
    if ((targets === "delayed" || targets === "delayed-queued") && read > 1) return changedRoute;
    if (targets === "draining" && read > 2) return changedRoute;
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
    const logBoxPath = targets === "logbox-react-native-tvos" ? "react-native-tvos/Libraries/LogBox/LogBox.js" : "react-native/Libraries/LogBox/LogBox.js";
    const logBoxModuleFound = (targets === "logbox-present" || targets === "logbox-react-native-tvos" || targets === "logbox-react-native") && (
      expression.includes('name.endsWith("/Libraries/LogBox/LogBox.js")') ||
      (logBoxPath.startsWith("react-native/") && expression.includes('name.endsWith("/react-native/Libraries/LogBox/LogBox.js")'))
    );
    const devLoadingViewModuleFound = targets === "dev-loading-view-react-native-tvos" && expression.includes('name.endsWith("/Libraries/Utilities/DevLoadingView.js")');
    const value = expression === "1+1" ? 2 : expression.includes("megabrain:logbox") ? (logBoxCalls += 1, logBoxModuleFound ? (ignoreAllLogsCalls += 1, { present: true }) : { present: false }) : expression.includes("megabrain:dev-loading-view") ? (devLoadingViewCalls += 1, devLoadingViewModuleFound ? (hideDevLoadingViewCalls += 1, { present: true }) : { present: false }) : expression.includes("megabrain:navigate") ? (navigationCalls += 1, firstNavigationListRequest ||= listRequests, { ok: true }) : expression.includes("megabrain:navigation-queue") && targets !== "queued-hang" ? (
      queueReads += 1,
      targets === "queued" ? 3
        : targets === "delayed-queued" ? 2
          : targets === "draining" ? (queueReads === 1 ? 2 : 0)
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
    const targetAvailable = targets === "reset-delayed" ? launched && listRequests >= 3 : targets !== "none";
    const target = targetAvailable ? [{ id: "target", webSocketDebuggerUrl: `ws://127.0.0.1:${(http.address() as { port: number }).port}/inspector/debug?target=target` }] : [];
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
    get firstNavigationListRequest() { return firstNavigationListRequest; },
    get listRequests() { return listRequests; },
    get launches() { return launches; },
    get logBoxCalls() { return logBoxCalls; },
    get ignoreAllLogsCalls() { return ignoreAllLogsCalls; },
    get devLoadingViewCalls() { return devLoadingViewCalls; },
    get hideDevLoadingViewCalls() { return hideDevLoadingViewCalls; },
    markLaunch() { launches += 1; launched = true; routeReadsSinceLaunch = 0; },
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

function captureProcess(server: FakeMetro, distinctFrames = false, frameHashes: readonly string[] = []): ProcessAdapter {
  let frameHashIndex = 0;
  return {
    async run(command, args) {
      if (command === "git") return ok({ stdout: "commit", stderr: "", exitCode: 0 });
      if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { "iOS-1": [{ udid: "one", state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
      if (command === "xcrun" && args[0] === "simctl" && args[1] === "terminate") return ok({ stdout: "", stderr: "", exitCode: 0 });
      if (command === "xcrun" && args[0] === "simctl" && args[1] === "launch") { server.markLaunch(); return ok({ stdout: "", stderr: "", exitCode: 0 }); }
      if (command === "xcrun" && args[0] === "simctl" && args[1] === "io") { await writeFile(args.at(-1) as string, "frame"); return ok({ stdout: "", stderr: "", exitCode: 0 }); }
      if (command === "shasum") {
        const path = args.at(-1) ?? "";
        const hash = path.endsWith("control.png") ? "control-hash" : frameHashes[frameHashIndex++] ?? (distinctFrames ? "screen-hash" : `frame-${frameHashIndex}`);
        return ok({ stdout: `${hash}  frame\n`, stderr: "", exitCode: 0 });
      }
      return failed(`${command} should not run`);
    },
    async startDetached() { return failed("must not start a process"); },
    invocationCount() { return 0; },
  };
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

  test("does not report an empty queue after observing pending work", async () => {
    const server = await fakeMetro("draining");
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
      expect(server.evaluations.filter((expression) => expression.includes("megabrain:navigation-queue")).length).toBeGreaterThan(2);
      if (result.kind === "ok") {
        expect(result.value).not.toContain("navigation was not queued");
        expect(JSON.parse(result.value)).toMatchObject({ after: { params: { filter: "favorites" } } });
      }
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("resets before a screen and waits for the inspector before navigating", async () => {
    const server = await fakeMetro("reset-delayed");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }]));
    const process = captureProcess(server, true);

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      expect(server.launches).toBe(1);
      expect(server.firstNavigationListRequest).toBeGreaterThan(3);
      expect(server.navigationCalls).toBe(1);
      if (result.kind === "ok") expect(JSON.parse(result.value)).toMatchObject({ ok: true, captured: 1 });
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("captures the second identical frame after the rendered frame settles", async () => {
    const server = await fakeMetro("reset-delayed");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }]));
    const process = captureProcess(server, false, ["first-frame", "stable-frame", "stable-frame"]);

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--capture-id", "settle", "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const value = JSON.parse(result.value);
        const expectedScreen = {
          name: "first",
          hash: "stable-frame",
          image: join(outputRoot, "phone/settle/light/default/first.png"),
          requestedRoute: "/first",
          reachedPathname: "/home",
        };
        expect(value).toMatchObject({ ok: true, screens: [expectedScreen] });
        expect(JSON.parse(await Bun.file(join(outputRoot, "phone/settle/manifest.json")).text()).screens).toEqual([expectedScreen]);
      }
      expect(await Bun.file(join(outputRoot, "phone/settle/light/default/first.png")).exists()).toBe(true);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("reports a failed screen without advertising an image and keeps the failure once", async () => {
    const server = await fakeMetro("reset-delayed");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }]));
    const process = captureProcess(server, false, ["control-hash", "control-hash"]);
    const image = join(outputRoot, "phone/failed/light/default/first.png");
    const failure = "screen first: frame matches the control frame";

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--capture-id", "failed", "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const value = JSON.parse(result.value);
        const expectedScreen = { name: "first", requestedRoute: "/first", image: null, failure };
        expect(value.screens).toEqual([expectedScreen]);
        expect(result.value.split(failure).length - 1).toBe(1);
        expect(JSON.parse(await Bun.file(join(outputRoot, "phone/failed/manifest.json")).text()).screens).toEqual([expectedScreen]);
      }
      expect(await Bun.file(image).exists()).toBe(false);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("fails an unsettled screen within its budget without writing its PNG", async () => {
    const server = await fakeMetro("reset-delayed");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }]));
    const process = captureProcess(server, false, ["frame-1", "frame-2", "frame-3"]);
    const started = performance.now();

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--capture-id", "unsettled", "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      expect(performance.now() - started).toBeLessThan(1250);
      if (result.kind === "ok") expect(result.value).toContain("screen first: frame did not settle");
      expect(await Bun.file(join(outputRoot, "phone/unsettled/light/default/first.png")).exists()).toBe(false);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("compares the settled frame with the control frame", async () => {
    const server = await fakeMetro("reset-delayed");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }]));
    const process = captureProcess(server, false, ["transient-frame", "control-hash", "control-hash"]);

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--capture-id", "control", "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(result.value).toContain("screen matches the control frame");
      expect(await Bun.file(join(outputRoot, "phone/control/light/default/first.png")).exists()).toBe(false);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("compares the settled frame with the previous screen", async () => {
    const server = await fakeMetro("reset-delayed");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }, { name: "second", route: "/second" }]));
    const process = captureProcess(server, false, ["first-frame", "first-frame", "transient-second", "first-frame", "first-frame", "transient-retry", "first-frame", "first-frame"]);

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--capture-id", "previous", "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(result.value).toContain("screen second: frame duplicates the previous screen after retry");
      expect(await Bun.file(join(outputRoot, "phone/previous/light/default/first.png")).exists()).toBe(true);
      expect(await Bun.file(join(outputRoot, "phone/previous/light/default/second.png")).exists()).toBe(false);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("reports absent overlays once without failing a multi-screen capture", async () => {
    const server = await fakeMetro("reset-delayed");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }, { name: "second", route: "/second" }]));
    const process = captureProcess(server, false, ["first-frame", "first-frame", "second-frame", "second-frame"]);

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--capture-id", "logbox-absent", "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(JSON.parse(result.value)).toMatchObject({ ok: true, summary: "2 captured, 2 distinct; LogBox not found in module registry; DevLoadingView not found in module registry" });
      expect(server.logBoxCalls).toBe(2);
      expect(server.devLoadingViewCalls).toBe(2);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("silences registered overlays after every screen reset", async () => {
    const server = await fakeMetro("logbox-react-native-tvos");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }, { name: "second", route: "/second" }]));
    const process = captureProcess(server, false, ["first-frame", "first-frame", "second-frame", "second-frame"]);

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--capture-id", "logbox-present", "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(JSON.parse(result.value)).toMatchObject({ ok: true, summary: "2 captured, 2 distinct; LogBox ignored after 2 resets; DevLoadingView not found in module registry" });
      expect(server.logBoxCalls).toBe(2);
      expect(server.ignoreAllLogsCalls).toBe(2);
      expect(server.devLoadingViewCalls).toBe(2);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("silences a LogBox registered by the plain react-native package", async () => {
    const server = await fakeMetro("logbox-react-native");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }]));
    const process = captureProcess(server, false, ["first-frame", "first-frame"]);

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--capture-id", "logbox-plain", "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(JSON.parse(result.value)).toMatchObject({ ok: true, summary: "1 captured, 1 distinct; LogBox ignored; DevLoadingView not found in module registry" });
      expect(server.logBoxCalls).toBe(1);
      expect(server.ignoreAllLogsCalls).toBe(1);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("hides a forked DevLoadingView after every screen reset", async () => {
    const server = await fakeMetro("dev-loading-view-react-native-tvos");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }, { name: "second", route: "/second" }]));
    const process = captureProcess(server, false, ["first-frame", "first-frame", "second-frame", "second-frame"]);

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--capture-id", "dev-loading-view", "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(JSON.parse(result.value)).toMatchObject({ ok: true, summary: "2 captured, 2 distinct; LogBox not found in module registry; DevLoadingView hidden after 2 resets" });
      expect(server.logBoxCalls).toBe(2);
      expect(server.devLoadingViewCalls).toBe(2);
      expect(server.hideDevLoadingViewCalls).toBe(2);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("silences overlays after a duplicate-frame retry reset", async () => {
    const server = await fakeMetro("logbox-react-native-tvos");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }, { name: "second", route: "/second" }]));
    const process = captureProcess(server, false, ["first-frame", "first-frame", "first-frame", "first-frame", "second-frame", "second-frame"]);

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--capture-id", "duplicate-overlay", "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(JSON.parse(result.value)).toMatchObject({ ok: true, summary: "2 captured, 2 distinct; LogBox ignored after 3 resets; DevLoadingView not found in module registry" });
      expect(server.logBoxCalls).toBe(3);
      expect(server.ignoreAllLogsCalls).toBe(3);
      expect(server.devLoadingViewCalls).toBe(3);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("fails the screen when reset cannot find an inspector target within its budget", async () => {
    const server = await fakeMetro("none");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }]));
    const process = captureProcess(server);
    const started = performance.now();

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      expect(performance.now() - started).toBeLessThan(1250);
      expect(server.launches).toBe(1);
      expect(server.navigationCalls).toBe(0);
      if (result.kind === "ok") {
        expect(result.value).toContain("reset failed");
        expect(result.value).toContain("Metro inspector target");
      }
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
    const process = captureProcess(server);

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      expect(server.navigationCalls).toBe(2);
      if (result.kind === "ok") {
        const value = JSON.parse(result.value);
        expect(value.failureReasons.some((reason: string) => reason.startsWith("capture stopped early"))).toBe(true);
        expect(value.screens).toHaveLength(3);
        expect(value.screens[2]).toEqual({
          name: "third",
          requestedRoute: "/third",
          image: null,
          failure: expect.stringContaining("not attempted"),
        });
      }
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("uses a failed screen hash for later duplicate and control-frame detection", async () => {
    const server = await fakeMetro("reset-delayed");
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-capture-"));
    const outputRoot = join(worktree, "output");
    const screensFile = join(worktree, "screens.json");
    await mkdir(join(worktree, ".megabrain"));
    await writeFile(join(worktree, ".megabrain/native.json"), JSON.stringify({ version: 1, surfaces: { phone: { metroPort: String(server.port) } } }));
    await writeFile(screensFile, JSON.stringify([{ name: "first", route: "/first" }, { name: "second", route: "/second" }]));
    const process = captureProcess(server, false, ["control-hash", "control-hash", "control-hash", "control-hash"]);

    try {
      const result = await executeNative(["capture", "phone", "--screens", screensFile, "--bundle-id", "com.example.app", "--device", "Phone", "--metro-port", String(server.port), "--output-root", outputRoot, "--capture-id", "failed-duplicate", "--timeout", "1", "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree }, process);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const value = JSON.parse(result.value);
        expect(value.controlMatches).toEqual(["first", "second"]);
        expect(value.duplicateGroups).toEqual([["first", "second"]]);
        expect(value.failureReasons).toContain("screens share a hash: first, second");
        expect(value.screens.every((screen: { image: string | null }) => screen.image === null)).toBe(true);
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
    const process = captureProcess(server);

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
