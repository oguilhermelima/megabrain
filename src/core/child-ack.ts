import { failed, ok, type Result } from "./result.js";

export function acknowledgeChildDelivery(
  status: string,
  recordConsumer: string,
  recordGeneration: string,
  consumer: string,
  generation: number,
  deliveryId: string,
): Result<{ readonly duplicate: boolean }> {
  if (status === "acknowledged") return ok({ duplicate: true });
  if (status === "fenced") return failed(`delivery ${deliveryId} refused: delivery is fenced`);
  if (status !== "outstanding" && status !== "superseded") return failed(`delivery ${deliveryId} refused: status is invalid (${status})`);
  if (recordConsumer !== consumer || recordGeneration !== String(generation)) {
    return failed(`delivery ${deliveryId} refused: outstanding delivery belongs to consumer ${recordConsumer} generation ${recordGeneration}`);
  }
  return ok({ duplicate: false });
}
