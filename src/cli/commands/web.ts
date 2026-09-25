import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { planWeb, type WebPlan } from "../../core/web.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { usageText } from "../../core/usage.js";
import { join } from "node:path";

export type WebEnvironment = Readonly<Record<string, string | undefined>>;

function usage(): string {
  return usageText("web");
}

function helpFor(args: readonly string[]): string {
  const action = args[1]?.startsWith("-") === true ? undefined : args[1];
  const key = args[0] === "session" ? "web-session" : args[0] === "viewport" ? (action === undefined ? "web-viewport" : `web-viewport-${action}`) : args[0] === "userscript" ? (action === undefined ? "web-userscript" : `web-userscript-${action}`) : `web-${args[0] ?? ""}`;
  const usageKeys = new Set([
    "web-viewport", "web-userscript", "web-capture", "web-measure", "web-session",
    "web-viewport-set", "web-viewport-show", "web-devices", "web-userscript-install",
    "web-userscript-list", "web-userscript-remove",
  ]);
  return usageKeys.has(key) ? usageText(key as keyof typeof import("../../core/usage.js").USAGE_LINES) : usage();
}

function scriptArgs(plan: Extract<WebPlan, { kind: "run" }>, playwrightRoot: string, userscriptsRoot: string): string[] {
  const args = [plan.command, "--root", playwrightRoot];
  if (plan.command === "userscript-install" || plan.command === "userscript-list" || plan.command === "userscript-remove") {
    const fileIndex = plan.args.indexOf("--file");
    if (fileIndex >= 0) {
      args.push("--userscripts", userscriptsRoot, "--file", plan.args[fileIndex + 1] ?? "");
      args.push(...plan.args.slice(0, fileIndex), ...plan.args.slice(fileIndex + 2));
    } else {
      args.push("--userscripts", userscriptsRoot, ...plan.args);
    }
  } else {
    args.push(...plan.args);
  }
  return args;
}

export async function executeWeb(
  args: readonly string[],
  environment: WebEnvironment,
  processAdapter: ProcessAdapter = createProcessAdapter(),
): Promise<Result<string>> {
  const plan = planWeb(args);
  if (plan.kind === "help") return ok(helpFor(args));
  if (plan.kind === "usage") return failed(plan.message, 2);
  const script = environment.MEGABRAIN_PLAYWRIGHT_SCRIPT ?? join(resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT), "scripts/playwright-web.mjs");
  const playwrightRoot = environment.MEGABRAIN_PLAYWRIGHT_ROOT ?? `${environment.HOME ?? ""}/.megabrain/playwright`;
  const userscriptsRoot = `${environment.HOME ?? ""}/.megabrain/userscripts`;
  const invocation = [script, ...scriptArgs(plan, playwrightRoot, userscriptsRoot)];
  const result = await processAdapter.run("node", invocation);
  if (result.kind !== "ok") return result;
  return ok(result.value.stdout);
}
