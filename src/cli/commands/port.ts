import { type ProcessAdapter } from "../../adapters/proc.js";
import { portFree, portKill, portWho, systemPorts } from "../../core/port.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText, type UsageKey } from "../../core/usage.js";
import type { Environment } from "./context.js";

function parsePort(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port > 0 && port < 65536 ? port : null;
}

export async function executePort(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const [verb, ...rest] = args;
  const key: UsageKey = verb === "who" ? "port-who" : verb === "free" ? "port-free" : verb === "kill" ? "port-kill" : "port";
  if (args.includes("-h") || args.includes("--help")) return ok(usageText(key));
  const usage = failed(usageText(key).trimEnd(), 2);
  const json = rest.includes("--json");
  const options = rest.filter((argument) => argument !== "--json");
  const system = systemPorts(environment, processAdapter);

  if (verb === "free") {
    if (options.length !== 0 && (options.length !== 2 || options[0] !== "--from")) return usage;
    const from = options.length === 0 ? 3000 : parsePort(options[1]);
    if (from === null) return usage;
    const result = await portFree(from, system);
    if (result.kind !== "ok") return result;
    return ok(json ? `${JSON.stringify(result.value, null, 2)}\n` : `${result.value.port}\n`);
  }

  if (verb !== "who" && verb !== "kill") return usage;
  const port = options.length === 1 ? parsePort(options[0]) : null;
  if (port === null) return usage;

  if (verb === "who") {
    const result = await portWho(port, system);
    if (result.kind !== "ok") return result;
    if (json) return ok(`${JSON.stringify(result.value, null, 2)}\n`);
    if (result.value.listeners.length === 0) return ok(`Nothing is listening on port ${port}\n`);
    return ok(result.value.listeners.map((listener) => `${listener.pid}\t${listener.command}\t${listener.cwd ?? "-"}\n`).join(""));
  }

  const result = await portKill(port, system);
  if (result.kind !== "ok") return result;
  return ok(json ? `${JSON.stringify(result.value, null, 2)}\n` : `Stopped pid ${result.value.stopped.join(", ")}; port ${port} is free\n`);
}
