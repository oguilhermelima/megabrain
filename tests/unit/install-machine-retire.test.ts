import { describe, expect, test } from "bun:test";
import { retireLegacyChannels } from "../../src/cli/commands/install-machine.js";
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

    const result = await retireLegacyChannels(["claude", "codex", "agy"], cli.adapter, true, false);

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

    const result = await retireLegacyChannels(["claude", "codex", "agy"], cli.adapter, true, false);

    expect(result.kind).toBe("ok");
    expect(cli.calls.some((call) => call.includes("uninstall") || call.includes("marketplace remove") || call.includes("plugin remove"))).toBe(false);
  });
});
