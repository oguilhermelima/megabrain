import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { executeQueueWrite } from "../../src/cli/commands/queue-write.js";
import { executeCheck } from "../../src/cli/commands/check.js";
import { failed, ok } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { createDispatch, listMessages, stateDatabase } from "../../src/adapters/state-db.js";

const processAdapter: ProcessAdapter = {
  async run() { return ok<ProcessOutput>({ stdout: "", stderr: "", exitCode: 0 }); },
  async startDetached() { return failed("not used"); },
  invocationCount() { return 0; },
};

async function seed(root: string, dispatchId: string): Promise<void> {
  const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") throw new Error(db.error);
  const created = createDispatch(db.value, { dispatchId, agent: "codex", state: "running", processState: "running", runtime: "host", childHost: "local", terminalId: "child-term" });
  if (created.kind !== "ok") throw new Error(created.error);
}

function messageTypes(root: string, dispatchId: string): string[] {
  const db = stateDatabase({ HOME: root, MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") throw new Error(db.error);
  const listed = listMessages(db.value, dispatchId);
  return listed.kind === "ok" ? listed.value.map((message) => message.type) : [];
}

describe("a child's state directory is the dispatch's own", () => {
  test("done lands in the dispatch state although MEGABRAIN_STATE_DIR points at a temporary directory", async () => {
    const real = await mkdtemp(`${tmpdir()}/megabrain-dispatch-real-`);
    const temporary = await mkdtemp(`${tmpdir()}/megabrain-dispatch-temp-`);
    try {
      await seed(real, "d-state");
      const result = await executeQueueWrite("done", ["finished"], {
        HOME: real, MEGABRAIN_STATE_DIR: temporary, MEGABRAIN_DISPATCH_STATE_DIR: real, MEGABRAIN_DISPATCH_ID: "d-state", MEGABRAIN_SESSION_ID: "child-term",
      }, processAdapter);
      expect(result.kind).toBe("ok");
      expect(messageTypes(real, "d-state")).toContain("done");
    } finally {
      await rm(real, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("received and ask follow the dispatch state too", async () => {
    const real = await mkdtemp(`${tmpdir()}/megabrain-dispatch-real-`);
    const temporary = await mkdtemp(`${tmpdir()}/megabrain-dispatch-temp-`);
    try {
      await seed(real, "d-state");
      const environment = { HOME: real, MEGABRAIN_STATE_DIR: temporary, MEGABRAIN_DISPATCH_STATE_DIR: real, MEGABRAIN_DISPATCH_ID: "d-state", MEGABRAIN_SESSION_ID: "child-term" };
      expect((await executeQueueWrite("received", [], environment, processAdapter)).kind).toBe("ok");
      expect((await executeQueueWrite("ask", ["which one?"], environment, processAdapter)).kind).toBe("ok");
      expect(messageTypes(real, "d-state")).toEqual(expect.arrayContaining(["received", "ask"]));
    } finally {
      await rm(real, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("check reads the dispatch state, not the temporary one", async () => {
    const real = await mkdtemp(`${tmpdir()}/megabrain-dispatch-real-`);
    const temporary = await mkdtemp(`${tmpdir()}/megabrain-dispatch-temp-`);
    try {
      await seed(real, "d-state");
      const result = await executeCheck(["--timeout", "0"], { HOME: real, MEGABRAIN_STATE_DIR: temporary, MEGABRAIN_DISPATCH_STATE_DIR: real, MEGABRAIN_DISPATCH_ID: "d-state", MEGABRAIN_SESSION_ID: "child-term" }, processAdapter);
      expect(result.kind === "failed" ? result.error : "").not.toContain("no managed dispatch");
    } finally {
      await rm(real, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("without the dispatch variable the ordinary state directory still applies", async () => {
    const real = await mkdtemp(`${tmpdir()}/megabrain-dispatch-real-`);
    try {
      await seed(real, "d-plain");
      const result = await executeQueueWrite("done", ["finished"], { HOME: real, MEGABRAIN_STATE_DIR: real, MEGABRAIN_DISPATCH_ID: "d-plain", MEGABRAIN_SESSION_ID: "child-term" }, processAdapter);
      expect(result.kind).toBe("ok");
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });
});
