import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeDoctor, executeInstall } from "../../src/cli/commands/install-doctor.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";

// "which" answers for every command except the ones listed, so only grok is installed here.
function fakeProcess(unavailable: readonly string[]): ProcessAdapter {
  return {
    async run(command, args) {
      if (command === "which") return unavailable.includes(args[0]) ? failed(`${args[0]} unavailable`) : ok({ stdout: `/usr/bin/${args[0]}`, stderr: "", exitCode: 0 });
      return failed(`${command} unavailable`);
    },
    async startDetached() {
      return failed("detached process unavailable");
    },
    invocationCount: () => 0,
  };
}

const others = ["claude", "codex", "agy", "cursor", "cursor-agent"];

function fixture(prefix: string): { home: string; binary: string; root: string } {
  const home = mkdtempSync(join("/tmp", `megabrain-grok-hooks-${prefix}-`));
  const root = mkdtempSync(join("/tmp", `megabrain-grok-hooks-${prefix}-root-`));
  mkdirSync(join(root, ".build"), { recursive: true });
  const binary = join(root, ".build/megabrain");
  writeFileSync(binary, "compiled megabrain fixture\n");
  chmodSync(binary, 0o755);
  return { home, binary, root };
}

type HookFile = { hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string }> }> } };

describe("grok orchestration hooks", () => {
  test("install writes a Stop hook into the user-level Grok hooks directory and nowhere in a project", async () => {
    const { home, binary, root } = fixture("install");
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_ROOT: root };
    const result = await executeInstall(["orchestration-hooks", "--yes"], environment, fakeProcess(others));
    expect(result.kind).toBe("ok");
    const written = JSON.parse(readFileSync(join(home, ".grok", "hooks", "megabrain.json"), "utf8")) as HookFile;
    const commands = written.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(commands).toContain(`MEGABRAIN_HOOK_AGENT=grok '${realpathSync(binary)}' hook turn-end`);
    for (const command of commands) expect(command).not.toMatch(/\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/);
    expect(existsSync(join(home, ".grok", "config.toml"))).toBe(false);
  });

  test("GROK_HOME moves the hook file with it", async () => {
    const { home, root } = fixture("grok-home");
    const grokHome = mkdtempSync(join("/tmp", "megabrain-grok-hooks-grok-home-"));
    const environment = { HOME: home, GROK_HOME: grokHome, MEGABRAIN_STATE_DIR: home, MEGABRAIN_ROOT: root };
    expect((await executeInstall(["orchestration-hooks", "--yes"], environment, fakeProcess(others))).kind).toBe("ok");
    expect(existsSync(join(grokHome, "hooks", "megabrain.json"))).toBe(true);
    expect(existsSync(join(home, ".grok"))).toBe(false);
  });

  test("a second install repairs in place instead of stacking entries", async () => {
    const { home, root } = fixture("idempotent");
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_ROOT: root };
    await executeInstall(["orchestration-hooks", "--yes"], environment, fakeProcess(others));
    await executeInstall(["orchestration-hooks", "--yes"], environment, fakeProcess(others));
    const written = JSON.parse(readFileSync(join(home, ".grok", "hooks", "megabrain.json"), "utf8")) as HookFile;
    expect(written.hooks.Stop.flatMap((group) => group.hooks)).toHaveLength(1);
  });

  test("revert removes the file install created", async () => {
    const { home, root } = fixture("revert-created");
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_ROOT: root };
    await executeInstall(["orchestration-hooks", "--yes"], environment, fakeProcess(others));
    expect(existsSync(join(home, ".grok", "hooks", "megabrain.json"))).toBe(true);
    expect((await executeInstall(["orchestration-hooks", "--revert"], environment, fakeProcess(others))).kind).toBe("ok");
    expect(existsSync(join(home, ".grok", "hooks", "megabrain.json"))).toBe(false);
  });

  test("revert restores a hook file that existed before install", async () => {
    const { home, root } = fixture("revert-existing");
    mkdirSync(join(home, ".grok", "hooks"), { recursive: true });
    const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
    writeFileSync(join(home, ".grok", "hooks", "megabrain.json"), JSON.stringify(original));
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_ROOT: root };
    await executeInstall(["orchestration-hooks", "--yes"], environment, fakeProcess(others));
    await executeInstall(["orchestration-hooks", "--revert"], environment, fakeProcess(others));
    expect(JSON.parse(readFileSync(join(home, ".grok", "hooks", "megabrain.json"), "utf8"))).toEqual(original);
  });

  test("doctor reports the grok entry missing before install and present after", async () => {
    const { home, root } = fixture("doctor");
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_ROOT: root };
    const before = await executeDoctor(["orchestration-hooks"], environment, fakeProcess(others));
    expect(JSON.stringify(before)).toContain("grok: entry-missing (config absent)");
    await executeInstall(["orchestration-hooks", "--yes"], environment, fakeProcess(others));
    const after = await executeDoctor(["orchestration-hooks"], environment, fakeProcess(others));
    expect(JSON.stringify(after)).toContain("grok: entry-present");
  });

  test("a grok that is not installed is skipped without creating a directory", async () => {
    const { home, root } = fixture("absent");
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_ROOT: root };
    await executeInstall(["orchestration-hooks", "--yes"], environment, fakeProcess([...others, "grok"]));
    expect(existsSync(join(home, ".grok"))).toBe(false);
  });
});
