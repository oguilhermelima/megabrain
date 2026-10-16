import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";

let root = "";
let home = "";
let state = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-project-appearance-")));
  home = join(root, "home");
  state = join(root, "state");
  mkdirSync(home);
  mkdirSync(state);
  env = { HOME: home, MEGABRAIN_STATE_DIR: state };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function cli(...args: string[]) {
  return route(args, { environment: env, processAdapter: createProcessAdapter() });
}

function parse<T>(result: { kind: string; value?: string; error?: string }): T {
  if (result.kind !== "ok" || result.value === undefined) throw new Error(result.error ?? "expected command output");
  return JSON.parse(result.value) as T;
}

type Appearance = { projects: Record<string, { name?: string; color?: string; picture?: string }> };
const read = async () => parse<Appearance>(await cli("settings", "get", "project-appearance", "--json"));
const picture = (name: string, bytes: Buffer | string = "fake image bytes") => {
  const file = join(root, name);
  writeFileSync(file, bytes);
  return file;
};
const project = "/repo/alpha";

describe("settings project-appearance", () => {
  test("reads an empty map before anything was saved", async () => {
    expect(await read()).toEqual({ projects: {} });
  });

  test("stores name and color as private state-dir JSON and reads them back", async () => {
    expect((await cli("settings", "set", "project-appearance", project, "--name", "Alpha", "--color", "#AA00ff", "--json")).kind).toBe("ok");
    expect(await read()).toEqual({ projects: { [project]: { name: "Alpha", color: "#aa00ff" } } });
    const file = join(state, "project-settings.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(state).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("patches only the named fields and clears with --no-flags", async () => {
    await cli("settings", "set", "project-appearance", project, "--name", "Alpha", "--color", "#112233", "--json");
    await cli("settings", "set", "project-appearance", project, "--color", "#445566", "--json");
    expect(await read()).toEqual({ projects: { [project]: { name: "Alpha", color: "#445566" } } });
    await cli("settings", "set", "project-appearance", project, "--no-name", "--json");
    expect(await read()).toEqual({ projects: { [project]: { color: "#445566" } } });
    await cli("settings", "set", "project-appearance", project, "--no-color", "--json");
    expect(await read()).toEqual({ projects: {} });
  });

  test("copies a picture into project-pictures and stores that path", async () => {
    const source = picture("logo.png");
    const set = parse<Appearance>(await cli("settings", "set", "project-appearance", project, "--picture", source, "--json"));
    const stored = set.projects[project]?.picture ?? "";
    expect(stored.startsWith(join(state, "project-pictures") + "/")).toBe(true);
    expect(stored.endsWith(".png")).toBe(true);
    expect(readFileSync(stored, "utf8")).toBe("fake image bytes");
    expect((await read()).projects[project]?.picture).toBe(stored);
    expect(existsSync(source)).toBe(true);
  });

  test("removes the stored copy on --no-picture and when replaced, keeping a shared copy", async () => {
    const first = picture("a.png", "same");
    const second = picture("b.png", "same");
    const a = (parse<Appearance>(await cli("settings", "set", "project-appearance", "/repo/a", "--picture", first, "--json"))).projects["/repo/a"]?.picture ?? "";
    const b = (parse<Appearance>(await cli("settings", "set", "project-appearance", "/repo/b", "--picture", second, "--json"))).projects["/repo/b"]?.picture ?? "";
    expect(a).toBe(b);
    await cli("settings", "set", "project-appearance", "/repo/a", "--no-picture", "--json");
    expect(existsSync(a)).toBe(true);
    await cli("settings", "set", "project-appearance", "/repo/b", "--picture", picture("c.svg", "<svg/>"), "--json");
    expect(existsSync(a)).toBe(false);
  });

  test("refuses bad input with one-line errors and keeps what was saved", async () => {
    await cli("settings", "set", "project-appearance", project, "--name", "Alpha", "--json");
    const big = picture("big.png", Buffer.alloc(2 * 1024 * 1024 + 1));
    const refused = [
      ["relative/path", "--name", "x"],
      [project, "--color", "red"],
      [project, "--color", "#12345"],
      [project, "--name", "   "],
      [project, "--name", "x".repeat(201)],
      [project, "--name", "A", "--no-name"],
      [project, "--picture", join(root, "missing.png")],
      [project, "--picture", picture("note.txt")],
      [project, "--picture", big],
      [project, "--wat"],
      [project],
    ];
    for (const args of refused) {
      const result = await cli("settings", "set", "project-appearance", ...args, "--json");
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.error.split(/\r?\n/)).toHaveLength(1);
    }
    expect(await read()).toEqual({ projects: { [project]: { name: "Alpha" } } });
    expect(existsSync(join(state, "project-pictures"))).toBe(false);
  });

  test("reads an empty map when the saved file is damaged", async () => {
    writeFileSync(join(state, "project-settings.json"), "{broken");
    expect(await read()).toEqual({ projects: {} });
  });
});

describe("projects appearance", () => {
  test("adds appearance to each project, empty when none is set", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => createProcessAdapter().run("git", args, { cwd: repo });
    await git("init", "-b", "main");
    await git("-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "--allow-empty", "-m", "initial");
    expect((await cli("repo", "add", repo)).kind).toBe("ok");
    const before = parse<Array<{ path: string; appearance: unknown }>>(await cli("projects", "--json"));
    expect(before.map((entry) => entry.appearance)).toEqual([{}]);
    const path = before[0]?.path ?? "";
    await cli("settings", "set", "project-appearance", path, "--name", "Renamed", "--color", "#010203", "--json");
    const after = parse<Array<{ path: string; name: string; appearance: unknown }>>(await cli("projects", "--json"));
    expect(after[0]?.appearance).toEqual({ name: "Renamed", color: "#010203" });
    expect(after[0]?.name).not.toBe("Renamed");
  });
});
