import { guardedStateDatabase } from "./state-db-guard.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMachineInstall } from "../../src/cli/commands/install-machine.js";
import { executeInstall } from "../../src/cli/commands/install-doctor.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { getInstallState, putInstallModule } from "../../src/adapters/state-db.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function machine(): { HOME: string; MEGABRAIN_STATE_DIR: string } {
  const root = mkdtempSync(join(tmpdir(), "megabrain-install-json-"));
  temporaryDirectories.push(root);
  return { HOME: join(root, "home"), MEGABRAIN_STATE_DIR: join(root, "state") };
}

function processAdapter(available: readonly string[] = []): ProcessAdapter {
  return {
    async run(command, args) {
      if (command === "which" && available.includes(args[0] ?? "")) return ok({ stdout: `/bin/${args[0]}`, stderr: "", exitCode: 0 });
      return failed(`${command} unavailable`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
}

function installState(environment: { MEGABRAIN_STATE_DIR: string }): Record<string, any> {
  const opened = guardedStateDatabase(environment);
  if (opened.kind !== "ok") throw new Error(opened.error);
  const loaded = getInstallState(opened.value);
  if (loaded.kind !== "ok") throw new Error(loaded.error);
  return loaded.value;
}

type Event = Record<string, any>;

async function runJson(
  args: readonly string[],
  environment: { HOME: string; MEGABRAIN_STATE_DIR: string },
  adapter: ProcessAdapter,
  installModule: (module: string) => Promise<Result<string>> = async () => ok("installed"),
  revert: () => Promise<Result<string>> = async () => ok("reverted"),
): Promise<{ result: Result<string>; events: Event[]; raw: string }> {
  let raw = "";
  const result = await runMachineInstall(
    args, environment, adapter, installModule, false, revert,
    () => { throw new Error("the terminal prompter must not run in JSON mode"); },
    (text) => { raw += text; },
  );
  const events = raw.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Event);
  return { result, events, raw };
}

describe("install --plan --json", () => {
  test("describes the environment, the choices and their defaults without installing", async () => {
    const environment = machine();
    let installs = 0;
    const result = await runMachineInstall(
      ["--plan", "--json"], environment, processAdapter(["tmux", "claude"]),
      async () => { installs += 1; return ok("installed"); }, false,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const plan = JSON.parse(result.value);
    expect(typeof plan.version).toBe("string");
    expect(plan.hosts).toEqual({ orca: false, superset: false, tmux: true });
    expect(plan.agents).toContainEqual(expect.objectContaining({ agent: "claude", label: "Claude Code", installed: true }));
    expect(plan.agents).toContainEqual(expect.objectContaining({ agent: "codex", installed: false }));
    const byModule = Object.fromEntries((plan.modules as Event[]).map((entry) => [entry.module, entry]));
    expect(byModule["tmux-runtime"]).toBeUndefined();
    expect(byModule.orchestration).toMatchObject({ label: "Orchestration", group: "Agents", selectedByDefault: true, unavailable: false });
    expect(byModule["resource-hooks"]).toMatchObject({ selectedByDefault: false, unavailable: false });
    expect(typeof byModule["resource-hooks"].hint).toBe("string");
    expect(byModule.worktree).toMatchObject({ unavailable: true, reason: "needs Orca and Superset" });
    expect(plan.defaults).toEqual({ agents: ["claude"], skill: "global", tmux: "yes", modules: ["orchestration", "orchestration-hooks"] });
    expect(plan.previous).toBeNull();
    expect(installs).toBe(0);
    expect(installState(environment).machineInstall).toBeUndefined();
  });

  test("marks orchestration unavailable when nothing can open a child", async () => {
    const result = await runMachineInstall(["--plan", "--json"], machine(), processAdapter(), async () => ok("installed"), false);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const plan = JSON.parse(result.value);
    const orchestration = (plan.modules as Event[]).find((entry) => entry.module === "orchestration");
    expect(orchestration).toMatchObject({ unavailable: true, reason: "needs Orca, Superset or tmux", selectedByDefault: false });
    expect(plan.defaults.tmux).toBe("no");
  });

  test("starts from what this machine chose last time", async () => {
    const environment = machine();
    const opened = guardedStateDatabase(environment);
    if (opened.kind !== "ok") throw new Error(opened.error);
    putInstallModule(opened.value, "machineInstall", {
      agents: ["codex"], skill: "project", tmux: "yes", requestedModules: ["orchestration-hooks"], modules: ["orchestration-hooks"], version: "0.0.1",
    });
    const result = await runMachineInstall(["--plan", "--json"], environment, processAdapter(["tmux", "claude"]), async () => ok("installed"), false);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const plan = JSON.parse(result.value);
    expect(plan.previous).toEqual({ agents: ["codex"], skill: "project", tmux: "yes", modules: ["orchestration-hooks"] });
    expect(plan.defaults).toMatchObject({ agents: ["codex"], skill: "project", modules: ["orchestration-hooks"] });
  });

  test("refuses --plan without --json", async () => {
    const result = await runMachineInstall(["--plan"], machine(), processAdapter(), async () => ok("installed"), false);
    expect(result).toMatchObject({ kind: "failed", exitCode: 2 });
  });

  test("refuses --plan combined with a selection", async () => {
    const result = await runMachineInstall(["--plan", "--json", "--agents", "claude"], machine(), processAdapter(), async () => ok("installed"), false);
    expect(result).toMatchObject({ kind: "failed", exitCode: 2 });
  });

  test("is reached through the install command", async () => {
    const result = await executeInstall(["--plan", "--json"], machine(), processAdapter(["tmux"]));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(JSON.parse(result.value).hosts.tmux).toBe(true);
  });
});

describe("install --json", () => {
  test("streams one JSON event per line and ends with the result", async () => {
    const environment = machine();
    const { result, events, raw } = await runJson(
      ["--json", "--agents", "none", "--modules", "orchestration-hooks,worktree", "--tmux", "no"], environment, processAdapter(),
    );
    expect(result).toMatchObject({ kind: "ok", value: "" });
    expect(raw.endsWith("\n")).toBe(true);
    expect(events[0]).toMatchObject({ type: "intro", hosts: { orca: false, superset: false, tmux: false } });
    expect(events).toContainEqual({ type: "step", module: "orchestration-hooks", label: expect.any(String), state: "start" });
    expect(events).toContainEqual(expect.objectContaining({ type: "step", module: "worktree", state: "done" }));
    expect(events.at(-1)).toEqual({ type: "result", ok: true, message: expect.any(String), configured: ["orchestration-hooks", "worktree"], failed: [] });
    expect(installState(environment).machineInstall.modules).toEqual(["orchestration-hooks", "worktree"]);
  });

  test("reports a failed module in its step and in the result", async () => {
    const { result, events } = await runJson(
      ["--json", "--agents", "none", "--modules", "orchestration-hooks,worktree", "--tmux", "no"], machine(), processAdapter(),
      async (module) => module === "worktree" ? failed("worktree: orca CLI is not on PATH") : ok("installed"),
    );
    expect(result).toMatchObject({ kind: "ok", exitCode: 1 });
    expect(events).toContainEqual(expect.objectContaining({ type: "step", module: "worktree", state: "fail", message: expect.stringContaining("orca CLI is not on PATH") }));
    expect(events.at(-1)).toMatchObject({ type: "result", ok: false, configured: ["orchestration-hooks"], failed: [{ module: "worktree", message: expect.stringContaining("orca CLI is not on PATH") }] });
  });

  test("reports the skill as a step instead of a plain line", async () => {
    const { events, raw } = await runJson(
      ["--json", "--agents", "claude", "--skill", "global", "--modules", "orchestration-hooks", "--tmux", "no"], machine(), processAdapter(["claude"]),
    );
    expect(raw).not.toContain("skill installed at");
    expect(events).toContainEqual(expect.objectContaining({ type: "step", label: "Installing the megabrain skill", state: "done" }));
  });

  test("an unchanged rerun still ends with the configured modules", async () => {
    const environment = machine();
    const args = ["--json", "--agents", "none", "--modules", "orchestration-hooks", "--tmux", "no"];
    await runJson(args, environment, processAdapter());
    const { events } = await runJson(args, environment, processAdapter(), async () => { throw new Error("must not reinstall"); });
    expect(events.at(-1)).toMatchObject({ type: "result", ok: true, configured: ["orchestration-hooks"], failed: [] });
  });

  test("never confirms a removal on its own", async () => {
    const environment = machine();
    const opened = guardedStateDatabase(environment);
    if (opened.kind !== "ok") throw new Error(opened.error);
    putInstallModule(opened.value, "tmux-runtime", { installed: true });
    let reverts = 0;
    const revert = async () => { reverts += 1; return ok("reverted"); };
    const declined = await runJson(["--json", "--agents", "none", "--modules", "orchestration-hooks", "--tmux", "no"], environment, processAdapter(["tmux"]), undefined, revert);
    expect(reverts).toBe(0);
    expect(declined.events).toContainEqual(expect.objectContaining({ type: "confirm", answer: false, message: expect.stringContaining("tmux") }));
    expect(declined.events.at(-1)).toMatchObject({ type: "result" });
    const accepted = await runJson(["--json", "--yes", "--agents", "none", "--modules", "orchestration-hooks", "--tmux", "no"], environment, processAdapter(["tmux"]), undefined, revert);
    expect(reverts).toBe(1);
    expect(accepted.events.at(-1)).toMatchObject({ type: "result", ok: true });
  });

  test("still needs --yes or an explicit selection", async () => {
    const { result } = await runJson(["--json"], machine(), processAdapter());
    expect(result.kind).toBe("failed");
  });
});

describe("install <module> --json", () => {
  test("reports a revert as one JSON object", async () => {
    const result = await executeInstall(["resource-hooks", "--revert", "--json"], machine(), processAdapter());
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(JSON.parse(result.value)).toEqual({ module: "resource-hooks", action: "revert", ok: true, message: expect.any(String) });
  });

  test("reports a refused revert as one JSON object with its exit code", async () => {
    const result = await executeInstall(["worktree", "--revert", "--json"], machine(), processAdapter());
    expect(result).toMatchObject({ exitCode: 2 });
    const text = result.kind === "ok" ? result.value : result.kind === "failed" ? result.error : "";
    expect(JSON.parse(text)).toEqual({ module: "worktree", action: "revert", ok: false, message: "module cannot be reverted: worktree" });
  });
});
