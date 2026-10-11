import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";
import { findClaudeSessionPid, resolveClaudeSession } from "../../src/agents/claude-session.js";

const capturedSession = new URL("../fixtures/claude-session-idle.json", import.meta.url);

function processFor(parents: Readonly<Record<number, number>>) {
  const process: ProcessAdapter = {
    async run(command, args) {
      if (command !== "ps") return failed(`unexpected command ${command}`);
      const pid = Number(args[args.indexOf("-p") + 1]);
      const parent = parents[pid];
      return parent === undefined
        ? failed(`no parent for ${pid}`)
        : ok<ProcessOutput>({ stdout: `${parent}\n`, stderr: "", exitCode: 0 });
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
  return process;
}

async function writeSession(home: string, pid: number, sessionId: string, status = "idle") {
  const directory = join(home, ".claude", "sessions");
  await mkdir(directory, { recursive: true });
  const captured = JSON.parse(await readFile(capturedSession, "utf8")) as Record<string, unknown>;
  await writeFile(join(directory, `${pid}.json`), JSON.stringify({ ...captured, pid, sessionId, status }));
}

describe("Claude session identity", () => {
  test("finds the matching session file while walking parent processes", async () => {
    const home = await mkdtemp(join(tmpdir(), "megabrain-claude-session-"));
    try {
      await writeSession(home, 300, "parent-session");
      const pid = await findClaudeSessionPid("parent-session", home, processFor({ 900: 700, 700: 300, 300: 1 }), 900);
      expect(pid).toBe(300);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("rescans by session id when the stored pid belongs to another session", async () => {
    const home = await mkdtemp(join(tmpdir(), "megabrain-claude-session-"));
    try {
      await writeSession(home, 400, "parent-session");
      await writeSession(home, 500, "different-session", "busy");
      const session = await resolveClaudeSession(home, 500, "parent-session");
      expect(session).toMatchObject({ pid: 400, sessionId: "parent-session", status: "idle" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("does not accept a session file whose id does not match", async () => {
    const home = await mkdtemp(join(tmpdir(), "megabrain-claude-session-"));
    try {
      await writeSession(home, 500, "different-session");
      expect(await resolveClaudeSession(home, 500, "parent-session")).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
