import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { openDatabase, type DatabaseHandle } from "../../src/db/db.js";
import { resolveStateDirectory, type StateEnvironment } from "../../src/core/state.js";
import { stateDatabase } from "../../src/adapters/state/shared.js";
import type { Result } from "../../src/core/result.js";

function resolved(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function assertUnitStateDirectory(environment: StateEnvironment): void {
  const protectedRoot = resolved(resolve(homedir(), ".megabrain"));
  const stateRoot = resolved(resolveStateDirectory(environment));
  if (stateRoot === protectedRoot || stateRoot.startsWith(`${protectedRoot}${sep}`)) {
    throw new Error(`unit test refused to open the real user state directory: ${stateRoot}`);
  }
}

export function guardedOpenDatabase(environment: StateEnvironment): Result<DatabaseHandle> {
  assertUnitStateDirectory(environment);
  return openDatabase(environment);
}

export function guardedStateDatabase(environment: StateEnvironment): Result<DatabaseHandle> {
  assertUnitStateDirectory(environment);
  return stateDatabase(environment);
}
