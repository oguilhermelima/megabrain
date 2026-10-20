import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ProcessAdapter } from "../../../adapters/proc.js";
import { resolvePackageRoot } from "../../../core/package-root.js";
import type { Environment } from "./index.js";

export type ServeSimCommand = { command: string; args: string[]; env?: Record<string, string> };

/** Resolve the bundled package first, then a repository install, then the user's PATH. */
export function resolveServeSim(
  env: Environment,
  executable = process.execPath,
  cwd = process.cwd(),
): ServeSimCommand {
  const bundled = [
    resolve(dirname(executable), "../Resources/megabrain/node_modules/serve-sim/dist/serve-sim.js"),
    resolve(dirname(executable), "../share/megabrain/node_modules/serve-sim/dist/serve-sim.js"),
  ].find(existsSync);
  if (bundled) return { command: executable, args: [bundled], env: { BUN_BE_BUN: "1" } };

  const roots = [cwd];
  try { roots.push(resolvePackageRoot(import.meta.url, env.MEGABRAIN_ROOT)); } catch { /* use cwd */ }
  const local = roots.map((root) => join(root, "node_modules/serve-sim/dist/serve-sim.js")).find(existsSync);
  return local ? { command: "node", args: [local] } : { command: "serve-sim", args: [] };
}

export async function runServeSim(processAdapter: ProcessAdapter, env: Environment, args: readonly string[]) {
  const resolved = resolveServeSim(env);
  const invocation = [...resolved.args, ...args];
  const result = await processAdapter.run(resolved.command, invocation, resolved.env ? { env: resolved.env } : undefined);
  if (resolved.command !== "serve-sim" || result.kind === "ok" || !result.error.includes("executable not found")) return result;
  return processAdapter.run("serve-sim", args);
}
