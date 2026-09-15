import { describe, expect, test } from "bun:test";
import {
  addFact,
  editFact,
  emptyStore,
  factInScope,
  factIdValid,
  factStringValid,
  formatFactList,
  removeFact,
  renderFact,
  validateStore,
  type FactStore,
} from "../../src/core/facts.js";

const fact = (id = "one", scope: "global" | "repository" = "global") => ({
  id, measurement: "measured", scope: scope === "global" ? { type: scope } : { type: scope, repository: "repo" },
  provenance: { who: "tester", when: "2026-09-07T19:27:29Z", command: "measure" },
});

describe("fact validation and operations", () => {
  test("creates and validates the empty store", () => {
    expect(emptyStore()).toEqual({ version: 1, facts: [] });
    expect(validateStore(emptyStore())).toEqual({ kind: "valid" });
  });

  test.each(["", "bad id", "bad/slash", "bad\nline"]) ("rejects invalid id %j", (id) => expect(factIdValid(id)).toBe(false));
  test.each(["ok", "", "line\nfeed", "line\rfeed"]) ("checks string newlines %j", (value) => expect(factStringValid(value)).toBe(!value.includes("\n") && !value.includes("\r")));

  test("reports malformed store and invalid fact branches", () => {
    expect(validateStore({ version: 2, facts: [] })).toEqual({ kind: "invalid", message: "invalid fact store: expected version 1 and a facts array" });
    expect(validateStore({ version: 1, facts: [{ ...fact(), id: "bad/id" }] })).toEqual({ kind: "invalid", message: "invalid fact: id must contain only letters, numbers, dot, underscore, and hyphen" });
    expect(validateStore({ version: 1, facts: [{ ...fact(), measurement: "" }] })).toEqual({ kind: "invalid", message: "fact one is missing measurement" });
    expect(validateStore({ version: 1, facts: [{ ...fact(), scope: { type: "local" } }] })).toEqual({ kind: "invalid", message: "fact one has invalid scope: expected global or repository" });
    expect(validateStore({ version: 1, facts: [{ ...fact(), provenance: { ...fact().provenance, when: "yesterday" } }] })).toEqual({ kind: "invalid", message: "fact one has a provenance.when that is not an ISO-8601 timestamp: yesterday" });
  });

  test("adds facts, rejects duplicates, and selects repository scope", () => {
    const added = addFact(emptyStore(), fact());
    expect(added.kind).toBe("ok");
    if (added.kind !== "ok") return;
    expect(addFact(added.value, fact())).toEqual({ kind: "invalid", message: "fact already exists: one" });
    const repoFact = addFact(added.value, fact("repo-fact", "repository"));
    expect(repoFact.kind).toBe("ok");
    if (repoFact.kind !== "ok") return;
    expect(factInScope(repoFact.value, "repo").map((entry) => entry.id)).toEqual(["one", "repo-fact"]);
    expect(factInScope(repoFact.value, "other").map((entry) => entry.id)).toEqual(["one"]);
  });

  test("edits and removes only existing facts", () => {
    const store: FactStore = { version: 1, facts: [fact(), fact("two")] };
    expect(editFact(store, "missing", store)).toEqual({ kind: "invalid", message: "fact not found: missing" });
    expect(editFact(store, "one", { version: 1, facts: [fact("one", "repository")] }).kind).toBe("ok");
    expect(removeFact(store, "missing")).toEqual({ kind: "invalid", message: "fact not found: missing" });
    const removed = removeFact(store, "one");
    expect(removed).toEqual({ kind: "ok", value: { version: 1, facts: [fact("two")] } });
  });

  test("renders JSON and table output", () => {
    const store: FactStore = { version: 1, facts: [fact()] };
    expect(renderFact(fact())).toBe("- one: measured (measured by tester at 2026-09-07T19:27:29Z; rerun: measure)");
    expect(formatFactList(store)).toContain("ID");
    expect(formatFactList(store)).toContain("one");
  });
});
