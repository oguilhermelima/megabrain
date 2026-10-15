import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { createDispatch } from "../../src/adapters/state-db.js";
import { stateDatabase } from "../../src/adapters/state-db.js";
import { ok, failed, type Result } from "../../src/core/result.js";
import { executeOrchestrateTranscript } from "../../src/cli/commands/orchestrate-transcript.js";

const temporary: string[] = [];
async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "megabrain-transcript-test-"));
  temporary.push(path);
  return path;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function fakeProcess(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput> = () => ok({ stdout: "", stderr: "", exitCode: 0 })): ProcessAdapter {
  let calls = 0;
  return {
    async run(command, args) { calls += 1; return behavior(command, args); },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls; },
  };
}

async function setup(): Promise<{ root: string; home: string }> {
  const root = await tempDir();
  const home = await tempDir();
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") throw new Error(database.error);
  return { root, home };
}

async function addDispatch(root: string, values: Record<string, unknown>): Promise<void> {
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") throw new Error(database.error);
  const created = createDispatch(database.value, {
    dispatchId: "dispatch-1", parentHost: "local", parentSessionId: "caller", agent: "claude",
    runtime: "tmux", tmuxPane: "%1", worktreePath: "/Users/operator/project", state: "running",
    ...values,
  });
  if (created.kind !== "ok") throw new Error(created.error);
}

async function installFixture(home: string, agent: string): Promise<void> {
  const target = agent === "claude" ? join(home, ".claude", "projects", "sample-project")
    : agent === "codex" ? join(home, ".codex", "sessions", "2026", "10", "01")
      : join(home, ".grok", "sessions", encodeURIComponent("/Users/operator/project"), "fixture-session");
  await mkdir(target, { recursive: true });
  const source = join(process.cwd(), "tests", "fixtures", "transcripts", `${agent}.jsonl`);
  await cp(source, join(target, agent === "claude" ? "fixture-session.jsonl" : agent === "codex" ? "rollout-2026-10-01T10-00-00-fixture-thread.jsonl" : "updates.jsonl"));
}

function transcript(result: Result<string>): { events: Array<{ id: string; at: string | null; kind: string; text: string; tool?: { name: string; input?: string; status?: string } }>; cursor: string; source: string } {
  if (result.kind !== "ok") throw new Error(result.error);
  return JSON.parse(result.value) as { events: Array<{ id: string; at: string | null; kind: string; text: string; tool?: { name: string; input?: string; status?: string } }>; cursor: string; source: string };
}

describe("orchestrate transcript", () => {
  test.each(["claude", "codex", "grok"] as const)("parses %s session events in order", async (agent) => {
    const { root, home } = await setup();
    await installFixture(home, agent);
    const metadata = agent === "claude" ? { agentSessionId: "fixture-session" }
      : agent === "codex" ? { agentThreadId: "fixture-thread" }
        : { grokSessionId: "fixture-session" };
    await addDispatch(root, { agent, ...metadata });
    const output = transcript(await executeOrchestrateTranscript(["dispatch-1", "--json"], {
      MEGABRAIN_STATE_DIR: root, HOME: home, MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "caller",
    }, fakeProcess()));
    expect(output.events.map((event) => event.kind)).toEqual(["user", "thinking", "tool-call", "tool-result", "assistant"]);
    expect(output.events.map((event) => event.text)).toContain("Please inspect the project.");
    expect(output.source).toBe(agent);
  });

  test("pages the transcript by its returned cursor and keeps ids stable", async () => {
    const { root, home } = await setup();
    await installFixture(home, "claude");
    await addDispatch(root, { agentSessionId: "fixture-session" });
    const environment = { MEGABRAIN_STATE_DIR: root, HOME: home, MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "caller" };
    const initial = transcript(await executeOrchestrateTranscript(["dispatch-1", "--json"], environment, fakeProcess()));
    const again = transcript(await executeOrchestrateTranscript(["dispatch-1", "--json"], environment, fakeProcess()));
    const path = join(home, ".claude", "projects", "sample-project", "fixture-session.jsonl");
    await appendFile(path, `${JSON.stringify({ type: "assistant", uuid: "fixture-appended", timestamp: "2026-10-01T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "A later response." }] } })}\n`);
    const newer = transcript(await executeOrchestrateTranscript(["dispatch-1", "--since", initial.cursor, "--json"], environment, fakeProcess()));
    expect(again.events.map((event) => event.id)).toEqual(initial.events.map((event) => event.id));
    expect(newer.events.map((event) => event.text)).toEqual(["A later response."]);
    expect(newer.cursor).not.toBe(initial.cursor);
  });

  test("caps event text and skips signature-only thinking", async () => {
    const { root, home } = await setup();
    await mkdir(join(home, ".claude", "projects", "sample"), { recursive: true });
    await writeFile(join(home, ".claude", "projects", "sample", "fixture-session.jsonl"), [
      JSON.stringify({ type: "assistant", uuid: "signature", message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "signature-only" }] } }),
      JSON.stringify({ type: "user", uuid: "long", message: { role: "user", content: "x".repeat(9000) } }),
    ].join("\n") + "\n");
    await addDispatch(root, { agentSessionId: "fixture-session" });
    const output = transcript(await executeOrchestrateTranscript(["dispatch-1", "--json"], {
      MEGABRAIN_STATE_DIR: root, HOME: home, MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "caller",
    }, fakeProcess()));
    expect(output.events).toHaveLength(1);
    expect(output.events[0]?.text.length).toBeLessThanOrEqual(8000);
    expect(output.events[0]?.text).toContain("[truncated]");
  });

  test("uses pane scrollback as a terminal system event if the session log is absent", async () => {
    const { root, home } = await setup();
    await addDispatch(root, { agentSessionId: "missing-session" });
    const output = transcript(await executeOrchestrateTranscript(["dispatch-1", "--json"], {
      MEGABRAIN_STATE_DIR: root, HOME: home, MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "caller",
    }, fakeProcess((command, args) => {
      if (command !== "tmux") return failed("unexpected command");
      if (args[0] === "list-panes") return ok({ stdout: "%1\n", stderr: "", exitCode: 0 });
      if (args[0] === "capture-pane") return ok({ stdout: "pane output\n", stderr: "", exitCode: 0 });
      return failed("unexpected tmux command");
    })));
    expect(output.source).toBe("terminal");
    expect(output.events).toEqual([expect.objectContaining({ kind: "system", text: "pane output" })]);
  });

  test("refuses a foreign dispatch without --operator", async () => {
    const { root, home } = await setup();
    await addDispatch(root, { parentSessionId: "someone-else", parentHost: "local" });
    const result = await executeOrchestrateTranscript(["dispatch-1"], {
      MEGABRAIN_STATE_DIR: root, HOME: home, MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "caller",
    }, fakeProcess());
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("is owned by");
  });

  test("reads a session directly and rejects unknown agent prefixes", async () => {
    const { root, home } = await setup();
    await installFixture(home, "claude");
    const environment = { MEGABRAIN_STATE_DIR: root, HOME: home };
    expect(transcript(await executeOrchestrateTranscript(["--session", "claude:fixture-session", "--json"], environment, fakeProcess())).events).toHaveLength(5);
    const unknown = await executeOrchestrateTranscript(["--session", "mystery:session"], environment, fakeProcess());
    expect(unknown.kind).toBe("failed");
    if (unknown.kind === "failed") expect(unknown.error).toContain("unknown agent");
  });

  test("prints readable event blocks without --json", async () => {
    const { root, home } = await setup();
    await installFixture(home, "claude");
    await addDispatch(root, { agentSessionId: "fixture-session" });
    const result = await executeOrchestrateTranscript(["dispatch-1"], {
      MEGABRAIN_STATE_DIR: root, HOME: home, MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "caller",
    }, fakeProcess());
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value.startsWith("user\nPlease inspect the project.\n\nthinking\n")).toBe(true);
  });
});
