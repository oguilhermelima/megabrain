import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type ProcessAdapter } from "../adapters/proc.js";
import { resolveStateDirectory, type StateEnvironment } from "./state.js";
import { openDatabase } from "../db/db.js";
import { listRepositories } from "../db/queries/repositories.js";
import { failed, type Result } from "./result.js";

export const CODE_SERVER_VERSION = "4.138.0";
const RELEASE_BASE = `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}`;
const CODE_SERVER_PORT_FIRST = 41000;
const CODE_SERVER_PORT_COUNT = 8000;

export type CodeServerAsset = Readonly<{ name: string; url: string; sha256: string }>;
export type CodeServerInfo = Readonly<{ root: string; url: string; port: number; pid: number; codeServerPid: number }>;

export const CODE_ENFORCED_SETTINGS = {
  "security.workspace.trust.enabled": false,
  "workbench.activityBar.location": "top",
  "workbench.statusBar.visible": false,
  "window.menuBarVisibility": "hidden",
  "window.customTitleBarVisibility": "never",
  "window.commandCenter": false,
  "workbench.layoutControl.enabled": false,
  "workbench.sideBar.location": "right",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "chat.disableAIFeatures": true,
  "workbench.editor.empty.hint": "hidden",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "window.autoDetectColorScheme": false,
  "explorer.openEditors.visible": 0,
} as const;

export const CODE_DEFAULT_SETTINGS = {
  "workbench.colorTheme": "megabrain-dark",
  "workbench.preferredDarkColorTheme": "megabrain-dark",
  "editor.fontFamily": "'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, monospace",
  "editor.minimap.enabled": false,
} as const;

export function codeServerProxyInvocation(execPath: string, argv: readonly string[], socketPath: string, port: number): { command: string; args: string[] } {
  const script = argv[1];
  const entryArguments = script !== undefined && !script.startsWith("/$bunfs/") ? [script] : [];
  return { command: execPath, args: [...entryArguments, "__code-server-proxy", socketPath, String(port)] };
}

type Platform = "darwin" | "linux" | "win32" | string;

type ServerRecord = Readonly<{
  root: string;
  url: string;
  port: number;
  token: string;
  codeServerPid: number;
  proxyPid: number;
  socketPath: string;
}>;

export type CodeServerDependencies = Readonly<{
  platform: string;
  arch: string;
  download(url: string, destination: string, progress: (downloaded: number, total: number | undefined) => void): Promise<void>;
  verifyChecksum(archive: string, expected: string): Promise<boolean>;
  extract(archive: string, destination: string): Promise<void>;
  start(command: string, args: readonly string[], options: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<Result<{ pid: number }>>;
  isAlive(pid: number): boolean;
  kill(pid: number): void;
  token(): string;
  portAvailable?(port: number): Promise<boolean>;
  ready?(port: number, codePid: number, proxyPid: number): Promise<void>;
}>;

export function selectCodeServerAsset(platform: Platform, arch: string): CodeServerAsset | undefined {
  const assets: Readonly<Record<string, string>> = {
    "darwin-arm64": "1ecf699868e64bb9094a7d3ffcac50bb903354a32137dfc4017cb9479ef6b456",
    "darwin-x64": "bd1a54d03e03d3b0ec75705f48c39c5f6b309a36a2c7ee878f746a6e5f9aa2ae",
    "linux-x64": "5d63f26c5dabc2acd29610b9b27f413b016aa67019e2cfcdf54031625e18f535",
    "linux-arm64": "fbebf4b18e97a5a48b7b105be0161d411e54ccfb53a1ffb1673c16518024fa30",
  };
  const target = platform === "darwin" && arch === "arm64" ? "macos-arm64"
    : platform === "darwin" && arch === "x64" ? "macos-amd64"
      : platform === "linux" && arch === "x64" ? "linux-amd64"
        : platform === "linux" && arch === "arm64" ? "linux-arm64"
          : undefined;
  const sha256 = assets[`${platform}-${arch}`];
  if (target === undefined || sha256 === undefined) return undefined;
  const name = `code-server-${CODE_SERVER_VERSION}-${target}.tar.gz`;
  return { name, url: `${RELEASE_BASE}/${name}`, sha256 };
}

function rootId(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 20);
}

export function codeServerPortCandidate(root: string): number {
  const hash = createHash("sha256").update(root).digest("hex");
  return CODE_SERVER_PORT_FIRST + (Number.parseInt(hash.slice(0, 8), 16) % CODE_SERVER_PORT_COUNT);
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPERM";
  }
}

async function downloadAsset(url: string, destination: string, progress: (downloaded: number, total: number | undefined) => void): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) throw new Error(`code-server download failed: HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  const file = await open(destination, "wx", 0o600);
  let downloaded = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      await file.write(bytes);
      downloaded += bytes.byteLength;
      progress(downloaded, total);
    }
    await file.sync();
  } catch (cause: unknown) {
    await file.close();
    await rm(destination, { force: true });
    throw cause;
  }
  await file.close();
  await chmod(destination, 0o600);
  process.stderr.write("\n");
}

async function verifyChecksum(archive: string, expected: string): Promise<boolean> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  return hash.digest("hex") === expected;
}

function defaultDependencies(processAdapter: ProcessAdapter): CodeServerDependencies {
  return {
    platform: process.platform,
    arch: process.arch,
    download: downloadAsset,
    verifyChecksum,
    async extract(archive, destination) {
      const result = await processAdapter.run("tar", ["-xzf", archive, "-C", destination]);
      if (result.kind !== "ok") throw new Error(result.error);
    },
    start: (command, args, options) => processAdapter.startDetached(command, args, options),
    isAlive: alive,
    kill(pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* the process already exited */ }
    },
    token: () => randomBytes(32).toString("hex"),
  };
}

async function canonical(path: string): Promise<string | undefined> {
  try { return await realpath(path); } catch { return undefined; }
}

async function validateRegisteredRoot(root: string, environment: StateEnvironment, processAdapter: ProcessAdapter): Promise<string> {
  const requested = await canonical(root);
  if (requested === undefined) throw new Error(`not a registered project or worktree: ${root}`);
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") throw new Error(opened.error);
  let roots: string[];
  try {
    roots = listRepositories(opened.value.db).map((repository) => repository.path);
  } finally {
    opened.value.close();
  }
  for (const registered of roots) {
    const registeredRoot = await canonical(registered);
    if (registeredRoot === undefined) continue;
    if (requested === registeredRoot) return requested;
    const worktrees = await processAdapter.run("git", ["-C", registeredRoot, "worktree", "list", "--porcelain"]);
    if (worktrees.kind !== "ok") continue;
    for (const match of worktrees.value.stdout.matchAll(/^worktree (.+)$/gm)) {
      const worktreePath = match[1];
      if (worktreePath === undefined) continue;
      if ((await canonical(worktreePath)) === requested) return requested;
    }
  }
  throw new Error(`not a registered project or worktree: ${root}`);
}

async function readRecord(path: string): Promise<ServerRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const row = parsed as Record<string, unknown>;
    if (typeof row.root !== "string" || typeof row.url !== "string" || typeof row.port !== "number" || typeof row.token !== "string" || typeof row.codeServerPid !== "number" || typeof row.proxyPid !== "number" || typeof row.socketPath !== "string") return undefined;
    return row as ServerRecord;
  } catch {
    return undefined;
  }
}

async function writeRecord(path: string, record: ServerRecord): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function availablePort(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function readAssignedPort(path: string): Promise<number | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("port" in parsed)) return undefined;
    const port: unknown = parsed.port;
    return typeof port === "number" && Number.isInteger(port) && port >= CODE_SERVER_PORT_FIRST && port < CODE_SERVER_PORT_FIRST + CODE_SERVER_PORT_COUNT ? port : undefined;
  } catch {
    return undefined;
  }
}

async function writeAssignedPort(path: string, root: string, port: number): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ root, port })}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function ensureDownloaded(stateRoot: string, asset: CodeServerAsset, dependencies: CodeServerDependencies, processAdapter: ProcessAdapter): Promise<string> {
  const versionRoot = join(stateRoot, "code-server", CODE_SERVER_VERSION);
  const executableDirectory = `${basename(asset.name, ".tar.gz")}`;
  const executable = join(versionRoot, executableDirectory, "bin", "code-server");
  if (await canonical(executable) !== undefined) return executable;
  await privateDirectory(versionRoot);
  const archive = join(versionRoot, asset.name);
  try {
    await dependencies.download(asset.url, archive, (downloaded, total) => {
      const size = total === undefined ? `${(downloaded / 1024 ** 2).toFixed(1)} MiB` : `${(downloaded / 1024 ** 2).toFixed(1)}/${(total / 1024 ** 2).toFixed(1)} MiB`;
      process.stderr.write(`\rDownloading code-server ${CODE_SERVER_VERSION}: ${size}`);
      if (total !== undefined && downloaded >= total) process.stderr.write("\n");
    });
    if (!(await dependencies.verifyChecksum(archive, asset.sha256))) throw new Error(`code-server ${CODE_SERVER_VERSION} checksum mismatch for ${asset.name}`);
    await dependencies.extract(archive, versionRoot);
    await chmod(executable, 0o755);
    await rm(archive, { force: true });
  } catch (cause: unknown) {
    process.stderr.write("\n");
    await rm(archive, { force: true });
    throw cause;
  }
  const info = await stat(executable).catch(() => undefined);
  if (info === undefined || !info.isFile()) throw new Error(`code-server release did not contain ${executableDirectory}/bin/code-server`);
  return executable;
}

async function acquireLock(path: string, dependencies: CodeServerDependencies): Promise<() => Promise<void>> {
  await privateDirectory(dirname(path));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, "owner"), `${process.pid}\n`, { mode: 0o600, flag: "wx" });
      return async () => rm(path, { recursive: true, force: true });
    } catch (cause: unknown) {
      if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")) throw cause;
      const owner = Number(await readFile(join(path, "owner"), "utf8").catch(() => ""));
      if (Number.isInteger(owner) && owner > 0 && !dependencies.isAlive(owner)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      await delay(50);
    }
  }
  throw new Error("timed out waiting for code-server startup lock");
}

async function waitForProxy(port: number, token: string, codePid: number, proxyPid: number, dependencies: CodeServerDependencies): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!dependencies.isAlive(codePid) || !dependencies.isAlive(proxyPid)) throw new Error("code-server exited during startup");
    try {
      const url = `http://127.0.0.1:${port}/${token}/`;
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      const ready = response.status !== 401 && response.status !== 502 && response.status < 500;
      await response.body?.cancel();
      if (ready) return;
    } catch {
      // The proxy or the code-server socket is still starting.
    }
    await delay(100);
  }
  throw new Error("code-server did not become ready on its private socket");
}

async function stopPid(pid: number, dependencies: CodeServerDependencies): Promise<void> {
  if (!dependencies.isAlive(pid)) return;
  dependencies.kill(pid);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!dependencies.isAlive(pid)) return;
    await delay(100);
  }
  throw new Error(`code-server process ${pid} did not stop`);
}

function startOrThrow(result: Result<{ pid: number }>, label: string): number {
  if (result.kind !== "ok") throw new Error(`${label}: ${result.error}`);
  return result.value.pid;
}

export function createCodeServerManager(environment: StateEnvironment, processAdapter: ProcessAdapter, suppliedDependencies?: CodeServerDependencies) {
  const dependencies = suppliedDependencies ?? defaultDependencies(processAdapter);
  const stateRoot = resolveStateDirectory(environment);
  const base = join(stateRoot, "code-server");

  async function open(root: string): Promise<CodeServerInfo> {
    const canonicalRoot = await validateRegisteredRoot(root, environment, processAdapter);
    await privateDirectory(base);
    const id = rootId(canonicalRoot);
    const lock = await acquireLock(join(base, "locks", `${id}.lock`), dependencies);
    try {
      const recordPath = join(base, "servers", `${id}.json`);
      await privateDirectory(join(base, "servers"));
      const existing = await readRecord(recordPath);
      if (existing !== undefined && existing.root === canonicalRoot && dependencies.isAlive(existing.codeServerPid) && dependencies.isAlive(existing.proxyPid)) {
        return { root: existing.root, url: existing.url, port: existing.port, pid: existing.proxyPid, codeServerPid: existing.codeServerPid };
      }
      if (existing !== undefined) {
        for (const pid of [existing.proxyPid, existing.codeServerPid]) await stopPid(pid, dependencies);
        await rm(recordPath, { force: true });
        await rm(existing.socketPath, { force: true });
      }

      const asset = selectCodeServerAsset(dependencies.platform, dependencies.arch);
      if (asset === undefined) throw new Error(`code-server ${CODE_SERVER_VERSION} is unavailable for ${dependencies.platform} ${dependencies.arch}`);
      const executable = await ensureDownloaded(stateRoot, asset, dependencies, processAdapter);
      const profile = join(base, "data", id);
      const socketDirectory = join(base, "run", id);
      await privateDirectory(profile);
      await privateDirectory(join(profile, "extensions"));
      await writeManagedSettings(join(profile, "User", "settings.json"));
      const extensionsDirectory = join(profile, "extensions");
      const extensionLocation = join(extensionsDirectory, "megabrain.megabrain-bridge-1.0.0");
      await installBridgeExtension(extensionLocation);
      await registerBridgeExtension(extensionsDirectory, extensionLocation);
      await rm(join(extensionsDirectory, "megabrain-bridge"), { recursive: true, force: true });
      await privateDirectory(socketDirectory);
      const configPath = join(profile, "config.yaml");
      await writeFile(configPath, "", { mode: 0o600 });
      await chmod(configPath, 0o600);
      const socketPath = join(socketDirectory, "server.sock");
      await rm(socketPath, { force: true });
      const token = dependencies.token();
      const codeServerPid = startOrThrow(await dependencies.start(executable, [
        "--socket", socketPath,
        "--auth", "none",
        "--disable-telemetry",
        "--disable-update-check",
        "--config", configPath,
        "--user-data-dir", profile,
        "--extensions-dir", join(profile, "extensions"),
        canonicalRoot,
      ], { cwd: canonicalRoot }), "code-server");
      let proxyPid: number | undefined;
      try {
        const port = await reservePort(id, canonicalRoot);
        const invocation = codeServerProxyInvocation(process.execPath, process.argv, socketPath, port);
        const proxyResult = await dependencies.start(invocation.command, invocation.args, { env: { MEGABRAIN_CODE_TOKEN: token } });
        proxyPid = startOrThrow(proxyResult, "code-server proxy");
        if (dependencies.ready === undefined) await waitForProxy(port, token, codeServerPid, proxyPid, dependencies);
        else await dependencies.ready(port, codeServerPid, proxyPid);
        const url = `http://127.0.0.1:${port}/${token}/`;
        const record: ServerRecord = { root: canonicalRoot, url, port, token, codeServerPid, proxyPid, socketPath };
        await writeRecord(recordPath, record);
        return { root: canonicalRoot, url, port, pid: proxyPid, codeServerPid };
      } catch (cause: unknown) {
        if (proxyPid !== undefined) await stopPid(proxyPid, dependencies);
        await stopPid(codeServerPid, dependencies);
        await rm(socketPath, { force: true });
        throw cause;
      }
    } finally {
      await lock();
    }
  }

  async function reservePort(id: string, root: string): Promise<number> {
    const directory = join(base, "ports");
    await privateDirectory(directory);
    const lock = await acquireLock(join(base, "locks", "ports.lock"), dependencies);
    try {
      const assignmentPath = join(directory, `${id}.json`);
      const assigned = await readAssignedPort(assignmentPath);
      const occupied = new Set<number>();
      for (const name of await readdir(directory)) {
        if (name === `${id}.json` || !name.endsWith(".json")) continue;
        const port = await readAssignedPort(join(directory, name));
        if (port !== undefined) occupied.add(port);
      }
      const canUse = async (port: number) => !occupied.has(port) && await (dependencies.portAvailable?.(port) ?? availablePort(port));
      if (assigned !== undefined && await canUse(assigned)) return assigned;
      const first = codeServerPortCandidate(root);
      for (let offset = 0; offset < CODE_SERVER_PORT_COUNT; offset += 1) {
        const port = CODE_SERVER_PORT_FIRST + ((first - CODE_SERVER_PORT_FIRST + offset) % CODE_SERVER_PORT_COUNT);
        if (await canUse(port)) {
          await writeAssignedPort(assignmentPath, root, port);
          return port;
        }
      }
      throw new Error("no available code-server ports remain in the managed range");
    } finally {
      await lock();
    }
  }

  async function stop(root: string): Promise<void> {
    const canonicalRoot = await validateRegisteredRoot(root, environment, processAdapter);
    await privateDirectory(base);
    const id = rootId(canonicalRoot);
    const lock = await acquireLock(join(base, "locks", `${id}.lock`), dependencies);
    try {
      const recordPath = join(base, "servers", `${id}.json`);
      const record = await readRecord(recordPath);
      if (record !== undefined) {
        await stopPid(record.proxyPid, dependencies);
        await stopPid(record.codeServerPid, dependencies);
        await rm(record.socketPath, { force: true });
      }
      await rm(recordPath, { force: true });
    } finally {
      await lock();
    }
  }

  async function goto(root: string, target: string, line?: number): Promise<CodeServerInfo> {
    const canonicalRoot = await validateRegisteredRoot(root, environment, processAdapter);
    const canonicalTarget = await canonical(target);
    if (canonicalTarget === undefined || (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}/`))) {
      throw new Error(`file is outside project or does not exist: ${target}`);
    }
    if (line !== undefined && (!Number.isInteger(line) || line < 1)) throw new Error("line must be a positive integer");
    const server = await open(canonicalRoot);
    const profile = join(base, "data", rootId(canonicalRoot));
    await writeGotoRequest(profile, canonicalTarget, line);
    return server;
  }

  return { open, goto, stop };
}

async function writeManagedSettings(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch (cause: unknown) {
    if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")) throw new Error(`could not read code-server settings: ${String(cause)}`);
  }
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  // Enforced settings protect the embedded workspace; defaults seed a new profile while leaving
  // choices made in VS Code (including its color theme) intact on every later start.
  const defaults = Object.fromEntries(Object.entries(CODE_DEFAULT_SETTINGS).filter(([key]) => !(key in existing)));
  await writeFile(temporary, `${JSON.stringify({ ...existing, ...defaults, ...CODE_ENFORCED_SETTINGS }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function writeGotoRequest(profile: string, target: string, line?: number): Promise<void> {
  const nonce = randomBytes(16).toString("hex");
  const requests = join(profile, "User", "globalStorage", "megabrain.megabrain-bridge", "requests");
  await privateDirectory(requests);
  const destination = join(requests, `${nonce}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ path: target, ...(line === undefined ? {} : { line }), nonce })}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

async function installBridgeExtension(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(path, "package.json"), `${JSON.stringify(BRIDGE_PACKAGE, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(path, "extension.js"), BRIDGE_EXTENSION, { mode: 0o600 });
  const themes = join(path, "themes");
  await mkdir(themes, { recursive: true, mode: 0o700 });
  await writeFile(join(themes, "megabrain-dark-color-theme.json"), `${JSON.stringify(BRIDGE_THEME, null, 2)}\n`, { mode: 0o600 });
}

async function registerBridgeExtension(extensionsDirectory: string, extensionLocation: string): Promise<void> {
  const manifestPath = join(extensionsDirectory, "extensions.json");
  let entries: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`invalid code-server extensions manifest: ${manifestPath}`);
    entries = parsed;
  } catch (cause: unknown) {
    if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")) throw cause;
  }
  const bridge = {
    identifier: { id: "megabrain.megabrain-bridge" },
    version: "1.0.0",
    location: { scheme: "file", path: extensionLocation },
    relativeLocation: basename(extensionLocation),
  };
  const updated = entries.filter((entry) => {
    if (typeof entry !== "object" || entry === null || !("identifier" in entry)) return true;
    const identifier: unknown = entry.identifier;
    return typeof identifier !== "object" || identifier === null || !("id" in identifier) || identifier.id !== bridge.identifier.id;
  });
  updated.push(bridge);
  const temporary = `${manifestPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, manifestPath);
  await chmod(manifestPath, 0o600);
}

const BRIDGE_PACKAGE = {
  name: "megabrain-bridge",
  displayName: "Megabrain Bridge",
  description: "Megabrain code-server integration",
  version: "1.0.0",
  publisher: "megabrain",
  engines: { vscode: "^1.100.0" },
  main: "./extension.js",
  activationEvents: ["*"],
  extensionKind: ["workspace"],
  categories: ["Themes"],
  contributes: {
    themes: [{ id: "megabrain-dark", label: "megabrain dark", uiTheme: "vs-dark", path: "./themes/megabrain-dark-color-theme.json" }],
  },
};

export const BRIDGE_EXTENSION = `const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.activate = async (context) => {
  const viewsHiddenKey = 'megabrain.viewsHidden';
  if (!context.globalState.get(viewsHiddenKey)) {
    await vscode.commands.executeCommand('outline.removeView');
    await vscode.commands.executeCommand('timeline.removeView');
    await context.globalState.update(viewsHiddenKey, true);
  }
  const requests = path.join(context.globalStorageUri.fsPath, 'requests');
  await fs.promises.mkdir(requests, { recursive: true, mode: 0o700 });
  const pending = new Set();
  const consume = async (name) => {
    if (!name || !/^[a-f0-9]{32}\\.json$/.test(name) || pending.has(name)) return;
    pending.add(name);
    const requestPath = path.join(requests, name);
    try {
      const request = JSON.parse(await fs.promises.readFile(requestPath, 'utf8'));
      if (request.nonce !== name.slice(0, -5) || typeof request.path !== 'string' || (request.line !== undefined && (!Number.isInteger(request.line) || request.line < 1))) return;
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(request.path));
      const position = request.line === undefined ? undefined : new vscode.Position(request.line - 1, 0);
      const editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One, ...(position ? { selection: new vscode.Range(position, position) } : {}) });
      if (position) editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      await fs.promises.unlink(requestPath);
    } catch (error) {
      console.error('megabrain-bridge could not consume a file-open request', error);
    } finally {
      pending.delete(name);
    }
  };
  const watcher = fs.watch(requests, (_event, name) => { void consume(String(name || '')); });
  context.subscriptions.push({ dispose: () => watcher.close() });
  for (const name of await fs.promises.readdir(requests)) void consume(name);
};
`;

// Canto dark tokens from packages/frontend-core/src/ui/tokens/colors.ts; accent and editor
// neutrals use apps/desktop/src/styles.css so the editor follows the desktop shell.
const BRIDGE_THEME = {
  name: "megabrain dark",
  type: "dark",
  colors: {
    "editor.background": "#0a0a0a", "editor.foreground": "#fafafa",
    "editorGroup.background": "#0a0a0a", "editorPane.background": "#0a0a0a",
    "editorGroupHeader.noTabsBackground": "#0a0a0a",
    "sideBar.background": "#111111", "sideBar.foreground": "#fafafa",
    "sideBarSectionHeader.background": "#111111", "sideBarSectionHeader.foreground": "#fafafa",
    "list.activeSelectionBackground": "#282828", "list.activeSelectionForeground": "#fafafa",
    "list.inactiveSelectionBackground": "#1c1c1c", "list.hoverBackground": "#1c1c1c",
    "focusBorder": "#8e9cff", "contrastBorder": "#262626", "editorGroup.border": "#262626",
    "tab.activeBackground": "#0a0a0a", "tab.inactiveBackground": "#111111",
    "tab.activeForeground": "#fafafa", "tab.inactiveForeground": "#b4b4bc", "tab.border": "#262626",
    "editorGroupHeader.tabsBackground": "#111111", "input.background": "#262626",
    "input.foreground": "#fafafa", "input.border": "#262626", "scrollbarSlider.background": "#232328",
    "scrollbarSlider.hoverBackground": "#303036", "scrollbarSlider.activeBackground": "#4c4c55",
    "editorLineNumber.foreground": "#8a8a94", "editorLineNumber.activeForeground": "#fafafa",
    "editorCursor.foreground": "#8e9cff", "editor.selectionBackground": "#8e9cff55",
    "editor.lineHighlightBackground": "#18181c", "editorIndentGuide.background": "#232328",
    "editorIndentGuide.activeBackground": "#4c4c55", "statusBar.background": "#111111",
    "titleBar.activeBackground": "#0a0a0a", "titleBar.inactiveBackground": "#0a0a0a",
    "activityBar.background": "#0a0a0a", "panel.background": "#0a0a0a",
    "panelSectionHeader.background": "#111111", "panelSectionHeader.foreground": "#fafafa",
    "panelTitle.activeBorder": "#8e9cff", "panelTitle.activeForeground": "#fafafa",
    "breadcrumb.background": "#0a0a0a", "breadcrumb.foreground": "#b4b4bc",
    "editorStickyScroll.background": "#0a0a0a", "editorOverviewRuler.background": "#0a0a0a",
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8a8a94", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type"], settings: { foreground: "#8e9cff" } },
    { scope: ["string", "markup.inline.raw"], settings: { foreground: "#34d399" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#c084fc" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "#60a5fa" } },
    { scope: ["entity.name.type", "entity.name.class"], settings: { foreground: "#fbbf24" } },
    { scope: ["variable", "identifier"], settings: { foreground: "#fafafa" } },
  ],
};
