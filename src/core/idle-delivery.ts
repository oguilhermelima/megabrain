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
  giveUp?: () => boolean;
  attempt?: (details: IdleDeliveryAttempt) => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  record?: (outcome: IdleDeliveryOutcome) => Promise<void>;
}>;

export type IdleDeliveryOutcome = "delivered" | "cancelled" | "failed" | "unavailable";
export type IdleDeliveryAttempt = Readonly<{
  status: "idle" | "busy" | "unknown";
  composer: "empty" | "draft" | "unknown" | "unread";
  decision: "cancelled" | "wait-busy" | "wait-composer" | "send" | "send-failed" | "failed";
}>;

const defaultWait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function deliverWhenIdle(input: IdleDeliveryInput): Promise<IdleDeliveryOutcome> {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? defaultWait;
  const deadline = now() + Math.max(0, input.timeoutMs);
  let delay = Math.max(1, input.initialDelayMs);
  while (now() <= deadline) {
    let status: IdleDeliveryAttempt["status"] = "unknown";
    let composer: IdleDeliveryAttempt["composer"] = "unread";
    if (await input.isRead()) {
      await input.attempt?.({ status, composer, decision: "cancelled" });
      return finish("cancelled");
    }
    status = await input.inspect();
    if (status === "idle") {
      let draft = await input.composer();
      composer = draft === undefined ? "unknown" : draft === "" ? "empty" : "draft";
      if (draft === input.ownDraft && draft !== undefined && draft !== "") {
        if (!(await input.clear())) {
          await input.attempt?.({ status, composer, decision: "failed" });
          return finish("failed");
        }
        draft = await input.composer();
        composer = draft === undefined ? "unknown" : draft === "" ? "empty" : "draft";
      }
      if (draft === "") {
        if (await input.isRead()) {
          await input.attempt?.({ status, composer, decision: "cancelled" });
          return finish("cancelled");
        }
        status = await input.inspect();
        if (status === "idle") {
          draft = await input.composer();
          composer = draft === undefined ? "unknown" : draft === "" ? "empty" : "draft";
        }
        if (status === "idle" && draft === "") {
          if (await input.send()) {
            await input.attempt?.({ status, composer, decision: "send" });
            return finish("delivered");
          }
          await input.attempt?.({ status, composer, decision: "send-failed" });
          return finish("failed");
        }
      }
      await input.attempt?.({ status, composer, decision: status !== "idle" ? "wait-busy" : composer === "draft" ? "wait-composer" : "wait-busy" });
    } else {
      await input.attempt?.({ status, composer, decision: "wait-busy" });
    }
    if (now() >= deadline) break;
    if (input.giveUp?.() === true) return finish("unavailable");
    await wait(Math.min(delay, deadline - now()));
    delay = Math.min(Math.max(delay * 2, 1), Math.max(1, input.maxDelayMs));
  }
  if (await input.isRead()) return finish("cancelled");
  return finish("failed");

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
