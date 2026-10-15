import { timingSafeEqual } from "node:crypto";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { Environment } from "../cli/commands/context.js";
import { failed, ok, type Result } from "./result.js";

const MAX_HEADER_BYTES = 65_536;

type ProxyRequest = Readonly<{
  method: string;
  target: string;
  version: string;
  headerLines: readonly string[];
  headers: ReadonlyMap<string, string>;
  head: Buffer;
}>;

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseRequest(data: Buffer): ProxyRequest | undefined {
  const boundary = data.indexOf("\r\n\r\n");
  if (boundary < 0) return undefined;
  const lines = data.subarray(0, boundary).toString("latin1").split("\r\n");
  const start = lines.shift();
  const match = start?.match(/^(\S+) (\S+) HTTP\/(1\.[01])$/);
  if (match === null || match === undefined) throw new Error("invalid HTTP request line");
  const headerLines = lines;
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("invalid HTTP request header");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    headers.set(name, existing === undefined ? value : name === "cookie" ? `${existing}; ${value}` : `${existing}, ${value}`);
  }
  return {
    method: match[1] ?? "GET",
    target: match[2] ?? "/",
    version: match[3] ?? "1.1",
    headerLines,
    headers,
    head: data.subarray(boundary + 4),
  };
}

function deny(client: Socket): void {
  client.end([
    "HTTP/1.1 401 Unauthorized",
    "Content-Type: text/plain; charset=utf-8",
    "Cache-Control: no-store",
    "Connection: close",
    "Content-Length: 13",
    "",
    "Unauthorized\n",
  ].join("\r\n"));
}

function badRequest(client: Socket, status: 400 | 431): void {
  const body = status === 431 ? "Request Header Fields Too Large\n" : "Bad Request\n";
  const reason = status === 431 ? "Request Header Fields Too Large" : "Bad Request";
  client.end([
    `HTTP/1.1 ${status} ${reason}`,
    "Content-Type: text/plain; charset=utf-8",
    "Connection: close",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n"));
}

function upstreamHeaders(request: ProxyRequest, close: boolean): string[] {
  const headers = request.headerLines.filter((line) => {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim().toLowerCase();
    return name !== "host" && (name !== "connection" || !close);
  });
  headers.push(`Host: ${request.headers.get("host") ?? "127.0.0.1"}`);
  if (close) headers.push("Connection: close");
  return headers;
}

function tokenPath(target: string, token: string): string | undefined {
  const parsed = new URL(target, "http://127.0.0.1");
  const firstSegment = parsed.pathname.slice(1).split("/", 1)[0] ?? "";
  if (!sameSecret(firstSegment, token) || !parsed.pathname.startsWith(`/${firstSegment}/`)) return undefined;
  parsed.pathname = parsed.pathname.slice(firstSegment.length + 1);
  return `${parsed.pathname}${parsed.search}`;
}

function rewriteLocation(header: Buffer, token: string): Buffer {
  const text = header.toString("latin1");
  const prefix = `/${token}`;
  const rewritten = text.replace(/(^|\r\n)(Location:\s*)(\/[^\r\n]*)/i, (_match, boundary: string, name: string, location: string) => {
    if (location.startsWith("//")) return `${boundary}${name}${location}`;
    return `${boundary}${name}${prefix}${location}`;
  });
  return Buffer.from(rewritten, "latin1");
}

function forward(socketPath: string, client: Socket, request: ProxyRequest, target: string, token: string): void {
  client.pause();
  const upstream = connect(socketPath);
  const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  let connected = false;
  client.once("error", () => upstream.destroy());
  upstream.once("connect", () => {
    connected = true;
    const start = `${request.method} ${target} HTTP/${request.version}`;
    upstream.write(`${start}\r\n${upstreamHeaders(request, !websocket).join("\r\n")}\r\n\r\n`);
    if (request.head.length > 0) upstream.write(request.head);
    client.pipe(upstream);
    let responseHeader = Buffer.alloc(0);
    let responseStarted = false;
    upstream.on("data", (chunk: Buffer) => {
      if (responseStarted) {
        client.write(chunk);
        return;
      }
      responseHeader = Buffer.concat([responseHeader, chunk]);
      const boundary = responseHeader.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      responseStarted = true;
      client.write(rewriteLocation(responseHeader.subarray(0, boundary), token));
      client.write(responseHeader.subarray(boundary));
      responseHeader = Buffer.alloc(0);
    });
    upstream.once("end", () => {
      if (!responseStarted && responseHeader.length > 0) client.write(responseHeader);
      client.end();
    });
  });
  upstream.once("error", () => {
    if (connected) client.destroy();
    else client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
}

function handleClient(socketPath: string, token: string, client: Socket): void {
  let buffer = Buffer.alloc(0);
  let handled = false;
  client.on("error", () => {});
  client.setTimeout(15_000, () => client.destroy());
  client.on("data", (chunk) => {
    if (handled) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.length > MAX_HEADER_BYTES && buffer.indexOf("\r\n\r\n") < 0) {
      handled = true;
      badRequest(client, 431);
      return;
    }
    let request: ProxyRequest | undefined;
    try {
      request = parseRequest(buffer);
    } catch {
      handled = true;
      badRequest(client, 400);
      return;
    }
    if (request === undefined) return;
    handled = true;
    client.setTimeout(0);
    const target = tokenPath(request.target, token);
    if (target !== undefined) return forward(socketPath, client, request, target, token);
    deny(client);
  });
}

export function createTokenProxyServer(socketPath: string, token: string): Server {
  return createServer((client) => handleClient(socketPath, token, client));
}

export async function runCodeServerProxy(args: readonly string[], environment: Environment): Promise<Result<string>> {
  const [socketPath, portText] = args;
  const port = Number(portText);
  const token = environment.MEGABRAIN_CODE_TOKEN;
  if (args.length !== 2 || socketPath === undefined || !Number.isInteger(port) || port < 1 || port > 65535 || token === undefined || token.length === 0) {
    return failed("invalid internal code server proxy arguments", 2);
  }
  const server = createTokenProxyServer(socketPath, token);
  return await new Promise<Result<string>>((resolve) => {
    server.once("error", (error: Error) => resolve(failed(`code server proxy: ${error.message}`)));
    server.listen(port, "127.0.0.1", () => {
      server.once("close", () => resolve(ok("")));
    });
  });
}
