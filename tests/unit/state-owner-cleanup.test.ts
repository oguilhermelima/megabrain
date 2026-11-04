import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTrackedStateOwners } from "../helpers/state-owner-cleanup.js";

test("owner cleanup accepts macOS temporary paths through /private", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "mb-owner-cleanup-"));
  if (!stateDirectory.startsWith("/var/")) {
    rmSync(stateDirectory, { recursive: true, force: true });
    return;
  }

  const privatePath = stateDirectory.replace("/var/", "/private/var/");
  try {
    await expect(cleanupTrackedStateOwners([privatePath])).resolves.toBeUndefined();
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
