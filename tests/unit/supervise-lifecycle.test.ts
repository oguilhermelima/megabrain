import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { executeSupervisorWorker, superviseOnce } from "../../src/cli/commands/supervise.js";
import { appendMessage, createDispatch, listMessages } from "../../src/adapters/state-db.js";
import { failed, ok } from "../../src/core/result.js";
import { openDatabase } from "../../src/db/db.js";
import { listLeases } from "../../src/adapters/state-db.js";
import { acquireSupervisorLease, hasOpenDispatches, isLiveProcessState, mayAutoRecover, shouldNotifyFinding } from "../../src/core/supervise.js";

async function paneGoneFixture(dispatchId = "pane-gone") {
  const directory = await mkdtemp(`${tmpdir()}/megabrain-supervise-finding-`);
  const environment = { MEGABRAIN_STATE_DIR: directory, HOME: directory };
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") throw new Error(opened.error);
  const created = createDispatch(opened.value, {
    dispatchId, state: "running", runtime: "tmux", tmuxSession: "missing", tmuxPane: "%7",
    worktreePath: "/shared/worktree", agent: "codex", terminalId: "worker", parentSessionId: "parent",
    parentHost: "unknown", parentTerminalId: "parent-terminal", chatName: dispatchId,
  });
  if (created.kind !== "ok") throw new Error(created.error);
  let dirtyFiles = " M first.ts\n";
  const process = {
    async run(command: string, args: readonly string[]) {
      if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "", stderr: "", exitCode: 0 });
      if (command === "git") return ok({ stdout: dirtyFiles, stderr: "", exitCode: 0 });
      return failed(`unexpected process invocation: ${command} ${args.join(" ")}`);
    },
    async startDetached() { return ok({ pid: 123 }); },
    invocationCount() { return 0; },
  };
  return {
    directory, environment, database: opened.value, process,
    setDirtyFiles(value: string) { dirtyFiles = value; },
    async close() { opened.value.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

async function supervise(fixture: Awaited<ReturnType<typeof paneGoneFixture>>, now: number) {
  return superviseOnce(fixture.directory, fixture.database, fixture.environment, fixture.process, now);
}

function superviseMessages(database: Parameters<typeof listMessages>[0], dispatchId: string) {
  const messages = listMessages(database, dispatchId);
  if (messages.kind !== "ok") throw new Error(messages.error);
  return messages.value.filter((message) => message.type === "supervise");
}

describe("supervisor lifecycle decisions", () => {
  test("notifies once for stable evidence, then again only when the finding changes or recurs", () => {
    const paneGone = { cause: "pane-gone" as const, paneId: "%7", worktreePath: "/repo", dirtyFiles: [] };
    const previousPaneGone = { ...paneGone, notifiedAt: 1_000 };
    expect(shouldNotifyFinding(undefined, paneGone, 1_000)).toBe(true);
    expect(shouldNotifyFinding(previousPaneGone, paneGone, 1_000 + 3 * 60 * 60_000)).toBe(false);
    expect(shouldNotifyFinding({ ...previousPaneGone, cause: "process-exited" }, paneGone, 1_001)).toBe(true);
    // An unknown finding records that the dispatch recovered; a later stop starts a new notice.
    expect(shouldNotifyFinding(undefined, paneGone, 1_001)).toBe(true);
    const usageLimit = { cause: "usage-limit" as const, resetAt: "1:43 PM" };
    expect(shouldNotifyFinding({ ...usageLimit, notifiedAt: 1_000 }, usageLimit, 1_000 + 3 * 60 * 60_000)).toBe(false);
    expect(shouldNotifyFinding({ ...usageLimit, notifiedAt: 1_000 }, { ...usageLimit, resetAt: "2:10 PM" }, 1_001)).toBe(true);
    expect(shouldNotifyFinding(undefined, { cause: "unknown" }, 1_000)).toBe(false);
  });

  test("appends one pane-gone notice across three hours of checks", async () => {
    const fixture = await paneGoneFixture();
    try {
      const start = 1_800_000_000_000;
      for (let tick = 0; tick <= 6; tick += 1) await supervise(fixture, start + tick * 30 * 60_000);
      expect(superviseMessages(fixture.database, "pane-gone")).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  test("keeps one pane-gone notice across three hours of checks and changing worktree files", async () => {
    const fixture = await paneGoneFixture();
    try {
      const start = 1_800_000_000_000;
      for (let tick = 0; tick <= 6; tick += 1) {
        fixture.setDirtyFiles(` M file-${tick}.ts\n`);
        await supervise(fixture, start + tick * 30 * 60_000);
      }
      expect(superviseMessages(fixture.database, "pane-gone")).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  test("ignores newer agent activity from another dispatch sharing the worktree", async () => {
    const fixture = await paneGoneFixture();
    try {
      const start = 1_800_000_000_000;
      await supervise(fixture, start);
      const other = createDispatch(fixture.database, {
        dispatchId: "other-worker", state: "running", worktreePath: "/shared/worktree", agent: "codex",
      });
      if (other.kind !== "ok") throw new Error(other.error);
      const received = appendMessage(fixture.database, "other-worker", {
        from: "child", type: "received", text: "working", createdAt: new Date(start + 60_000).toISOString(),
      });
      if (received.kind !== "ok") throw new Error(received.error);
      for (let tick = 1; tick <= 6; tick += 1) await supervise(fixture, start + tick * 30 * 60_000);
      expect(superviseMessages(fixture.database, "pane-gone")).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  test("notifies again after a newer received message from the same dispatch", async () => {
    const fixture = await paneGoneFixture();
    try {
      const start = 1_800_000_000_000;
      await supervise(fixture, start);
      const received = appendMessage(fixture.database, "pane-gone", {
        from: "child", type: "received", text: "recovered", createdAt: new Date(start + 60_000).toISOString(),
      });
      if (received.kind !== "ok") throw new Error(received.error);
      await supervise(fixture, start + 120_000);
      expect(superviseMessages(fixture.database, "pane-gone")).toHaveLength(2);
    } finally { await fixture.close(); }
  });

  test("compares identity fields independent of object key order and ignores message context", () => {
    const previous = { cause: "pane-gone" as const, paneId: "%7", notifiedAt: 1_000, worktreePath: "/old", dirtyFiles: ["old.ts"] };
    const current = { dirtyFiles: ["new.ts"], paneId: "%7", worktreePath: "/new", cause: "pane-gone" as const };
    expect(shouldNotifyFinding(previous, current, 2_000)).toBe(false);
    expect(shouldNotifyFinding({ cause: "network", errorText: "timeout", errorCode: "ETIMEDOUT", notifiedAt: 1_000 }, { errorCode: "ETIMEDOUT", cause: "network", errorText: "timeout" }, 2_000)).toBe(false);
  });

  test("auto-recovers only an unsubmitted prompt and exits when no dispatch is open", () => {
    expect(mayAutoRecover({ cause: "prompt-unsubmitted" })).toBe(true);
    for (const cause of ["usage-limit", "rate-limited", "server-error", "network", "auth-required", "dialog-waiting", "process-exited", "pane-gone", "unknown"] as const) {
      expect(mayAutoRecover({ cause })).toBe(false);
    }
    expect(hasOpenDispatches(["spawning", "running", "waiting_for_reply", "orphaned"])).toBe(true);
    expect(hasOpenDispatches(["done", "failed", "closed", "circuit_broken"])).toBe(false);
  });

  test("a zombie agent is not a live process", () => {
    expect(isLiveProcessState("")).toBe(false);
    expect(isLiveProcessState("Zs\n")).toBe(false);
    expect(isLiveProcessState("Z+")).toBe(false);
    expect(isLiveProcessState("S\n")).toBe(true);
    expect(isLiveProcessState("Ss+")).toBe(true);
  });

  test("uses one database lease for the state directory and releases it for the next owner", async () => {
    const directory = await mkdtemp(`${tmpdir()}/megabrain-supervise-lease-`);
    const opened = openDatabase({ MEGABRAIN_STATE_DIR: directory, HOME: directory });
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      expect(acquireSupervisorLease(opened.value, "first", 30)).toEqual({ kind: "ok", value: true });
      expect(acquireSupervisorLease(opened.value, "second", 30)).toEqual({ kind: "ok", value: false });
      opened.value.db.run("DELETE FROM leases WHERE key = ?", ["supervise"]);
      expect(acquireSupervisorLease(opened.value, "second", 30)).toEqual({ kind: "ok", value: true });
    } finally {
      opened.value.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("supervisor worker", () => {
  test("exits when its state directory is deleted underneath it", async () => {
    const directory = await mkdtemp(`${tmpdir()}/megabrain-supervise-gone-`);
    const environment = { MEGABRAIN_STATE_DIR: directory, HOME: directory, MEGABRAIN_SUPERVISE_INTERVAL_SECONDS: "1" };
    const opened = openDatabase(environment);
    if (opened.kind !== "ok") throw new Error(opened.error);
    const created = createDispatch(opened.value, { dispatchId: "d1", state: "running" });
    if (created.kind !== "ok") throw new Error(created.error);
    opened.value.close();
    const process = { async run() { return failed("not used"); }, async startDetached() { return failed("not used"); }, invocationCount() { return 0; } };
    const worker = executeSupervisorWorker(["1-00000000-0000-0000-0000-000000000000"], environment, process);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await rm(directory, { recursive: true, force: true });
    const outcome = await Promise.race([worker.then(() => "exited"), new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 4000))]);
    expect(outcome).toBe("exited");
  }, 10000);

  test("records its own process id as the lease holder so --stop reaches it", async () => {
    const directory = await mkdtemp(`${tmpdir()}/megabrain-supervise-pid-`);
    const environment = { MEGABRAIN_STATE_DIR: directory, HOME: directory, MEGABRAIN_SUPERVISE_INTERVAL_SECONDS: "1" };
    const opened = openDatabase(environment);
    if (opened.kind !== "ok") throw new Error(opened.error);
    const created = createDispatch(opened.value, { dispatchId: "d1", state: "running" });
    if (created.kind !== "ok") throw new Error(created.error);
    const starter = "1-00000000-0000-0000-0000-000000000000";
    expect(acquireSupervisorLease(opened.value, starter, 30)).toEqual({ kind: "ok", value: true });
    const process = { async run() { return failed("not used"); }, async startDetached() { return failed("not used"); }, invocationCount() { return 0; } };
    const worker = executeSupervisorWorker([starter], environment, process);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const leases = listLeases(opened.value);
      if (leases.kind !== "ok") throw new Error(leases.error);
      const holder = leases.value.find((lease) => lease.key === "supervise")?.holder ?? "";
      expect(holder.split("-", 1)[0]).toBe(String(globalThis.process.pid));
    } finally {
      opened.value.close();
      await rm(directory, { recursive: true, force: true });
      await worker;
    }
  }, 10000);
});

// Spawn owns the first prompt until its transport step settles: an agent launched with the brief on its
// command line can show an idle, empty composer for seconds before submitting it (Codex while its MCP
// servers start), and the paste fallback waits through that. Judging the prompt then calls it lost.
describe("supervisor and a prompt still in transport", () => {
  async function idleFixture(dispatchId: string, record: Record<string, unknown>) {
    const directory = await mkdtemp(`${tmpdir()}/megabrain-supervise-transport-`);
    const environment = { MEGABRAIN_STATE_DIR: directory, HOME: directory };
    const opened = openDatabase(environment);
    if (opened.kind !== "ok") throw new Error(opened.error);
    const created = createDispatch(opened.value, {
      dispatchId, runtime: "tmux", tmuxSession: "s", tmuxPane: "%9", worktreePath: "/shared/worktree", agent: "codex",
      terminalId: "worker", parentSessionId: "parent", parentHost: "unknown", parentTerminalId: "parent-terminal", chatName: dispatchId,
      ...record,
    });
    if (created.kind !== "ok") throw new Error(created.error);
    const prompt = appendMessage(opened.value, dispatchId, { from: "parent", type: "prompt", text: "[megabrain dispatch: codex /shared/worktree]\n\nDispatch identity: " + dispatchId + "\n\nRun the whole migration and report the counts.", sessionId: "parent" });
    if (prompt.kind !== "ok") throw new Error(prompt.error);
    const frame = await readFile(new URL("../fixtures/tmux-capture-codex-argv-pending.txt", import.meta.url), "utf8");
    const process = {
      async run(command: string, args: readonly string[]) {
        if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%9\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "capture-pane") return ok({ stdout: frame, stderr: "", exitCode: 0 });
        // The pane's shell carries the dispatch identity, which is how the supervisor proves the pane.
        if (command === "tmux" && args.includes("#{pane_pid}")) return ok({ stdout: "4242\n", stderr: "", exitCode: 0 });
        if (command === "ps" && args.includes("tty=")) return ok({ stdout: "ttys009\n", stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "eww") return ok({ stdout: `4242 1 -zsh MEGABRAIN_DISPATCH_ID=${dispatchId}\n`, stderr: "", exitCode: 0 });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      },
      async startDetached() { return ok({ pid: 123 }); },
      invocationCount() { return 0; },
    };
    return {
      directory, environment, database: opened.value, process,
      async close() { opened.value.close(); await rm(directory, { recursive: true, force: true }); },
    };
  }

  test("a settled dispatch idle at an empty composer without its prompt is reported lost", async () => {
    const fixture = await idleFixture("settled-idle", { state: "running", promptTransport: "transported" });
    try {
      await superviseOnce(fixture.directory, fixture.database, fixture.environment, fixture.process, Date.now());
      expect(superviseMessages(fixture.database, "settled-idle").map((message) => message.text.split(".")[0])).toEqual(["prompt-lost"]);
    } finally {
      await fixture.close();
    }
  });

  test("a spawning dispatch whose prompt is still in transport is not judged", async () => {
    const fixture = await idleFixture("spawning-idle", { state: "spawning", promptTransport: "pending" });
    try {
      await superviseOnce(fixture.directory, fixture.database, fixture.environment, fixture.process, Date.now());
      expect(superviseMessages(fixture.database, "spawning-idle")).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
