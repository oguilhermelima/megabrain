import { describe, expect, test } from "bun:test";
import { buildNativeCapturePaths, decideCaptureOutcome } from "../../src/core/native-capture.js";

describe("native capture distinctness", () => {
  test("fails when two screens share a hash and names both screens", () => {
    const outcome = decideCaptureOutcome({
      controlHash: "control",
      screens: [
        { name: "home", hash: "same" },
        { name: "settings", hash: "same" },
      ],
    });

    expect(outcome.failed).toBe(true);
    expect(outcome.duplicateGroups).toEqual([["home", "settings"]]);
    expect(outcome.failureReasons).toContain("screens share a hash: home, settings");
  });

  test("fails a screen matching the control frame distinctly from a duplicate", () => {
    const outcome = decideCaptureOutcome({
      controlHash: "launch",
      screens: [
        { name: "home", hash: "launch" },
        { name: "settings", hash: "settings" },
      ],
    });

    expect(outcome.failed).toBe(true);
    expect(outcome.controlMatches).toEqual(["home"]);
    expect(outcome.duplicateGroups).toEqual([]);
    expect(outcome.failureReasons).toContain("screen matches the control frame: home");
  });

  test("reports exact captured and distinct counts and duplicate groups", () => {
    const outcome = decideCaptureOutcome({
      controlHash: "control",
      screens: [
        { name: "home", hash: "home" },
        { name: "settings", hash: "settings" },
        { name: "profile", hash: "home" },
      ],
    });

    expect(outcome.captured).toBe(3);
    expect(outcome.distinct).toBe(2);
    expect(outcome.summary).toBe("3 captured, 2 distinct, groups: home, profile");
  });

  test("succeeds when every screen is distinct and differs from control", () => {
    const outcome = decideCaptureOutcome({
      controlHash: "control",
      screens: [
        { name: "home", hash: "home" },
        { name: "settings", hash: "settings" },
      ],
    });

    expect(outcome.failed).toBe(false);
    expect(outcome.captured).toBe(2);
    expect(outcome.distinct).toBe(2);
    expect(outcome.duplicateGroups).toEqual([]);
    expect(outcome.summary).toBe("2 captured, 2 distinct");
  });
});

describe("native capture paths", () => {
  test("builds the surface, capture, theme, viewport, and screen layout", () => {
    expect(buildNativeCapturePaths({
      outputRoot: "/tmp/captures",
      surface: "phone",
      captureId: "2026-09-20",
      theme: "dark",
      viewport: "390x844",
      screen: "settings",
    })).toEqual({
      directory: "/tmp/captures/phone/2026-09-20",
      image: "/tmp/captures/phone/2026-09-20/dark/390x844/settings.png",
      manifest: "/tmp/captures/phone/2026-09-20/manifest.json",
    });
  });
});
