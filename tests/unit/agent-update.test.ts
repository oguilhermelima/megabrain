import { describe, expect, test } from "bun:test";
import { codexReleaseVersion, inspectAgentUpdate, runAgentUpdate, runAgentUpdateLocked, type AgentInstallKind, type AgentVersionSource } from "../../src/core/agent-update.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentUpdateStatus, recordAgentUpdate, runBackgroundAgentUpdate, scheduleAgentAutoUpdate } from "../../src/core/agent-update.js";

function fakeProcess(installed: string, executablePath: string, version: string, calls: string[][] = []): ProcessAdapter {
  return {
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "sh") return ok({ stdout: `${installed}\n`, stderr: "", exitCode: 0 });
      if (command === "realpath") return ok({ stdout: `${executablePath}\n`, stderr: "", exitCode: 0 });
      if (args[0] === "--version") return ok({ stdout: `${version}\n`, stderr: "", exitCode: 0 });
      if (args[0] === "update" || command === "bash" || command === "npm" || command === "brew") return ok({ stdout: "updated\n", stderr: "", exitCode: 0 });
      return failed("unexpected command", 1);
    },
    startDetached: async () => failed("not used"),
    invocationCount: () => calls.length,
  };
}

const fixedLatest = (latest: string | null): AgentVersionSource => async () => latest;

describe("agent update", () => {
  test("reads the standalone Codex release tag from the official channel manifest", () => {
    expect(codexReleaseVersion({ tag_name: "0.163.0", assets: [] })).toBe("0.163.0");
  });

  test("check reports installed and latest without invoking an installer", async () => {
    const calls: string[][] = [];
    const process = fakeProcess("/usr/local/bin/codex", "/usr/local/lib/node_modules/@openai/codex/bin/codex", "codex-cli 0.162.1", calls);
    const report = await inspectAgentUpdate("codex", process, fixedLatest("0.163.0"));
    expect(report).toMatchObject({ agent: "codex", installed: "0.162.1", latest: "0.163.0", status: "update-available", installKind: "npm" satisfies AgentInstallKind });
    expect(calls.some((call) => call[0] === "npm" && call[1] === "install")).toBe(false);
  });

  test("a newer Codex standalone release runs the official installer", async () => {
    const calls: string[][] = [];
    const process = fakeProcess("/Users/test/.local/bin/codex", "/Users/test/.codex/packages/standalone/releases/0.163.0/bin/codex", "codex-cli 0.163.0", calls);
    const report = await runAgentUpdate("codex", false, process, fixedLatest("0.164.0"));
    expect(report).toMatchObject({ installed: "0.163.0", latest: "0.164.0", status: "updated", installKind: "standalone" });
    expect(calls.some((call) => call[0] === "bash" && call.at(-1)?.includes("chatgpt.com/codex/install.sh"))).toBe(true);
  });

  test("a failed or unavailable latest source is recorded as unknown without updating", async () => {
    const calls: string[][] = [];
    const process = fakeProcess("/Users/test/.local/bin/agy", "/Users/test/.local/bin/agy", "1.4.1", calls);
    const report = await runAgentUpdate("agy", true, process, fixedLatest(null));
    expect(report).toMatchObject({ agent: "agy", installed: "1.4.1", latest: null, status: "latest-unknown", installKind: "unknown" });
    expect(calls.some((call) => call[1] === "update")).toBe(false);
  });

  test("background updates skip installs when the official latest version is unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-agent-update-"));
    const calls: string[][] = [];
    const process = fakeProcess("/Users/test/.local/bin/agy", "/Users/test/.local/bin/agy", "1.4.1", calls);
    try {
      await runBackgroundAgentUpdate("agy", process, { MEGABRAIN_STATE_DIR: root }, fixedLatest(null));
      expect(await agentUpdateStatus({ MEGABRAIN_STATE_DIR: root })).toMatchObject({ agy: { status: "latest-unknown", installed: "1.4.1" } });
      expect(calls.some((call) => call[1] === "update")).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("auto update defaults off in a fresh state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-agent-update-"));
    const starts: string[][] = [];
    const process: ProcessAdapter = {
      ...fakeProcess("/bin/codex", "/bin/codex", "codex-cli 1.0.0"),
      startDetached: async (_command, args) => { starts.push([...args]); return ok({ pid: 42 }); },
    };
    try {
      await scheduleAgentAutoUpdate("codex", { MEGABRAIN_STATE_DIR: root }, process);
      expect(starts).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("explicitly enabled auto update reserves one slot and prevents duplicate workers", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-agent-update-"));
    const starts: string[][] = [];
    const process: ProcessAdapter = {
      ...fakeProcess("/bin/codex", "/bin/codex", "codex-cli 1.0.0"),
      startDetached: async (_command, args) => { starts.push([...args]); return ok({ pid: 42 }); },
    };
    try {
      await writeFile(join(root, "agent-update-settings.json"), JSON.stringify({ enabled: true, perAgent: {} }));
      await scheduleAgentAutoUpdate("codex", { MEGABRAIN_STATE_DIR: root }, process);
      await scheduleAgentAutoUpdate("codex", { MEGABRAIN_STATE_DIR: root }, process);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toContain("--background");
      expect(await agentUpdateStatus({ MEGABRAIN_STATE_DIR: root })).toEqual({});
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("auto update can be disabled and fresh results are cached for six hours", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-agent-update-"));
    const starts: string[][] = [];
    const process: ProcessAdapter = {
      ...fakeProcess("/bin/codex", "/bin/codex", "codex-cli 1.0.0"),
      startDetached: async (_command, args) => { starts.push([...args]); return ok({ pid: 42 }); },
    };
    try {
      await writeFile(join(root, "agent-update-settings.json"), JSON.stringify({ enabled: false, perAgent: {} }));
      await scheduleAgentAutoUpdate("codex", { MEGABRAIN_STATE_DIR: root }, process);
      expect(starts).toHaveLength(0);
      await writeFile(join(root, "agent-update-settings.json"), JSON.stringify({ enabled: false, perAgent: { codex: true } }));
      await scheduleAgentAutoUpdate("codex", { MEGABRAIN_STATE_DIR: root }, process);
      expect(starts).toHaveLength(1);
      await writeFile(join(root, "agent-update-settings.json"), JSON.stringify({ enabled: true, perAgent: { codex: false } }));
      await recordAgentUpdate({ agent: "codex", installed: "1.0.0", latest: "1.0.0", installKind: "unknown", status: "up-to-date", checkedAt: new Date().toISOString() }, { MEGABRAIN_STATE_DIR: root });
      await scheduleAgentAutoUpdate("codex", { MEGABRAIN_STATE_DIR: root }, process);
      expect(starts).toHaveLength(1);
      expect(JSON.parse(await readFile(join(root, "agent-updates", "codex.json"), "utf8"))).toMatchObject({ agent: "codex", status: "up-to-date" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("an explicit update reports its in-progress state and successful attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-agent-update-"));
    const calls: string[][] = [];
    const base = fakeProcess("/Users/test/.local/bin/codex", "/Users/test/.codex/packages/standalone/releases/0.163.0/bin/codex", "codex-cli 0.163.0", calls);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const process: ProcessAdapter = {
      ...base,
      run: async (command, args, options) => {
        if (command === "bash") await waiting;
        return base.run(command, args, options);
      },
    };
    try {
      const operation = runAgentUpdateLocked("codex", false, process, { MEGABRAIN_STATE_DIR: root }, fixedLatest("0.164.0"));
      for (let attempt = 0; attempt < 20 && (await agentUpdateStatus({ MEGABRAIN_STATE_DIR: root })).codex?.status !== "updating"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await agentUpdateStatus({ MEGABRAIN_STATE_DIR: root })).codex?.status).toBe("updating");
      release();
      await expect(operation).resolves.toMatchObject({ status: "updated", lastAttempt: { ok: true } });
      expect((await agentUpdateStatus({ MEGABRAIN_STATE_DIR: root })).codex).toMatchObject({ status: "updated", lastAttempt: { ok: true } });
    } finally { release(); await rm(root, { recursive: true, force: true }); }
  });
});
