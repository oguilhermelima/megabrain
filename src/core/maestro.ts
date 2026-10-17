import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";

type Environment = Readonly<Record<string, string | undefined>>;

/** The Maestro CLI release megabrain installs and checks against. */
export const MAESTRO_VERSION = "2.11.0";
export const MAESTRO_INSTALLER_URL = "https://get.maestro.mobile.dev";
const MINIMUM_JAVA = 17;

export type MaestroRecord = Readonly<{ version: string; javaHome: string; installedAt: string }>;

/** Where Maestro lives: the installer's own MAESTRO_DIR, else ~/.maestro. */
export function maestroRoot(environment: Environment): string {
  const own = environment.MAESTRO_DIR;
  return own !== undefined && own !== "" ? own : join(environment.HOME ?? "", ".maestro");
}

export const maestroBinary = (environment: Environment): string => join(maestroRoot(environment), "bin", "maestro");
export const maestroRecordPath = (environment: Environment): string => join(maestroRoot(environment), "megabrain-module.json");

export function readMaestroRecord(environment: Environment): MaestroRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(maestroRecordPath(environment), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { version, javaHome, installedAt } = parsed as Record<string, unknown>;
    return typeof version === "string" && typeof javaHome === "string" && typeof installedAt === "string" ? { version, javaHome, installedAt } : undefined;
  } catch {
    return undefined;
  }
}

async function javaMajor(javaHome: string, process: ProcessAdapter): Promise<number | undefined> {
  const java = join(javaHome, "bin", "java");
  if (!existsSync(java)) return undefined;
  const ran = await process.run(java, ["-version"]);
  // java prints its version on stderr; a failed run still carries it in the error text.
  const text = ran.kind === "ok" ? `${ran.value.stderr}\n${ran.value.stdout}` : ran.error;
  const match = /version "(\d+)(?:\.(\d+))?/.exec(text);
  if (match?.[1] === undefined) return undefined;
  return match[1] === "1" ? Number(match[2]) : Number(match[1]);
}

/** A JDK of at least 17: the person's JAVA_HOME if it qualifies, else the one macOS reports. */
export async function findJavaHome(environment: Environment, process: ProcessAdapter): Promise<string | undefined> {
  const candidates: string[] = [];
  if (environment.JAVA_HOME !== undefined && environment.JAVA_HOME !== "") candidates.push(environment.JAVA_HOME);
  const reported = await process.run(environment.MEGABRAIN_JAVA_HOME_TOOL ?? "/usr/libexec/java_home", ["-v", `${MINIMUM_JAVA}+`]);
  if (reported.kind === "ok" && reported.value.stdout.trim() !== "") candidates.push(reported.value.stdout.trim());
  for (const candidate of candidates) {
    const major = await javaMajor(candidate, process);
    if (major !== undefined && major >= MINIMUM_JAVA) return candidate;
  }
  return undefined;
}

/** The environment every Maestro call of megabrain's runs with. */
export function maestroEnvironment(environment: Environment, javaHome: string): Record<string, string> {
  return { JAVA_HOME: javaHome, MAESTRO_CLI_NO_ANALYTICS: "1", MAESTRO_DIR: maestroRoot(environment), PATH: `${join(javaHome, "bin")}:${environment.PATH ?? ""}` };
}
