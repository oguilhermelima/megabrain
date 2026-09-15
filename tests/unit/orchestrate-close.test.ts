import { describe, expect, test } from "bun:test";
import { closeDecision, closeOutput, hostCloseReason, parseCloseArgs } from "../../src/core/orchestrate-close.js";

const meta = (values: Record<string, unknown> = {}) => ({ dispatchId: "d", state: "running", terminalState: "owned", runtime: "host", ...values });

describe("orchestrate close", () => {
  test("parses force-release and json", () => expect(parseCloseArgs(["d", "--force-release", "--json"])).toEqual({ kind: "ok", value: { dispatchId: "d", forceRelease: true, json: true } }));
  test("refuses the caller pane even with force-release", () => expect(closeDecision(meta({ runtime: "tmux", tmuxSession: "s", tmuxPane: "%1" }), { tmuxSession: "s", tmuxPane: "%1" }, true)).toEqual({ kind: "failed", error: "refusing to close dispatch d: target tmux pane %1 is the calling pane", exitCode: 1 }));
  test("refuses retained terminals without force and permits force", () => {
    expect(closeDecision(meta({ terminalState: "retained" }), {}, false)).toEqual({ kind: "ok", value: "retained" });
    expect(closeDecision(meta({ terminalState: "retained" }), {}, true)).toEqual({ kind: "ok", value: "close" });
  });
  test("recognizes duplicate closes", () => expect(closeDecision(meta({ state: "closed" }), {}, false)).toEqual({ kind: "ok", value: "duplicate" }));
  test("formats shared and host close output", () => {
    expect(closeOutput("d", false, "tmux", "orca", "shared-pane")).toBe("closed: d\ntmux pane removed; the shared tmux session and host terminal tab were kept.\n");
    expect(JSON.parse(closeOutput("d", true, "host", "orca", "unknown"))).toEqual({ dispatchId: "d", status: "closed" });
  });
  test("extracts and defaults host close reasons", () => {
    expect(hostCloseReason('{"error":{"message":"terminal close denied"}}')).toBe("terminal close denied");
    expect(hostCloseReason("\n\r")).toBe("the host gave no reason");
  });
});
