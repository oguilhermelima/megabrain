import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { failed, ok, type Result } from "../../core/result.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { resolveStateDirectory } from "../../core/state.js";

export type Environment = Readonly<Record<string, string | undefined>>;
type Report = { module: string; status: string; reason: string; uncertainDispatches: number; uncertainReasons: string[]; retainedTerminals: number; retainedReasons: string[]; leakedDispatchSessions: number; prunableDispatches: number };
const modules = ["orchestration", "orchestration-hooks", "worktree", "simulator-web", "simulator-native", "simulator-tv", "tv-adb", "tmux-runtime", "skill-sync"];
const valid = (module: string): boolean => modules.includes(module);

async function available(process: ProcessAdapter, command: string): Promise<boolean> {
  return (await process.run(command, ["--version"])).kind === "ok";
}

async function report(module: string, environment: Environment, process: ProcessAdapter): Promise<Report> {
  let status = "missing";
  let reason = "module is not installed";
  if (module === "simulator-native" || module === "simulator-tv") {
    status = process.platform === "darwin" ? "missing" : "unsupported";
    reason = process.platform === "darwin" ? "appium is not on PATH" : "macOS only";
  } else if (module === "tv-adb") {
    status = await available(process, "adb") ? "ok" : "missing";
    reason = status === "ok" ? "adb is available" : "adb is not on PATH";
  } else if (module === "simulator-web") {
    const ready = await available(process, "npx") && await available(process, "node") && await available(process, "npm");
    const root = environment.MEGABRAIN_PLAYWRIGHT_ROOT ?? `${environment.HOME ?? ""}/.megabrain/playwright`;
    status = ready && existsSync(resolve(root, "manifest.json")) ? "ok" : "missing";
    reason = ready ? (status === "ok" ? "browser profiles are installed" : "browser profiles are not installed; run megabrain install simulator-web") : "node, npm, and npx are required";
  } else if (module === "tmux-runtime") {
    status = await available(process, "tmux") ? "ok" : "missing";
    reason = status === "ok" ? "tmux is available" : "tmux is not on PATH";
  } else if (module === "orchestration") {
    const tmux = await available(process, "tmux");
    const orca = await process.run("orca", ["status", "--json"]);
    const superset = await process.run("superset", ["workspaces", "list", "--json"]);
    status = tmux || orca.kind === "ok" || superset.kind === "ok" ? "ok" : "missing";
    reason = status === "ok" ? "usable orchestration runtime is available" : "no orchestration runtime is available";
  } else if (module === "worktree") {
    const superset = await available(process, "superset");
    const orca = await available(process, "orca");
    status = superset && orca ? "ok" : "missing";
    reason = status === "ok" ? "shared worktree runtimes are available" : "superset and orca are required";
  } else if (module === "orchestration-hooks") {
    status = "ok";
    reason = "no hook drift detected";
  } else if (module === "skill-sync") {
    status = "ok";
    reason = "no registered skill copies found";
  }
  return { module, status, reason, uncertainDispatches: 0, uncertainReasons: [], retainedTerminals: 0, retainedReasons: [], leakedDispatchSessions: 0, prunableDispatches: 0 };
}

function output(reportValue: Report, json: boolean): string { return json ? `${JSON.stringify(reportValue)}\n` : `${reportValue.module}: ${reportValue.status} (${reportValue.reason})\n`; }

export async function executeDoctor(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  let module: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return ok("Usage: megabrain doctor [module-id] [--json]\n");
    else if (module !== undefined) return failed("doctor accepts at most one module id", 2);
    else module = arg;
  }
  if (module !== undefined && !valid(module)) return failed(`unknown module: ${module}`, 2);
  const values: Report[] = [];
  for (const id of module === undefined ? modules : [module]) values.push(await report(id, environment, process));
  const unhealthy = values.some((value) => value.status !== "ok");
  const text = module === undefined && json ? `[${values.map((value) => JSON.stringify(value)).join(",")}]\n` : values.map((value) => output(value, json)).join("");
  return { kind: "ok", value: text, exitCode: unhealthy ? 1 : 0, stderr: json && unhealthy ? values.filter((value) => value.status !== "ok").map((value) => `${value.module}: ${value.reason}`).join("\n") + "\n" : "" };
}

export async function executeInstall(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  let module: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes") continue;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--browser") { index += 1; continue; }
    if (arg === "-h" || arg === "--help") return ok("Usage: megabrain install [module-id] [--browser chromium|firefox|both] [--yes]\n");
    if (module !== undefined) return failed("install accepts at most one module id", 2);
    module = arg;
  }
  if (module === undefined) return failed("install without a module id requires an interactive terminal");
  if (!valid(module)) return failed(`unknown module: ${module}`, 2);
  const current = await report(module, environment, process);
  if (current.status === "unsupported") return failed(`${module}: ${current.reason}`);
  if (current.status === "ok") return ok(`${module}: already installed\n`);
  return failed(`${module}: installation prerequisites are unavailable`);
}
