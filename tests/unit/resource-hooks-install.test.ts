import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeDoctor, executeInstall } from "../../src/cli/commands/install-doctor.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";

// "which" answers for every command except the listed ones.
function fakeProcess(unavailable: readonly string[] = ["cursor", "cursor-agent"]): ProcessAdapter {
  return {
    async run(command, args) {
      if (command === "which") return unavailable.includes(args[0] ?? "") ? failed("unavailable") : ok({ stdout: `/usr/bin/${args[0]}`, stderr: "", exitCode: 0 });
      return failed(`${command} unavailable`);
    },
    async startDetached() { return failed("detached process unavailable"); },
    invocationCount: () => 0,
  };
}

function fixture(prefix: string): { environment: Record<string, string>; home: string; binary: string } {
  const home = mkdtempSync(join("/tmp", `megabrain-resource-hooks-${prefix}-`));
  const root = mkdtempSync(join("/tmp", `megabrain-resource-hooks-${prefix}-root-`));
  mkdirSync(join(root, ".build"), { recursive: true });
  const binary = join(root, ".build/megabrain");
  writeFileSync(binary, "compiled megabrain fixture\n");
  chmodSync(binary, 0o755);
  return { environment: { HOME: home, MEGABRAIN_STATE_DIR: join(home, "state"), MEGABRAIN_ROOT: root }, home, binary: realpathSync(binary) };
}

const read = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const command = (agent: string, binary: string) => `MEGABRAIN_HOOK_AGENT=${agent} '${binary}' hook pre-tool`;
const paths = (home: string) => ({
  claude: join(home, ".claude", "settings.json"),
  codex: join(home, ".codex", "hooks.json"),
  grok: join(home, ".grok", "hooks", "megabrain-resources.json"),
  agy: join(home, ".gemini", "config", "hooks.json"),
});

function preToolCommands(file: Record<string, any>): string[] {
  const groups = (file.hooks?.PreToolUse ?? []) as Array<{ hooks: Array<{ command: string }> }>;
  return groups.flatMap((group) => group.hooks.map((hook) => hook.command));
}

describe("resource hooks module", () => {
  test("installs a pre-tool hook into every agent and keeps what was there", async () => {
    const { environment, home, binary } = fixture("install");
    const files = paths(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(files.claude, JSON.stringify({ model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] } }));
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(files.agy, JSON.stringify({ "orca-status": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "orca" }] }] } }));

    const result = await executeInstall(["resource-hooks", "--yes"], environment, fakeProcess());
    expect(result.kind).toBe("ok");

    const claude = read(files.claude);
    expect(claude.model).toBe("x");
    expect(preToolCommands(claude)).toEqual(["rtk hook claude", command("claude", binary)]);
    expect(claude.hooks.PreToolUse[1].matcher).toBe("Bash");
    expect(preToolCommands(read(files.codex))).toEqual([command("codex", binary)]);
    expect(preToolCommands(read(files.grok))).toEqual([command("grok", binary)]);
    const agy = read(files.agy);
    expect(agy["orca-status"].PreToolUse[0].hooks[0].command).toBe("orca");
    expect(agy["megabrain-resources"].PreToolUse).toEqual([{ matcher: "run_command", hooks: [{ type: "command", command: command("agy", binary), timeout: 10 }] }]);
  });

  test("a second install repairs in place instead of stacking entries", async () => {
    const { environment, home } = fixture("idempotent");
    await executeInstall(["resource-hooks", "--yes"], environment, fakeProcess());
    await executeInstall(["resource-hooks", "--yes"], environment, fakeProcess());
    const files = paths(home);
    expect(preToolCommands(read(files.claude))).toHaveLength(1);
    expect(preToolCommands(read(files.codex))).toHaveLength(1);
    expect(preToolCommands(read(files.grok))).toHaveLength(1);
  });

  test("skips agents that are not installed", async () => {
    const { environment, home } = fixture("skip");
    expect((await executeInstall(["resource-hooks", "--yes"], environment, fakeProcess(["codex", "agy", "grok", "cursor", "cursor-agent"]))).kind).toBe("ok");
    const files = paths(home);
    expect(existsSync(files.claude)).toBe(true);
    expect(existsSync(files.codex)).toBe(false);
    expect(existsSync(files.grok)).toBe(false);
    expect(existsSync(files.agy)).toBe(false);
  });

  test("doctor reports an opt-in module never installed as missing, and ok after install", async () => {
    const { environment } = fixture("doctor");
    const before = await executeDoctor(["resource-hooks"], environment, fakeProcess());
    expect(before.kind === "ok" ? before.value : before.error).toContain("resource-hooks: missing");
    await executeInstall(["resource-hooks", "--yes"], environment, fakeProcess());
    const after = await executeDoctor(["resource-hooks"], environment, fakeProcess());
    expect(after.kind === "ok" ? after.value : after.error).toContain("resource-hooks: ok");
  });

  test("revert removes only megabrain's entries", async () => {
    const { environment, home } = fixture("revert");
    const files = paths(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(files.claude, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] } }));
    await executeInstall(["resource-hooks", "--yes"], environment, fakeProcess());
    expect((await executeInstall(["resource-hooks", "--revert"], environment, fakeProcess())).kind).toBe("ok");
    expect(preToolCommands(read(files.claude))).toEqual(["rtk hook claude"]);
    expect(preToolCommands(read(files.codex))).toEqual([]);
    expect(existsSync(files.grok)).toBe(false);
    expect(read(files.agy)["megabrain-resources"]).toBeUndefined();
  });
});
