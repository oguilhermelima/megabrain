import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { ChatStore, type Chat } from "../../src/chat/store.js";

const directories: string[] = [];
const followers: number[] = [];
afterEach(() => {
  for (const pid of followers.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hasReadyEvent = (outputFile: string): boolean =>
  readFileSync(outputFile, "utf8").split("\n").some((line) => {
    try {
      const parsed = JSON.parse(line) as { event?: { text?: string } };
      return parsed.event?.text === "ready";
    } catch {
      return false;
    }
  });

test("a followed chat stream ends by itself when the process that started it goes away", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-follow-"));
  directories.push(root);
  const state = join(root, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const store = new ChatStore(state);
  await store.initialize();
  const chat: Chat = {
    id: "0a1b2c3d-0000-4000-8000-00000000f011",
    agent: "claude",
    model: null,
    cwd: root,
    title: null,
    state: "suspended",
    mode: "chat",
    agentSessionId: null,
    createdAt: new Date().toISOString(),
    lastActivityAt: null,
  };
  const daemon = new ChatDaemon(state, {
    HOME: root,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  });
  await daemon.start();
  await daemon.listen();
  await store.put(chat);
  await store.append(chat.id, { id: "initial", at: new Date().toISOString(), kind: "system", text: "ready" });
  try {
    const pidFile = join(root, "follower.pid");
    const outputFile = join(root, "follower.jsonl");
    const releaseFile = join(root, "release-parent");
    const script = join(root, "parent.sh");
    // The parent stays alive until the follower receives historical output and proves its stream is open.
    writeFileSync(
      script,
      `#!/bin/sh\n"${process.execPath}" "${join(process.cwd(), "src/cli/index.ts")}" chat events 0a1b2c3d-0000-4000-8000-00000000f011 --follow --json > "${outputFile}" 2>&1 &\necho $! > "${pidFile}"\nwhile [ ! -f "${releaseFile}" ]; do sleep 0.02; done\n`,
      { mode: 0o700 },
    );
    const environment = {
      PATH: process.env.PATH ?? "",
      HOME: root,
      MEGABRAIN_STATE_DIR: state,
    };
    const parent = Bun.spawn(["sh", script], {
      env: environment,
      stdout: "ignore",
      stderr: "ignore",
    });
    const startDeadline = Date.now() + 10_000;
    while ((!existsSync(pidFile) || !existsSync(outputFile) || !hasReadyEvent(outputFile)) && Date.now() < startDeadline) await sleep(20);
    expect(existsSync(pidFile)).toBe(true);
    expect(hasReadyEvent(outputFile)).toBe(true);
    const follower = Number(readFileSync(pidFile, "utf8").trim());
    followers.push(follower);
    // Control: the follower has connected and received history while its parent is still alive.
    expect(alive(follower)).toBe(true);
    writeFileSync(releaseFile, "exit");
    await parent.exited;
    const exitDeadline = Date.now() + 10_000;
    while (alive(follower) && Date.now() < exitDeadline) await sleep(50);
    expect(alive(follower)).toBe(false);
  } finally {
    await daemon.close();
  }
}, 25000);
