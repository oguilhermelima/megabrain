import { describe, expect, test } from "bun:test";
import { createPeriodicTestRunnerCollection } from "../helpers/test-runner-memory.js";

describe("periodic test runner collection", () => {
  test("collects only after the configured number of completed tests", () => {
    let collections = 0;
    const completed = createPeriodicTestRunnerCollection(() => { collections += 1; }, 3);

    completed();
    completed();
    expect(collections).toBe(0);
    completed();
    expect(collections).toBe(1);
    completed();
    expect(collections).toBe(1);
  });

  test("uses a bounded default interval", () => {
    let collections = 0;
    const completed = createPeriodicTestRunnerCollection(() => { collections += 1; });

    for (let index = 0; index < 499; index += 1) completed();
    expect(collections).toBe(0);
    completed();
    expect(collections).toBe(1);
  });
});
