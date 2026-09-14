import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { parseTv, tvConnectOutput, tvUsage } from "../../core/tv.js";
import { failed, ok, type Result } from "../../core/result.js";

export async function executeTv(args: readonly string[], processAdapter: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  if (args[0] === "connect" && (args[1] === "-h" || args[1] === "--help")) return ok(tvUsage("connect"));
  if (args[0] === "disconnect" && (args[1] === "-h" || args[1] === "--help")) return ok(tvUsage("disconnect"));
  const request = parseTv(args); if (request.kind !== "ok") return request;
  if (request.value.operation === "help") return ok(tvUsage());
  const doctor = await processAdapter.run("adb", ["version"]);
  if (doctor.kind !== "ok") return failed("adb version failed");
  if (request.value.operation === "connect") {
    const serial = `${request.value.ip}:${request.value.port}`;
    await processAdapter.run("adb", ["connect", serial]);
    const devices = await processAdapter.run("adb", ["devices"]);
    const state = devices.kind === "ok" ? devices.value.stdout.split("\n").find((line) => line.startsWith(`${serial} `))?.split(/\s+/)[1] ?? "" : "";
    return tvConnectOutput(serial, state);
  }
  const result = request.value.ip === undefined ? await processAdapter.run("adb", ["disconnect"]) : await processAdapter.run("adb", ["disconnect", request.value.ip]);
  return result.kind === "ok" ? ok(result.value.stdout) : failed(result.error, result.exitCode);
}
