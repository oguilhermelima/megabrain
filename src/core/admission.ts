import type { MachineResources } from "./resources.js";

export const DEFAULT_AGENT_COST_BYTES = 2 * 1024 ** 3;

export type AdmissionLimit = number | null;
export type AdmissionPolicy = Readonly<{
  maxAgents?: AdmissionLimit;
  minAvailableMiB?: AdmissionLimit;
  maxPressure?: "normal" | "elevated" | null;
  maxContainerSuites?: AdmissionLimit;
}>;
export type AdmissionRequest = Readonly<{ kind: string; agent: string; estimatedCostBytes: number }>;
export type AdmissionResult =
  | Readonly<{ status: "admitted" }>
  | Readonly<{ status: "queued"; reason: string }>
  | Readonly<{ status: "refused"; reason: string }>;
export type AdmissionSnapshot = Readonly<{
  machine: Pick<MachineResources, "totalMemoryBytes" | "availableMemoryBytes" | "pressure"> | undefined;
  runningAgents: number;
  runningContainerSuites: number;
}>;

const pressureRank = { normal: 0, elevated: 1, critical: 2, unknown: 3 } as const;

export function decideAdmission(request: AdmissionRequest, policy: AdmissionPolicy | undefined, snapshot: AdmissionSnapshot): AdmissionResult {
  if (policy === undefined) return { status: "admitted" };
  const cost = Number.isFinite(request.estimatedCostBytes) && request.estimatedCostBytes >= 0
    ? request.estimatedCostBytes : DEFAULT_AGENT_COST_BYTES;
  if (snapshot.machine !== undefined && cost > snapshot.machine.totalMemoryBytes) {
    return { status: "refused", reason: `estimated cost ${Math.ceil(cost / 1024 ** 2)} MiB exceeds total memory` };
  }
  const reasons: string[] = [];
  const machine = snapshot.machine;
  if (policy.minAvailableMiB != null) {
    if (machine === undefined) reasons.push("available memory unavailable");
    else if (machine.availableMemoryBytes - cost < policy.minAvailableMiB * 1024 ** 2) {
      reasons.push(`${Math.floor(machine.availableMemoryBytes / 1024 ** 2)} MiB available, needs ${policy.minAvailableMiB} MiB free`);
    }
  }
  if (policy.maxPressure != null) {
    if (machine === undefined || machine.pressure === "unknown") reasons.push("memory pressure unavailable");
    else if (pressureRank[machine.pressure] > pressureRank[policy.maxPressure]) reasons.push(`memory pressure ${machine.pressure}`);
  }
  if (policy.maxAgents != null && snapshot.runningAgents >= policy.maxAgents) {
    reasons.push(`${snapshot.runningAgents} agents running, limit ${policy.maxAgents}`);
  }
  if (request.kind === "container-suite" && policy.maxContainerSuites != null && snapshot.runningContainerSuites >= policy.maxContainerSuites) {
    reasons.push(`${snapshot.runningContainerSuites} container suites running, limit ${policy.maxContainerSuites}`);
  }
  return reasons.length === 0 ? { status: "admitted" } : { status: "queued", reason: reasons.join("; ") };
}
