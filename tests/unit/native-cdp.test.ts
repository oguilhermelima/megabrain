import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, test } from "bun:test";
import { connectMetroInspector } from "../../src/core/native-cdp.js";

type FakeTarget = "none" | "probe" | "hang";
type FakeMetro = {
  readonly port: number;
  readonly origins: string[];
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
  const rawSockets = new Set<Socket>();
  let targets = initialTargets;
  let listRequests = 0;

  const sendProbeResult = (socket: WebSocket, message: string) => {
    const request = JSON.parse(message) as { id?: number; method?: string; params?: { expression?: string } };
    if (request.method !== "Runtime.evaluate" || request.id === undefined) return;
    const expression = request.params?.expression ?? "";
    const value = expression === "1+1" ? 2 : expression.includes("megabrain:navigate") || expression.includes("megabrain:navigation-state") ? { key: "same-route", name: "home" } : undefined;
    if (value !== undefined) socket.send(JSON.stringify({ id: request.id, result: { result: { type: typeof value === "number" ? "number" : "object", value } } }));
  };

  wsServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("message", (message) => {
      if (targets === "probe") sendProbeResult(socket, message.toString());
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

});
