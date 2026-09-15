import { describe, expect, test } from "bun:test";
import { resolveDispatchId } from "../../src/core/dispatch-paths.js";

describe("resolveDispatchId", () => {
  test.each(["", "../outside", "dispatch/child", "dispatch child", "dispatch$child"]) (
    "rejects %j",
    (dispatchId) => expect(resolveDispatchId(dispatchId)).toEqual({ kind: "invalid", dispatchId }),
  );

  test.each(["dispatch-1", "a.b_c-2"]) ("accepts %j", (dispatchId) => {
    expect(resolveDispatchId(dispatchId)).toEqual({ kind: "valid", dispatchId });
  });
});
