import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDelivery, createDispatch, getDispatch, appendMessage, transcriptPath } from "../../src/adapters/state-db.js";
import { listDeliveries, listMessages } from "../../src/adapters/state-db.js";
import { startSupervisorWorker, superviseOnce } from "../../src/cli/commands/supervise.js";
import { openDatabase } from "../../src/db/db.js";
import { failed, ok } from "../../src/core/result.js";
import type { DatabaseHandle } from "../../src/db/db.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { getTmux, registerTmux, type TmuxProvider } from "../../src/hosts/tmux.js";

let directory = "";
let database: DatabaseHandle | undefined;
afterEach(async () => { database?.close(); database = undefined; if (directory !== "") await rm(directory, { recursive: true, force: true }); directory = ""; });

const doneAt = "2026-11-03T12:00:00.000Z";

async function setup(deliveryStatus: string, acknowledgedAt: string | null) {
  directory = await mkdtemp(`${tmpdir()}/megabrain-supervise-auto-close-`);
  const opened = openDatabase({ MEGABRAIN_STATE_DIR: directory, HOME: directory });
  if (opened.kind !== "ok") throw new Error(opened.error);
  database = opened.value;
  const created = createDispatch(database, {
    dispatchId: "dispatch-auto-close", state: "done", runtime: "tmux", tmuxSession: "auto-close-session",
    tmuxPane: "%8", tmuxSessionOwned: true, terminalId: "%8", parentSessionId: "parent",
  });
  if (created.kind !== "ok") throw new Error(created.error);
  const message = appendMessage(database, "dispatch-auto-close", {
    from: "child", type: "done", text: "finished", sessionId: "%8", createdAt: doneAt,
  });
  if (message.kind !== "ok") throw new Error(message.error);
  const delivered = createDelivery(database, {
    id: "delivery-done", dispatchId: "dispatch-auto-close", recipient: "parent", messageSeqs: [message.value.seq],
    status: deliveryStatus, acknowledgedAt,
  });
  if (delivered.kind !== "ok") throw new Error(delivered.error);
  return database;
}

function adapter(run: ProcessAdapter["run"]): ProcessAdapter {
  return { run, startDetached: async () => failed("unused"), invocationCount: () => 0 };
}

describe("supervisor dispatch auto-close", () => {
  test("keeps the supervisor alive and never probes or closes before done ack", async () => {
    const db = await setup("outstanding", null);
    let tmuxCalls = 0;
    const process = adapter(async (command) => {
      if (command === "tmux") tmuxCalls += 1;
      return failed("unexpected command");
    });
    const result = await superviseOnce(directory, db, { MEGABRAIN_STATE_DIR: directory, HOME: directory }, process, Date.parse(doneAt) + 600_000);
    expect(result.open).toBe(true);
    expect(tmuxCalls).toBe(0);
    expect(getDispatch(db, "dispatch-auto-close")).toMatchObject({ kind: "ok", value: { state: "done" } });
  });

  test("starts the supervisor for a completed tmux dispatch awaiting ack", async () => {
    const db = await setup("outstanding", null);
    db.close();
    database = undefined;
    let started = 0;
    const process: ProcessAdapter = {
      run: async () => failed("unexpected command"),
      startDetached: async () => { started += 1; return ok({ pid: 100 }); },
      invocationCount: () => 0,
    };
    const result = await startSupervisorWorker(directory, { MEGABRAIN_STATE_DIR: directory, HOME: directory }, process);
    expect(result).toBe("started");
    expect(started).toBe(1);
  });

  test("holds the dispatch through grace and records a human client viewing it", async () => {
    const db = await setup("acknowledged", "2026-11-03T12:00:10.000Z");
    let calls = 0;
    const process = adapter(async (_command, args) => {
      calls += 1;
      if (args[0] === "-L" && args[1] === "default") return ok({ stdout: "1793707201|1793707201\n", stderr: "", exitCode: 0 });
      return failed("unexpected command");
    });
    const result = await superviseOnce(directory, db, { MEGABRAIN_STATE_DIR: directory, HOME: directory }, process, Date.parse("2026-11-03T12:03:00.000Z"));
    expect(result.open).toBe(false);
    expect(calls).toBe(1);
    expect(getDispatch(db, "dispatch-auto-close")).toMatchObject({ kind: "ok", value: { state: "done", autoCloseViewedAt: "2026-11-03T12:03:00.000Z" } });
  });

  test("keeps an idle client attached before done open", async () => {
    const db = await setup("acknowledged", "2026-11-03T12:00:10.000Z");
    const process = adapter(async (_command, args) => args[1] === "default"
      ? ok({ stdout: "1793707190|1793707199\n", stderr: "", exitCode: 0 })
      : failed("unexpected command"));
    const result = await superviseOnce(directory, db, { MEGABRAIN_STATE_DIR: directory, HOME: directory }, process, Date.parse("2026-11-03T12:03:00.000Z"));
    expect(result.open).toBe(false);
    expect(getDispatch(db, "dispatch-auto-close")).toMatchObject({ kind: "ok", value: { state: "done", autoCloseViewedAt: "2026-11-03T12:03:00.000Z" } });
  });

  test("defers closing when tmux client listing fails unexpectedly", async () => {
    const db = await setup("acknowledged", "2026-11-03T12:00:10.000Z");
    const process = adapter(async () => failed("permission denied"));
    const result = await superviseOnce(directory, db, { MEGABRAIN_STATE_DIR: directory, HOME: directory }, process, Date.parse("2026-11-03T12:03:00.000Z"));
    expect(result.open).toBe(true);
    expect(getDispatch(db, "dispatch-auto-close")).toMatchObject({ kind: "ok", value: { state: "done" } });
  });

  test("stays alive during the acknowledgement grace and closes after it", async () => {
    const db = await setup("acknowledged", "2026-11-03T12:00:10.000Z");
    const original = getTmux();
    registerTmux({ ...original, id: "tmux", paneExists: async () => ok(true), sessionExists: async () => ok(true), panesForSession: async () => ok(["%8"]), capturePane: async () => ok(""), killSession: async () => ok(undefined) });
    const process = adapter(async (_command, args) => args[0] === "-L" ? ok({ stdout: "", stderr: "", exitCode: 0 }) : failed("unexpected command"));
    try {
      const environment = { MEGABRAIN_STATE_DIR: directory, HOME: directory, MEGABRAIN_SESSION_ID: "parent", MEGABRAIN_SESSION_HOST: "superset" };
      expect((await superviseOnce(directory, db, environment, process, Date.parse("2026-11-03T12:01:00.000Z"))).open).toBe(true);
      expect((await superviseOnce(directory, db, environment, process, Date.parse("2026-11-03T12:02:10.000Z"))).open).toBe(false);
      expect(getDispatch(db, "dispatch-auto-close")).toMatchObject({ kind: "ok", value: { state: "closed" } });
    } finally { registerTmux(original); }
  });

  test("keeps a failed close pending for retry", async () => {
    const db = await setup("acknowledged", "2026-11-03T12:00:10.000Z");
    const original = getTmux();
    registerTmux({ ...original, id: "tmux", paneExists: async () => ok(true), sessionExists: async () => ok(true), panesForSession: async () => ok(["%8"]), capturePane: async () => ok(""), killSession: async () => failed("busy") });
    const process = adapter(async (_command, args) => args[0] === "-L" ? ok({ stdout: "", stderr: "", exitCode: 0 }) : failed("unexpected command"));
    try {
      const result = await superviseOnce(directory, db, { MEGABRAIN_STATE_DIR: directory, HOME: directory, MEGABRAIN_SESSION_ID: "parent", MEGABRAIN_SESSION_HOST: "superset" }, process, Date.parse("2026-11-03T12:03:00.000Z"));
      expect(result.open).toBe(true);
      expect(getDispatch(db, "dispatch-auto-close")).toMatchObject({ kind: "ok", value: { state: "done" } });
    } finally { registerTmux(original); }
  });

  test("closes an unviewed tmux dispatch after the ack grace and keeps its transcript", async () => {
    const db = await setup("acknowledged", "2026-11-03T12:00:10.000Z");
    const original = getTmux();
    registerTmux({
      ...original, id: "tmux",
      paneExists: async () => ok(true),
      sessionExists: async () => ok(true),
      panesForSession: async () => ok(["%8"]),
      capturePane: async () => ok("finished transcript"),
      killSession: async () => ok(undefined),
    } satisfies TmuxProvider);
    const process = adapter(async (_command, args) => args[0] === "-L"
      ? ok({ stdout: "", stderr: "", exitCode: 0 })
      : failed("unexpected command"));
    try {
      const result = await superviseOnce(directory, db, {
        MEGABRAIN_STATE_DIR: directory, HOME: directory,
        MEGABRAIN_SESSION_ID: "parent", MEGABRAIN_SESSION_HOST: "superset",
      }, process, Date.parse("2026-11-03T12:02:10.000Z"));
      expect(result.open).toBe(false);
      expect(getDispatch(db, "dispatch-auto-close")).toMatchObject({ kind: "ok", value: { state: "closed" } });
      const transcript = transcriptPath({ MEGABRAIN_STATE_DIR: directory }, "dispatch-auto-close");
      expect(transcript.kind).toBe("ok");
      if (transcript.kind === "ok") expect(await Bun.file(transcript.value).text()).toBe("finished transcript");
    } finally {
      registerTmux(original);
    }
  });
});
