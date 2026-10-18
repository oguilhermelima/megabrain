export type Frame = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number } };
type Waiter = { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Line framed JSON-RPC transport used by grok agent stdio. */
export class AcpPeer {
  private nextId = 1;
  private readonly pending = new Map<string | number, Waiter>();
  onRequest: (frame: Frame) => void = () => undefined;
  onNotification: (frame: Frame) => void = () => undefined;
  onResponse: (method: string, result: unknown, error?: Error) => void = () => undefined;

  constructor(private readonly writeFrame: (frame: string) => void) {}

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      try { this.writeFrame(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
      catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  respond(id: string | number, result: unknown): void {
    this.writeFrame(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  receive(line: string): void {
    const frame = JSON.parse(line) as Frame;
    if (frame.jsonrpc !== "2.0" || (frame.id === undefined && !frame.method)) throw new Error("invalid ACP JSON-RPC frame");
    if (frame.method !== undefined) {
      if (frame.id === undefined) this.onNotification(frame);
      else this.onRequest(frame);
      return;
    }
    if (frame.id === undefined) throw new Error("ACP response is missing an id");
    const waiter = this.pending.get(frame.id);
    if (!waiter) return; // Late responses after cancellation are harmless.
    this.pending.delete(frame.id);
    if (frame.error) {
      const error = new Error(frame.error.message || "ACP request failed");
      waiter.reject(error);
      this.onResponse(waiter.method, undefined, error);
    } else {
      waiter.resolve(frame.result);
      this.onResponse(waiter.method, frame.result);
    }
  }

  close(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
