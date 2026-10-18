import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import pinnedList from "./code-extensions.json" with { type: "json" };
import { type ProcessAdapter } from "../adapters/proc.js";
import { failed, ok, type Result } from "./result.js";
import { resolveStateDirectory, type StateEnvironment } from "./state.js";

// The extensions the app's Code view recommends, pinned in code-extensions.json and installed from
// Open VSX into each worktree's code-server profile, never into an editor the person uses elsewhere.
// Opening Code only starts the sync (see syncExtensions in code-server.ts) and never waits for it, so
// a slow or failed download leaves Code as it was; what the sync installs shows on the server's next
// start, and what it could not install is tried again on a later open.

/** `editorAssociations` are the file patterns the extension's editor takes over in Code (or hands
 * back to the text editor as "default", where it would otherwise claim them). */
export type PinnedExtension = Readonly<{ id: string; version: string; sha256: string; editorAssociations?: Readonly<Record<string, string>> }>;

export type ExtensionSyncDependencies = Readonly<{
  download(url: string, destination: string): Promise<void>;
  install(vsix: string): Promise<void>;
  isAlive(pid: number): boolean;
}>;

export type ExtensionSyncResult = Readonly<{ installed: string[]; failed: Array<{ id: string; reason: string }>; skipped: boolean }>;

const extensionId = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i;
const exactVersion = /^\d+\.\d+\.\d+$/;
const sha256Hex = /^[a-f0-9]{64}$/;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 2 * 60_000;

/** The pinned list, refusing anything but exact versions with a SHA-256 and each id once. */
export function parsePinnedExtensions(value: unknown): PinnedExtension[] {
  const list: unknown = typeof value === "object" && value !== null && "extensions" in value ? value.extensions : undefined;
  if (!Array.isArray(list)) throw new Error("code extensions: expected an extensions list");
  const seen = new Set<string>();
  const claimed = new Set<string>();
  return list.map((entry: unknown) => {
    const row = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : {};
    const { id, version, sha256, editorAssociations } = row;
    if (typeof id !== "string" || !extensionId.test(id)) throw new Error(`code extensions: invalid id ${String(id)}`);
    if (typeof version !== "string" || !exactVersion.test(version)) throw new Error(`code extensions: ${id} needs an exact version`);
    if (typeof sha256 !== "string" || !sha256Hex.test(sha256)) throw new Error(`code extensions: ${id} needs a SHA-256`);
    if (seen.has(id.toLowerCase())) throw new Error(`code extensions: ${id} is listed twice`);
    seen.add(id.toLowerCase());
    if (editorAssociations === undefined) return { id, version, sha256 };
    if (typeof editorAssociations !== "object" || editorAssociations === null || Array.isArray(editorAssociations)) throw new Error(`code extensions: ${id} has invalid editor associations`);
    const associations: Record<string, string> = {};
    for (const [pattern, editor] of Object.entries(editorAssociations)) {
      if (pattern === "" || typeof editor !== "string" || editor === "") throw new Error(`code extensions: ${id} has an invalid editor association for ${pattern}`);
      if (claimed.has(pattern)) throw new Error(`code extensions: ${pattern} is associated twice`);
      claimed.add(pattern);
      associations[pattern] = editor;
    }
    return { id, version, sha256, editorAssociations: associations };
  });
}

/** Every pin's editor associations as one workbench.editorAssociations map. */
export function codeEditorAssociations(pinned: readonly PinnedExtension[]): Record<string, string> {
  return Object.assign({}, ...pinned.map((extension) => extension.editorAssociations ?? {}));
}

export const PINNED_EXTENSIONS: readonly PinnedExtension[] = parsePinnedExtensions(pinnedList);

function vsixName(extension: PinnedExtension): string {
  return `${extension.id}-${extension.version}.vsix`;
}

/** The pinned version's package on Open VSX. */
export function vsixUrl(extension: PinnedExtension): string {
  const [publisher, name] = extension.id.split(".");
  return `https://open-vsx.org/api/${publisher}/${name}/${extension.version}/file/${vsixName(extension)}`;
}

/** Each installed extension's version by lower-case id, from a profile's extensions.json. */
export function installedExtensionVersions(manifest: unknown): Map<string, string> {
  const versions = new Map<string, string>();
  if (!Array.isArray(manifest)) return versions;
  for (const entry of manifest) {
    if (typeof entry !== "object" || entry === null) continue;
    const { identifier, version } = entry as Record<string, unknown>;
    const id: unknown = typeof identifier === "object" && identifier !== null ? (identifier as Record<string, unknown>).id : undefined;
    if (typeof id === "string" && typeof version === "string") versions.set(id.toLowerCase(), version);
  }
  return versions;
}

/** The pins a profile lacks or holds at another version. */
export function extensionsToInstall(pinned: readonly PinnedExtension[], installed: ReadonlyMap<string, string>): PinnedExtension[] {
  return pinned.filter((extension) => installed.get(extension.id.toLowerCase()) !== extension.version);
}

/** What a profile's extensions directory holds; a missing or unreadable manifest holds nothing. */
export async function readInstalledExtensions(extensionsDirectory: string): Promise<Map<string, string>> {
  try {
    return installedExtensionVersions(JSON.parse(await readFile(join(extensionsDirectory, "extensions.json"), "utf8")));
  } catch {
    return new Map();
  }
}

async function sha256File(path: string): Promise<string | undefined> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

async function acquireSyncLock(extensionsDirectory: string, isAlive: (pid: number) => boolean): Promise<(() => Promise<void>) | undefined> {
  const lock = join(extensionsDirectory, ".megabrain-sync.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, "owner"), `${process.pid}\n`, { mode: 0o600 });
      return async () => rm(lock, { recursive: true, force: true });
    } catch (cause: unknown) {
      if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")) throw cause;
      const owner = Number((await readFile(join(lock, "owner"), "utf8").catch(() => "")).trim());
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) return undefined;
      await rm(lock, { recursive: true, force: true });
    }
  }
  return undefined;
}

/** A verified package for the pin in the cache, downloading it when the cache has no good copy. */
async function cachedPackage(extension: PinnedExtension, cacheDirectory: string, dependencies: ExtensionSyncDependencies): Promise<string> {
  const destination = join(cacheDirectory, vsixName(extension));
  if (await sha256File(destination) === extension.sha256) return destination;
  await rm(destination, { force: true });
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const partial = `${destination}.${process.pid}.part`;
  try {
    await rm(partial, { force: true });
    await dependencies.download(vsixUrl(extension), partial);
    if (await sha256File(partial) !== extension.sha256) throw new Error(`${vsixName(extension)} does not match its pinned SHA-256`);
    await rename(partial, destination);
    return destination;
  } finally {
    await rm(partial, { force: true });
  }
}

/** Installs the pins a profile lacks, one at a time so one failure never stops the rest. */
export async function syncExtensions(pinned: readonly PinnedExtension[], extensionsDirectory: string, cacheDirectory: string, dependencies: ExtensionSyncDependencies): Promise<ExtensionSyncResult> {
  await mkdir(extensionsDirectory, { recursive: true, mode: 0o700 });
  const release = await acquireSyncLock(extensionsDirectory, dependencies.isAlive);
  if (release === undefined) return { installed: [], failed: [], skipped: true };
  const installed: string[] = [];
  const failures: Array<{ id: string; reason: string }> = [];
  try {
    for (const extension of extensionsToInstall(pinned, await readInstalledExtensions(extensionsDirectory))) {
      try {
        await dependencies.install(await cachedPackage(extension, cacheDirectory, dependencies));
        installed.push(extension.id);
      } catch (cause: unknown) {
        failures.push({ id: extension.id, reason: cause instanceof Error ? cause.message : String(cause) });
      }
    }
  } finally {
    await release();
  }
  return { installed, failed: failures, skipped: false };
}

async function downloadVsix(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600, flag: "wx" });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPERM";
  }
}

function inside(parent: string, path: string): boolean {
  const offset = relative(parent, path);
  return offset !== "" && !offset.startsWith("..") && !offset.startsWith(sep);
}

/** The detached `__code-extensions <code-server> <profile>/extensions` run that opening Code starts. */
export async function runCodeExtensionsSync(args: readonly string[], environment: StateEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const [executable, extensionsDirectory] = args;
  const base = join(resolveStateDirectory(environment), "code-server");
  if (args.length !== 2 || executable === undefined || extensionsDirectory === undefined || !inside(base, executable) || !inside(join(base, "data"), extensionsDirectory)) {
    return failed("invalid internal code extensions arguments", 2);
  }
  const result = await syncExtensions(PINNED_EXTENSIONS, extensionsDirectory, join(base, "vsix"), {
    download: downloadVsix,
    async install(vsix) {
      const installed = await processAdapter.run(executable, ["--user-data-dir", dirname(extensionsDirectory), "--extensions-dir", extensionsDirectory, "--install-extension", vsix, "--force"], { timeoutMs: INSTALL_TIMEOUT_MS });
      if (installed.kind !== "ok") throw new Error(installed.error);
    },
    isAlive: alive,
  });
  return ok(JSON.stringify(result));
}
