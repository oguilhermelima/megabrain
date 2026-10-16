import { type ProcessAdapter } from "../../adapters/proc.js";
import { createCodeServerManager } from "../../core/code-server.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";
import type { Environment } from "./context.js";

export async function executeCode(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const [action, root, ...options] = args;
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("code"));
  if (root === undefined) return failed(usageText("code").trimEnd(), 2);
  if (action === "goto") {
    const target = options[0];
    const remaining = options.slice(1);
    let line: number | undefined;
    if (remaining[0] === "--line" && remaining[1] !== undefined && /^\d+$/.test(remaining[1])) {
      line = Number(remaining[1]);
      remaining.splice(0, 2);
    }
    if (target === undefined || remaining.some((option) => option !== "--json") || remaining.filter((option) => option === "--json").length > 1) {
      return failed(usageText("code").trimEnd(), 2);
    }
    const server = await createCodeServerManager(environment, processAdapter).goto(root, target, line);
    return ok(remaining.includes("--json") ? `${JSON.stringify(server, null, 2)}\n` : `Opened ${target} in Code\n`);
  }
  if ((action !== "open" && action !== "stop") || options.some((option) => option !== "--json") || options.filter((option) => option === "--json").length > 1) {
    return failed(usageText("code").trimEnd(), 2);
  }
  const manager = createCodeServerManager(environment, processAdapter);
  if (action === "open") {
    const server = await manager.open(root);
    return ok(options.includes("--json") ? `${JSON.stringify(server, null, 2)}\n` : `Code is ready at ${server.url}\n`);
  }
  await manager.stop(root);
  return ok(options.includes("--json") ? `${JSON.stringify({ root, stopped: true }, null, 2)}\n` : `Stopped Code for ${root}\n`);
}
