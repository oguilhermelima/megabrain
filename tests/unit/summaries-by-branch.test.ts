import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ChatStore, type Chat } from "../../src/chat/store.js";
import { ChatSummarizer, defaultSummarySettings, readSummaries } from "../../src/chat/summaries.js";
import { chatProtocolAdapters } from "../../src/chat/protocol.js";
import { listSummaries, migrateSummaries, resolveLocation, searchEntries, showEntry, summariesContext } from "../../src/chat/summary-library.js";
import { executeSummaries } from "../../src/cli/commands/summaries.js";
import { executeHookSessionStart } from "../../src/cli/commands/hook-session-start.js";
import { executeDoctor, executeInstall } from "../../src/cli/commands/install-doctor.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();

/** A state dir plus a real repository (branch main) with a linked worktree on feat/login. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-sbb-")));
  directories.push(root);
  const state = join(root, "state"), repo = join(root, "api"), feature = join(root, "api-login");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "feat/login", feature);
  const store = new ChatStore(state);
  return { root, state, repo, feature, store };
}

type World = ReturnType<typeof world>;
let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 1) + (clock += 60_000)).toISOString();

/** Writes a chat record and a summaries.jsonl the way the summarizer lays them out; `legacy` drops the new fields. */
async function seed(w: World, cwd: string, texts: string[], options: { legacy?: boolean; agent?: Chat["agent"]; title?: string } = {}): Promise<string> {
  await w.store.initialize();
  const chatId = randomUUID();
  const chat: Chat = { id: chatId, agent: options.agent ?? "claude", model: null, cwd, title: options.title ?? "a chat", state: "idle", mode: "chat", agentSessionId: null, createdAt: at(), lastActivityAt: null, summary: null, titleSource: "first-message" };
  await w.store.put(chat);
  const lines = texts.map((text, index) => {
    const stamp = at();
    const base = { text, updatedAt: stamp, model: "haiku", title: options.title ?? "a chat", userTurns: index + 1 };
    return JSON.stringify(options.legacy === true ? base : { ...base, id: randomUUID(), chatId, repo: cwd, project: "x", worktree: cwd, branch: "x", agent: chat.agent, createdAt: stamp });
  });
  mkdirSync(join(w.state, "chats", chatId), { recursive: true });
  writeFileSync(join(w.state, "chats", chatId, "summaries.jsonl"), `${lines.join("\n")}\n`);
  return chatId;
}

describe("a summary belongs to a worktree and a branch", () => {
  test("resolveLocation names repo, project, worktree and branch for a linked worktree and the main checkout", async () => {
    const w = world();
    expect(await resolveLocation(w.feature)).toEqual({ repo: w.repo, project: "api", worktree: w.feature, branch: "feat/login" });
    expect(await resolveLocation(w.repo)).toEqual({ repo: w.repo, project: "api", worktree: w.repo, branch: "main" });
    // A subfolder resolves to its worktree root.
    mkdirSync(join(w.feature, "src"));
    expect((await resolveLocation(join(w.feature, "src"))).worktree).toBe(w.feature);
  });

  test("a folder outside git keeps its path as repo and worktree", async () => {
    const w = world();
    const loose = join(w.root, "loose");
    mkdirSync(loose);
    expect(await resolveLocation(loose)).toMatchObject({ repo: loose, worktree: loose, project: "loose" });
  });

  test("a new summary entry carries branch, worktree, repo, project, chat and agent", async () => {
    const w = world();
    await w.store.initialize();
    const bin = join(w.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on("end",()=>process.stdout.write("TITLE: Login\\nSUMMARY: Fixed login.\\n"));\n`);
    chmodSync(join(bin, "claude"), 0o700);
    writeFileSync(join(w.state, "chat-summaries.json"), JSON.stringify({ ...defaultSummarySettings, enabled: true, model: "haiku" }));
    const environment = { HOME: w.root, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, MEGABRAIN_STATE_DIR: w.state };
    const summarizer = new ChatSummarizer({ store: w.store, stateDir: w.state, environment, emit: async () => {} });
    const chat: Chat = { id: randomUUID(), agent: "claude", model: null, cwd: w.feature, title: null, state: "idle", mode: "chat", agentSessionId: null, createdAt: at(), lastActivityAt: null, summary: null, titleSource: "first-message" };
    await w.store.put(chat);
    await w.store.append(chat.id, { id: randomUUID(), at: at(), kind: "user", text: "fix login" });
    await summarizer.summarize(chat.id);
    const [entry] = readSummaries(w.state, chat.id);
    expect(entry).toMatchObject({ chatId: chat.id, agent: "claude", repo: w.repo, project: "api", worktree: w.feature, branch: "feat/login", title: "Login", text: "Fixed login.", model: "haiku" });
    expect(typeof (entry as { id?: unknown }).id).toBe("string");
    expect(Date.parse((entry as { createdAt?: string }).createdAt ?? "")).toBeGreaterThan(0);
  });
});

describe("migration of entries written before branches existed", () => {
  test("fills worktree, branch, repo and project from the chat cwd, once", async () => {
    const w = world();
    const id = await seed(w, w.feature, ["old one", "old two"], { legacy: true });
    expect(await migrateSummaries(w.state)).toBe(2);
    const migrated = readSummaries(w.state, id);
    expect(migrated.map((entry) => entry.text)).toEqual(["old two", "old one"]);
    for (const entry of migrated) expect(entry).toMatchObject({ chatId: id, repo: w.repo, project: "api", worktree: w.feature, branch: "feat/login", agent: "claude" });
    const ids = migrated.map((entry) => (entry as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
    // Second run changes nothing, ids included.
    expect(await migrateSummaries(w.state)).toBe(0);
    expect(readSummaries(w.state, id).map((entry) => (entry as { id: string }).id)).toEqual(ids);
  });

  test("a chat whose worktree is gone keeps the path as worktree and falls back to the index branch", async () => {
    const w = world();
    const gone = join(w.root, "deleted-worktree");
    const id = await seed(w, gone, ["from a removed tree"], { legacy: true });
    writeFileSync(join(w.state, "chat-summaries-index.json"), JSON.stringify({ [id]: { chatId: id, project: "deleted-worktree", branch: "feat/old", title: "t", summary: "s", updatedAt: at() } }));
    await migrateSummaries(w.state);
    expect(readSummaries(w.state, id)[0]).toMatchObject({ worktree: gone, branch: "feat/old" });
  });
});

describe("listing, searching, showing", () => {
  test("list groups by project then branch, newest first, ordered by latest activity", async () => {
    const legacy = world();
    await seed(legacy, legacy.feature, ["a1", "a2", "a3"], { legacy: true });
    await seed(legacy, legacy.repo, ["m1"], { legacy: true });
    const result = await listSummaries(legacy.state, {});
    expect(result.projects).toHaveLength(1);
    const project = result.projects[0];
    expect(project).toMatchObject({ repo: legacy.repo, project: "api" });
    // main got the latest entry (m1), so it leads.
    expect(project?.branches.map((branch) => branch.branch)).toEqual(["main", "feat/login"]);
    expect(project?.branches[0]).toMatchObject({ worktree: legacy.repo, live: true });
    expect(project?.branches[1]?.summaries.map((entry) => entry.text)).toEqual(["a3", "a2", "a1"]);
    const login = project?.branches[1]?.summaries[0];
    expect(login).toMatchObject({ repo: legacy.repo, project: "api", worktree: legacy.feature, branch: "feat/login", agent: "claude", model: "haiku", title: "a chat" });
  });

  test("list limits per branch, filters by repo and branch, and marks a removed worktree not live", async () => {
    const w = world();
    await seed(w, w.feature, ["a1", "a2", "a3"], { legacy: true });
    await migrateSummaries(w.state);
    expect((await listSummaries(w.state, { limit: 2 })).projects[0]?.branches[0]?.summaries.map((entry) => entry.text)).toEqual(["a3", "a2"]);
    expect((await listSummaries(w.state, { branch: "main" })).projects).toEqual([]);
    expect((await listSummaries(w.state, { repo: "api", branch: "feat/login" })).projects).toHaveLength(1);
    expect((await listSummaries(w.state, { repo: w.repo })).projects).toHaveLength(1);
    expect((await listSummaries(w.state, { repo: "other" })).projects).toEqual([]);
    git(w.repo, "worktree", "remove", "--force", w.feature);
    const after = await listSummaries(w.state, {});
    expect(after.projects[0]?.branches[0]).toMatchObject({ branch: "feat/login", worktree: w.feature, live: false });
  });

  test("search ranks title and branch hits above body hits, honours filters and limit", async () => {
    const w = world();
    await seed(w, w.feature, ["fixed the redirect after sign in"], { legacy: true, title: "Auth" });
    await seed(w, w.repo, ["notes about the login page copy"], { legacy: true, title: "Docs" });
    await seed(w, w.repo, ["unrelated release chores"], { legacy: true, title: "Chores" });
    await migrateSummaries(w.state);
    const found = await searchEntries(w.state, "login", {});
    expect(found.results.map((entry) => entry.text)).toEqual(["fixed the redirect after sign in", "notes about the login page copy"]);
    expect(found.results[0]?.score).toBeGreaterThan(found.results[1]?.score ?? 0);
    expect((await searchEntries(w.state, "login", { branch: "main" })).results.map((entry) => entry.title)).toEqual(["Docs"]);
    expect((await searchEntries(w.state, "login", { limit: 1 })).results).toHaveLength(1);
    expect((await searchEntries(w.state, "zzz nothing", {})).results).toEqual([]);
    expect((await searchEntries(w.state, "   ", {})).results).toEqual([]);
  });

  test("show finds an entry by id and fails for an unknown one", async () => {
    const w = world();
    await seed(w, w.feature, ["only one"], { legacy: true });
    await migrateSummaries(w.state);
    const [entry] = (await searchEntries(w.state, "only", {})).results;
    expect(entry).toBeDefined();
    expect(await showEntry(w.state, entry?.id ?? "")).toMatchObject({ id: entry?.id, text: "only one", branch: "feat/login" });
    expect(await showEntry(w.state, "nope")).toBeNull();
  });

  test("the summaries verbs print the contract JSON and fail on bad usage", async () => {
    const w = world();
    await seed(w, w.feature, ["login redirect fixed"], { legacy: true });
    const environment = { HOME: w.root, MEGABRAIN_STATE_DIR: w.state };
    const listed = await executeSummaries(["list", "--json"], environment);
    expect(listed.kind === "ok" && JSON.parse(listed.value).projects[0].branches[0]).toMatchObject({ branch: "feat/login", live: true });
    const searched = await executeSummaries(["search", "login", "--json"], environment);
    const hit = searched.kind === "ok" ? JSON.parse(searched.value).results[0] : null;
    expect(hit).toMatchObject({ branch: "feat/login", text: "login redirect fixed" });
    expect(typeof hit.score).toBe("number");
    const shown = await executeSummaries(["show", hit.id, "--json"], environment);
    expect(shown.kind === "ok" && JSON.parse(shown.value).id).toBe(hit.id);
    expect((await executeSummaries(["show", "missing", "--json"], environment)).kind).toBe("failed");
    expect((await executeSummaries(["search", "--json"], environment)).kind).toBe("failed");
    expect((await executeSummaries(["list", "--limit", "0", "--json"], environment)).kind).toBe("failed");
    expect((await executeSummaries(["bogus"], environment)).kind).toBe("failed");
  });
});

describe("summaries context", () => {
  test("branch summaries first, then the latest two of main, as Markdown", async () => {
    const w = world();
    await seed(w, w.feature, ["f1", "f2", "f3", "f4"], { legacy: true });
    await seed(w, w.repo, ["m1", "m2", "m3"], { legacy: true });
    const block = await summariesContext(w.state, w.feature, 3);
    expect(block.indexOf("f4")).toBeGreaterThan(-1);
    expect(block).not.toContain("f1");
    expect(block.indexOf("f4")).toBeLessThan(block.indexOf("f3"));
    expect(block.indexOf("f2")).toBeLessThan(block.indexOf("m3"));
    expect(block).toContain("m3");
    expect(block).toContain("m2");
    expect(block).not.toContain("m1");
    expect(block).toContain("feat/login");
    expect(block.trimStart().startsWith("#")).toBe(true);
  });

  test("on main there is no second section, and nothing at all when there are no summaries", async () => {
    const w = world();
    expect(await summariesContext(w.state, w.repo, 3)).toBe("");
    await seed(w, w.repo, ["m1"], { legacy: true });
    const block = await summariesContext(w.state, w.repo, 3);
    expect(block.match(/m1/g)).toHaveLength(1);
    // Another repository's summaries never leak in.
    const other = world();
    await seed(other, other.repo, ["secret elsewhere"], { legacy: true });
    expect(await summariesContext(w.state, w.feature, 3)).toContain("m1");
    expect(await summariesContext(w.state, w.feature, 3)).not.toContain("secret elsewhere");
  });

  test("is capped near 2 KB however long the summaries are", async () => {
    const w = world();
    await seed(w, w.feature, Array.from({ length: 5 }, (_, index) => `entry ${index} ${"x".repeat(3000)}`), { legacy: true });
    const block = await summariesContext(w.state, w.feature, 5);
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(2200);
    expect(block).toContain("entry 4");
  });

  test("the context verb prints nothing for no summaries and the block otherwise", async () => {
    const w = world();
    const environment = { HOME: w.root, MEGABRAIN_STATE_DIR: w.state };
    const empty = await executeSummaries(["context", "--cwd", w.feature], environment);
    expect(empty).toEqual({ kind: "ok", value: "" });
    await seed(w, w.feature, ["f1"], { legacy: true });
    const printed = await executeSummaries(["context", "--cwd", w.feature], environment);
    expect(printed.kind === "ok" && printed.value).toContain("f1");
    const json = await executeSummaries(["context", "--cwd", w.feature, "--json"], environment);
    expect(json.kind === "ok" && JSON.parse(json.value).context).toContain("f1");
    expect((await executeSummaries(["context"], environment)).kind).toBe("failed");
  });
});

describe("new chats get the context", () => {
  async function chatWith(w: World, enabled: boolean, withSummaries: boolean): Promise<Chat> {
    writeFileSync(join(w.state, "chat-summaries.json"), JSON.stringify({ ...defaultSummarySettings, enabled }));
    if (withSummaries) await seed(w, w.feature, ["fixed the login redirect"], { legacy: true });
    return { id: randomUUID(), agent: "claude", model: null, cwd: w.feature, title: null, state: "starting", mode: "chat", agentSessionId: null, createdAt: at(), lastActivityAt: null, summary: null, titleSource: "first-message" };
  }

  test("claude gets --append-system-prompt with the block only when enabled and there is something to add", async () => {
    const on = world();
    const chatOn = await chatWith(on, true, true);
    const invocation = await chatProtocolAdapters.claude.prepare(chatOn, on.state);
    const flag = invocation.args.indexOf("--append-system-prompt");
    expect(flag).toBeGreaterThan(-1);
    expect(invocation.args[flag + 1]).toContain("fixed the login redirect");
    expect(Buffer.byteLength(invocation.args[flag + 1] ?? "")).toBeLessThanOrEqual(2200);

    const off = world();
    expect((await chatProtocolAdapters.claude.prepare(await chatWith(off, false, true), off.state)).args).not.toContain("--append-system-prompt");
    const empty = world();
    expect((await chatProtocolAdapters.claude.prepare(await chatWith(empty, true, false), empty.state)).args).not.toContain("--append-system-prompt");
  });

  test("codex gets developer_instructions through -c under the same rule", async () => {
    const on = world();
    const chatOn = { ...(await chatWith(on, true, true)), agent: "codex" as const };
    const args = (await chatProtocolAdapters.codex.prepare(chatOn, on.state)).args;
    expect(args[0]).toBe("app-server");
    const config = args.indexOf("-c");
    expect(config).toBeGreaterThan(-1);
    expect(args[config + 1]).toMatch(/^developer_instructions=".*fixed the login redirect/s);
    // The value is a TOML string: quotes and newlines are escaped, so it parses as one line.
    expect(args[config + 1]).not.toContain("\n");

    const off = world();
    expect((await chatProtocolAdapters.codex.prepare({ ...(await chatWith(off, false, true)), agent: "codex" }, off.state)).args).toEqual(["app-server"]);
  });
});

function fakeProcess(): ProcessAdapter {
  return {
    async run(command, args) { return command === "which" ? ok({ stdout: `/usr/bin/${args[0]}`, stderr: "", exitCode: 0 }) : failed(`${command} unavailable`); },
    async startDetached() { return failed("detached process unavailable"); },
    invocationCount: () => 0,
  };
}

function fixture() {
  const home = mkdtempSync(join("/tmp", "megabrain-summaries-context-"));
  const root = mkdtempSync(join("/tmp", "megabrain-summaries-context-root-"));
  directories.push(home, root);
  mkdirSync(join(root, ".build"), { recursive: true });
  const binary = join(root, ".build/megabrain");
  writeFileSync(binary, "compiled megabrain fixture\n");
  chmodSync(binary, 0o755);
  return { environment: { HOME: home, MEGABRAIN_STATE_DIR: join(home, "state"), MEGABRAIN_ROOT: root }, home, binary: realpathSync(binary) };
}

const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const sessionStartCommands = (file: Record<string, any>): string[] => ((file.hooks?.SessionStart ?? []) as Array<{ hooks: Array<{ command: string }> }>).flatMap((group) => group.hooks.map((hook) => hook.command));

describe("summaries-context install module", () => {
  test("adds a SessionStart hook to Claude and Codex in a temp HOME, keeps other hooks, and reverts exactly its own", async () => {
    const { environment, home, binary } = fixture();
    const claude = join(home, ".claude", "settings.json"), codex = join(home, ".codex", "hooks.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claude, JSON.stringify({ model: "x", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other-hook" }] }] } }));

    const installed = await executeInstall(["summaries-context", "--yes"], environment, fakeProcess());
    expect(installed.kind).toBe("ok");
    const mine = `'${binary}' hook session-start`;
    const claudeCommands = sessionStartCommands(readJson(claude));
    expect(claudeCommands[0]).toBe("other-hook");
    expect(claudeCommands.filter((command) => command.includes("hook session-start"))).toHaveLength(1);
    expect(claudeCommands.some((command) => command.includes(mine))).toBe(true);
    expect(readJson(claude).model).toBe("x");
    expect(sessionStartCommands(readJson(codex)).some((command) => command.includes(mine))).toBe(true);

    // Idempotent: installing again does not stack a second entry.
    await executeInstall(["summaries-context", "--yes"], environment, fakeProcess());
    expect(sessionStartCommands(readJson(claude)).filter((command) => command.includes("hook session-start"))).toHaveLength(1);

    const reverted = await executeInstall(["summaries-context", "--revert"], environment, fakeProcess());
    expect(reverted.kind).toBe("ok");
    expect(sessionStartCommands(readJson(claude))).toEqual(["other-hook"]);
    expect(existsSync(codex) ? sessionStartCommands(readJson(codex)).some((command) => command.includes("hook session-start")) : false).toBe(false);
  });

  test("is opt-in: a default install leaves SessionStart alone and doctor knows the module", async () => {
    const { environment, home } = fixture();
    await executeInstall(["--agents", "claude", "--yes"], environment, fakeProcess());
    const claude = join(home, ".claude", "settings.json");
    expect(existsSync(claude) ? sessionStartCommands(readJson(claude)).some((command) => command.includes("hook session-start")) : false).toBe(false);
    const doctor = await executeDoctor(["summaries-context", "--json"], environment, fakeProcess());
    expect(doctor.kind).toBe("ok");
  });
});

describe("the session-start hook command", () => {
  test("prints Claude's additionalContext JSON from the summaries of its cwd, and nothing when empty", async () => {
    const w = world();
    await seed(w, w.feature, ["fixed the login redirect"], { legacy: true });
    const environment = { HOME: w.root, MEGABRAIN_STATE_DIR: w.state };
    const run = async (stdin: string) => { const result = await executeHookSessionStart([], environment, async () => stdin); return result.kind === "ok" ? result.value : `failed: ${result.error}`; };
    const parsed = JSON.parse(await run(JSON.stringify({ cwd: w.feature, hook_event_name: "SessionStart" }))) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("fixed the login redirect");
    expect(await run(JSON.stringify({ cwd: w.root }))).toBe("");
    expect(await run("not json")).toBe("");
  });
});
