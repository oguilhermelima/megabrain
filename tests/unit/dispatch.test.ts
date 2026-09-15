import { describe, expect, test } from "bun:test";
import {
  decorateDispatchRecord,
  filterDispatchRecords,
  formatDispatchList,
  parseDispatchRecord,
  type DispatchListOptions,
  type DispatchRecord,
} from "../../src/core/dispatch.js";

const record = (values: Record<string, unknown> = {}): DispatchRecord => {
  const parsed = parseDispatchRecord({ dispatchId: "dispatch", parentSessionId: "session", parentHost: "host", state: "running", processState: "running", terminalState: "owned", worktreePath: "/worktree", ...values });
  if (parsed.kind !== "ok") throw new Error(parsed.reason);
  return parsed.value;
};
const options = (values: Partial<DispatchListOptions> = {}): DispatchListOptions => ({ all: false, orphans: false, uncertain: false, ...values });

describe("parseDispatchRecord", () => {
  test("preserves the complete document and types known fields", () => {
    const parsed = parseDispatchRecord({ dispatchId: "one", state: "future", extra: { kept: true } });
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.value.dispatchId).toBe("one");
      expect(parsed.value.state).toEqual({ kind: "unknown", value: "future" });
      expect(parsed.value.raw.extra).toEqual({ kept: true });
    }
  });
  const invalidValues = [{ value: null }, { value: [] }, { value: "not an object" }, { value: 4 }];
  test.each(invalidValues)("rejects non-object metadata: $value", ({ value }) => expect(parseDispatchRecord(value).kind).toBe("unknown"));
});

describe("filterDispatchRecords", () => {
  const owned = record({ dispatchId: "owned", parentSessionId: "caller", parentHost: "host" });
  const other = record({ dispatchId: "other", parentSessionId: "someone-else", parentHost: "host" });
  const orphan = record({ dispatchId: "orphan", state: "orphaned" });
  const uncertain = record({ dispatchId: "uncertain", processState: "exited" });
  test.each([
    [options(), [owned]], [options({ all: true }), [owned, other, orphan, uncertain]],
    [options({ orphans: true }), [orphan]], [options({ uncertain: true }), [uncertain]],
    [options({ orphans: true, all: true }), [orphan]],
  ] as const)("selects shell-compatible records", (selection, expected) => {
    expect(filterDispatchRecords([owned, other, orphan, uncertain], selection, { id: "caller", host: "host" }).map((item) => item.dispatchId)).toEqual(expected.map((item) => item.dispatchId));
  });
  test("treats an unrecognised state as open", () => {
    const future = record({ dispatchId: "future", state: "future" });
    expect(filterDispatchRecords([future], options(), { id: "caller", host: "host" })).toEqual([]);
    expect(filterDispatchRecords([future], options({ all: true }), { id: "caller", host: "host" })).toHaveLength(1);
  });
});

describe("formatDispatchList", () => {
  test("matches the exact plain header and columns", () => {
    const value = decorateDispatchRecord(record({ dispatchId: "one" }), { id: "caller", host: "host" });
    expect(formatDispatchList([value], false)).toBe("DISPATCH                               STATE                PROCESS            TERMINAL     OWNERSHIP  WORKTREE\none                                    running              running            owned        not-owned  /worktree\n");
  });
  test("serializes JSON with computed inventory fields", () => {
    const value = decorateDispatchRecord(record({ dispatchId: "one" }), { id: "caller", host: "host" });
    expect(JSON.parse(formatDispatchList([value], true))).toEqual([{ dispatchId: "one", parentSessionId: "session", parentHost: "host", state: "running", processState: "running", terminalState: "owned", worktreePath: "/worktree", ownedByCaller: false, orphan: false, uncertain: false, reconcileResult: "unchanged" }]);
  });
});
