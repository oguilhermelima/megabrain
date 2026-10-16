import { describe, expect, test } from "bun:test";
import { columnStep } from "@/launcher/launcher-keys";

const open = (count: number) => Array.from({ length: count }, () => false);

describe("columnStep", () => {
  test("arrows move one item down and up", () => {
    expect(columnStep(0, "ArrowDown", open(3))).toBe(1);
    expect(columnStep(2, "ArrowUp", open(3))).toBe(1);
  });

  test("the ends stop instead of wrapping", () => {
    expect(columnStep(2, "ArrowDown", open(3))).toBeNull();
    expect(columnStep(0, "ArrowUp", open(3))).toBeNull();
  });

  test("Home and End jump to the first and last items", () => {
    expect(columnStep(1, "Home", open(4))).toBe(0);
    expect(columnStep(1, "End", open(4))).toBe(3);
  });

  test("Home on the first item and End on the last do not move", () => {
    expect(columnStep(0, "Home", open(3))).toBeNull();
    expect(columnStep(2, "End", open(3))).toBeNull();
  });

  test("disabled items are skipped in every direction", () => {
    const agents = [false, true, true, false, true];
    expect(columnStep(0, "ArrowDown", agents)).toBe(3);
    expect(columnStep(3, "ArrowUp", agents)).toBe(0);
    expect(columnStep(0, "End", agents)).toBe(3);
    expect(columnStep(3, "ArrowDown", agents)).toBeNull();
  });

  test("Home skips disabled items at the start", () => {
    expect(columnStep(3, "Home", [true, true, false, false])).toBe(2);
  });

  test("other keys, an empty column and a lone item do not move", () => {
    expect(columnStep(0, "Enter", open(3))).toBeNull();
    expect(columnStep(0, "Tab", open(3))).toBeNull();
    expect(columnStep(0, "ArrowDown", [])).toBeNull();
    expect(columnStep(0, "ArrowDown", open(1))).toBeNull();
  });
});
