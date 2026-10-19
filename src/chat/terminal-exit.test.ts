import { expect, test } from "bun:test";
import { terminalExitMessage } from "./terminal-exit.js";

test("terminal exit notice reports the pane status and captured output", () => {
  expect(terminalExitMessage("7", "agent failed to start")).toBe("The terminal process exited with code 7.\n\nagent failed to start");
});

test("terminal exit notice keeps a missing pane status honest", () => {
  expect(terminalExitMessage("unknown", "")).toBe("The terminal process exited with an unknown code.");
});
