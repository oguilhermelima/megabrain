import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectScripts, projectScripts, setProjectScripts } from "../../src/core/project-scripts.js";
import { route } from "../../src/cli/router.js";
import { createProcessAdapter } from "../../src/adapters/proc.js";

let root = "";
let state = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-project-scripts-")));
  state = join(root, "state");
  env = { HOME: join(root, "home"), MEGABRAIN_STATE_DIR: state };
  mkdirSync(env.HOME as string);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("project scripts", () => {
  test("detects package manager and available scripts", () => {
    const directory = join(root, "pnpm");
    mkdirSync(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }));
    writeFileSync(join(directory, "pnpm-lock.yaml"), "");
    expect(detectProjectScripts(directory)).toEqual({
      run: { command: "pnpm run dev", source: "detected" },
      build: { command: "pnpm run build", source: "detected" },
      install: { command: "pnpm install", source: "detected" },
    });
  });

  test("uses npm fallback and start when dev is absent; leaves unavailable scripts null", () => {
    const directory = join(root, "npm");
    mkdirSync(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { start: "node .", test: "test" } }));
    expect(detectProjectScripts(directory)).toEqual({
      run: { command: "npm start", source: "detected" }, build: null,
      install: { command: "npm install", source: "detected" },
    });
  });

  test("selects Bun and Yarn lockfiles before the npm fallback", () => {
    for (const [name, lockfile, manager] of [["bun", "bun.lock", "bun"], ["yarn", "yarn.lock", "yarn"]] as const) {
      const directory = join(root, name);
      mkdirSync(directory);
      writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { dev: "dev" } }));
      writeFileSync(join(directory, lockfile), "");
      expect(detectProjectScripts(directory).run).toEqual({ command: `${manager} run dev`, source: "detected" });
    }
  });

  test("detects Cargo and Make targets", () => {
    const cargo = join(root, "cargo");
    const make = join(root, "make");
    mkdirSync(cargo); mkdirSync(make);
    writeFileSync(join(cargo, "Cargo.toml"), "[package]");
    writeFileSync(join(make, "Makefile"), "build:\nrun:\ninstall:\n");
    expect(detectProjectScripts(cargo)).toEqual({
      run: { command: "cargo run", source: "detected" }, build: { command: "cargo build", source: "detected" }, install: null,
    });
    expect(detectProjectScripts(make)).toEqual({
      run: { command: "make run", source: "detected" }, build: { command: "make build", source: "detected" }, install: { command: "make install", source: "detected" },
    });
  });

  test("saves scripts by canonical repository path, supports clearing, and uses a private file", async () => {
    const repository = join(root, "repository");
    mkdirSync(repository);
    const result = await setProjectScripts(repository, { run: "bun run dev", build: "" }, env);
    expect(result).toEqual({ run: { command: "bun run dev", source: "saved" }, build: null, install: null });
    expect(await projectScripts(repository, env)).toEqual(result);
    const store = join(state, "project-scripts.json");
    expect(statSync(store).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(store, "utf8"))).toHaveProperty(repository);
  });

  test("CLI prints and saves the documented JSON shape", async () => {
    const repository = join(root, "cli-repo");
    mkdirSync(repository);
    const gitInit = await createProcessAdapter().run("git", ["init", "-b", "main"], { cwd: repository });
    expect(gitInit.kind).toBe("ok");
    const worktree = join(root, "cli-tree");
    const gitCommit = await createProcessAdapter().run("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial"]);
    expect(gitCommit.kind).toBe("ok");
    const gitWorktree = await createProcessAdapter().run("git", ["-C", repository, "worktree", "add", "-b", "feature", worktree]);
    expect(gitWorktree.kind).toBe("ok");
    const saved = await route(["repo", "scripts", repository, "--run", "node server.js", "--json"], { environment: env, processAdapter: createProcessAdapter() });
    expect(saved.kind).toBe("ok");
    if (saved.kind === "ok") expect(JSON.parse(saved.value)).toEqual({ repo: repository, scripts: { run: { command: "node server.js", source: "saved" }, build: null, install: null }, port: null });
    const fromWorktree = await route(["repo", "scripts", worktree, "--json"], { environment: env, processAdapter: createProcessAdapter() });
    expect(fromWorktree.kind).toBe("ok");
    if (fromWorktree.kind === "ok") expect(JSON.parse(fromWorktree.value)).toEqual(JSON.parse(saved.kind === "ok" ? saved.value : "{}"));
  });
});
