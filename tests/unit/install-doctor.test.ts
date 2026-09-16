import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeDoctor } from "../../src/cli/commands/install-doctor.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";

function processFor(values: Record<string, string>): ProcessAdapter {
  return {
    async run(command, args) {
      const key = [command, ...args].join(" ");
      if (key in values) return ok({ stdout: values[key], stderr: "", exitCode: 0 });
      if (command === "which") return ok({ stdout: `/usr/bin/${args[0]}`, stderr: "", exitCode: 0 });
      return failed(`${key} unavailable`);
    },
    async startDetached() { return failed("detached process unavailable"); },
    invocationCount: () => 0,
  };
}

function report(result: Awaited<ReturnType<typeof executeDoctor>>) {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("doctor failed");
  return JSON.parse(result.value) as { status: string; reason: string; uncertainDispatches: number };
}

describe("doctor live state", () => {
  test("reports uncertain dispatches as misconfigured", async () => {
    const state = mkdtempSync("/tmp/megabrain-doctor-dispatch-");
    mkdirSync(join(state, "dispatches", "uncertain"), { recursive: true });
    writeFileSync(join(state, "dispatches", "uncertain", "meta.json"), JSON.stringify({
      dispatchId: "uncertain",
      processState: "start-unproven",
    }));
    const result = report(await executeDoctor(["orchestration", "--json"], {
      HOME: state,
      MEGABRAIN_STATE_DIR: state,
    }, processFor({
      "orca status --json": "{}",
      "superset workspaces list --json": "{}",
    })));
    expect(result.status).toBe("misconfigured");
    expect(result.uncertainDispatches).toBe(1);
    expect(result.reason).toContain("dispatch state requires reconciliation");
  });

  test("preserves unknown browser state when an extension is behind", async () => {
    const root = mkdtempSync("/tmp/megabrain-doctor-web-");
    const state = mkdtempSync("/tmp/megabrain-doctor-state-");
    mkdirSync(join(root, "node_modules", "playwright"), { recursive: true });
    writeFileSync(join(root, "manifest.json"), "{}\n");
    writeFileSync(join(root, "node_modules", "playwright", "package.json"), JSON.stringify({ version: "1.62.1" }));
    const result = report(await executeDoctor(["simulator-web", "--json"], {
      HOME: state,
      MEGABRAIN_STATE_DIR: state,
      MEGABRAIN_PLAYWRIGHT_ROOT: root,
    }, processFor({
      [`node scripts/playwright-web.mjs doctor --root ${root}`]: JSON.stringify({
        status: "unknown",
        reason: "chromium.ublock: installed 2026.907.2003, expected 2026.914.1325",
      }),
    })));
    expect(result.status).toBe("unknown");
    expect(result.reason).toContain("chromium.ublock");
  });
});
