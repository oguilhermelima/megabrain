import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type ProjectScript = Readonly<{ command: string; source: "saved" | "detected" }>;
export type ProjectScripts = Readonly<{ run: ProjectScript | null; build: ProjectScript | null; install: ProjectScript | null }>;
export type ProjectScriptName = keyof ProjectScripts;
export type SavedProjectScripts = Partial<Record<ProjectScriptName, string>>;

const names: readonly ProjectScriptName[] = ["run", "build", "install"];

function packageScripts(root: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const scripts = (value as Record<string, unknown>).scripts;
    return typeof scripts === "object" && scripts !== null ? scripts as Record<string, unknown> : {};
  } catch { return undefined; }
}

function packageManager(root: string): string {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

function detected(command: string | undefined): ProjectScript | null {
  return command === undefined ? null : { command, source: "detected" };
}

export function detectProjectScripts(root: string): ProjectScripts {
  const scripts = packageScripts(root);
  if (scripts !== undefined && existsSync(join(root, "package.json"))) {
    const manager = packageManager(root);
    const dev = typeof scripts.dev === "string";
    const start = typeof scripts.start === "string";
    return {
      run: detected(dev ? `${manager} run dev` : start ? `${manager} start` : undefined),
      build: detected(typeof scripts.build === "string" ? `${manager} run build` : undefined),
      install: { command: `${manager} install`, source: "detected" },
    };
  }
  if (existsSync(join(root, "Cargo.toml"))) return {
    run: { command: "cargo run", source: "detected" },
    build: { command: "cargo build", source: "detected" },
    install: null,
  };
  const makefile = ["Makefile", "makefile", "GNUmakefile"].map((name) => join(root, name)).find(existsSync);
  if (makefile !== undefined) {
    let contents = "";
    try { contents = readFileSync(makefile, "utf8"); } catch { /* unavailable targets remain undetected */ }
    const hasTarget = (name: string) => new RegExp(`^${name}\\s*:(?:\\s|$)`, "m").test(contents);
    return {
      run: detected(hasTarget("run") ? "make run" : undefined),
      build: detected(hasTarget("build") ? "make build" : undefined),
      install: detected(hasTarget("install") ? "make install" : undefined),
    };
  }
  return { run: null, build: null, install: null };
}

function stateFile(environment: Readonly<Record<string, string | undefined>>): string {
  const directory = environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.env.HOME ?? ".", ".megabrain");
  return join(directory, "project-scripts.json");
}

async function readSaved(file: string): Promise<Record<string, Partial<Record<ProjectScriptName, string>>>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, Partial<Record<ProjectScriptName, string>>>;
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`could not read saved project scripts: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return {};
}

function combine(root: string, saved: Record<string, Partial<Record<ProjectScriptName, string>>>): ProjectScripts {
  const detectedScripts = detectProjectScripts(root);
  const own = saved[root];
  return Object.fromEntries(names.map((name) => {
    const command = own?.[name];
    return [name, command === undefined ? detectedScripts[name] : command === "" ? detectedScripts[name] : { command, source: "saved" }];
  })) as unknown as ProjectScripts;
}

export async function projectScripts(root: string, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<ProjectScripts> {
  return combine(root, await readSaved(stateFile(environment)));
}

export async function setProjectScripts(root: string, scripts: SavedProjectScripts, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<ProjectScripts> {
  const file = stateFile(environment);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      try {
        const info = await stat(lock);
        if (Date.now() - info.mtimeMs > 30_000) await rm(lock, { recursive: true, force: true });
      } catch { /* another writer released it */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!acquired) throw new Error("timed out waiting to save project scripts");
  try {
    const saved = await readSaved(file);
    const current = { ...(saved[root] ?? {}) };
    for (const name of names) {
      const command = scripts[name];
      if (command === undefined) continue;
      if (typeof command !== "string") throw new Error(`invalid ${name} command`);
      if (command === "") delete current[name];
      else current[name] = command;
    }
    if (Object.keys(current).length === 0) delete saved[root];
    else saved[root] = current;
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
    await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
    } finally { await rm(temporary, { force: true }); }
    return combine(root, saved);
  } finally { await rm(lock, { recursive: true, force: true }); }
}
