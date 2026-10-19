import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { registerMegabrainRepository } from "../../src/core/project-registry.js";
import { BRIDGE_EXTENSION, CODE_CONFIG_VERSION, CODE_ENFORCED_SETTINGS, codeConfigVersion, codeServerPortCandidate, createCodeServerManager, selectCodeServerAsset, type CodeServerDependencies } from "../../src/core/code-server.js";
import { CODE_WORKBENCH_CSS } from "../../src/core/code-server-proxy.js";
import { PINNED_EXTENSIONS, codeEditorAssociations } from "../../src/core/code-extensions.js";
import { ok } from "../../src/core/result.js";

let root = "";
let state = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-code-server-")));
  state = join(root, "state");
  env = { HOME: join(root, "home"), MEGABRAIN_STATE_DIR: state };
  mkdirSync(env.HOME as string);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await createProcessAdapter().run("git", args, { cwd });
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value.stdout.trim();
}

async function repository(name: string): Promise<string> {
  const path = join(root, name);
  mkdirSync(path);
  await git(path, "init", "-b", "main");
  await git(path, "-c", "user.name=Operator", "-c", "user.email=operator@example.test", "commit", "--allow-empty", "-m", "initial");
  return path;
}

function fakes(overrides: Partial<CodeServerDependencies> = {}) {
  const started: Array<{ command: string; args: readonly string[]; options: { cwd?: string; env?: Readonly<Record<string, string>> } }> = [];
  const downloaded: string[] = [];
  const alive = new Set([4242, 4343]);
  let nextPid = 4242;
  const dependencies: CodeServerDependencies = {
    platform: "darwin",
    arch: "arm64",
    download: async (url, destination) => { downloaded.push(url); writeFileSync(destination, "fake archive"); },
    verifyChecksum: async () => true,
    extract: async (_archive, destination) => {
      const executable = join(destination, "code-server-4.138.0-macos-arm64", "bin", "code-server");
      mkdirSync(join(executable, ".."), { recursive: true });
      writeFileSync(executable, "fake executable");
      chmodSync(executable, 0o755);
    },
    start: async (command, args, options) => {
      started.push({ command, args, options });
      nextPid += 101;
      alive.add(nextPid - 101);
      return ok({ pid: nextPid - 101 });
    },
    isAlive: (pid) => alive.has(pid),
    kill: (pid) => { alive.delete(pid); },
    token: () => "random-test-token",
    ready: async () => {},
    ...overrides,
  };
  return { dependencies, started, downloaded, alive };
}

describe("code server", () => {
  test("selects the pinned standalone asset for macOS arm64 and Linux x64 and arm64", () => {
    expect(selectCodeServerAsset("darwin", "arm64")).toMatchObject({ name: "code-server-4.138.0-macos-arm64.tar.gz", sha256: "1ecf699868e64bb9094a7d3ffcac50bb903354a32137dfc4017cb9479ef6b456" });
    expect(selectCodeServerAsset("linux", "x64")).toMatchObject({ name: "code-server-4.138.0-linux-amd64.tar.gz", sha256: "5d63f26c5dabc2acd29610b9b27f413b016aa67019e2cfcdf54031625e18f535" });
    expect(selectCodeServerAsset("linux", "arm64")).toMatchObject({ name: "code-server-4.138.0-linux-arm64.tar.gz", sha256: "fbebf4b18e97a5a48b7b105be0161d411e54ccfb53a1ffb1673c16518024fa30" });
    expect(selectCodeServerAsset("win32", "x64")).toBeUndefined();
  });

  test("puts the activity bar on top of a right side bar and keeps the title bar it forces at its fixed height", () => {
    expect(CODE_ENFORCED_SETTINGS).toMatchObject({
      "window.commandCenter": false,
      "workbench.layoutControl.enabled": false,
      "window.menuBarVisibility": "hidden",
      "workbench.activityBar.location": "top",
      "workbench.sideBar.location": "right",
    });
  });

  test("opens spreadsheets, office documents and PDFs in the recommended extensions' viewers", () => {
    expect(CODE_ENFORCED_SETTINGS["workbench.editorAssociations"]).toEqual(codeEditorAssociations(PINNED_EXTENSIONS));
    expect(CODE_ENFORCED_SETTINGS["workbench.editorAssociations"]["*.csv"]).toBe("cweijan.officeViewer");
  });

  test("enforced layout keys win over layout the person set in the profile's user settings", async () => {
    const path = await repository("enforced-user");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const profile = join(state, "code-server", "data", createHash("sha256").update(path).digest("hex").slice(0, 20));
    mkdirSync(join(profile, "User"), { recursive: true });
    writeFileSync(join(profile, "User", "settings.json"), `${JSON.stringify({
      "workbench.sideBar.location": "left",
      "workbench.activityBar.location": "default",
      "editor.fontSize": 15,
    })}\n`);
    await createCodeServerManager(env, createProcessAdapter(), fakes().dependencies).open(path);
    expect(JSON.parse(readFileSync(join(profile, "User", "settings.json"), "utf8"))).toMatchObject({
      "workbench.sideBar.location": "right",
      "workbench.activityBar.location": "top",
      "editor.fontSize": 15,
    });
  });

  test("restarts a live server started with an older configuration and rewrites its settings", async () => {
    const path = await repository("stale-config");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const id = createHash("sha256").update(path).digest("hex").slice(0, 20);
    const fake = fakes();
    const manager = createCodeServerManager(env, createProcessAdapter(), fake.dependencies);
    const first = await manager.open(path);
    const recordPath = join(state, "code-server", "servers", `${id}.json`);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    expect(typeof record.configVersion).toBe("string");
    // A server from an earlier build: no version in its record, and the old layout in its profile.
    delete record.configVersion;
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
    const settingsPath = join(state, "code-server", "data", id, "User", "settings.json");
    writeFileSync(settingsPath, `${JSON.stringify({ "workbench.activityBar.location": "default", "workbench.sideBar.location": "left" })}\n`);
    const second = await manager.open(path);
    expect(fake.alive.has(first.pid)).toBe(false);
    expect(fake.alive.has(first.codeServerPid)).toBe(false);
    expect(fake.started).toHaveLength(4);
    expect(second.codeServerPid).not.toBe(first.codeServerPid);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ "workbench.activityBar.location": "top", "workbench.sideBar.location": "right" });
    expect(JSON.parse(readFileSync(recordPath, "utf8"))).toMatchObject({ configVersion: CODE_CONFIG_VERSION });
  });

  test("restarts a live server whose recorded configuration version differs", async () => {
    const path = await repository("other-config");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const id = createHash("sha256").update(path).digest("hex").slice(0, 20);
    const fake = fakes();
    const manager = createCodeServerManager(env, createProcessAdapter(), fake.dependencies);
    await manager.open(path);
    const recordPath = join(state, "code-server", "servers", `${id}.json`);
    writeFileSync(recordPath, `${JSON.stringify({ ...JSON.parse(readFileSync(recordPath, "utf8")), configVersion: "older" })}\n`);
    await manager.open(path);
    expect(fake.started).toHaveLength(4);
    await manager.open(path);
    expect(fake.started).toHaveLength(4);
  });

  test("the configuration version covers the enforced settings, the bridge and the workbench CSS", () => {
    expect(CODE_CONFIG_VERSION).toBe(codeConfigVersion(CODE_ENFORCED_SETTINGS, BRIDGE_EXTENSION, CODE_WORKBENCH_CSS));
    expect(codeConfigVersion({ ...CODE_ENFORCED_SETTINGS, "workbench.sideBar.location": "left" }, BRIDGE_EXTENSION, CODE_WORKBENCH_CSS)).not.toBe(CODE_CONFIG_VERSION);
    expect(codeConfigVersion(CODE_ENFORCED_SETTINGS, `${BRIDGE_EXTENSION}\n`, CODE_WORKBENCH_CSS)).not.toBe(CODE_CONFIG_VERSION);
    expect(codeConfigVersion(CODE_ENFORCED_SETTINGS, BRIDGE_EXTENSION, `${CODE_WORKBENCH_CSS}\n`)).not.toBe(CODE_CONFIG_VERSION);
  });

  test("refuses an unregistered repository without downloading or spawning", async () => {
    const path = await repository("unregistered");
    const fake = fakes();
    const manager = createCodeServerManager(env, createProcessAdapter(), fake.dependencies);
    await expect(manager.open(path)).rejects.toThrow("not a registered project or worktree");
    expect(fake.downloaded).toHaveLength(0);
    expect(fake.started).toHaveLength(0);
  });

  test("treats a missing state database as an empty repository registry", async () => {
    const path = await repository("unregistered-without-state");
    const fake = fakes();
    const manager = createCodeServerManager(env, createProcessAdapter(), fake.dependencies);
    await expect(manager.open(path)).rejects.toThrow("not a registered project or worktree");
    expect(fake.downloaded).toHaveLength(0);
    expect(fake.started).toHaveLength(0);
  });

  test("refuses a downloaded release archive whose published SHA256 does not match", async () => {
    const path = await repository("checksum");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const fake = fakes({ verifyChecksum: async () => false });
    const manager = createCodeServerManager(env, createProcessAdapter(), fake.dependencies);
    await expect(manager.open(path)).rejects.toThrow("checksum mismatch");
    expect(fake.started).toHaveLength(0);
  });

  test("opens a registered project with the token in its URL and isolated data paths", async () => {
    const path = await repository("registered");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const fake = fakes();
    const manager = createCodeServerManager(env, createProcessAdapter(), fake.dependencies);
    const server = await manager.open(path);
    expect(server.url).toContain("127.0.0.1");
    expect(server.url).toContain("random-test-token");
    expect(server.pid).toBe(4343);
    expect(server.codeServerPid).toBe(4242);
    const serverArgs = fake.started.find((item) => item.args.includes("--socket"))?.args ?? [];
    expect(serverArgs).toContain(path);
    expect(serverArgs).toContain("--socket");
    expect(serverArgs).toContain("--auth");
    expect(serverArgs).toContain("none");
    expect(serverArgs.join(" ")).toContain(join(state, "code-server", "data"));
    expect(serverArgs).toContain("--config");
    const configPath = serverArgs[serverArgs.indexOf("--config") + 1];
    expect(configPath?.startsWith(join(state, "code-server", "data"))).toBe(true);
    expect(configPath === undefined ? "missing config path" : readFileSync(configPath, "utf8")).toBe("");
    expect(configPath === undefined ? 0 : statSync(configPath).mode & 0o777).toBe(0o600);
    const serverStart = fake.started.find((item) => item.args.includes("--socket"));
    const configHome = serverStart?.options.env?.XDG_CONFIG_HOME;
    expect(configHome?.startsWith(join(state, "code-server", "data"))).toBe(true);
    expect(fake.started).toHaveLength(2);
    const profile = join(state, "code-server", "data", createHash("sha256").update(path).digest("hex").slice(0, 20));
    const settingsPath = join(profile, "User", "settings.json");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
      "security.workspace.trust.enabled": false,
      "workbench.activityBar.location": "top",
      "workbench.statusBar.visible": false,
      "workbench.colorTheme": "megabrain-dark",
      "workbench.preferredDarkColorTheme": "megabrain-dark",
      "window.autoDetectColorScheme": false,
      "workbench.sideBar.location": "right",
      "editor.minimap.enabled": false,
    });
    expect(readFileSync(join(profile, "extensions", "megabrain.megabrain-bridge-1.0.0", "package.json"), "utf8")).toContain("megabrain-bridge");
    const bridge = readFileSync(join(profile, "extensions", "megabrain.megabrain-bridge-1.0.0", "extension.js"), "utf8");
    expect(bridge).toContain("outline.removeView");
    expect(bridge).toContain("timeline.removeView");
    writeFileSync(join(profile, "extensions", "extensions.json"), "[]\n");
    writeFileSync(settingsPath, `${JSON.stringify({
      "workbench.colorTheme": "Default Light Modern",
      "workbench.activityBar.location": "hidden",
      "security.workspace.trust.enabled": true,
    })}\n`);
    await manager.stop(path);
    await manager.open(path);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
      "workbench.colorTheme": "Default Light Modern",
      "workbench.activityBar.location": "top",
      "security.workspace.trust.enabled": false,
    });
    expect(JSON.parse(readFileSync(join(profile, "extensions", "extensions.json"), "utf8"))).toContainEqual(expect.objectContaining({
      identifier: { id: "megabrain.megabrain-bridge" },
      version: "1.0.0",
      relativeLocation: "megabrain.megabrain-bridge-1.0.0",
    }));
    expect(existsSync(join(profile, "extensions", "megabrain-bridge"))).toBe(false);
  });

  test("writes a private goto request for the bridge extension to consume", async () => {
    const path = await repository("goto-open");
    const file = join(path, "src.ts");
    writeFileSync(file, "export const answer = 42;\n");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const fake = fakes();
    const server = await createCodeServerManager(env, createProcessAdapter(), fake.dependencies).goto(path, file, 12);
    const profile = join(state, "code-server", "data", createHash("sha256").update(path).digest("hex").slice(0, 20));
    const requests = join(profile, "User", "globalStorage", "megabrain.megabrain-bridge", "requests");
    const [requestName] = readdirSync(requests);
    expect(requestName).toMatch(/^[a-f0-9]{32}\.json$/);
    expect(JSON.parse(readFileSync(join(requests, requestName), "utf8"))).toMatchObject({ path: file, line: 12, nonce: requestName.slice(0, -5) });
    expect(statSync(join(requests, requestName)).mode & 0o777).toBe(0o600);
    expect(server.root).toBe(path);
  });

  test("rejects a goto target outside the project", async () => {
    const path = await repository("goto-outside");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const fake = fakes();
    const manager = createCodeServerManager(env, createProcessAdapter(), fake.dependencies);
    await expect(manager.goto(path, join(root, "elsewhere.ts"))).rejects.toThrow("outside project");
    expect(fake.started).toHaveLength(0);
    expect(existsSync(join(state, "code-server", "data", createHash("sha256").update(path).digest("hex").slice(0, 20), "User", "globalStorage", "megabrain.megabrain-bridge", "requests"))).toBe(false);
  });

  test("reuses a live server for the same registered root", async () => {
    const path = await repository("reuse");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const fake = fakes();
    const manager = createCodeServerManager(env, createProcessAdapter(), fake.dependencies);
    const first = await manager.open(path);
    const second = await manager.open(path);
    expect(second).toEqual(first);
    expect(fake.started).toHaveLength(2);
    expect(fake.downloaded).toHaveLength(1);
  });

  test("keeps the assigned port when a project is stopped and reopened", async () => {
    const path = await repository("stable-port");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const fake = fakes();
    const manager = createCodeServerManager(env, createProcessAdapter(), fake.dependencies);
    const first = await manager.open(path);
    await manager.stop(path);
    const second = await manager.open(path);
    expect(second.port).toBe(first.port);
  });

  test("uses the next port when the root's stable candidate is occupied", async () => {
    const path = await repository("occupied-port");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const candidate = codeServerPortCandidate(path);
    const fake = fakes({ portAvailable: async (port) => port !== candidate });
    const server = await createCodeServerManager(env, createProcessAdapter(), fake.dependencies).open(path);
    expect(server.port).toBe(candidate + 1);
  });

  test("hides Outline and Timeline once per profile when the bridge activates", async () => {
    const called: string[] = [];
    const values = new Map<string, unknown>();
    const bridgeModule: { activate?: (context: unknown) => Promise<void> } = {};
    const fs = {
      promises: {
        mkdir: async () => {},
        readdir: async () => [],
      },
      watch: () => ({ close: () => {} }),
    };
    const vscode = {
      commands: { executeCommand: async (id: string) => { called.push(id); } },
    };
    runInNewContext(BRIDGE_EXTENSION, {
      exports: bridgeModule,
      require: (name: string) => name === "node:fs" ? fs : name === "node:path" ? { join } : vscode,
      console,
    });
    const context = {
      globalStorageUri: { fsPath: join(root, "bridge-storage") },
      globalState: {
        get: (key: string) => values.get(key),
        update: async (key: string, value: unknown) => { values.set(key, value); },
      },
      subscriptions: [] as Array<{ dispose(): void }>,
    };
    if (bridgeModule.activate === undefined) throw new Error("bridge activation was not registered");
    await bridgeModule.activate(context);
    await bridgeModule.activate(context);
    expect(called).toEqual(["outline.removeView", "timeline.removeView"]);
  });

  test("cleans a stale record and starts a fresh server", async () => {
    const path = await repository("stale");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const initial = fakes();
    await createCodeServerManager(env, createProcessAdapter(), initial.dependencies).open(path);
    const fake = fakes({ isAlive: () => false });
    const manager = createCodeServerManager(env, createProcessAdapter(), fake.dependencies);
    const server = await manager.open(path);
    expect(server.pid).toBe(4343);
    expect(server.codeServerPid).toBe(4242);
    expect(fake.started).toHaveLength(2);
  });

  test("starts the recommended extensions' sync for a profile that lacks one, without waiting for it", async () => {
    const path = await repository("extensions-missing");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const synced: Array<{ executable: string; extensions: string }> = [];
    const fake = fakes({ syncExtensions: async (executable, extensions) => { synced.push({ executable, extensions }); } });
    const server = await createCodeServerManager(env, createProcessAdapter(), fake.dependencies).open(path);
    expect(server.codeServerPid).toBe(4242);
    const profile = join(state, "code-server", "data", createHash("sha256").update(path).digest("hex").slice(0, 20));
    expect(synced).toEqual([{ executable: join(state, "code-server", "4.138.0", "code-server-4.138.0-macos-arm64", "bin", "code-server"), extensions: join(profile, "extensions") }]);
  });

  test("starts no sync when every recommended extension is installed at its pinned version", async () => {
    const path = await repository("extensions-installed");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const profile = join(state, "code-server", "data", createHash("sha256").update(path).digest("hex").slice(0, 20));
    mkdirSync(join(profile, "extensions"), { recursive: true });
    writeFileSync(join(profile, "extensions", "extensions.json"), JSON.stringify(PINNED_EXTENSIONS.map((extension) => ({ identifier: { id: extension.id }, version: extension.version }))));
    const synced: string[] = [];
    const fake = fakes({ syncExtensions: async (_executable, extensions) => { synced.push(extensions); } });
    await createCodeServerManager(env, createProcessAdapter(), fake.dependencies).open(path);
    expect(synced).toEqual([]);
  });

  test("a sync that cannot start never keeps Code from opening", async () => {
    const path = await repository("extensions-failing");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const fake = fakes({ syncExtensions: async () => { throw new Error("spawn failed"); } });
    const server = await createCodeServerManager(env, createProcessAdapter(), fake.dependencies).open(path);
    expect(server.url).toContain("random-test-token");
  });

  test("stop kills the server recorded for the registered root", async () => {
    const path = await repository("stop");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const fake = fakes();
    const manager = createCodeServerManager(env, createProcessAdapter(), fake.dependencies);
    await manager.open(path);
    await manager.stop(path);
    expect(fake.alive.has(4242)).toBe(false);
    expect(fake.alive.has(4343)).toBe(false);
  });

  test("accepts a registered git worktree root", async () => {
    const path = await repository("worktree-main");
    await registerMegabrainRepository(path, env, createProcessAdapter());
    const tree = join(root, "worktree-child");
    await git(path, "worktree", "add", "-b", "feature", tree);
    const manager = createCodeServerManager(env, createProcessAdapter(), fakes().dependencies);
    await expect(manager.open(tree)).resolves.toMatchObject({ root: tree });
  });
});
