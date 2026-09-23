import { createProcessAdapter } from "../adapters/proc.js";
import { reconcileSkillsAtStartup, shouldReconcileSkillsAtStartup } from "../core/skill.js";
import { route } from "./router.js";

const commandArguments = process.argv.slice(2);

// WHY: skill cache repair is best-effort runtime hygiene; its stderr diagnostics are useful,
// but an unwritable plugin cache must not fail an unrelated command such as orchestrate list.
if (shouldReconcileSkillsAtStartup(commandArguments)) {
  const skillDiagnostics = await reconcileSkillsAtStartup(process.env);
  if (skillDiagnostics !== undefined) process.stderr.write(skillDiagnostics);
}

const result = await route(commandArguments, {
  environment: process.env,
  processAdapter: createProcessAdapter(),
});

if (result.kind === "ok") {
  process.stdout.write(result.value);
  if (result.stderr !== undefined && result.stderr.length > 0) process.stderr.write(result.stderr);
  if (result.exitCode !== undefined) process.exitCode = result.exitCode;
} else if (result.kind === "failed") {
  process.stderr.write(`${result.error.startsWith("megabrain ") || result.error.startsWith("megabrain:") ? result.error : `megabrain: ${result.error}`}\n`);
  process.exitCode = result.exitCode;
} else {
  process.stderr.write(`megabrain: result is unknown: ${result.reason}\n`);
  process.exitCode = 1;
}
