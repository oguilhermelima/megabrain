import { describe, expect, test } from "bun:test";
import { parseDispatchRecord } from "../../src/core/dispatch.js";
import { reconcileDecision } from "../../src/core/orchestrate-reconcile.js";
import { checkDispatchTransition, dispatchStates, processStates, terminalStates, type DispatchAxis } from "../../src/core/dispatch-states.js";

const transitions = {
  dispatch: {
    spawning: ["spawning", "running", "exited", "failed", "closed"],
    running: ["running", "waiting_for_reply", "done", "exited", "failed", "orphaned", "closed"],
    waiting_for_reply: ["waiting_for_reply", "running", "done", "exited", "failed", "orphaned", "closed"],
    done: ["done", "closed"],
    exited: ["exited", "closed"],
    failed: ["failed", "closed"],
    orphaned: ["orphaned", "running", "waiting_for_reply", "done", "exited", "failed", "closed"],
    closed: ["closed"],
    circuit_broken: ["circuit_broken"],
  },
  process: {
    starting: ["starting", "running", "start-unproven", "failed", "stopping", "stopped", "stop-unproven", "abandoned"],
    "start-unproven": ["start-unproven", "running", "failed", "stopping", "stopped", "stop-unproven", "abandoned"],
    running: ["running", "succeeded", "failed", "stopping", "stopped", "abandoned", "exited"],
    stopping: ["stopping", "stopped", "stop-unproven", "running", "failed", "abandoned"],
    "stop-unproven": ["stop-unproven", "failed", "stopped", "abandoned"],
    succeeded: ["succeeded"],
    failed: ["failed"],
    stopped: ["stopped"],
    abandoned: ["abandoned"],
    exited: ["exited", "running", "succeeded"],
  },
  terminal: {
    owned: ["owned", "missing", "released"],
    missing: ["missing", "released"],
    released: ["released"],
  },
} as const satisfies Record<DispatchAxis, Readonly<Record<string, readonly string[]>>>;

const statesByAxis = { dispatch: dispatchStates, process: processStates, terminal: terminalStates } as const;
const cases = (Object.entries(transitions) as Array<[DispatchAxis, Readonly<Record<string, readonly string[]>>]>).flatMap(([axis, rows]) =>
  Object.entries(rows).flatMap(([from, allowed]) => statesByAxis[axis].map((to) => ({ axis, from, to, allowed: allowed.includes(to) }))),
);

describe("dispatch transition table", () => {
  test.each(cases)("$axis $from -> $to follows the bash table", ({ axis, from, to, allowed }) => {
    const result = checkDispatchTransition(axis, from, to);
    expect(result.kind).toBe(allowed ? "ok" : "failed");
  });

  test("returns Unknown with a reason for an unrecognised axis or state", () => {
    expect(checkDispatchTransition("other", "running", "done").kind).toBe("unknown");
    expect(checkDispatchTransition("dispatch", "future", "done").kind).toBe("unknown");
    expect(checkDispatchTransition("dispatch", "running", "future").kind).toBe("unknown");
  });
});

describe("dispatch state consumers", () => {
  test("reads legacy circuit-broken rows as exited", () => {
    const result = parseDispatchRecord({ state: "circuit_broken" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value.state).toBe("exited");
  });

  test("reads legacy retained and identity-unproven rows as exited without changing stored metadata", () => {
    const raw = { state: "running", terminalState: "retained", stage: "identity-unproven" };
    const result = parseDispatchRecord(raw);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value.raw.state).toBe("exited");
    expect(raw.state).toBe("running");
  });

  test("keeps every orphaned recovery transition legal", () => {
    expect(checkDispatchTransition("dispatch", "orphaned", "running").kind).toBe("ok");
    expect(checkDispatchTransition("dispatch", "orphaned", "waiting_for_reply").kind).toBe("ok");
    expect(checkDispatchTransition("dispatch", "orphaned", "done").kind).toBe("ok");
  });

  test("does not change dispatch state while its terminal is alive", () => {
    const result = reconcileDecision({ state: "waiting_for_reply", processState: "running", terminalState: "owned" }, "proven", "alive");
    expect(result).toEqual({ outcome: "running", updates: {} });
  });

  test("makes exited state final", () => {
    expect(checkDispatchTransition("dispatch", "exited", "running").kind).toBe("failed");
    expect(checkDispatchTransition("dispatch", "exited", "closed").kind).toBe("ok");
  });
});
