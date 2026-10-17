import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import {
  findJavaHome, maestroBinary, maestroEnvironment, maestroRecordPath, maestroRoot, MAESTRO_INSTALLER_URL, MAESTRO_VERSION, readMaestroRecord,
} from "../../core/maestro.js";

type Environment = Readonly<Record<string, string | undefined>>;
type ModuleReport = Readonly<{ status: string; reason: string }>;

/** The installer script: MEGABRAIN_MAESTRO_INSTALLER may name a local file (tests), else the official URL. */
async function fetchInstaller(environment: Environment, directory: string, process: ProcessAdapter): Promise<Result<string>> {
  const override = environment.MEGABRAIN_MAESTRO_INSTALLER;
  if (override !== undefined && override !== "" && existsSync(override)) return ok(override);
  const target = join(directory, "install.sh");
  const fetched = await process.run("curl", ["--fail", "--silent", "--show-error", "--location", override ?? MAESTRO_INSTALLER_URL, "--output", target], { timeoutMs: 120_000 });
  return fetched.kind === "ok" ? ok(target) : failed(`could not download the Maestro installer: ${fetched.error}`);
}

/**
 * Installs the pinned Maestro CLI with the official installer. The installer appends a PATH line to
 * the person's shell rc files, so it runs with a throwaway HOME and ZDOTDIR: MAESTRO_DIR still points
 * at the real directory, and every rc file it touches is one that is deleted afterwards.
 */
export async function installMaestro(environment: Environment, process: ProcessAdapter): Promise<Result<void>> {
  const javaHome = await findJavaHome(environment, process);
  if (javaHome === undefined) return failed("Maestro needs a JDK 17 or newer; install one (for example Temurin 17) or set JAVA_HOME");
  const scratch = mkdtempSync(join(tmpdir(), "megabrain-maestro-"));
  try {
    const installer = await fetchInstaller(environment, scratch, process);
    if (installer.kind !== "ok") return installer;
    const home = join(scratch, "home");
    mkdirSync(home);
    const installed = await process.run("bash", [installer.value], {
      timeoutMs: 600_000,
      env: { ...maestroEnvironment(environment, javaHome), HOME: home, ZDOTDIR: home, MAESTRO_VERSION },
    });
    if (installed.kind !== "ok") return failed(`Maestro installer failed: ${installed.error}`);
    if (!existsSync(maestroBinary(environment))) return failed(`Maestro installer finished but ${maestroBinary(environment)} is missing`);
    writeFileSync(maestroRecordPath(environment), `${JSON.stringify({ version: MAESTRO_VERSION, javaHome, installedAt: new Date().toISOString() }, null, 2)}\n`);
    return ok(undefined);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Removes what the installer put in place and the record; the rest of the directory is the person's. */
export function revertMaestro(environment: Environment): Result<string> {
  const root = maestroRoot(environment);
  for (const entry of ["bin", "lib"]) rmSync(join(root, entry), { recursive: true, force: true });
  rmSync(maestroRecordPath(environment), { force: true });
  return ok("simulator-maestro reverted\n");
}

/** java, the recorded version, and the iOS driver the CLI ships. */
export async function maestroReport(environment: Environment, process: ProcessAdapter): Promise<ModuleReport> {
  const platform = await process.run("uname", ["-s"]);
  if (!(platform.kind === "ok" && platform.value.stdout.trim() === "Darwin")) return { status: "unsupported", reason: "macOS only" };
  const record = readMaestroRecord(environment);
  if (!existsSync(maestroBinary(environment)) || record === undefined) return { status: "missing", reason: "module is not installed" };
  const javaHome = await findJavaHome({ ...environment, JAVA_HOME: record.javaHome }, process);
  if (javaHome === undefined) return { status: "misconfigured", reason: `no JDK 17 or newer at ${record.javaHome}; reinstall with megabrain install simulator-maestro` };
  const ran = await process.run(maestroBinary(environment), ["--version"], { timeoutMs: 60_000, env: maestroEnvironment(environment, javaHome) });
  if (ran.kind !== "ok") return { status: "misconfigured", reason: `maestro --version failed: ${ran.error}` };
  const reported = /(\d+\.\d+\.\d+)/.exec(`${ran.value.stdout}\n${ran.value.stderr}`)?.[1];
  if (reported !== record.version) return { status: "misconfigured", reason: `maestro reports ${reported ?? "no version"}, recorded ${record.version}` };
  const lib = join(maestroRoot(environment), "lib");
  const driver = existsSync(lib) && readdirSync(lib).some((file) => /ios/i.test(file));
  if (!driver) return { status: "misconfigured", reason: "the iOS driver is missing from the Maestro installation" };
  return { status: "ok", reason: `maestro ${record.version} with java at ${record.javaHome}; iOS driver present` };
}
