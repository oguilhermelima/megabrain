import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { executeMaestro } from "../../src/cli/commands/maestro.js";

const adapter = createProcessAdapter();
const fixtures = resolve(import.meta.dir, "../fixtures/maestro");
const UDID = "401F3DA8-E4C1-48B7-9BB9-2C8416115E1A";
const roots: string[] = [];

afterEach(() => { while (roots.length > 0) rmSync(roots.pop() ?? "", { recursive: true, force: true }); });

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "mb-maestro-run-"));
  roots.push(root);
  const home = join(root, "home");
  const worktree = join(root, "work");
  mkdirSync(join(home, ".maestro", "bin"), { recursive: true });
  mkdirSync(join(home, ".maestro", "lib"), { recursive: true });
  cpSync(join(fixtures, "fake-maestro"), join(home, ".maestro", "bin", "maestro"));
  chmodSync(join(home, ".maestro", "bin", "maestro"), 0o755);
  cpSync(join(fixtures, "run-passed.txt"), join(home, ".maestro", "bin", "run-passed.txt"));
  cpSync(join(fixtures, "run-failed.txt"), join(home, ".maestro", "bin", "run-failed.txt"));
  cpSync(join(fixtures, "privacy-failed.txt"), join(home, ".maestro", "bin", "privacy-failed.txt"));
  cpSync(join(fixtures, "artifacts"), join(home, ".maestro", "bin", "artifacts"), { recursive: true });
  const jdk = join(root, "jdk");
  mkdirSync(join(jdk, "bin"), { recursive: true });
  writeFileSync(join(jdk, "bin", "java"), "#!/bin/sh\necho 'openjdk version \"17.0.9\"' >&2\n");
  chmodSync(join(jdk, "bin", "java"), 0o755);
  writeFileSync(join(home, ".maestro", "megabrain-module.json"), JSON.stringify({ version: "2.11.0", javaHome: jdk, installedAt: "2026-10-17T00:00:00Z" }));
  mkdirSync(join(worktree, ".maestro", "auth"), { recursive: true });
  mkdirSync(join(worktree, "maestro"), { recursive: true });
  writeFileSync(join(worktree, ".maestro", "prefs.yaml"), "appId: com.apple.Preferences\nname: Preferences opens\n---\n- launchApp\n");
  writeFileSync(join(worktree, ".maestro", "auth", "login.yaml"), "appId: com.example.app\n---\n- launchApp\n");
  writeFileSync(join(worktree, ".maestro", "config.yaml"), "flows:\n  - '*'\n");
  writeFileSync(join(worktree, "maestro", "home.yml"), "appId: com.example.app\nname: Home\n---\n- launchApp\n");
  const environment: Record<string, string | undefined> = {
    PATH: process.env.PATH, HOME: home, MEGABRAIN_STATE_DIR: join(root, "state"), JAVA_HOME: jdk,
    MEGABRAIN_MAESTRO_INSTALLER: "unused", FAKE_MAESTRO_ARGS: join(root, "args.txt"), FAKE_MAESTRO_INVOCATIONS: join(root, "invocations"),
  };
  return { root, home, worktree, environment };
}

const lines = (value: string): Array<Record<string, unknown>> => value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

describe("maestro flows", () => {
  test("lists flows from .maestro and maestro with name and app id", async () => {
    const { worktree, environment } = sandbox();
    const result = await executeMaestro(["flows", "--worktree", worktree, "--json"], environment, adapter);
    expect(result.kind).toBe("ok");
    const flows = JSON.parse(result.kind === "ok" ? result.value : "[]") as Array<{ path: string; name: string; appId: string }>;
    expect(flows.map((flow) => flow.path)).toEqual([".maestro/auth/login.yaml", ".maestro/prefs.yaml", "maestro/home.yml"]);
    expect(flows.map((flow) => flow.name)).toEqual(["login", "Preferences opens", "Home"]);
    expect(flows.map((flow) => flow.appId)).toEqual(["com.example.app", "com.apple.Preferences", "com.example.app"]);
  });

  test("a worktree without flows lists none", async () => {
    const { root, environment } = sandbox();
    const empty = join(root, "empty");
    mkdirSync(empty);
    const result = await executeMaestro(["flows", "--worktree", empty, "--json"], environment, adapter);
    expect(result.kind === "ok" ? JSON.parse(result.value) : null).toEqual([]);
  });
});

describe("maestro run", () => {
  test("runs a url flow on Maestro's own headless Chromium with the web platform argv", async () => {
    const { worktree, environment, root } = sandbox();
    writeFileSync(join(worktree, ".maestro", "web.yaml"), "url: data:text/html,<h1>hi</h1>\n---\n- assertVisible: hi\n");
    const result = await executeMaestro(["run", ".maestro/web.yaml", "--worktree", worktree, "--json"], environment, adapter);
    expect(result.kind).toBe("ok");
    const argv = readFileSync(join(root, "args.txt"), "utf8");
    expect(argv).toContain("--headless");
    expect(argv).toContain("--platform web");
    expect(argv).not.toContain("--udid");
  });

  test("streams one event per step and stores artifacts per worktree and run", async () => {
    const { root, worktree, environment } = sandbox();
    const result = await executeMaestro(["run", ".maestro/prefs.yaml", "--worktree", worktree, "--device", UDID, "--json"], environment, adapter);
    expect(result.kind).toBe("ok");
    const events = lines(result.kind === "ok" ? result.value : "");
    const steps = events.filter((event) => event.type === "step");
    expect(steps.map((step) => [step.index, step.status])).toEqual([[1, "passed"], [2, "passed"], [3, "passed"]]);
    expect(steps.map((step) => step.command)).toEqual([
      'Launch app "com.apple.Preferences"',
      "Assert that id: com.apple.settings.sidebar.collectionView is visible",
      "Take screenshot prefs-home",
    ]);
    expect(typeof steps[0]?.durationMs).toBe("number");
    expect(String(steps[2]?.screenshot)).toContain(join(root, "state", "maestro"));
    expect(existsSync(String(steps[2]?.screenshot))).toBe(true);
    const end = events.find((event) => event.type === "run");
    expect(end).toMatchObject({ state: "passed", exitCode: 0, device: UDID });
    expect(readFileSync(join(root, "args.txt"), "utf8")).toContain(`--udid ${UDID}`);
  });

  test("a failing step is reported with its error and the run fails", async () => {
    const { worktree, environment } = sandbox();
    const result = await executeMaestro(["run", ".maestro/prefs.yaml", "--worktree", worktree, "--device", UDID, "--json"], { ...environment, FAKE_MAESTRO_OUTPUT: "run-failed.txt", FAKE_MAESTRO_EXIT: "1" }, adapter);
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" ? result.exitCode : 0).toBe(1);
    const events = lines(result.kind === "ok" ? result.value : "");
    const failedStep = events.find((event) => event.type === "step" && event.status === "failed");
    expect(failedStep?.index).toBe(2);
    expect(String(failedStep?.error)).toContain('Assertion is false: "General" is visible');
    expect(events.find((event) => event.type === "run")).toMatchObject({ state: "failed", exitCode: 1 });
  });

  test("preserves non-ASCII flow bytes when invoking Maestro", async () => {
    const { worktree, environment, root } = sandbox();
    const flow = join(worktree, ".maestro", "acentos.yaml");
    const contents = "appId: com.example.app\n---\n- inputText: " + JSON.stringify("ação, café, 東京") + "\n";
    writeFileSync(flow, contents, "utf8");
    const result = await executeMaestro(["run", ".maestro/acentos.yaml", "--worktree", worktree, "--device", UDID, "--json"], { ...environment, FAKE_MAESTRO_HASH: "1" }, adapter);
    expect(result.kind).toBe("ok");
    expect(readFileSync(join(root, "args.txt"), "utf8")).toContain(join(worktree, ".maestro", "acentos.yaml"));
    expect(readFileSync(join(root, "echoed-flow.sha256"), "utf8").trim()).toBe(createHash("sha256").update(readFileSync(flow)).digest("hex"));
  });

  test("rejects decimal percentage points before starting Maestro with source location", async () => {
    const { worktree, environment, root } = sandbox();
    writeFileSync(join(worktree, ".maestro", "prefs.yaml"), 'appId: com.example.app\n---\n- tapOn:\n    point: "43%,90.6%"\n');
    const result = await executeMaestro(["run", ".maestro/prefs.yaml", "--worktree", worktree, "--device", UDID, "--json"], environment, adapter);
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("prefs.yaml:4");
    expect(result.kind === "failed" ? result.error : "").toContain("90.6%");
    expect(existsSync(join(root, "args.txt"))).toBe(false);
  });

  test("copies Maestro's run log into artifacts and reports its path", async () => {
    const { worktree, environment } = sandbox();
    const result = await executeMaestro(["run", ".maestro/prefs.yaml", "--worktree", worktree, "--device", UDID, "--json"], { ...environment, FAKE_MAESTRO_LOG: "diagnostic log" }, adapter);
    expect(result.kind).toBe("ok");
    const end = lines(result.kind === "ok" ? result.value : "").find((event) => event.type === "run");
    expect(typeof end?.maestroLog).toBe("string");
    expect(readFileSync(String(end?.maestroLog), "utf8")).toBe("diagnostic log");
  });

  test("retries only an XCUITest driver startup failure and reports its reason", async () => {
    const { worktree, environment, root } = sandbox();
    const result = await executeMaestro(["run", ".maestro/prefs.yaml", "--worktree", worktree, "--device", UDID, "--json"], { ...environment, FAKE_MAESTRO_DRIVER_FAIL_ONCE: "1" }, adapter);
    expect(result.kind).toBe("ok");
    expect(readFileSync(join(root, "invocations"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(lines(result.kind === "ok" ? result.value : "").find((event) => event.type === "run")).toMatchObject({ reasonCode: "xcuitest_driver_start_failed" });
  });

  test("surfaces launchApp privacy grant failures in the run event", async () => {
    const { worktree, environment } = sandbox();
    const result = await executeMaestro(["run", ".maestro/prefs.yaml", "--worktree", worktree, "--device", UDID, "--json"], { ...environment, FAKE_MAESTRO_OUTPUT: "privacy-failed.txt", FAKE_MAESTRO_EXIT: "1" }, adapter);
    expect(result.kind).toBe("ok");
    expect(lines(result.kind === "ok" ? result.value : "").find((event) => event.type === "run")).toMatchObject({ reasonCode: "privacy_grant_failed", reason: expect.stringContaining("privacy grant") });
  });

  test("refuses a flow that is not in the worktree", async () => {
    const { worktree, environment } = sandbox();
    const result = await executeMaestro(["run", ".maestro/nope.yaml", "--worktree", worktree, "--device", UDID], environment, adapter);
    expect(result.kind).toBe("failed");
  });

  test("refuses to run when Maestro is not installed", async () => {
    const { home, worktree, environment } = sandbox();
    rmSync(join(home, ".maestro", "megabrain-module.json"));
    const result = await executeMaestro(["run", ".maestro/prefs.yaml", "--worktree", worktree, "--device", UDID], environment, adapter);
    expect(result.kind === "failed" ? result.error : "").toContain("megabrain install simulator-maestro");
  });

  test("status reports the last run and stop ends a running one", async () => {
    const { root, worktree, environment } = sandbox();
    await executeMaestro(["run", ".maestro/prefs.yaml", "--worktree", worktree, "--device", UDID, "--json"], environment, adapter);
    const status = await executeMaestro(["status", "--worktree", worktree, "--json"], environment, adapter);
    expect(status.kind === "ok" ? JSON.parse(status.value) : null).toMatchObject({ state: "passed", flow: ".maestro/prefs.yaml" });

    const running = executeMaestro(["run", ".maestro/prefs.yaml", "--worktree", worktree, "--device", UDID, "--json"], { ...environment, FAKE_MAESTRO_SLEEP: "30" }, adapter);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await executeMaestro(["status", "--worktree", worktree, "--json"], environment, adapter);
      if (current.kind === "ok" && JSON.parse(current.value).state === "running") break;
      await new Promise((done) => setTimeout(done, 100));
    }
    const stopped = await executeMaestro(["stop", "--worktree", worktree, "--json"], environment, adapter);
    expect(stopped.kind).toBe("ok");
    await running;
    const after = await executeMaestro(["status", "--worktree", worktree, "--json"], environment, adapter);
    expect(after.kind === "ok" ? JSON.parse(after.value).state : "").toBe("stopped");
    expect(readdirSync(join(root, "state", "maestro")).length).toBe(1);
  });
});

describe("maestro runs", () => {
  test("lists every run of the worktree, newest first, with its verdict and duration", async () => {
    const { worktree, environment } = sandbox();
    await executeMaestro(["run", ".maestro/prefs.yaml", "--worktree", worktree, "--device", UDID, "--json"], environment, adapter);
    await executeMaestro(["run", "maestro/home.yml", "--worktree", worktree, "--device", UDID, "--json"], { ...environment, FAKE_MAESTRO_OUTPUT: "run-failed.txt", FAKE_MAESTRO_EXIT: "1" }, adapter);
    const result = await executeMaestro(["runs", "--worktree", worktree, "--json"], environment, adapter);
    expect(result.kind).toBe("ok");
    const runs = JSON.parse(result.kind === "ok" ? result.value : "[]") as Array<Record<string, unknown>>;
    expect(runs.map((run) => [run.flow, run.state])).toEqual([["maestro/home.yml", "failed"], [".maestro/prefs.yaml", "passed"]]);
    expect(typeof runs[0]?.durationMs).toBe("number");
    expect(typeof runs[0]?.startedAt).toBe("string");
    expect(String(runs[0]?.artifacts)).toContain(String(runs[0]?.runId));
  });

  test("a worktree that never ran lists none", async () => {
    const { worktree, environment } = sandbox();
    const result = await executeMaestro(["runs", "--worktree", worktree, "--json"], environment, adapter);
    expect(result.kind === "ok" ? JSON.parse(result.value) : null).toEqual([]);
  });
});

describe("maestro new", () => {
  test("writes a flow from the template under .maestro, which flows then lists", async () => {
    const { worktree, environment } = sandbox();
    const result = await executeMaestro(["new", "checkout", "--worktree", worktree, "--json"], environment, adapter);
    expect(result.kind === "ok" ? JSON.parse(result.value) : null).toEqual({ path: ".maestro/checkout.yaml" });
    const text = readFileSync(join(worktree, ".maestro", "checkout.yaml"), "utf8");
    expect(text).toContain("appId:");
    expect(text).toContain("name: checkout");
    expect(text).toContain("- launchApp");
    const flows = await executeMaestro(["flows", "--worktree", worktree, "--json"], environment, adapter);
    expect((JSON.parse(flows.kind === "ok" ? flows.value : "[]") as Array<{ path: string }>).map((flow) => flow.path)).toContain(".maestro/checkout.yaml");
  });

  test("creates .maestro when the worktree has none and accepts a name ending in .yaml", async () => {
    const { root, environment } = sandbox();
    const bare = join(root, "bare");
    mkdirSync(bare);
    const result = await executeMaestro(["new", "smoke.yaml", "--worktree", bare, "--json"], environment, adapter);
    expect(result.kind === "ok" ? JSON.parse(result.value) : null).toEqual({ path: ".maestro/smoke.yaml" });
    expect(existsSync(join(bare, ".maestro", "smoke.yaml"))).toBe(true);
  });

  test("refuses to overwrite an existing flow", async () => {
    const { worktree, environment } = sandbox();
    const before = readFileSync(join(worktree, ".maestro", "prefs.yaml"), "utf8");
    const result = await executeMaestro(["new", "prefs", "--worktree", worktree, "--json"], environment, adapter);
    expect(result.kind).toBe("failed");
    expect(readFileSync(join(worktree, ".maestro", "prefs.yaml"), "utf8")).toBe(before);
  });

  test.each(["../escape", "a/b", ".hidden", ""])("refuses the name %p", async (name) => {
    const { root, worktree, environment } = sandbox();
    const result = await executeMaestro(["new", name, "--worktree", worktree, "--json"], environment, adapter);
    expect(result.kind).toBe("failed");
    expect(existsSync(join(root, "escape.yaml"))).toBe(false);
  });
});
