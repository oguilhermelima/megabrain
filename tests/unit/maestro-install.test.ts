import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { executeDoctor, executeInstall } from "../../src/cli/commands/install-doctor.js";

const adapter = createProcessAdapter();
const fakeMaestro = resolve(import.meta.dir, "../fixtures/maestro/fake-maestro");
const roots: string[] = [];

afterEach(() => { while (roots.length > 0) rmSync(roots.pop() ?? "", { recursive: true, force: true }); });

function fakeJdk(root: string, major: number): string {
  const home = join(root, `jdk${major}`);
  mkdirSync(join(home, "bin"), { recursive: true });
  const java = join(home, "bin", "java");
  writeFileSync(java, `#!/bin/sh\necho 'openjdk version "${major}.0.9" 2023-10-17' >&2\n`);
  chmodSync(java, 0o755);
  return home;
}

// An installer that behaves like the official one: it lays bin and lib under MAESTRO_DIR and, as the
// real one does, appends a PATH line to the rc files of whatever HOME it was given.
function fakeInstaller(root: string, version = "2.11.0"): string {
  const script = join(root, "install.sh");
  writeFileSync(script, `#!/bin/bash
echo "version=$MAESTRO_VERSION java=$JAVA_HOME" > "${root}/installer-saw.txt"
mkdir -p "$MAESTRO_DIR/bin" "$MAESTRO_DIR/lib"
cp "${fakeMaestro}" "$MAESTRO_DIR/bin/maestro"
sed -i '' 's/2.11.0/${version}/' "$MAESTRO_DIR/bin/maestro"
touch "$MAESTRO_DIR/lib/maestro-ios-driver.jar"
echo 'export PATH=$PATH:$MAESTRO_DIR/bin' >> "$HOME/.zshrc"
echo 'export PATH=$PATH:$MAESTRO_DIR/bin' >> "\${ZDOTDIR:-$HOME}/.zshrc"
`);
  return script;
}

function sandbox(major = 17, version = "2.11.0") {
  const root = mkdtempSync(join(tmpdir(), "mb-maestro-install-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".zshrc"), "# person's rc\n");
  const environment = {
    PATH: process.env.PATH,
    HOME: home,
    MEGABRAIN_STATE_DIR: join(root, "state"),
    JAVA_HOME: fakeJdk(root, major),
    MEGABRAIN_JAVA_HOME_TOOL: join(root, "no-java-home-tool"),
    MEGABRAIN_MAESTRO_INSTALLER: fakeInstaller(root, version),
  };
  return { root, home, environment };
}

describe("simulator-maestro module", () => {
  test("install runs the installer with the pinned version and the found JDK", async () => {
    const { root, environment } = sandbox();
    const result = await executeInstall(["simulator-maestro"], environment, adapter);
    expect(result.kind).toBe("ok");
    expect(readFileSync(join(root, "installer-saw.txt"), "utf8")).toBe(`version=2.11.0 java=${environment.JAVA_HOME}\n`);
    const record = JSON.parse(readFileSync(join(environment.HOME, ".maestro", "megabrain-module.json"), "utf8"));
    expect(record.version).toBe("2.11.0");
    expect(record.javaHome).toBe(environment.JAVA_HOME);
  });

  test("install never touches the person's shell rc files", async () => {
    const { home, environment } = sandbox();
    await executeInstall(["simulator-maestro"], environment, adapter);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# person's rc\n");
    expect(existsSync(join(home, ".bash_profile"))).toBe(false);
    expect(existsSync(join(home, ".bashrc"))).toBe(false);
  });

  test("install refuses when no JDK 17 is available", async () => {
    const { environment } = sandbox(11);
    const result = await executeInstall(["simulator-maestro"], environment, adapter);
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("JDK 17");
    expect(existsSync(join(environment.HOME, ".maestro", "bin", "maestro"))).toBe(false);
  });

  test("doctor reports missing before install and ok after", async () => {
    const { environment } = sandbox();
    const before = await executeDoctor(["simulator-maestro", "--json"], environment, adapter);
    expect(before.kind === "ok" ? JSON.parse(before.value).status : "").toBe("missing");
    await executeInstall(["simulator-maestro"], environment, adapter);
    const after = await executeDoctor(["simulator-maestro", "--json"], environment, adapter);
    const report = after.kind === "ok" ? JSON.parse(after.value) : {};
    expect(report.status).toBe("ok");
    expect(report.reason).toContain("maestro 2.11.0");
  });

  test("doctor flags a version that differs from the recorded one", async () => {
    const { environment } = sandbox(17, "2.10.0");
    await executeInstall(["simulator-maestro"], environment, adapter);
    const report = await executeDoctor(["simulator-maestro", "--json"], environment, adapter);
    expect(report.kind === "ok" ? JSON.parse(report.value).status : "").toBe("misconfigured");
  });

  test("doctor flags a missing iOS driver", async () => {
    const { environment } = sandbox();
    await executeInstall(["simulator-maestro"], environment, adapter);
    rmSync(join(environment.HOME, ".maestro", "lib", "maestro-ios-driver.jar"));
    const report = await executeDoctor(["simulator-maestro", "--json"], environment, adapter);
    const parsed = report.kind === "ok" ? JSON.parse(report.value) : {};
    expect(parsed.status).toBe("misconfigured");
    expect(parsed.reason).toContain("iOS driver");
  });

  test("revert removes the installation and keeps the rest of the directory", async () => {
    const { environment } = sandbox();
    await executeInstall(["simulator-maestro"], environment, adapter);
    const keep = join(environment.HOME, ".maestro", "tests.txt");
    writeFileSync(keep, "mine");
    const result = await executeInstall(["simulator-maestro", "--revert"], environment, adapter);
    expect(result.kind).toBe("ok");
    expect(existsSync(join(environment.HOME, ".maestro", "bin"))).toBe(false);
    expect(existsSync(keep)).toBe(true);
    const report = await executeDoctor(["simulator-maestro", "--json"], environment, adapter);
    expect(report.kind === "ok" ? JSON.parse(report.value).status : "").toBe("missing");
  });
});
