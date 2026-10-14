import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repository = resolve(import.meta.dir, "../..");
const script = join(repository, "scripts/build-binary.sh");
const manifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")) as { files: string[] };

// One build serves every assertion: compiling takes about a second and writes ~64 MB.
const out = mkdtempSync("/tmp/megabrain-build-binary-");
const build = existsSync(script)
  ? spawnSync("bash", [script, "--out", out], { cwd: repository, encoding: "utf8" })
  : undefined;

function runStaged(args: string[]): ReturnType<typeof spawnSync> {
  const home = mkdtempSync("/tmp/megabrain-build-binary-home-");
  const pathDirectory = mkdtempSync("/tmp/megabrain-build-binary-path-");
  const link = join(pathDirectory, "megabrain");
  if (!existsSync(link)) symlinkSync(join(out, "bin/megabrain"), link);
  const state = mkdtempSync("/tmp/megabrain-build-binary-state-");
  mkdirSync(join(home, ".config"), { recursive: true });
  return spawnSync(link, args, {
    cwd: home,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: home, MEGABRAIN_STATE_DIR: state },
  });
}

describe("scripts/build-binary.sh", () => {
  test("builds an executable for the host", () => {
    expect(build?.status).toBe(0);
    const binary = join(out, "bin/megabrain");
    expect(existsSync(binary)).toBe(true);
    expect(statSync(binary).mode & 0o111).not.toBe(0);
  });

  test("stages every shipped asset beside it", () => {
    const assets = join(out, "share/megabrain");
    expect(JSON.parse(readFileSync(join(assets, "package.json"), "utf8")).name).toBe("megabrain");
    for (const entry of manifest.files.filter((file) => file !== ".build/megabrain")) {
      expect(existsSync(join(assets, entry))).toBe(true);
    }
  });

  test("the staged binary finds its assets through a symlink and without Node", () => {
    const version = runStaged(["--version"]);
    expect(version.status).toBe(0);
    expect(String(version.stdout)).toContain("megabrain ");
    expect(String(version.stderr)).not.toContain("package root");

    const models = runStaged(["model", "list", "--json"]);
    expect(String(models.stderr)).not.toContain("package root");
    expect(models.status).toBe(0);
  });

  test("rejects an unknown option", () => {
    const result = spawnSync("bash", [script, "--bogus"], { cwd: repository, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--bogus");
  });
});
