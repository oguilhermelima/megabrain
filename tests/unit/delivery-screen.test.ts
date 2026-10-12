import { describe, expect, test } from "bun:test";
import { deliveryHasKeystrokeDialog } from "../../src/cli/commands/delivery-screen.js";

describe("delivery dialog detection", () => {
  test("ignores approval language in scrollback above an empty composer", () => {
    const screen = ["Earlier document: approve the change and press enter to continue.", "", "❯"].join("\n");
    expect(deliveryHasKeystrokeDialog("claude", screen)).toBe(false);
  });

  test("ignores deny and select wording in old output", () => {
    const screen = ["deny the request, then select an option from the report", ...Array.from({ length: 20 }, () => "ordinary output"), "❯"].join("\n");
    expect(deliveryHasKeystrokeDialog("claude", screen)).toBe(false);
  });

  test("does not mistake the agent's last answer for a dialog above the composer", () => {
    const screens = [
      [...Array.from({ length: 20 }, () => "ordinary output"), "approve the change and press enter", "❯"].join("\n"),
      [...Array.from({ length: 20 }, () => "ordinary output"), "deny the request, then select an option", "❯"].join("\n"),
    ];
    for (const screen of screens) expect(deliveryHasKeystrokeDialog("claude", screen)).toBe(false);
  });

  test("holds a concrete permission dialog at the bottom of the screen", () => {
    const screen = ["ordinary output", "", "Allow this action?", "❯ 1. Yes", "  2. No", "Press Enter to confirm"].join("\n");
    expect(deliveryHasKeystrokeDialog("claude", screen)).toBe(true);
  });
});
