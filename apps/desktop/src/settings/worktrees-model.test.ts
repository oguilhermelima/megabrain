import { describe, expect, test } from "bun:test";
import {
  defaultWorktreeLocation,
  examplePath,
  overrideCount,
  parseWorktreeLocation,
  withOverride,
  withoutOverride,
} from "@/settings/worktrees-model";

describe("worktree location model", () => {
  test("anything unusable reads as the default", () => {
    expect(parseWorktreeLocation(null)).toEqual(defaultWorktreeLocation);
    expect(parseWorktreeLocation({ version: 1, mode: "nowhere" })).toEqual(
      defaultWorktreeLocation,
    );
  });

  test("keeps a valid stored value and drops a broken override", () => {
    const raw = {
      version: 1,
      mode: "megabrain",
      customRoot: null,
      layout: "nested",
      projects: {
        "/w/alpha": { mode: "repo", customRoot: null, layout: "nested" },
        "/w/bad": { mode: "x" },
      },
    };
    const parsed = parseWorktreeLocation(raw);
    expect(parsed.mode).toBe("megabrain");
    expect(Object.keys(parsed.projects)).toEqual(["/w/alpha"]);
  });

  test("example path per mode, for one project and branch", () => {
    const project = { path: "/w/alpha", name: "alpha" };
    expect(
      examplePath(
        { mode: "megabrain", customRoot: null, layout: "nested" },
        project,
      ),
    ).toBe("~/.megabrain/worktrees/alpha/feat-example");
    expect(
      examplePath(
        { mode: "repo", customRoot: null, layout: "nested" },
        project,
      ),
    ).toBe("/w/alpha/.worktrees/feat-example");
    expect(
      examplePath(
        { mode: "custom", customRoot: "/Trees", layout: "nested" },
        project,
      ),
    ).toBe("/Trees/alpha/feat-example");
    expect(
      examplePath(
        { mode: "custom", customRoot: "/Trees", layout: "flat" },
        project,
      ),
    ).toBe("/Trees/feat-example");
    expect(
      examplePath(
        { mode: "custom", customRoot: null, layout: "flat" },
        project,
      ),
    ).toBe("<shared worktrees folder>/feat-example");
  });

  test("adds and removes a project override without touching the rest", () => {
    const start = parseWorktreeLocation({
      ...defaultWorktreeLocation,
      mode: "megabrain",
      layout: "nested",
    });
    const added = withOverride(start, "/w/alpha", {
      mode: "repo",
      customRoot: null,
      layout: "nested",
    });
    expect(overrideCount(added)).toBe(1);
    expect(added.mode).toBe("megabrain");
    expect(overrideCount(withoutOverride(added, "/w/alpha"))).toBe(0);
  });
});
