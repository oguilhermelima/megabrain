import { describe, expect, test } from "bun:test";
import { parseProcStartArguments, filterProcLogLines, isProcErrorLine } from "../../src/core/proc-runner.js";

describe("managed process arguments", () => {
  test("passes every argument after -- through byte for byte", () => {
    const parsed = parseProcStartArguments([
      "--name", "api", "--cwd", "/tmp/project", "--env", "A=x y", "--",
      "pnpm", "exec", "prisma", "migrate", "--schema=some file", "--force",
    ]);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") expect(parsed.value.command).toEqual([
      "pnpm", "exec", "prisma", "migrate", "--schema=some file", "--force",
    ]);
  });

  test("filters timestamped logs by age, regex, and the shared error classifier", () => {
    const lines = [
      "2026-10-12T10:00:00.000Z ready",
      "2026-10-12T10:01:00.000Z Error: request failed",
      "2026-10-12T10:02:00.000Z     at main (app.js:1:1)",
    ];
    expect(filterProcLogLines(lines, { grep: "request" })).toEqual([lines[1]]);
    expect(filterProcLogLines(lines, { since: "2026-10-12T10:01:30.000Z" })).toEqual([lines[2]]);
    expect(lines.filter(isProcErrorLine)).toEqual([lines[1], lines[2]]);
  });
});
