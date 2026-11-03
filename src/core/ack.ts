import { failed, ok, type Result } from "./result.js";

export function acknowledgeDelivery(
  status: string,
  recordConsumer: string,
  recordGeneration: string | number,
  consumer: string,
  generation: number,
  deliveryId = "delivery",
): Result<{ readonly duplicate: boolean }> {
  if (status === "acknowledged") return ok({ duplicate: true });
  if (status === "fenced") return failed(`delivery ${deliveryId} refused: delivery is fenced`);
  if (status !== "outstanding" && status !== "superseded") return failed(`delivery ${deliveryId} refused: status is invalid (${status})`);
  if (recordConsumer !== consumer || String(recordGeneration) !== String(generation)) {
    if (recordConsumer === "") {
      return failed(`delivery ${deliveryId} refused: delivery has not been read by this consumer; run megabrain orchestrate watch <dispatch-id> --full first`);
    }
    return failed(`delivery ${deliveryId} refused: outstanding delivery belongs to consumer ${recordConsumer} generation ${recordGeneration}`);
  }
  return ok({ duplicate: false });
}

export function unknownDeliveryReason(deliveryId: string, dispatchId: string, records: readonly Readonly<{ dispatchId: string; archived: boolean; deliveryIds: readonly string[] }>[]): string {
  const record = records.find((candidate) => candidate.dispatchId !== dispatchId && candidate.archived === true && candidate.deliveryIds.includes(deliveryId));
  if (record !== undefined) return `delivery was recorded for archived dispatch ${record.dispatchId}`;
  const other = records.find((candidate) => candidate.dispatchId !== dispatchId && candidate.deliveryIds.includes(deliveryId));
  if (other !== undefined) return `delivery was recorded for dispatch ${other.dispatchId}, not ${dispatchId}`;
  return "it was never recorded";
}
