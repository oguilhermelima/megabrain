import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { ChatStore, type Chat } from "../../src/chat/store.js";

const directories: string[] = [];
const daemons: ChatDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const ID = "7c2a1d40-5b3e-4f6a-8d9c-1e2f3a4b5c6d";
// The smallest valid PNG: a 1x1 transparent pixel.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "megabrain-images-"));
  directories.push(root);
  const state = join(root, "state");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(cwd);
  mkdirSync(bin);
  for (const name of ["claude", "codex"]) {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\nprocess.stdin.resume();\n`);
    chmodSync(path, 0o700);
  }
  const image = join(cwd, "shot.png");
  writeFileSync(image, PNG);
  return { root, state, cwd, bin, image };
}
type Env = ReturnType<typeof sandbox>;

async function daemonFor(env: Env, chat?: Partial<Chat>): Promise<ChatDaemon> {
  const environment = { HOME: env.root, PATH: `${env.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
  if (chat !== undefined) {
    await new ChatStore(env.state).put({
      id: ID, agent: "claude", model: null, cwd: env.cwd, title: "t", state: "suspended", mode: "chat",
      agentSessionId: "sess-1", createdAt: "2026-10-16T09:00:00.000Z", lastActivityAt: null, ...chat,
    });
  }
  const daemon = new ChatDaemon(env.state, environment);
  await daemon.start();
  await daemon.listen();
  daemons.push(daemon);
  return daemon;
}

const userEvents = async (daemon: ChatDaemon, id: string) =>
  (await daemon.store.events(id)).flatMap((line) => line.event?.kind === "user" ? [line.event] : []);

describe("images in sent messages", () => {
  test("a send records the image paths on the user event, never the bytes", async () => {
    const env = sandbox();
    const daemon = await daemonFor(env, {});
    await daemon.handle({ operation: "send", id: ID, parts: [{ type: "text", text: "what is this?" }, { type: "image", path: "shot.png" }] });
    const [sent] = await userEvents(daemon, ID);
    expect(sent?.text).toBe("what is this?");
    expect(sent?.images).toEqual([{ path: env.image }]);
    const file = readFileSync(join(env.state, "chats", ID, "events.jsonl"), "utf8");
    expect(file).not.toContain(PNG.toString("base64"));
  });

  test("a send of text alone carries no images field", async () => {
    const env = sandbox();
    const daemon = await daemonFor(env, {});
    await daemon.handle({ operation: "send", id: ID, parts: [{ type: "text", text: "hello" }] });
    const [sent] = await userEvents(daemon, ID);
    expect(sent !== undefined && "images" in sent).toBe(false);
    expect(sent !== undefined && "parts" in sent).toBe(false);
  });

  test("a send records its parts in order, each image once and in its place", async () => {
    const env = sandbox();
    const daemon = await daemonFor(env, {});
    await daemon.handle({ operation: "send", id: ID, parts: [{ type: "image", path: "shot.png" }, { type: "text", text: "before and after" }, { type: "image", path: env.image }] });
    const [sent] = await userEvents(daemon, ID);
    expect(sent?.text).toBe("before and after");
    expect(sent?.images).toEqual([{ path: env.image }, { path: env.image }]);
    expect(sent?.parts).toEqual([{ type: "image", path: env.image }, { type: "text", text: "before and after" }, { type: "image", path: env.image }]);
  });

  test("one image sent is one image on the stored event, also when read back", async () => {
    const env = sandbox();
    const daemon = await daemonFor(env, {});
    await daemon.handle({ operation: "send", id: ID, parts: [{ type: "image", path: "shot.png" }, { type: "text", text: "once" }] });
    const lines = readFileSync(join(env.state, "chats", ID, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event?: { kind: string; images?: unknown[]; parts?: { type: string }[] } });
    const users = lines.flatMap((line) => line.event?.kind === "user" ? [line.event] : []);
    expect(users).toHaveLength(1);
    expect(users[0]?.images).toHaveLength(1);
    expect(users[0]?.parts?.filter((part) => part.type === "image")).toHaveLength(1);
  });

  test("a chat started with an image records it on its first user event", async () => {
    const env = sandbox();
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd, parts: [{ type: "image", path: env.image }, { type: "text", text: "look" }] }) as Chat;
    const [sent] = await userEvents(daemon, chat.id);
    expect(sent?.images).toEqual([{ path: env.image }]);
    expect(sent?.parts).toEqual([{ type: "image", path: env.image }, { type: "text", text: "look" }]);
  });
});
