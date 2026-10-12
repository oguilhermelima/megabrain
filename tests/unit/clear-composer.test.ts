import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { clearComposer } from "../../src/cli/commands/spawn-prompt.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";
import { ok } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

const original = getTmux();
afterEach(() => registerTmux(original));

// Antigravity CLI 1.3.3, measured in tmux: each C-u empties the current line, and the next one
// joins it to the line above, so a draft of n lines takes 2n - 1 presses to empty.
function agyComposer(draft: string[]): { presses: () => number } {
  const lines = [...draft];
  let presses = 0;
  const idle = readFileSync(new URL("../fixtures/composer/agy-idle.txt", import.meta.url), "utf8");
  registerTmux({
    ...original,
    capturePane: async () => ok(lines.length === 1 && lines[0] === ""
      ? idle
      : idle.replace(/^>\s*$/m, lines.map((line, index) => (index === 0 ? `> ${line}` : `  ${line}`)).join("\n"))),
    sendKey: async (_pane: string, key: string) => {
      if (key === "C-u") {
        presses += 1;
        if (lines.at(-1) !== "") lines[lines.length - 1] = "";
        else if (lines.length > 1) lines.pop();
      }
      return ok(undefined);
    },
  } as typeof original);
  return { presses: () => presses };
}

const process = {} as ProcessAdapter;

describe("clearComposer", () => {
  test("empties a multi-line Antigravity draft one line at a time", async () => {
    const composer = agyComposer(Array.from({ length: 10 }, (_, index) => `row ${index} text`));
    expect(await clearComposer({ pane: "%1", agent: "agy", process })).toEqual({ kind: "ok", value: undefined });
    expect(composer.presses()).toBe(19);
  });

  test("gives up soon once presses stop changing the screen", async () => {
    let presses = 0;
    registerTmux({
      ...original,
      capturePane: async () => ok("──────\n> stuck draft\n──────\n"),
      sendKey: async () => { presses += 1; return ok(undefined); },
    } as typeof original);
    expect((await clearComposer({ pane: "%1", agent: "agy", process })).kind).toBe("failed");
    expect(presses).toBeLessThanOrEqual(6);
  });
});
