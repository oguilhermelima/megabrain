import { describe, expect, test } from "bun:test";
import { acknowledgeDelivery, parseParentAckArgs } from "../../src/core/parent-queue.js";

describe("parseParentAckArgs", () => {
  test("parses dispatch, delivery, consumer and generation", () => {
    expect(parseParentAckArgs(["dispatch", "delivery", "--consumer", "orca/parent", "--generation", "3", "--json"])).toEqual({
      kind: "ok",
      value: { dispatchId: "dispatch", deliveryId: "delivery", consumer: "orca/parent", generation: 3, json: true },
    });
  });

  test("rejects missing identifiers and invalid generation", () => {
    expect(parseParentAckArgs([])).toEqual({ kind: "failed", error: "Usage: megabrain orchestrate ack <dispatch-id> <delivery-id> [--consumer <id>] [--generation <number>] [--json]\n", exitCode: 2 });
    expect(parseParentAckArgs(["dispatch", "delivery", "--generation", "0"])).toEqual({ kind: "failed", error: "--generation must be a positive number", exitCode: 2 });
  });
});

describe("acknowledgeDelivery", () => {
  test("acknowledges an owned outstanding delivery", () => {
    expect(acknowledgeDelivery("outstanding", "orca/parent", 3, "orca/parent", 3)).toEqual({ kind: "ok", value: { duplicate: false } });
  });

  test("makes acknowledgement idempotent", () => {
    expect(acknowledgeDelivery("acknowledged", "orca/parent", 3, "orca/parent", 3)).toEqual({ kind: "ok", value: { duplicate: true } });
  });

  test.each([
    ["fenced", "delivery delivery refused: delivery is fenced"],
    ["invalid", "delivery delivery refused: status is invalid (invalid)"],
  ] as const)("refuses %s deliveries", (status, error) => {
    expect(acknowledgeDelivery(status, "orca/parent", 3, "orca/parent", 3)).toEqual({ kind: "failed", error, exitCode: 1 });
  });

  test("refuses a delivery owned by another consumer or generation", () => {
    expect(acknowledgeDelivery("outstanding", "other", 2, "orca/parent", 3)).toEqual({ kind: "failed", error: "delivery delivery refused: outstanding delivery belongs to consumer other generation 2", exitCode: 1 });
  });
});
