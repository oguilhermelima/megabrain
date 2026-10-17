import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
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
  try {
    const pidFile = join(root, "follower.pid");
    const script = join(root, "parent.sh");
    // The parent starts the follow in the background, records its pid, stays 1.5 s, then exits without stopping it.
    writeFileSync(
      script,
      `#!/bin/sh\n"${process.execPath}" "${join(process.cwd(), "src/cli/index.ts")}" chat events 0a1b2c3d-0000-4000-8000-00000000f011 --follow --json >/dev/null 2>&1 &\necho $! > "${pidFile}"\nsleep 1.5\n`,
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
    await sleep(1000);
    const follower = Number(readFileSync(pidFile, "utf8").trim());
    followers.push(follower);
    // Control: while the parent lives the follower runs, so a dead follower later is not an early failure.
    expect(alive(follower)).toBe(true);
    await parent.exited;
    const deadline = Date.now() + 6000;
    while (alive(follower) && Date.now() < deadline) await sleep(100);
    expect(alive(follower)).toBe(false);
  } finally {
    await daemon.close();
  }
}, 20000);
