import { describe, expect, test } from "bun:test";
import { decideAdmission, type AdmissionPolicy, type AdmissionRequest } from "../../src/core/admission.js";

const request: AdmissionRequest = { kind: "spawn", agent: "codex", estimatedCostBytes: 2 * 1024 ** 3 };
const machine = { totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 8 * 1024 ** 3, pressure: "normal" as const };

describe("resource admission", () => {
  test("admits without an opt-in policy", () => {
    expect(decideAdmission(request, undefined, { machine, runningAgents: 20, runningContainerSuites: 4 })).toEqual({ status: "admitted" });
  });

  test("queues when memory pressure exceeds the policy, with a useful reason", () => {
    const policy: AdmissionPolicy = { maxPressure: "normal" };
    expect(decideAdmission(request, policy, {
      machine: { ...machine, pressure: "elevated" }, runningAgents: 1, runningContainerSuites: 0,
    })).toEqual({ status: "queued", reason: "memory pressure elevated" });
  });

  test("queues when the agent limit is reached", () => {
    const policy: AdmissionPolicy = { maxAgents: 2 };
    expect(decideAdmission(request, policy, { machine, runningAgents: 2, runningContainerSuites: 0 })).toMatchObject({
      status: "queued", reason: expect.stringContaining("2 agents running"),
    });
  });

  test("applies the container suite limit to that request kind", () => {
    const policy: AdmissionPolicy = { maxContainerSuites: 1 };
    expect(decideAdmission({ ...request, kind: "container-suite" }, policy, {
      machine, runningAgents: 0, runningContainerSuites: 1,
    })).toMatchObject({ status: "queued", reason: expect.stringContaining("container suites") });
  });

  test("refuses a cost that exceeds total memory", () => {
    expect(decideAdmission({ ...request, estimatedCostBytes: machine.totalMemoryBytes + 1 }, {}, {
      machine, runningAgents: 0, runningContainerSuites: 0,
    })).toMatchObject({ status: "refused", reason: expect.stringContaining("total memory") });
  });
});
