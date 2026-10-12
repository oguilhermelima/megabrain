import type { ProcessAdapter } from "../adapters/proc.js";
import { homedir } from "node:os";
import { join } from "node:path";

export type MachineResources = Readonly<{
  totalMemoryBytes: number; availableMemoryBytes: number; pressure: "normal" | "elevated" | "critical" | "unknown";
  swapUsedBytes: number; loadAverage1: number; loadAverage5: number; cpuCount: number;
}>;
export type ProcessResources = Readonly<{ rssBytes: number; cpuPercent: number }>;
export type DockerResource = Readonly<{ name: string; memoryBytes: number; cpuPercent: number }>;

const finite = (value: string | undefined): number | undefined => value === undefined || !Number.isFinite(Number(value)) ? undefined : Number(value);
const kb = (value: number): number => value * 1024;
const mb = (value: number): number => value * 1024 * 1024;

export function parseMacMachineResources(vmStat: string, sysctl: string, memoryPressure: string): MachineResources {
  const pageSize = finite(/page size of ([\d,]+) bytes/i.exec(vmStat)?.[1]?.replaceAll(",", "")) ?? 4096;
  const pages = (name: string): number => finite(new RegExp(`^Pages ${name}:\\s*([\\d,]+)`, "mi").exec(vmStat)?.[1]?.replaceAll(",", "")) ?? 0;
  const sys = (name: string): string | undefined => new RegExp(`^${name}:\\s*(.+)$`, "mi").exec(sysctl)?.[1]?.trim();
  const total = finite(sys("hw.memsize")) ?? 0;
  const load = /vm\.loadavg:\s*\{\s*([\d.]+)\s+([\d.]+)/.exec(sysctl);
  const swap = /used\s*=\s*([\d.]+)M/i.exec(sys("vm.swapusage") ?? "");
  const freePercent = finite(/System-wide memory free percentage:\s*([\d.]+)%/i.exec(memoryPressure)?.[1]);
  // macOS available memory follows psutil: free + inactive pages.
  const freeBytes = (pages("free") + pages("inactive")) * pageSize;
  return {
    totalMemoryBytes: total, availableMemoryBytes: freeBytes,
    pressure: freePercent === undefined ? "unknown" : freePercent < 10 ? "critical" : freePercent < 20 ? "elevated" : "normal",
    // sysctl reports swap in MiB; round to the nearest whole byte.
    swapUsedBytes: swap === null ? 0 : Math.round(mb(Number(swap[1]))),
    loadAverage1: Number(load?.[1] ?? 0), loadAverage5: Number(load?.[2] ?? 0),
    cpuCount: finite(sys("hw.ncpu")) ?? 0,
  };
}

export function parseLinuxMachineResources(meminfo: string, loadavg: string, pressure: string): MachineResources {
  const fields = new Map([...meminfo.matchAll(/^([^:]+):\s*(\d+)\s*kB\s*$/gmi)].map((match) => [match[1]!.trim(), Number(match[2])]));
  const total = fields.get("MemTotal") ?? 0;
  const available = fields.get("MemAvailable") ?? fields.get("MemFree") ?? 0;
  const swap = (fields.get("SwapTotal") ?? 0) - (fields.get("SwapFree") ?? 0);
  const load = /^(\S+)\s+(\S+)/.exec(loadavg.trim());
  const some = /^some\s+.*?avg10=(\d+(?:\.\d+)?)/m.exec(pressure);
  const avg = some?.[1] === undefined ? undefined : Number(some[1]);
  return { totalMemoryBytes: kb(total), availableMemoryBytes: kb(available), swapUsedBytes: kb(Math.max(0, swap)),
    loadAverage1: Number(load?.[1] ?? 0), loadAverage5: Number(load?.[2] ?? 0),
    pressure: avg === undefined ? "unknown" : avg >= 10 ? "critical" : avg >= 1 ? "elevated" : "normal", cpuCount: 0 };
}

export function parseProcessTable(table: string, rootPid: number): ProcessResources {
  const rows = table.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
  const parent = new Map<number, number>();
  for (const row of rows) if (row.length >= 4 && row.every(Number.isFinite)) parent.set(row[0]!, row[1]!);
  const included = new Set<number>([rootPid]);
  let changed = true;
  while (changed) { changed = false; for (const [pid, ppid] of parent) if (included.has(ppid) && !included.has(pid)) { included.add(pid); changed = true; } }
  let rss = 0; let cpu = 0;
  for (const row of rows) if (included.has(row[0]!)) { rss += row[2]!; cpu += row[3]!; }
  return { rssBytes: rss * 1024, cpuPercent: cpu };
}

export async function sampleProcessTree(rootPid: number, process: ProcessAdapter, platform = processPlatform()): Promise<ProcessResources | undefined> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) return undefined;
  const result = await process.run("ps", ["-A", "-o", "pid=,ppid=,rss=,%cpu="]);
  return result.kind === "ok" ? parseProcessTable(result.value.stdout, rootPid) : undefined;
}

function processPlatform(): string { return process.platform; }

export async function readMachineResources(process: ProcessAdapter, platform = processPlatform()): Promise<MachineResources | undefined> {
  if (platform === "darwin") {
    const [vm, ctl, pressure] = await Promise.all([
      process.run("vm_stat", []), process.run("sysctl", ["hw.memsize", "vm.swapusage", "vm.loadavg", "hw.ncpu"]), process.run("memory_pressure", []),
    ]);
    if (vm.kind !== "ok" || ctl.kind !== "ok") return undefined;
    return parseMacMachineResources(vm.value.stdout, ctl.value.stdout, pressure.kind === "ok" ? pressure.value.stdout : "");
  }
  if (platform === "linux") {
    const [mem, load, pressure, cpu] = await Promise.all([
      process.run("cat", ["/proc/meminfo"]), process.run("cat", ["/proc/loadavg"]), process.run("cat", ["/proc/pressure/memory"]), process.run("getconf", ["_NPROCESSORS_ONLN"]),
    ]);
    if (mem.kind !== "ok" || load.kind !== "ok") return undefined;
    return { ...parseLinuxMachineResources(mem.value.stdout, load.value.stdout, pressure.kind === "ok" ? pressure.value.stdout : ""), cpuCount: Number(cpu.kind === "ok" ? cpu.value.stdout.trim() : 0) };
  }
  return undefined;
}

const DOCKER_TIMEOUT_MS = 3000;

function isMissingExecutable(error: string | undefined, command: string): boolean {
  return error?.includes(`${command}: executable not found`) === true;
}

async function socketExists(process: ProcessAdapter): Promise<boolean> {
  const host = globalThis.process.env.DOCKER_HOST;
  const configuredSocket = host?.startsWith("unix://") ? host.slice("unix://".length) : undefined;
  const sockets = configuredSocket ? [configuredSocket] : ["/var/run/docker.sock", join(homedir(), ".docker/run/docker.sock")];
  for (const socket of sockets) {
    const result = await process.run("test", ["-S", socket], { timeoutMs: 500 });
    if (result.kind === "ok") return true;
  }
  return false;
}

async function orbStackIsRunning(process: ProcessAdapter): Promise<boolean | undefined> {
  const orb = await process.run("orb", ["status"], { timeoutMs: DOCKER_TIMEOUT_MS });
  if (orb.kind === "ok") return /^Running\s*$/m.test(orb.value.stdout);
  if (!isMissingExecutable(orb.error, "orb")) return false;
  const orbctl = await process.run("orbctl", ["status"], { timeoutMs: DOCKER_TIMEOUT_MS });
  if (orbctl.kind === "ok") return /^Running\s*$/m.test(orbctl.value.stdout);
  if (isMissingExecutable(orbctl.error, "orbctl")) return undefined;
  return false;
}

export async function readDockerResources(process: ProcessAdapter, platform = processPlatform()): Promise<readonly DockerResource[] | undefined> {
  if (platform === "darwin") {
    const orbStackRunning = await orbStackIsRunning(process);
    if (orbStackRunning === false) return undefined;
    if (orbStackRunning === undefined && !(await socketExists(process))) return undefined;
  } else if (!(await socketExists(process))) return undefined;
  const result = await process.run("docker", ["stats", "--no-stream", "--format", "{{json .}}"], { timeoutMs: DOCKER_TIMEOUT_MS });
  if (result.kind !== "ok") return undefined;
  const resources: DockerResource[] = [];
  for (const line of result.value.stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const row = JSON.parse(line) as Record<string, string>;
      const mem = /^([\d.]+)\s*(B|KiB|MiB|GiB)$/i.exec(row.MemUsage?.split("/")[0]?.trim() ?? "");
      if (row.Name === undefined || mem === null) continue;
      const scale = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[mem[2] as "B" | "KiB" | "MiB" | "GiB"];
      resources.push({ name: row.Name, memoryBytes: Math.round(Number(mem[1]) * scale), cpuPercent: Number.parseFloat(row.CPUPerc ?? "0") || 0 });
    } catch { /* ignore malformed Docker rows */ }
  }
  return resources;
}
