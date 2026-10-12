import { describe, expect, test } from "bun:test";
import { executeHookPreTool } from "../../src/cli/commands/hook-pre-tool.js";
import { routeResourceCommand } from "../../src/core/resource-commands.js";

describe("resource command routing", () => {
  test("a dev server becomes a managed process that keeps the exact command", () => {
    expect(routeResourceCommand("pnpm dev")).toEqual({ action: "rewrite", command: "megabrain proc start --name dev --shell 'pnpm dev'" });
    expect(routeResourceCommand("cd apps/web && npm run dev -- --port 3001")).toEqual({
      action: "rewrite", command: "megabrain proc start --name dev --shell 'cd apps/web && npm run dev -- --port 3001'",
    });
    expect(routeResourceCommand("PORT=4000 bun run start")).toEqual({ action: "rewrite", command: "megabrain proc start --name start --shell 'PORT=4000 bun run start'" });
    expect(routeResourceCommand("npx vite")).toEqual({ action: "rewrite", command: "megabrain proc start --name dev --shell 'npx vite'" });
  });

  test("container work runs in the foreground with docker held", () => {
    expect(routeResourceCommand("docker compose up -d db")).toEqual({ action: "rewrite", command: "megabrain proc run --name docker --needs docker --shell 'docker compose up -d db'" });
    expect(routeResourceCommand("docker run --rm -e 'A=b c' alpine echo hi")).toEqual({
      action: "rewrite", command: "megabrain proc run --name docker --needs docker --shell 'docker run --rm -e '\\''A=b c'\\'' alpine echo hi'",
    });
  });

  test("migrations run in the foreground under admission", () => {
    expect(routeResourceCommand("pnpm exec prisma migrate dev --name init")).toEqual({ action: "rewrite", command: "megabrain proc run --name migrate --shell 'pnpm exec prisma migrate dev --name init'" });
    expect(routeResourceCommand("npx drizzle-kit push")).toEqual({ action: "rewrite", command: "megabrain proc run --name migrate --shell 'npx drizzle-kit push'" });
  });

  test("starting or stopping OrbStack by hand is refused with what to run instead", () => {
    const routed = routeResourceCommand("orb stop");
    expect(routed?.action).toBe("deny");
    expect(routed?.action === "deny" ? routed.reason : "").toContain("megabrain proc run --needs docker");
  });

  test("everything else passes untouched", () => {
    for (const command of [
      "git status", "ls -la", "pnpm test", "pnpm typecheck", "docker ps", "docker logs api", "echo 'pnpm dev'",
      "grep -r 'docker run' .", "megabrain proc start --name dev -- pnpm dev", "cat package.json | jq .scripts.dev",
    ]) expect(routeResourceCommand(command)).toBeUndefined();
  });
});

function run(agent: string, payload: unknown): Promise<string> {
  return executeHookPreTool([], { MEGABRAIN_HOOK_AGENT: agent }, async () => JSON.stringify(payload)).then((result) => {
    if (result.kind !== "ok") throw new Error(result.kind === "failed" ? result.error : result.reason);
    return result.value;
  });
}

describe("pre-tool hook", () => {
  test("Claude, Codex and Grok get updatedInput with every other field kept", async () => {
    for (const agent of ["claude", "codex", "grok"]) {
      const output = JSON.parse(await run(agent, { tool_name: "Bash", tool_input: { command: "pnpm dev", description: "start", timeout: 5000 } }));
      expect(output).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { command: "megabrain proc start --name dev --shell 'pnpm dev'", description: "start", timeout: 5000 },
        },
      });
    }
  });

  test("Agy gets overwrite on CommandLine and still asks for permission", async () => {
    const output = JSON.parse(await run("agy", { toolCall: { name: "run_command", args: { CommandLine: "pnpm dev", Cwd: "/x" } } }));
    expect(output).toEqual({ decision: "ask", overwrite: { CommandLine: "megabrain proc start --name dev --shell 'pnpm dev'" } });
  });

  test("Agy always gets a decision, and ask is its neutral one", async () => {
    // Orca's own Agy PreToolUse hook answers {"decision":"ask"} for every call; Agy requires one.
    expect(JSON.parse(await run("agy", { toolCall: { name: "run_command", args: { CommandLine: "git status" } } }))).toEqual({ decision: "ask" });
    expect(JSON.parse(await run("agy", { toolCall: { name: "view_file", args: { AbsolutePath: "/x" } } }))).toEqual({ decision: "ask" });
    const garbage = await executeHookPreTool([], { MEGABRAIN_HOOK_AGENT: "agy" }, async () => "not json");
    expect(garbage.kind === "ok" ? JSON.parse(garbage.value) : undefined).toEqual({ decision: "ask" });
  });

  test("a refusal uses each agent's deny form", async () => {
    const claude = JSON.parse(await run("claude", { tool_name: "Bash", tool_input: { command: "orb stop" } }));
    expect(claude.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(claude.hookSpecificOutput.permissionDecisionReason).toContain("megabrain");
    const agy = JSON.parse(await run("agy", { toolCall: { name: "run_command", args: { CommandLine: "orb stop" } } }));
    expect(agy.decision).toBe("deny");
    expect(agy.reason).toContain("megabrain");
  });

  test("prints nothing for an ordinary command, a non-shell tool, an unknown agent or bad input", async () => {
    expect(await run("claude", { tool_name: "Bash", tool_input: { command: "git status" } })).toBe("");
    expect(await run("claude", { tool_name: "Read", tool_input: { file_path: "/x" } })).toBe("");
    expect(await run("cursor", { tool_name: "Bash", tool_input: { command: "pnpm dev" } })).toBe("");
    const garbage = await executeHookPreTool([], { MEGABRAIN_HOOK_AGENT: "claude" }, async () => "not json");
    expect(garbage).toEqual({ kind: "ok", value: "" });
  });
});
