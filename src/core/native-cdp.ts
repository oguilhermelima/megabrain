import WebSocket from "ws";
import { failed, ok, type Result } from "./result.js";

type MetroTarget = Readonly<{ webSocketDebuggerUrl: string }>;
type CdpResponse = Readonly<{
  id?: number;
  result?: {
    result?: { value?: unknown; unserializableValue?: string; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  error?: { message?: string };
}>;

export type MetroEvaluation =
  | Readonly<{ kind: "value"; value: unknown }>
  | Readonly<{ kind: "exception"; message: string }>;

export type MetroInspector = Readonly<{
  evaluate: (expression: string, timeoutMs?: number) => Promise<Result<MetroEvaluation>>;
  close: () => void;
}>;

function deadlineSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function listTargets(port: number, timeoutMs: number): Promise<Result<MetroTarget[]>> {
  const request = deadlineSignal(timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: request.signal });
    if (!response.ok) return failed(`Metro /json/list returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!Array.isArray(value)) return failed("Metro /json/list returned invalid target data");
    const targets = value.flatMap((entry): MetroTarget[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const url = (entry as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
      return typeof url === "string" && url.length > 0 ? [{ webSocketDebuggerUrl: url }] : [];
    });
    return ok(targets);
  } catch (cause) {
    return failed(cause instanceof Error && cause.name === "AbortError" ? "Metro /json/list timed out" : "Metro /json/list was unavailable");
  } finally {
    request.clear();
  }
}

function openSocket(url: string, origin: string, timeoutMs: number): Promise<Result<WebSocket>> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(url, { headers: { Origin: origin } });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      resolve(failed(`Metro inspector socket did not open within ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (result: Result<WebSocket>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    socket.once("open", () => finish(ok(socket)));
    socket.once("error", () => finish(failed("Metro inspector socket could not open")));
  });
}

function inspectorFor(socket: WebSocket): MetroInspector {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (result: Result<MetroEvaluation>) => void; timer: ReturnType<typeof setTimeout> }>();

  socket.on("message", (message) => {
    let response: CdpResponse;
    try { response = JSON.parse(message.toString()) as CdpResponse; } catch { return; }
    if (response.id === undefined) return;
    const request = pending.get(response.id);
    if (request === undefined) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) {
      request.resolve(failed(`Runtime.evaluate failed: ${response.error.message ?? "unknown protocol error"}`));
      return;
    }
    const exception = response.result?.exceptionDetails;
    if (exception !== undefined) {
      request.resolve(ok({ kind: "exception", message: exception.exception?.description ?? exception.text ?? "expression threw" }));
      return;
    }
    const value = response.result?.result;
    if (value === undefined) {
      request.resolve(failed("Runtime.evaluate returned no result"));
      return;
    }
    const resolved = "value" in value ? value.value : "unserializableValue" in value ? value.unserializableValue : value.description;
    request.resolve(ok({ kind: "value", value: resolved }));
  });

  const rejectPending = (message: string) => {
    for (const [id, request] of pending) {
      pending.delete(id);
      clearTimeout(request.timer);
      request.resolve(failed(message));
    }
  };
  socket.once("close", () => {
    closed = true;
    rejectPending("Metro inspector socket closed before Runtime.evaluate answered");
  });
  socket.once("error", () => rejectPending("Metro inspector socket failed during Runtime.evaluate"));

  return {
    async evaluate(expression, timeoutMs = 1000) {
      if (closed || socket.readyState !== WebSocket.OPEN) return failed("Metro inspector socket is not open");
      const id = nextId++;
      return new Promise<Result<MetroEvaluation>>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(failed(`Runtime.evaluate did not answer within ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        try {
          socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          resolve(failed("Metro inspector could not send Runtime.evaluate"));
        }
      });
    },
    close() {
      if (!closed) socket.close();
      closed = true;
      rejectPending("Metro inspector socket closed");
    },
  };
}

function wait(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 20)));
}

export async function connectMetroInspector(port: number, timeoutMs: number): Promise<Result<MetroInspector>> {
  const started = Date.now();
  let lastError = "Metro has no inspector target";
  while (Date.now() - started < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - started);
    const targets = await listTargets(port, Math.max(1, Math.min(remaining, 250)));
    if (targets.kind === "ok" && targets.value.length > 0) {
      const attemptMs = Math.max(1, Math.min(timeoutMs - (Date.now() - started), 250));
      const socket = await openSocket(targets.value[0]?.webSocketDebuggerUrl ?? "", `http://127.0.0.1:${port}`, attemptMs);
      if (socket.kind === "ok") {
        const inspector = inspectorFor(socket.value);
        const probe = await inspector.evaluate("1+1", attemptMs);
        if (probe.kind === "ok" && probe.value.kind === "value" && probe.value.value === 2) return ok(inspector);
        lastError = probe.kind === "failed" ? probe.error : "Metro inspector probe returned an unexpected value";
        inspector.close();
      } else lastError = socket.error;
    } else if (targets.kind === "failed") lastError = targets.error;
    const afterAttempt = timeoutMs - (Date.now() - started);
    if (afterAttempt > 0) await wait(afterAttempt);
  }
  return failed(`Metro inspector was not ready within ${timeoutMs}ms: ${lastError}`);
}
