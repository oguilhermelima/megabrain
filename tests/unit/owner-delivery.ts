import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { listOutbox } from "../../src/adapters/state-db.js";
import { startStateOwner, stopStateOwner } from "../../src/db/state-owner.js";

export async function deliverWithOwner(root: string, process: ProcessAdapter, environment: Readonly<Record<string, string | undefined>>, outboxId: string, timeoutMs = 5_000): Promise<void> {
  const owner = await startStateOwner(root, process, { ...environment, HOME: environment.HOME ?? root, MEGABRAIN_STATE_DIR: root, MEGABRAIN_DELIVERY_TIMEOUT_MS: String(timeoutMs) });
  try {
    const deadline = Date.now() + timeoutMs + 1_000;
    while (Date.now() < deadline) {
      const outbox = listOutbox(owner.handle);
      const status = outbox.kind === "ok" ? outbox.value.find((item) => item.id === outboxId)?.status : undefined;
      if (status !== undefined && status !== "pending" && status !== "sending") break;
      if (owner.pendingDeliveries.size > 0) await Promise.all([...owner.pendingDeliveries]);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally { await stopStateOwner(owner); }
}
