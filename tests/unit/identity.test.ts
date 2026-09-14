import { describe, expect, test } from "bun:test";
import { resolveConsumerIdentity, type ConsumerIdentityInput } from "../../src/core/identity.js";

const known = (value: string) => ({ kind: "known", value });
const base = (mailbox: "parent" | "child"): ConsumerIdentityInput => ({
  mailbox,
  sessionHost: "orca",
  sessionId: "term_abc",
  childHost: "superset",
  childSessionId: "child-terminal",
});

describe("resolveConsumerIdentity", () => {
  test.each([
    ["parent", known("orca/term_abc")],
    ["child outside tmux", known("child/superset/child-terminal")],
    ["child in tmux", known("child/superset/work-session/%7")],
  ] as const)("chooses the %s form", (name, expected) => {
    const input = name === "child in tmux" ? { ...base("child"), tmux: { session: "work-session", pane: "%7" } } : base(name === "parent" ? "parent" : "child");
    expect(resolveConsumerIdentity(input)).toEqual(expected);
  });

  test.each(["parent", "child"] as const)("uses explicit override on %s mailbox", (mailbox) => {
    expect(resolveConsumerIdentity({ ...base(mailbox), explicitConsumer: " explicit " })).toEqual(known("explicit"));
  });

  test.each(["parent", "child"] as const)("uses environment override on %s mailbox", (mailbox) => {
    expect(resolveConsumerIdentity({ ...base(mailbox), environmentConsumer: " environment " })).toEqual(known("environment"));
  });

  test("returns unknown when a tmux session cannot be resolved", () => {
    expect(resolveConsumerIdentity({ ...base("child"), tmux: { pane: "%7" } })).toEqual({ kind: "unknown", reason: "tmux session could not be resolved" });
  });
});
