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

function transcriptJson(result: Result<string>): { events: Array<{ id: string; at: string | null; kind: string; text: string; tool?: { name: string; input?: string; status?: string } }>; cursor: string; source: string; truncated?: boolean } {
  return transcript(result) as ReturnType<typeof transcript> & { truncated?: boolean };
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

  test("bounds default output to the newest 300 events and preserves the end cursor", async () => {
    const { root, home } = await setup();
    const project = join(home, ".claude", "projects", "sample-project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "fixture-session.jsonl"), Array.from({ length: 305 }, (_, index) => JSON.stringify({
      type: "user", timestamp: `2026-10-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`, message: { role: "user", content: `event ${index}` },
    })).join("\n") + "\n");
    await addDispatch(root, { agentSessionId: "fixture-session" });
    const environment = { MEGABRAIN_STATE_DIR: root, HOME: home, MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "caller" };
    const first = transcriptJson(await executeOrchestrateTranscript(["dispatch-1", "--json"], environment, fakeProcess()));
    expect(first.events).toHaveLength(300);
    expect(first.events[0]?.text).toBe("event 5");
    expect(first.events.at(-1)?.text).toBe("event 304");
    expect(first.truncated).toBe(true);
    const all = transcriptJson(await executeOrchestrateTranscript(["dispatch-1", "--since", "v1:0", "--limit", "400", "--json"], environment, fakeProcess()));
    expect(all.events).toHaveLength(305);
    expect(all.truncated).toBeUndefined();
    const capped = transcriptJson(await executeOrchestrateTranscript(["dispatch-1", "--since", "v1:0", "--limit", "20", "--json"], environment, fakeProcess()));
    expect(capped.events.map((event) => event.text)).toEqual(Array.from({ length: 20 }, (_, index) => `event ${index + 285}`));
    expect(capped.truncated).toBe(true);
    expect(capped.cursor).toBe(first.cursor);
  });

  test("finds a Claude child log by worktree, creation time and first-entry cwd", async () => {
    const { root, home } = await setup();
    const project = join(home, ".claude", "projects", "-Users-operator-project");
    await mkdir(project, { recursive: true });
    const entry = (cwd: string, timestamp: string, text: string) => JSON.stringify({ cwd, type: "assistant", timestamp, message: { role: "assistant", content: text } });
    await writeFile(join(project, "older.jsonl"), `${entry("/Users/operator/project", "2026-10-01T09:59:59.000Z", "too early")}\n`);
    await writeFile(join(project, "other-cwd.jsonl"), `${entry("/Users/operator/other", "2026-10-01T10:00:01.000Z", "wrong cwd")}\n`);
    await writeFile(join(project, "child-session.jsonl"), `${entry("/Users/operator/project", "2026-10-01T10:00:01.000Z", "matched child")}\n`);
    await addDispatch(root, { agentSessionId: null, createdAt: "2026-10-01T10:00:00.000Z" });
    const output = transcript(await executeOrchestrateTranscript(["dispatch-1", "--json"], {
      MEGABRAIN_STATE_DIR: root, HOME: home, MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "caller",
    }, fakeProcess()));
    expect(output.source).toBe("claude");
    expect(output.events.map((event) => event.text)).toEqual(["matched child"]);
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

  test.each([
    [{ id: "terminal-1", ok: true, result: { terminal: { tail: ["first host line", "second host line"] } } }, "first host line\nsecond host line"],
    [{ id: "terminal-1", ok: true, result: { text: "legacy host text" } }, "legacy host text"],
  ] as const)("extracts terminal text from the captured host read payload shape", async (payload, expected) => {
    const { root, home } = await setup();
    await addDispatch(root, { runtime: "host", childHost: "orca", terminalId: "terminal-1", workspaceId: "workspace-1", agentSessionId: "missing-session" });
    const output = transcript(await executeOrchestrateTranscript(["dispatch-1", "--json"], {
      MEGABRAIN_STATE_DIR: root, HOME: home, MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "caller",
    }, fakeProcess(() => ok({ stdout: JSON.stringify(payload), stderr: "", exitCode: 0 }))));
    expect(output.source).toBe("terminal");
    expect(output.events).toEqual([expect.objectContaining({ kind: "system", text: expected })]);
  });

  test("uses shell commands as tool event text for Codex and Claude", async () => {
    const { root, home } = await setup();
    const codex = join(home, ".codex", "sessions", "2026", "10", "01");
    await mkdir(codex, { recursive: true });
    await writeFile(join(codex, "rollout-2026-10-01T10-00-00-fixture-thread.jsonl"), [
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec", arguments: JSON.stringify({ cmd: "printf 'codex command'\necho next" }) } }),
    ].join("\n") + "\n");
    await addDispatch(root, { agent: "codex", agentThreadId: "fixture-thread" });
    const codexOutput = transcript(await executeOrchestrateTranscript(["dispatch-1", "--json"], {
      MEGABRAIN_STATE_DIR: root, HOME: home, MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "caller",
    }, fakeProcess()));
    expect(codexOutput.events[0]?.text).toBe("printf 'codex command'");

    await writeFile(join(home, ".claude", "projects", "sample-project", "fixture-session.jsonl"), `${JSON.stringify({
      type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "echo claude command\necho next" } }] },
    })}\n`);
    await addDispatch(root, { agent: "claude", agentSessionId: "fixture-session" });
    const claudeOutput = transcript(await executeOrchestrateTranscript(["dispatch-1", "--json"], {
      MEGABRAIN_STATE_DIR: root, HOME: home, MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "caller",
    }, fakeProcess()));
    expect(claudeOutput.events[0]?.text).toBe("echo claude command");
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
