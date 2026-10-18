import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

export type AppControlSocket = Pick<Socket, "write" | "destroyed" | "once">;
type Pending = { socket: AppControlSocket; timer: ReturnType<typeof setTimeout>; resolve(value: unknown): void; reject(error: Error): void };

/** Correlates short lived CLI requests with the desktop app's persistent chatd connection. */
export class AppControlBroker {
  private app: AppControlSocket | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs: number) {}

  get connected(): boolean { return this.app !== null && !this.app.destroyed; }

  connect(socket: AppControlSocket): void {
    if (this.app !== null && !this.app.destroyed) throw new Error("a desktop app is already connected");
    this.app = socket;
    socket.once("close", () => this.disconnect(socket));
    socket.once("error", () => this.disconnect(socket));
  }

  request(request: unknown): Promise<unknown> {
    const socket = this.app;
    if (socket === null || socket.destroyed) return Promise.reject(new Error("no desktop app is connected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("desktop app did not answer the layout request in time"));
      }, this.timeoutMs);
      this.pending.set(id, { socket, timer, resolve, reject });
      try { socket.write(`${JSON.stringify({ event: "app-control", id, request })}\n`); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  reply(socket: AppControlSocket, reply: { id?: unknown; value?: unknown; error?: unknown }): void {
    if (typeof reply.id !== "string") return;
    const pending = this.pending.get(reply.id);
    if (pending === undefined || pending.socket !== socket) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (typeof reply.error === "string") pending.reject(new Error(reply.error));
    else pending.resolve(reply.value);
  }

  close(): void { this.disconnect(this.app); }

  private disconnect(socket: AppControlSocket | null): void {
    if (socket === null) return;
    if (this.app === socket) this.app = null;
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error("desktop app disconnected before answering the layout request"));
    }
  }
}
