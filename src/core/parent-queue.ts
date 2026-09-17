import { failed, ok, type Result } from "./result.js";

export type ParentAckArguments = Readonly<{
  readonly dispatchId: string;
  readonly deliveryId: string;
  readonly consumer?: string;
  readonly generation: number;
  readonly close?: boolean;
  readonly json: boolean;
}>;

export function parseParentAckArgs(args: readonly string[]): Result<ParentAckArguments> {
  const dispatchId = args[0] ?? "";
  const deliveryId = args[1] ?? "";
  if (dispatchId === "" || deliveryId === "") return failed("Usage: megabrain orchestrate ack <dispatch-id> <delivery-id> [--consumer <id>] [--generation <number>] [--json]\n", 2);
  let consumer: string | undefined;
  let generation = 1;
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

export function acknowledgeDelivery(status: string, recordConsumer: string, recordGeneration: number, consumer: string, generation: number): Result<{ readonly duplicate: boolean }> {
  if (status === "acknowledged") return ok({ duplicate: true });
  if (status === "fenced") return failed("delivery delivery refused: delivery is fenced");
  if (status !== "outstanding" && status !== "superseded") return failed(`delivery delivery refused: status is invalid (${status})`);
  if (recordConsumer !== consumer || recordGeneration !== generation) return failed(`delivery delivery refused: outstanding delivery belongs to consumer ${recordConsumer} generation ${recordGeneration}`);
  return ok({ duplicate: false });
}
