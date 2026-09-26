import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retireLegacyChannels, retireLegacyInstructions } from "../../src/cli/commands/install-machine.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";

function fakeCli(responses: Record<string, string>): { readonly adapter: ProcessAdapter; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    adapter: {
      async run(command, args) {
        const invocation = [command, ...args].join(" ");
        calls.push(invocation);
        const output = responses[invocation];
        return output === undefined ? failed(`${invocation} unavailable`) : ok({ stdout: output, stderr: "", exitCode: 0 });
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return calls.length; },
    },
  };
}

describe("retireLegacyChannels", () => {
  test("detects and removes plugin and marketplace registrations with --yes", async () => {
    const cli = fakeCli({
      "claude plugin list": "megabrain@megabrain-local enabled\n",
      "claude plugin marketplace list": "megabrain-local /old/checkout\n",
      "codex plugin list": "megabrain@megabrain-local installed, enabled\n",
      "codex plugin marketplace list": "megabrain-local /old/checkout\n",
      "agy plugin list": '{"imports":[{"name":"megabrain","source":"claude-code","components":["skills"]}]}\n',
      "claude plugin uninstall megabrain@megabrain-local": "",
      "claude plugin marketplace remove megabrain-local": "",
      "codex plugin remove megabrain@megabrain-local": "",
      "codex plugin marketplace remove megabrain-local": "",
      "agy plugin uninstall megabrain": "",
    });

    const result = await retireLegacyChannels(["claude", "codex", "agy"], cli.adapter, true, undefined);

    expect(result.kind).toBe("ok");
    expect(cli.calls).toContain("claude plugin uninstall megabrain@megabrain-local");
    expect(cli.calls).toContain("claude plugin marketplace remove megabrain-local");
    expect(cli.calls).toContain("codex plugin remove megabrain@megabrain-local");
    expect(cli.calls).toContain("codex plugin marketplace remove megabrain-local");
    expect(cli.calls).toContain("agy plugin uninstall megabrain");
  });

  test("leaves legacy channels alone when none are registered", async () => {
    const cli = fakeCli({
      "claude plugin list": "No plugins installed\n",
      "claude plugin marketplace list": "No marketplaces configured\n",
      "codex plugin list": "No plugins available\n",
      "codex plugin marketplace list": "No marketplaces configured\n",
      "agy plugin list": '{"imports":[]}\n',
    });

    const result = await retireLegacyChannels(["claude", "codex", "agy"], cli.adapter, true, undefined);

    expect(result.kind).toBe("ok");
    expect(cli.calls.some((call) => call.includes("uninstall") || call.includes("marketplace remove") || call.includes("plugin remove"))).toBe(false);
  });
});

describe("retireLegacyInstructions", () => {
  test("removes only the legacy heading and its adjacent trailing blank line", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-retire-instructions-"));
    try {
      const home = join(root, "home");
      const project = join(root, "project");
      const codexFile = join(home, ".codex", "AGENTS.md");
      const agyFile = join(home, ".agy", "AGENTS.md");
      const projectFile = join(project, "AGENTS.md");
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(join(home, ".agy"), { recursive: true });
      mkdirSync(project, { recursive: true });
      writeFileSync(codexFile, "Keep these rules.\n# megabrain recipes\n\n");
      writeFileSync(agyFile, "# megabrain recipes\n");
      writeFileSync(projectFile, "Project rules\n# megabrain recipes\n");

      const result = await retireLegacyInstructions({ HOME: home }, project, true, undefined);

      expect(result.kind).toBe("ok");
      expect(readFileSync(codexFile, "utf8")).toBe("Keep these rules.\n");
      expect(readFileSync(agyFile, "utf8")).toBe("");
      expect(readFileSync(projectFile, "utf8")).toBe("Project rules\n");
      if (result.kind === "ok") {
        expect(result.value).toContain(codexFile);
        expect(result.value).toContain(agyFile);
        expect(result.value).toContain(projectFile);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves a heading followed by user content byte-identical and reports it", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-retire-instructions-"));
    try {
      const home = join(root, "home");
      const project = join(root, "project");
      const codexFile = join(home, ".codex", "AGENTS.md");
      const original = "# megabrain recipes\nMy instructions follow.\n";
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(project, { recursive: true });
      writeFileSync(codexFile, original);

      const result = await retireLegacyInstructions({ HOME: home }, project, true, undefined);

      expect(result.kind).toBe("ok");
      expect(readFileSync(codexFile, "utf8")).toBe(original);
      if (result.kind === "ok") expect(result.value).toContain(`${codexFile}: retained; content follows the heading`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a matching legacy heading without removing it unless asked", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-retire-instructions-"));
    try {
      const home = join(root, "home");
      const project = join(root, "project");
      const codexFile = join(home, ".codex", "AGENTS.md");
      const original = "# megabrain recipes\n";
      mkdirSync(join(home, ".codex"), { recursive: true });
      mkdirSync(project, { recursive: true });
      writeFileSync(codexFile, original);

      const result = await retireLegacyInstructions({ HOME: home }, project, false, undefined);

      expect(result.kind).toBe("ok");
      expect(readFileSync(codexFile, "utf8")).toBe(original);
      if (result.kind === "ok") expect(result.value).toContain(`${codexFile}: legacy heading found; rerun with --yes to remove it`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
