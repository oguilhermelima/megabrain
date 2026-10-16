import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { CODE_WORKBENCH_CSS } from "../../src/core/code-server-proxy.js";

const directories: string[] = [];
const servers: HttpServer[] = [];
const nodeProcesses: ChildProcess[] = [];

afterEach(async () => {
  for (const child of nodeProcesses.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function socketPath(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "megabrain-code-proxy-"));
  directories.push(directory);
  return join(directory, "backend.sock");
}

async function listen(server: HttpServer, path?: string): Promise<number> {
  server.listen(path ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP listener");
  return address.port;
}

async function nodeWebSocketBackend(path: string): Promise<void> {
  const script = [
    'const http = require("node:http");',
    'const { WebSocketServer } = require("ws");',
    'const server = http.createServer();',
    'const wss = new WebSocketServer({ noServer: true });',
    'server.on("upgrade", (request, socket, head) => {',
    '  socket.pause();',
    '  wss.handleUpgrade(request, socket, head, (websocket) => {',
    '    websocket.on("message", () => websocket.send(JSON.stringify({ event: "health", status: "alive" })));',
    '    socket.resume();',
    '  });',
    '});',
    'server.listen(process.argv[1], () => process.stdout.write("ready\\n"));',
  ].join("\n");
  const child = spawn("node", ["-e", script, path], { stdio: ["ignore", "pipe", "pipe"] });
  nodeProcesses.push(child);
  await nodeReady(child);
}

async function nodeTokenProxy(socket: string, token: string): Promise<number> {
  const directory = directories[0];
  if (directory === undefined) throw new Error("missing temporary directory");
  const entrypoint = join(import.meta.dir, "../../src/core/code-server-proxy.ts");
  const build = await Bun.build({ entrypoints: [entrypoint], target: "node", format: "esm", write: false });
  if (!build.success) throw new Error(build.logs.map((item) => item.message).join("\n"));
  const modulePath = join(directory, "code-server-proxy.mjs");
  const bundle = build.outputs[0];
  if (bundle === undefined) throw new Error("proxy build did not emit an output");
  await Bun.write(modulePath, bundle);

  const probe = createHttpServer();
  const port = await listen(probe);
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const script = 'import { pathToFileURL } from "node:url"; const { createTokenProxyServer } = await import(pathToFileURL(process.argv[1])); const server = createTokenProxyServer(process.argv[2], process.argv[4]); server.prependListener("upgrade", (_request, socket) => socket.cork()); server.listen(Number(process.argv[3]), "127.0.0.1", () => process.stdout.write("ready\\n"));';
  const child = spawn("node", ["--input-type=module", "-e", script, modulePath, socket, String(port), token], { stdio: ["ignore", "pipe", "pipe"] });
  nodeProcesses.push(child);
  await nodeReady(child);
  return port;
}

async function nodeReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stdout = child.stdout;
    if (stdout === null) return reject(new Error("Node fixture stdout is unavailable"));
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => { if (chunk.includes("ready")) resolve(); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Node fixture exited during startup (${code ?? "signal"})`)));
  });
}

async function nodeWebSocketClient(port: number, token: string): Promise<string> {
  const script = [
    'const WebSocket = require("ws");',
    'const client = new WebSocket(`ws://127.0.0.1:${process.argv[1]}/${process.argv[2]}/healthz`);',
    'const timer = setTimeout(() => { client.terminate(); process.exit(1); }, 2_000);',
    'client.once("open", () => client.send("health"));',
    'client.once("message", (data) => { clearTimeout(timer); process.stdout.write(data.toString()); client.close(); });',
    'client.once("error", () => { clearTimeout(timer); process.exit(1); });',
  ].join("\n");
  const child = spawn("node", ["-e", script, String(port), token], { stdio: ["ignore", "pipe", "pipe"] });
  nodeProcesses.push(child);
  let output = "";
  const stdout = child.stdout;
  if (stdout === null) throw new Error("Node WebSocket client stdout is unavailable");
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => { output += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Node WebSocket client exited with status ${code ?? "signal"}`)));
  });
  return output;
}

async function nodeKeepAliveUnauthorizedClient(port: number): Promise<readonly [number, number]> {
  const script = [
    'const http = require("node:http");',
    'const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });',
    'function get(path) { return new Promise((resolve, reject) => { http.get({ hostname: "127.0.0.1", port: Number(process.argv[1]), path, agent }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); }).once("error", reject); }); }',
    '(async () => { const first = await get(`/secret-token/first`); let second = 0; try { second = await get("/"); } catch (error) { if (!(["ECONNRESET", "EPIPE"].includes(error.code))) throw error; } process.stdout.write(JSON.stringify([first, second])); agent.destroy(); })().catch((error) => { process.stderr.write(error.message); process.exit(1); });',
  ].join("\n");
  const child = spawn("node", ["-e", script, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  nodeProcesses.push(child);
  let output = "";
  const stdout = child.stdout;
  if (stdout === null) throw new Error("Node HTTP client stdout is unavailable");
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => { output += chunk; });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Node HTTP client exited with status ${code ?? "signal"}`)));
  });
  return JSON.parse(output) as readonly [number, number];
}

describe("code server token proxy", () => {
  test("requires a token-prefixed path and strips it before forwarding HTTP", async () => {
    const socket = await socketPath();
    let backendUrl = "";
    const backend = createHttpServer((request, response) => { backendUrl = request.url ?? ""; response.writeHead(200); response.end("editor"); });
    servers.push(backend);
    backend.listen(socket);
    await once(backend, "listening");

    const port = await nodeTokenProxy(socket, "secret-token");
    const unauthorized = await fetch(`http://127.0.0.1:${port}/`);
    expect(unauthorized.status).toBe(401);

    const editor = await fetch(`http://127.0.0.1:${port}/secret-token/static/app.js?build=1`);
    expect(editor.status).toBe(200);
    expect(await editor.text()).toBe("editor");
    expect(backendUrl).toBe("/static/app.js?build=1");
    expect(editor.headers.get("set-cookie")).toBeNull();
  });

  test("rechecks authorization instead of forwarding a second keep-alive request", async () => {
    const socket = await socketPath();
    let backendRequests = 0;
    const backend = createHttpServer((_request, response) => { backendRequests += 1; response.writeHead(200); response.end("editor"); });
    servers.push(backend);
    backend.listen(socket);
    await once(backend, "listening");

    const port = await nodeTokenProxy(socket, "secret-token");
    const [first, second] = await nodeKeepAliveUnauthorizedClient(port);
    expect(first).toBe(200);
    expect([0, 401]).toContain(second);
    expect(backendRequests).toBe(1);
  });

  test("forwards authenticated WebSocket upgrades to the Unix socket", async () => {
    const socket = await socketPath();
    await nodeWebSocketBackend(socket);

    const port = await nodeTokenProxy(socket, "secret-token");
    const frame = await nodeWebSocketClient(port, "secret-token");
    expect(JSON.parse(frame)).toEqual({ event: "health", status: "alive" });
  });

  test("serves the workbench stylesheet with the layout CSS after the original, which it imports", async () => {
    const socket = await socketPath();
    const backendUrls: string[] = [];
    const backend = createHttpServer((request, response) => { backendUrls.push(request.url ?? ""); response.writeHead(200, { "Content-Type": "text/css" }); response.end(".original{}"); });
    servers.push(backend);
    backend.listen(socket);
    await once(backend, "listening");

    const port = await nodeTokenProxy(socket, "secret-token");
    const stylesheet = "/stable-1/static/out/vs/code/browser/workbench/workbench.css";
    const patched = await fetch(`http://127.0.0.1:${port}/secret-token${stylesheet}`);
    expect(patched.status).toBe(200);
    expect(patched.headers.get("content-type")).toContain("text/css");
    expect(patched.headers.get("cache-control")).toBe("no-store");
    const body = await patched.text();
    expect(body.startsWith('@import url("workbench.css?megabrain-original");')).toBe(true);
    expect(body).toContain(CODE_WORKBENCH_CSS);
    expect(backendUrls).toHaveLength(0);

    const original = await fetch(`http://127.0.0.1:${port}/secret-token${stylesheet}?megabrain-original`);
    expect(await original.text()).toBe(".original{}");
    expect(backendUrls).toEqual([`${stylesheet}?megabrain-original`]);
  });

  test("the layout CSS hides the accounts and manage buttons wherever the workbench puts them", () => {
    expect(CODE_WORKBENCH_CSS).toContain(".global-activity");
    expect(CODE_WORKBENCH_CSS).toContain("display: none");
  });
});
