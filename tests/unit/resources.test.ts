import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { parseLinuxMachineResources, parseMacMachineResources, parseProcessTable, sampleProcessTree, readDockerResources } from "../../src/core/resources.js";
import { executeResources } from "../../src/cli/commands/resources.js";

const fixture = (name: string) => readFile(join(import.meta.dir, "../fixtures/resources", name), "utf8");

function processFor(behavior: (command: string, args: readonly string[]) => string | undefined): ProcessAdapter {
  return {
    run: async (command, args): Promise<Result<ProcessOutput>> => {
      const stdout = behavior(command, args);
      return stdout === undefined ? { kind: "failed", error: `${command} unavailable` } : ok({ stdout, stderr: "", exitCode: 0 });
    },
    startDetached: async () => ({ kind: "failed", error: "unused" }),
    invocationCount: () => 0,
  };
}

describe("resource sampling", () => {
  test("parses captured macOS system output", async () => {
    const [vmStat, sysctl, pressure] = await Promise.all([fixture("macos/vm-stat.txt"), fixture("macos/sysctl.txt"), fixture("macos/memory-pressure.txt")]);
    expect(parseMacMachineResources(vmStat, sysctl, pressure)).toEqual({
      totalMemoryBytes: 19327352832, availableMemoryBytes: 3829448704, pressure: "normal",
      swapUsedBytes: 3285587067, loadAverage1: 5.3, loadAverage5: 5.45, cpuCount: 11,
    });
  });

  test("parses captured Linux proc output and tolerates missing PSI", async () => {
    const [meminfo, loadavg, pressure] = await Promise.all([fixture("linux/meminfo.txt"), fixture("linux/loadavg.txt"), fixture("linux/pressure-memory.txt")]);
    expect(parseLinuxMachineResources(meminfo, loadavg, pressure)).toMatchObject({
      totalMemoryBytes: 6284353536, availableMemoryBytes: 3553796096, swapUsedBytes: 388427776,
      loadAverage1: 1.13, loadAverage5: 1.23, pressure: "unknown",
    });
  });

  test("sums RSS and CPU across only the root process and its descendants", () => {
    const table = "PID PPID RSS %CPU\n10 1 1000 2.5\n11 10 2000 3.0\n12 11 3000 4.5\n13 1 9000 99.0\n";
    expect(parseProcessTable(table, 10)).toEqual({ rssBytes: 6144000, cpuPercent: 10 });
  });

  test("uses the pane process tree and skips Docker when the daemon does not answer", async () => {
    const process = processFor((command, args) => command === "ps" && args.join(" ") === "-A -o pid=,ppid=,rss=,%cpu=" ? "10 1 1000 2.5\n11 10 2000 3.0\n" : undefined);
    await expect(sampleProcessTree(10, process, "linux")).resolves.toEqual({ rssBytes: 3072000, cpuPercent: 5.5 });
    const docker = await readDockerResources(process);
    expect(docker).toBeUndefined();
  });
  test("resources --json returns a stable machine, Docker, and dispatch shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-resources-"));
    const vm = await fixture("macos/vm-stat.txt");
    const ctl = await fixture("macos/sysctl.txt");
    const pressure = await fixture("macos/memory-pressure.txt");
    const process = processFor((command) => command === "vm_stat" ? vm : command === "sysctl" ? ctl : command === "memory_pressure" ? pressure : undefined);
    try {
      const result = await executeResources(["--json", "--all"], { MEGABRAIN_STATE_DIR: root }, process);
      expect(result.kind).toBe("ok");
      const payload = JSON.parse(result.kind === "ok" ? result.value : "{}") as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(["dispatches", "docker", "machine"]);
      expect(payload.machine).toMatchObject({ totalMemoryBytes: 19327352832, pressure: "normal", cpuCount: 11 });
      expect(payload.dispatches).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
