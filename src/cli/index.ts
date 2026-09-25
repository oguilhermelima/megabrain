#!/usr/bin/env node

import { createProcessAdapter } from "../adapters/proc.js";
import { reconcileSkillsAtStartup, shouldReconcileSkillsAtStartup } from "../core/skill.js";
import { route } from "./router.js";
import { ROOT_USAGE } from "../core/usage.js";

const commandArguments = process.argv.slice(2);

// WHY: skill cache repair is best-effort runtime hygiene; its stderr diagnostics are useful,
// but an unwritable plugin cache must not fail an unrelated command such as orchestrate list.
let skillDiagnostics: string | undefined;
if (shouldReconcileSkillsAtStartup(commandArguments)) {
  skillDiagnostics = await reconcileSkillsAtStartup(process.env);
}

const result = await route(commandArguments, {
  environment: process.env,
  processAdapter: createProcessAdapter(),
});

const firstArgument = commandArguments[0] ?? "";
const isRootOutput =
  commandArguments.length === 0 ||
  ["help", "-h", "--help", "version", "-V", "--version"].includes(firstArgument);
const isUnknownCommand = result.kind === "failed" && result.error.startsWith("unknown command: ");
if (skillDiagnostics !== undefined && !isRootOutput && !isUnknownCommand) {
  process.stderr.write(skillDiagnostics);
}

if (result.kind === "ok") {
  process.stdout.write(result.value);
  if (result.stderr !== undefined && result.stderr.length > 0) process.stderr.write(result.stderr);
  if (result.exitCode !== undefined) process.exitCode = result.exitCode;
} else if (result.kind === "failed") {
  process.stderr.write(`${result.error.startsWith("megabrain ") || result.error.startsWith("megabrain:") ? result.error : `megabrain: ${result.error}`}\n`);
  if (result.error.startsWith("unknown command: ")) process.stderr.write(ROOT_USAGE);
  process.exitCode = result.exitCode;
} else {
  process.stderr.write(`megabrain: result is unknown: ${result.reason}\n`);
  process.exitCode = 1;
}
