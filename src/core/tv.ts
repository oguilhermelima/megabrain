import { failed, ok, type Result } from "./result.js";
import { usageGroup, usageText } from "./usage.js";

export type TvRequest = { readonly operation: "connect" | "disconnect"; readonly ip?: string; readonly port: string } | { readonly operation: "help" };

export function tvUsage(operation?: "connect" | "disconnect"): string {
  if (operation === "connect") return usageText("tv-connect");
  if (operation === "disconnect") return usageText("tv-disconnect");
  return usageGroup(["tv-connect", "tv-disconnect"]);
}

export function parseTv(args: readonly string[]): Result<TvRequest> {
  const [operation, value, ...rest] = args;
  if (operation === "-h" || operation === "--help" || operation === undefined || operation === "") return ok({ operation: "help" });
  if (operation !== "connect" && operation !== "disconnect") return failed(`unknown tv command: ${operation}`, 2);
  if (rest.some((arg) => arg !== "--port" && !/^[0-9]+$/.test(arg))) return failed(`unknown tv ${operation} option: ${rest.find((arg) => arg !== "--port") ?? ""}`, 2);
  if (operation === "connect") {
    if (value === "-h" || value === "--help") return ok({ operation: "help" });
    if (value === undefined || value.length === 0) return failed(tvUsage(), 2);
    const portIndex = rest.indexOf("--port");
    return ok({ operation, ip: value, port: portIndex >= 0 ? rest[portIndex + 1] ?? "" : "5555" });
  }
  if (value === "-h" || value === "--help") return ok({ operation: "help" });
  if (rest.length > 0 || (value !== undefined && value.length === 0)) return failed(tvUsage(), 2);
  return ok({ operation, ip: value, port: "5555" });
}
export function tvConnectOutput(serial: string, state: string): Result<string> {
  return state === "device" ? ok(`tv: connected (${serial})\n`) : failed(`tv: not ready (${serial}: ${state || "not listed"})`, 1);
}
