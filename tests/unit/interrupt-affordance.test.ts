import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { interruptKey } from "../../src/agents/index.js";

function screen(name: string): string {
  return readFileSync(new URL(`../fixtures/interrupt-screens/${name}.txt`, import.meta.url), "utf8");
}

describe("per-agent interrupt affordances", () => {
  test("uses a live running-turn hint before its agent fallback", () => {
    expect(interruptKey("codex", screen("codex-working"))).toEqual({ kind: "ok", value: "Escape" });
    expect(interruptKey("grok", "Working (2s · ctrl+c to interrupt)")).toEqual({ kind: "ok", value: "C-c" });
    expect(interruptKey("claude", "Working (2s · ctrl+c to interrupt)")).toEqual({ kind: "ok", value: "C-c" });
    expect(interruptKey("claude", screen("claude-working"))).toEqual({ kind: "ok", value: "Escape" });
  });

  test("does not interrupt an agent whose trust screen prevented a safe probe", () => {
    expect(interruptKey("agy", screen("agy-trust"))).toMatchObject({ kind: "unknown" });
  });

  test("does not mistake a Grok usage-limit screen for a running turn", () => {
    expect(interruptKey("grok", screen("grok-limit"))).toEqual({ kind: "ok", value: "C-c" });
  });
});
