import { createProcessAdapter } from "../adapters/proc.js";
import { route } from "./router.js";

const result = await route(process.argv.slice(2), {
  environment: process.env,
  processAdapter: createProcessAdapter(),
});

if (result.kind === "ok") {
  process.stdout.write(result.value);
} else if (result.kind === "failed") {
  process.stderr.write(`${result.error.startsWith("megabrain ") ? result.error : `megabrain: ${result.error}`}\n`);
  process.exitCode = result.exitCode;
} else {
  process.stderr.write(`megabrain: result is unknown: ${result.reason}\n`);
  process.exitCode = 1;
}
