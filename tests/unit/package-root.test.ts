import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modelRegistryPaths } from "../../src/core/model.js";
import { reconcileSkills } from "../../src/core/skill.js";
import { executeWeb } from "../../src/cli/commands/web.js";
import { executeTmux } from "../../src/cli/commands/tmux.js";
import * as installDoctor from "../../src/cli/commands/install-doctor.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { ok } from "../../src/core/result.js";
import { executeDoctor } from "../../src/cli/commands/install-doctor.js";

const packageRootModule = await import("../../src/core/package-root.js").catch(() => undefined);

describe("package root resolution", () => {
  test("resolves the nearest package root from a nested module path", () => {
    expect(packageRootModule).toBeDefined();
    if (packageRootModule === undefined) return;
    const root = mkdtempSync("/tmp/megabrain-package-root-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "megabrain" }));
    const nested = join(root, "src/core/nested/module.js");
    expect(packageRootModule.resolvePackageRoot(new URL(`file://${nested}`).href)).toBe(root);
  });

  test("resolves a scoped package root ending in megabrain", () => {
    expect(packageRootModule).toBeDefined();
    if (packageRootModule === undefined) return;
    const root = mkdtempSync("/tmp/megabrain-scoped-package-root-");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@oguilhermelima/megabrain" }));
    const nested = join(root, "node_modules/@oguilhermelima/megabrain/src/cli/index.js");
    expect(packageRootModule.resolvePackageRoot(new URL(`file://${nested}`).href)).toBe(root);
  });

  test("uses the explicit root override before inspecting the module path", () => {
    expect(packageRootModule).toBeDefined();
    if (packageRootModule === undefined) return;
    const override = "/tmp/megabrain-root-override";
    expect(packageRootModule.resolvePackageRoot("file:///missing/module.js", override)).toBe(override);
  });

  test("reports the package name and module URL when no root exists", () => {
    expect(packageRootModule).toBeDefined();
    if (packageRootModule === undefined) return;
    expect(() => packageRootModule.resolvePackageRoot("file:///tmp/missing/module.js")).toThrow(/package\.json.*megabrain/);
  });

  test("builds safe hook commands for Node and compiled runtimes", () => {
    const createCommand = Reflect.get(installDoctor, "hookEntrypointCommand") as
      | ((environment: Readonly<Record<string, string | undefined>>, agent: "codex", runtime: { execPath: string; node: boolean }) => string | undefined)
      | undefined;
    expect(createCommand).toBeDefined();
    if (createCommand === undefined) return;
    const root = mkdtempSync("/tmp/megabrain-hook-root-");
    const nodePath = "/opt/Node's Runtime/bin/node";
    const entrypoint = join(root, ".build/megabrain");
    const compiled = join(root, ".build/megabrain");
    mkdirSync(join(root, ".build"), { recursive: true });
    writeFileSync(entrypoint, "bundle");
    writeFileSync(compiled, "binary");
    chmodSync(entrypoint, 0o755);
    chmodSync(compiled, 0o755);
    expect(createCommand({ MEGABRAIN_ROOT: root }, "codex", { execPath: nodePath, node: true }))
      .toBe(`MEGABRAIN_HOOK_AGENT=codex '/opt/Node'\\''s Runtime/bin/node' '${entrypoint}' hook turn-end`);
    expect(createCommand({ MEGABRAIN_ROOT: root }, "codex", { execPath: compiled, node: false }))
      .toBe(`MEGABRAIN_HOOK_AGENT=codex '${realpathSync(compiled)}' hook turn-end`);
  });
});

describe("shipped asset paths", () => {
  const originalCwd = process.cwd();
  const unrelated = mkdtempSync("/tmp/megabrain-unrelated-cwd-");

  test("model template comes from the package root", () => {
    process.chdir(unrelated);
    try { expect(modelRegistryPaths({}).template).toBe(join(originalCwd, ".megabrain/models.json")); }
    finally { process.chdir(originalCwd); }
  });

  test("skill source comes from the package root", () => {
    process.chdir(unrelated);
    try {
      const scan = reconcileSkills({ HOME: mkdtempSync("/tmp/megabrain-package-skill-home-") });
      expect(scan.failureCount).toBe(0);
    } finally { process.chdir(originalCwd); }
  });

  test("web invokes the shipped Playwright script", async () => {
    let invokedScript = "";
    const processAdapter: ProcessAdapter = {
      async run(_command, args) { invokedScript = args[0] ?? ""; return ok({ stdout: "", stderr: "", exitCode: 0 }); },
      async startDetached() { return ok(undefined); },
      invocationCount() { return 1; },
    };
    process.chdir(unrelated);
    try {
      await executeWeb(["capture", "--url", "https://example.com", "--screen", "home"], { HOME: unrelated }, processAdapter);
      expect(invokedScript).toBe(join(originalCwd, "scripts/playwright-web.mjs"));
    } finally { process.chdir(originalCwd); }
  });

  test("tmux tune installs the packaged tuning file", async () => {
    const home = mkdtempSync("/tmp/megabrain-package-tmux-tune-home-");
    process.chdir(unrelated);
    try {
      const processAdapter: ProcessAdapter = {
        async run() { return ok({ stdout: "", stderr: "", exitCode: 0 }); },
        async startDetached() { return ok(undefined); },
        invocationCount() { return 0; },
      };
      const result = await executeTmux(["tune", "--yes"], { HOME: home }, processAdapter);
      expect(result.kind).toBe("ok");
      expect(readFileSync(join(home, ".megabrain/tmux/megabrain.tmux.conf"), "utf8"))
        .toBe(readFileSync(join(originalCwd, "tmux/megabrain.tmux.conf"), "utf8"));
    } finally { process.chdir(originalCwd); }
  });

  test.each([
    ["/bin/bash", ".megabrain/bash/megabrain-agent-tmux.bash", "bash/megabrain-agent-tmux.bash"],
    ["/bin/zsh", ".megabrain/zsh/megabrain-agent-tmux.zsh", "zsh/megabrain-agent-tmux.zsh"],
  ] as const)("tmux %s wrapper installs the packaged source", async (shell, installedPath, sourcePath) => {
    const home = mkdtempSync("/tmp/megabrain-package-tmux-home-");
    process.chdir(unrelated);
    try {
      const processAdapter: ProcessAdapter = {
        async run() { return ok({ stdout: "", stderr: "", exitCode: 0 }); },
        async startDetached() { return ok(undefined); },
        invocationCount() { return 0; },
      };
      const result = await executeTmux(["wrapper", "--yes"], { HOME: home, SHELL: shell }, processAdapter);
      expect(result.kind).toBe("ok");
      expect(readFileSync(join(home, installedPath), "utf8")).toBe(readFileSync(join(originalCwd, sourcePath), "utf8"));
    } finally { process.chdir(originalCwd); }
  });

  test("doctor invokes the packaged Playwright source", async () => {
    let invokedScript = "";
    const playwrightRoot = mkdtempSync("/tmp/megabrain-package-playwright-");
    writeFileSync(join(playwrightRoot, "manifest.json"), "{}\n");
    const processAdapter: ProcessAdapter = {
      async run(command, args) {
        if (command === "which") return ok({ stdout: "/usr/bin/tool", stderr: "", exitCode: 0 });
        invokedScript = args[0] ?? "";
        return ok({ stdout: JSON.stringify({ status: "ok", reason: "ready" }), stderr: "", exitCode: 0 });
      },
      async startDetached() { return ok(undefined); },
      invocationCount() { return 1; },
    };
    process.chdir(unrelated);
    try {
      await executeDoctor(["simulator-web", "--json"], {
        HOME: unrelated,
        MEGABRAIN_PLAYWRIGHT_ROOT: playwrightRoot,
      }, processAdapter);
      expect(invokedScript).toBe(join(originalCwd, "scripts/playwright-web.mjs"));
    } finally { process.chdir(originalCwd); }
  });
});

describe("compiled binary package root", () => {
  const bundledModule = "file:///$bunfs/root/megabrain";

  function stagedLayout(binary: string, assets: string): { root: string; executable: string; assets: string } {
    const root = realpathSync(mkdtempSync("/tmp/megabrain-compiled-root-"));
    const executable = join(root, binary);
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "binary");
    mkdirSync(join(root, assets), { recursive: true });
    writeFileSync(join(root, assets, "package.json"), JSON.stringify({ name: "megabrain" }));
    return { root, executable, assets: join(root, assets) };
  }

  test("finds the assets in share/megabrain beside a bin directory", () => {
    const layout = stagedLayout("bin/megabrain", "share/megabrain");
    expect(packageRootModule?.resolvePackageRoot(bundledModule, undefined, layout.executable)).toBe(layout.assets);
  });

  test("finds the assets in Resources/megabrain inside a macOS app bundle", () => {
    const layout = stagedLayout("Megabrain.app/Contents/MacOS/megabrain", "Megabrain.app/Contents/Resources/megabrain");
    expect(packageRootModule?.resolvePackageRoot(bundledModule, undefined, layout.executable)).toBe(layout.assets);
  });

  test("follows a symlink on PATH to the real executable", () => {
    const layout = stagedLayout("bin/megabrain", "share/megabrain");
    const pathDirectory = mkdtempSync("/tmp/megabrain-compiled-path-");
    const link = join(pathDirectory, "megabrain");
    symlinkSync(layout.executable, link);
    expect(packageRootModule?.resolvePackageRoot(bundledModule, undefined, link)).toBe(layout.assets);
  });

  test("prefers the package that contains the module over the executable", () => {
    const checkout = realpathSync(mkdtempSync("/tmp/megabrain-compiled-checkout-"));
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "megabrain" }));
    const layout = stagedLayout("bin/megabrain", "share/megabrain");
    const module = new URL(`file://${join(checkout, "src/core/package-root.ts")}`).href;
    expect(packageRootModule?.resolvePackageRoot(module, undefined, layout.executable)).toBe(checkout);
  });

  test("ignores an asset directory whose package is not megabrain", () => {
    const layout = stagedLayout("bin/megabrain", "share/megabrain");
    writeFileSync(join(layout.assets, "package.json"), JSON.stringify({ name: "other" }));
    expect(() => packageRootModule?.resolvePackageRoot(bundledModule, undefined, layout.executable))
      .toThrow(/share\/megabrain/);
  });

  test("names the executable locations it tried when nothing matches", () => {
    const executable = join(realpathSync(mkdtempSync("/tmp/megabrain-compiled-missing-")), "bin/megabrain");
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "binary");
    expect(() => packageRootModule?.resolvePackageRoot(bundledModule, undefined, executable))
      .toThrow(/share\/megabrain.*Resources\/megabrain/);
  });
});
