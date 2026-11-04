import { describe, expect, test } from "bun:test";
import { AUTO_CLOSE_GRACE_MS, mayAutoCloseDispatch, tmuxClientsViewedSinceDone } from "../../src/core/dispatch-auto-close.js";
import { parseArgs } from "../../src/cli/commands/orchestrate-spawn-options.js";

const candidate = (overrides: Partial<Parameters<typeof mayAutoCloseDispatch>[0]> = {}) => ({
  state: "done", runtime: "tmux", keepOpen: false, enabled: true,
  acknowledgedAt: "2026-11-03T12:00:00.000Z", now: Date.parse("2026-11-03T12:02:00.000Z"),
  viewedSinceDone: false, ...overrides,
});

describe("dispatch auto-close policy", () => {
  test("accepts --keep-open per spawn and defaults it off", () => {
    const base = ["--worktree", "/work/tree", "--agent", "codex", "--prompt", "task"];
    expect(parseArgs(base)).toMatchObject({ kind: "ok", value: { keepOpen: false } });
    expect(parseArgs([...base, "--keep-open"])).toMatchObject({ kind: "ok", value: { keepOpen: true } });
  });

  test("uses a two-minute grace period after ack", () => {
    expect(AUTO_CLOSE_GRACE_MS).toBe(120_000);
    expect(mayAutoCloseDispatch(candidate({ now: Date.parse("2026-11-03T12:01:59.999Z") }))).toBe(false);
    expect(mayAutoCloseDispatch(candidate())).toBe(true);
  });

  test("never closes before the done delivery is acknowledged", () => {
    expect(mayAutoCloseDispatch(candidate({ acknowledgedAt: null }))).toBe(false);
  });

  test("keeps dispatches open when opted out, disabled, or viewed since done", () => {
    expect(mayAutoCloseDispatch(candidate({ keepOpen: true }))).toBe(false);
    expect(mayAutoCloseDispatch(candidate({ enabled: false }))).toBe(false);
    expect(mayAutoCloseDispatch(candidate({ viewedSinceDone: true }))).toBe(false);
  });

  test("does not auto-close non-tmux runtimes or dispatches not done", () => {
    expect(mayAutoCloseDispatch(candidate({ runtime: "host" }))).toBe(false);
    expect(mayAutoCloseDispatch(candidate({ state: "running" }))).toBe(false);
  });

  test("uses focused state, post-done input, and attachment time to detect viewing", () => {
    const doneAt = "2026-11-03T12:00:00.000Z";
    expect(tmuxClientsViewedSinceDone("", doneAt)).toBe(false);
    expect(tmuxClientsViewedSinceDone("/dev/ttys025|43715|1793707190|1793707199|attached,focused,UTF-8", doneAt)).toBe(true);
    expect(tmuxClientsViewedSinceDone("/dev/ttys025|43715|1793707190|1793707201|attached,UTF-8", doneAt)).toBe(true);
    expect(tmuxClientsViewedSinceDone("/dev/ttys026|43716|1793707201|1793707201|attached,UTF-8", doneAt)).toBe(true);
    expect(tmuxClientsViewedSinceDone("/dev/ttys026|43716|1793707190|1793707199|attached,UTF-8", doneAt, [{ server: "default", tty: "/dev/ttys026", pid: 43716 }], "default")).toBe(false);
    expect(tmuxClientsViewedSinceDone("malformed", doneAt)).toBeUndefined();
  });
});
