import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMachineInstall } from "../../src/cli/commands/install-machine.js";
import { SetupCancelled, type MachinePrompter } from "../../src/cli/commands/install-ui.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function environment(): { HOME: string; MEGABRAIN_STATE_DIR: string } {
  const root = mkdtempSync(join(tmpdir(), "megabrain-install-ui-"));
  temporaryDirectories.push(root);
  return { HOME: join(root, "home"), MEGABRAIN_STATE_DIR: join(root, "state") };
}

function processAdapter(available: readonly string[]): ProcessAdapter {
  return {
    async run(command, args) {
      if (command === "which" && available.includes(args[0] ?? "")) return ok({ stdout: `/bin/${args[0]}`, stderr: "", exitCode: 0 });
      return failed(`${command} unavailable`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
}

type Answers = Partial<{ agents: string[]; skill: "none" | "global" | "project"; tmux: "yes" | "no"; modules: string[]; review: boolean; cancelAt: string }>;

function scriptedPrompter(answers: Answers, seen: string[]): () => MachinePrompter {
  const answer = <T>(step: string, value: T): T => {
    seen.push(step);
    if (answers.cancelAt === step) throw new SetupCancelled();
    return value;
  };
  return () => ({
    intro: () => { seen.push("intro"); },
    agents: async (choices, initial) => answer("agents", (answers.agents ?? [...initial]).filter((agent) => choices.some((choice) => choice.agent === agent && choice.installed))) as never,
    skill: async (initial) => answer("skill", answers.skill ?? initial),
    tmux: async (initial) => answer("tmux", answers.tmux ?? (initial ? "yes" : "no")),
    modules: async (choices) => answer("modules", answers.modules ?? choices.filter((choice) => choice.selectedByDefault).map((choice) => choice.module)),
    confirm: async () => answer("confirm", true),
    review: async () => answer("review", answers.review ?? true),
    step: (label) => { seen.push(`step:${label}`); return { done: () => undefined, fail: () => undefined }; },
    info: () => undefined,
    warn: (message) => { seen.push(`warn:${message}`); },
    outro: (message) => { seen.push(`outro:${message}`); },
  });
}

describe("interactive machine install", () => {
  test("asks each question in order, applies the answers, and prints nothing on the plain channel", async () => {
    const env = environment();
    const seen: string[] = [];
    const installed: string[] = [];
    const result = await runMachineInstall([], env, processAdapter(["claude", "codex", "tmux"]), async (module) => { installed.push(module); return ok("installed"); },
      true, async () => ok("reverted"), scriptedPrompter({ agents: ["codex"], skill: "global", modules: ["orchestration-hooks"] }, seen));

    expect(result).toEqual(ok(""));
    expect(seen.filter((step) => !step.startsWith("step:") && !step.startsWith("outro:"))).toEqual(["intro", "agents", "skill", "tmux", "modules", "review"]);
    expect(installed).toEqual(["tmux-runtime", "orchestration-hooks"]);
    expect(existsSync(join(env.HOME, ".codex", "skills", "megabrain", "SKILL.md"))).toBe(true);
    expect(existsSync(join(env.HOME, ".claude", "skills", "megabrain", "SKILL.md"))).toBe(false);
    const state = JSON.parse(readFileSync(join(env.MEGABRAIN_STATE_DIR, "state.json"), "utf8"));
    expect(state.machineInstall).toMatchObject({ agents: ["codex"], skill: "global", tmux: "yes" });
  });

  test("modules whose prerequisite is missing are offered as unavailable and never preselected", async () => {
    const env = environment();
    let offered: readonly { module: string; selectedByDefault: boolean; unavailable?: boolean; skippedReason: string | undefined }[] = [];
    const prompter = scriptedPrompter({ agents: [], modules: [] }, []);
    await runMachineInstall([], env, processAdapter(["claude", "tmux"]), async () => ok("installed"), true, async () => ok("reverted"), () => ({
      ...prompter(),
      modules: async (choices) => { offered = choices; return []; },
    }));

    const adb = offered.find((choice) => choice.module === "tv-adb");
    expect(adb).toMatchObject({ unavailable: true, selectedByDefault: false, skippedReason: "needs adb from Android platform-tools" });
    expect(offered.find((choice) => choice.module === "worktree")).toMatchObject({ unavailable: true, skippedReason: "needs Orca and Superset" });
    expect(offered.find((choice) => choice.module === "orchestration")).toMatchObject({ unavailable: false, selectedByDefault: true });
  });

  test("declining the review changes nothing", async () => {
    const env = environment();
    const installed: string[] = [];
    const result = await runMachineInstall([], env, processAdapter(["claude"]), async (module) => { installed.push(module); return ok("installed"); },
      true, async () => ok("reverted"), scriptedPrompter({ review: false }, []));

    expect(result).toEqual(ok(""));
    expect(installed).toEqual([]);
    expect(existsSync(join(env.MEGABRAIN_STATE_DIR, "state.json"))).toBe(false);
    expect(existsSync(join(env.HOME, ".claude", "skills"))).toBe(false);
  });

  test("cancelling exits 130 without an error line and without writing anything", async () => {
    const env = environment();
    const result = await runMachineInstall([], env, processAdapter(["claude"]), async () => ok("installed"),
      true, async () => ok("reverted"), scriptedPrompter({ cancelAt: "skill" }, []));

    expect(result).toEqual(ok("", 130));
    expect(existsSync(join(env.MEGABRAIN_STATE_DIR, "state.json"))).toBe(false);
  });

  test("a rerun starts from the previous answers and ends as a no-op", async () => {
    const env = environment();
    const adapter = processAdapter(["claude", "codex"]);
    await runMachineInstall([], env, adapter, async () => ok("installed"), true, async () => ok("reverted"),
      scriptedPrompter({ agents: ["claude"], skill: "global", modules: [] }, []));

    const seen: string[] = [];
    const result = await runMachineInstall([], env, adapter, async () => ok("installed"), true, async () => ok("reverted"), scriptedPrompter({}, seen));

    expect(result).toEqual(ok(""));
    expect(seen).toContain("outro:Everything is already set up. Nothing to change.");
  });

  test("--yes never opens the interactive prompts, even in a terminal", async () => {
    const env = environment();
    const seen: string[] = [];
    const result = await runMachineInstall(["--yes", "--agents", "none"], env, processAdapter([]), async () => ok("installed"),
      true, async () => ok("reverted"), scriptedPrompter({}, seen));

    expect(seen).toEqual([]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value).toContain("machine install summary");
  });
});
