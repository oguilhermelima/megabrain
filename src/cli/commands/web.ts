import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { planWeb, type WebPlan } from "../../core/web.js";

export type WebEnvironment = Readonly<Record<string, string | undefined>>;

function usage(): string {
  return "Usage: megabrain web [--device SLUG|--category NAME|--viewport WxH] ...\n";
}

function helpFor(args: readonly string[]): string {
  const action = args[1]?.startsWith("-") === true ? undefined : args[1];
  const key = args[0] === "session" ? "web-session" : args[0] === "viewport" ? (action === undefined ? "web-viewport" : `web-viewport-${action}`) : args[0] === "userscript" ? (action === undefined ? "web-userscript" : `web-userscript-${action}`) : `web-${args[0] ?? ""}`;
  const lines: Readonly<Record<string, string>> = {
    "web-viewport": "Usage: megabrain web viewport set|show|devices ...\n",
    "web-userscript": "Usage: megabrain web userscript install|list|remove ...\n",
    "web-capture": "Usage: megabrain web capture --url URL --screen NAME [--settle default|scroll] [--scroll-timeout MS] [options]\n",
    "web-measure": "Usage: megabrain web measure --url URL --screen NAME [--settle default|scroll] [--scroll-timeout MS] [options]\n",
    "web-session": "Usage: megabrain web session save --url URL --output FILE [options]\n",
    "web-viewport-set": "Usage: megabrain web viewport set [--browser chromium|firefox|both] [--viewport WxH|--device SLUG|--category NAME|--width W --height H] [--orientation portrait|landscape]\n",
    "web-viewport-show": "Usage: megabrain web viewport show [--browser chromium|firefox|both]\n",
    "web-devices": "Usage: megabrain web devices list [FILTER] [--orientation portrait|landscape|all] | add SLUG --viewport WxH --source SOURCE [options] | remove SLUG\n",
    "web-userscript-install": "Usage: megabrain web userscript install <file.user.js> [--viewport WxH|--device SLUG|--category NAME] [--orientation portrait|landscape]\n",
    "web-userscript-list": "Usage: megabrain web userscript list\n",
    "web-userscript-remove": "Usage: megabrain web userscript remove <file.user.js> [--viewport WxH|--device SLUG|--category NAME] [--orientation portrait|landscape]\n",
  };
  return lines[key] ?? usage();
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
  const root = environment.MEGABRAIN_ROOT ?? ".";
  const playwrightRoot = environment.MEGABRAIN_PLAYWRIGHT_ROOT ?? `${environment.HOME ?? ""}/.megabrain/playwright`;
  const userscriptsRoot = `${environment.HOME ?? ""}/.megabrain/userscripts`;
  const invocation = [root.endsWith("/") ? `${root}scripts/playwright-web.mjs` : `${root}/scripts/playwright-web.mjs`, ...scriptArgs(plan, playwrightRoot, userscriptsRoot)];
  const result = await processAdapter.run("node", invocation);
  if (result.kind !== "ok") return result;
  return ok(result.value.stdout);
}
