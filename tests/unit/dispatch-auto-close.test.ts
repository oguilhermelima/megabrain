import { describe, expect, test } from "bun:test";
import { AUTO_CLOSE_GRACE_MS, mayAutoCloseDispatch } from "../../src/core/dispatch-auto-close.js";

const candidate = (overrides: Partial<Parameters<typeof mayAutoCloseDispatch>[0]> = {}) => ({
  state: "done", runtime: "tmux", keepOpen: false, enabled: true,
  acknowledgedAt: "2026-11-03T12:00:00.000Z", now: Date.parse("2026-11-03T12:02:00.000Z"),
  viewedSinceDone: false, ...overrides,
});

describe("dispatch auto-close policy", () => {
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
});
