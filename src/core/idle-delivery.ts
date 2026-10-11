export type IdleDeliveryInput = Readonly<{
  timeoutMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  ownDraft?: string;
  inspect: () => Promise<"idle" | "busy" | "unknown">;
  composer: () => Promise<string | undefined>;
  clear: () => Promise<boolean>;
  send: () => Promise<boolean>;
  isRead: () => Promise<boolean>;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  record?: (outcome: IdleDeliveryOutcome) => Promise<void>;
}>;

export type IdleDeliveryOutcome = "delivered" | "cancelled" | "failed";

const defaultWait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function deliverWhenIdle(input: IdleDeliveryInput): Promise<IdleDeliveryOutcome> {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? defaultWait;
  const deadline = now() + Math.max(0, input.timeoutMs);
  let delay = Math.max(1, input.initialDelayMs);
  while (now() <= deadline) {
    if (await input.isRead()) return finish("cancelled");
    if (await input.inspect() === "idle") {
      let draft = await input.composer();
      if (draft === input.ownDraft && draft !== undefined && draft !== "") {
        if (!(await input.clear())) return finish("failed");
        draft = await input.composer();
      }
      if (draft === "") {
        if (await input.isRead()) return finish("cancelled");
        if (await input.inspect() === "idle" && await input.composer() === "") {
          if (await input.send()) return finish("delivered");
          return finish("failed");
        }
      }
    }
    if (now() >= deadline) break;
    await wait(Math.min(delay, deadline - now()));
    delay = Math.min(Math.max(delay * 2, 1), Math.max(1, input.maxDelayMs));
  }
  return finish((await input.isRead()) ? "cancelled" : "failed");

  async function finish(outcome: IdleDeliveryOutcome): Promise<IdleDeliveryOutcome> {
    await input.record?.(outcome);
    return outcome;
  }
}

export async function startDeferredDelivery(
  target: string,
  holder: string,
  reserve: (target: string, holder: string) => Promise<boolean>,
  start: (holder: string) => Promise<boolean>,
  release: (target: string, holder: string) => Promise<void>,
): Promise<"started" | "already-running" | "failed"> {
  let reserved = false;
  try { reserved = await reserve(target, holder); } catch { return "failed"; }
  if (!reserved) return "already-running";
  try {
    if (await start(holder)) return "started";
  } catch {
    // Release the reservation below when detached launch fails.
  }
  await release(target, holder).catch(() => undefined);
  return "failed";
}
