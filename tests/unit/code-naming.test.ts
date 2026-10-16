import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { usageText } from "../../src/core/usage.js";

const repository = join(import.meta.dir, "../..");
// The embedded editor is called Code inside megabrain. Only text about the separate VS Code app a
// person may run on their own machine keeps that name.
const outsideApp = new Set(["src/core/terminal-openers.ts"]);
const banned = /VS ?Code|Visual Studio Code/;

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === "node_modules" || name === "dist" || name === "target") return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|rs|md)$/.test(name) ? [path] : [];
  });
}

describe("the editor is called Code", () => {
  test("code usage text never says VS Code", () => {
    expect(usageText("code")).not.toMatch(banned);
  });

  test("app, CLI and agent instructions never call the embedded editor VS Code", () => {
    const sources = [
      ...files(join(repository, "src")),
      ...files(join(repository, "apps/desktop/src")),
      ...files(join(repository, "apps/desktop/src-tauri/src")),
      join(repository, "AGENTS.md"),
      join(repository, "skills/megabrain/SKILL.md"),
      join(repository, "tests/fixtures/root-usage.txt"),
    ];
    const offending = sources
      .map((path) => relative(repository, path))
      .filter((path) => !outsideApp.has(path))
      .flatMap((path) => readFileSync(join(repository, path), "utf8").split("\n").flatMap((line, index) => banned.test(line) ? [`${path}:${index + 1}`] : []));
    expect(offending).toEqual([]);
  });
});
