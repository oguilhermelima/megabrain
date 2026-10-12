import type { ProcessAdapter } from "../../adapters/proc.js";
import { listDispatches, readAdmissionPolicy, resourceHistoryEnabled, setResourceHistory, stateDatabase, writeAdmissionPolicy, type StoredAdmissionPolicy } from "../../adapters/state-db.js";
import { readDockerResources, readMachineResources, sampleProcessTree, type DockerResource, type MachineResources, type ProcessResources } from "../../core/resources.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";
import { callerFromEnvironment } from "./orchestrate-list.js";

type Environment = Readonly<Record<string, string | undefined>>;
type DispatchResource = Readonly<{ dispatchId: string; agent: string; state: string; pid?: number; resources?: ProcessResources }>;
type ResourceSnapshot = Readonly<{ machine: MachineResources | null; docker: readonly DockerResource[] | null; dispatches: readonly DispatchResource[] }>;
const OPEN = new Set(["queued", "spawning", "running", "waiting_for_reply", "orphaned"]);

export async function collectResources(environment: Environment, process: ProcessAdapter, all = false): Promise<ResourceSnapshot> {
  const [machine, docker] = await Promise.all([readMachineResources(process), readDockerResources(process)]);
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return { machine: machine ?? null, docker: docker ?? null, dispatches: [] };
  const listed = listDispatches(database.value);
  if (listed.kind !== "ok") return { machine: machine ?? null, docker: docker ?? null, dispatches: [] };
  const caller = all ? undefined : await callerFromEnvironment(environment, process);
  const selected = listed.value.filter((item) => OPEN.has(String(item.state)) && (all || item.ownerSessionId === caller?.id || item.ownerSessionId === caller?.terminalId));
  const dispatches = await Promise.all(selected.map(async (item): Promise<DispatchResource> => {
    const pane = typeof item.tmuxPane === "string" && item.tmuxPane !== "";
    let pid = typeof item.agentPid === "number" ? item.agentPid : Number(item.agentPid);
    if (pane) {
      const panePid = await process.run("tmux", ["display-message", "-p", "-t", String(item.tmuxPane), "#{pane_pid}"]);
      pid = panePid.kind === "ok" ? Number(panePid.value.stdout.trim()) : 0;
    }
    const resources = Number.isSafeInteger(pid) && pid > 1 ? await sampleProcessTree(pid, process) : undefined;
    return { dispatchId: String(item.dispatchId), agent: String(item.agent ?? "unknown"), state: String(item.state), ...(resources === undefined ? {} : { pid, resources }) };
  }));
  return { machine: machine ?? null, docker: docker ?? null, dispatches };
}

function bytes(value: number | undefined): string { return value === undefined ? "n/a" : `${(value / 1024 ** 2).toFixed(0)} MiB`; }
function format(snapshot: ResourceSnapshot): string {
  const machine = snapshot.machine;
  const lines = [machine === null ? "machine: unavailable" : `machine: memory ${bytes(machine.availableMemoryBytes)} available / ${bytes(machine.totalMemoryBytes)} total · pressure ${machine.pressure} · swap ${bytes(machine.swapUsedBytes)} · load ${machine.loadAverage1.toFixed(2)}/${machine.loadAverage5.toFixed(2)} · ${machine.cpuCount} CPUs`];
  if (snapshot.docker !== null) lines.push(`docker: ${snapshot.docker.length === 0 ? "running, no containers" : snapshot.docker.map((item) => `${item.name} ${bytes(item.memoryBytes)} ${item.cpuPercent.toFixed(1)}% CPU`).join(" · ")}`);
  else lines.push("docker: unavailable");
  lines.push(...snapshot.dispatches.map((item) => `${item.dispatchId} · ${item.agent} · RSS ${bytes(item.resources?.rssBytes)} · CPU ${item.resources?.cpuPercent.toFixed(1) ?? "n/a"}%`));
  if (snapshot.dispatches.length === 0) lines.push("dispatches: none open");
  return `${lines.join("\n")}\n`;
}

export async function executeResources(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("resources"));
  if (args[0] === "policy") {
    const action = args[1];
    if (action === "show" && args.length === 2) {
      const policy = await readAdmissionPolicy(environment);
      return ok(policy === undefined ? "resource admission: off\n" : `resource admission policy:\n${Object.entries(policy).map(([key, value]) => `  ${key}: ${value}`).join("\n")}\n`);
    }
    if (action === "off" && args.length === 2) {
      await writeAdmissionPolicy(environment, undefined);
      return ok("resource admission: off\n");
    }
    if (action === "set") {
      const current = await readAdmissionPolicy(environment) ?? {};
      const next: Record<string, unknown> = { ...current };
      const flags: Record<string, keyof StoredAdmissionPolicy> = {
        "--max-agents": "maxAgents", "--min-available-mib": "minAvailableMiB",
        "--max-pressure": "maxPressure", "--max-container-suites": "maxContainerSuites",
      };
      let changed = 0;
      for (let index = 2; index < args.length; index += 2) {
        const flag = args[index] ?? "";
        const key = flags[flag];
        const value = args[index + 1];
        if (key === undefined || value === undefined) return failed(`invalid resource policy option: ${flag}`, 2);
        if (value === "none") delete next[key];
        else if (key === "maxPressure") {
          if (value !== "normal" && value !== "elevated") return failed("--max-pressure must be normal, elevated, or none", 2);
          next[key] = value;
        } else {
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 0) return failed(`${flag} must be a non-negative integer or none`, 2);
          next[key] = Number(value);
        }
        changed += 1;
      }
      if (changed === 0) return failed("resources policy set requires at least one limit", 2);
      await writeAdmissionPolicy(environment, next as StoredAdmissionPolicy);
      return ok("resource admission policy updated\n");
    }
    return failed("resources policy accepts show|set [limits]|off", 2);
  }
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  if (args.length === 1 && (args[0] === "enable" || args[0] === "disable")) {
    const enabled = args[0] === "enable";
    await setResourceHistory(environment, enabled);
    return ok(`resource history: ${enabled ? "enabled" : "disabled"}\n`);
  }
  if (args.length === 1 && args[0] === "status") return ok(`resource history: ${await resourceHistoryEnabled(environment) ? "enabled" : "disabled"}\n`);
  if (args.every((argument) => argument === "--json" || argument === "--all") && new Set(args).size === args.length) {
    const snapshot = await collectResources(environment, process, args.includes("--all"));
    return ok(args.includes("--json") ? `${JSON.stringify(snapshot, null, 2)}\n` : format(snapshot));
  }
  return failed("resources accepts [--json|--all], enable|disable|status, or policy show|set|off", 2);
}
