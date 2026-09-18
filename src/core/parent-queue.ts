import { failed, ok, type Result } from "./result.js";

export { acknowledgeDelivery } from "./ack.js";

export type ParentAckArguments = Readonly<{
  readonly dispatchId: string;
  readonly deliveryId: string;
  readonly consumer?: string;
  readonly generation: number;
  readonly close?: boolean;
  readonly json: boolean;
}>;

export function parseParentAckArgs(args: readonly string[], environmentGeneration = "1"): Result<ParentAckArguments> {
  const dispatchId = args[0] ?? "";
  const deliveryId = args[1] ?? "";
  if (dispatchId === "" || deliveryId === "") return failed("Usage: megabrain orchestrate ack <dispatch-id> <delivery-id> [--consumer <id>] [--generation <number>] [--json]\n", 2);
  let consumer: string | undefined;
  let generation = Number(environmentGeneration);
  let close = false;
  let json = false;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--consumer") consumer = args[++index];
    else if (arg === "--generation") generation = Number(args[++index]);
    else if (arg === "--close") close = true;
    else if (arg === "--json") json = true;
    else return failed(`unknown orchestrate ack option: ${arg}`, 2);
  }
  if (!Number.isInteger(generation) || generation < 1) return failed("--generation must be a positive number", 2);
  return ok({ dispatchId, deliveryId, consumer, generation, ...(close ? { close: true } : {}), json });
}

export function ackCloseRefusal(dispatchId: string, state: string, json: boolean): Result<string> {
  const message = `dispatch ${dispatchId} is ${state ?? "unknown"}; refusing to acknowledge delivery with --close; dispatch must be done or closed`;
  if (json) return { kind: "ok", value: `${JSON.stringify({ refusal: { code: "dispatch-not-done", message } }, null, 2)}\n`, exitCode: 1, stderr: `dispatch-not-done: ${message}\n` };
  return failed(`dispatch-not-done: ${message}`);
}
