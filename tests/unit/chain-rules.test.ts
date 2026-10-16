import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRule, selectChain, type ChainConfig, type MatchContext, type Rule } from "../../src/core/chain.js";
import { chainExplain, editStep, executeChain, moveStep, saveChain } from "../../src/cli/commands/chain.js";
import type { ModelRegistry } from "../../src/core/model.js";

const luna = { agent: "codex", model: "gpt-6-luna", effort: "medium" };
const wednesday = new Date(2026, 9, 14, 10, 30); // local Wed 10:30

function context(overrides: Partial<MatchContext> = {}): MatchContext {
  return { parent: { agent: "claude", model: "claude-opus-5-5", effort: "high" }, ...overrides };
}
function matches(rule: Rule, overrides: Partial<MatchContext> = {}): boolean { return evaluateRule(rule, context(overrides)).matched; }

describe("rule grammar", () => {
  test("a condition ANDs its fields and keeps single-string meaning", () => {
    expect(matches({ parentAgent: "claude" })).toBe(true);
    expect(matches({ parentAgent: "claude", parentModel: "claude-opus-5-5" })).toBe(true);
    expect(matches({ parentAgent: "claude", parentModel: "other" })).toBe(false);
  });
  test("an empty condition matches everything", () => { expect(matches({})).toBe(true); });
  test("array values mean any of", () => {
    expect(matches({ parentEffort: ["low", "medium", "high"] })).toBe(true);
    expect(matches({ parentEffort: ["low", "medium"] })).toBe(false);
    expect(matches({ parentAgent: ["codex", "claude"] })).toBe(true);
  });
  test("a constrained field with no known input does not match", () => {
    expect(matches({ parentModel: "x" }, { parent: { agent: "claude" } })).toBe(false);
    expect(matches({ repo: "megabrain" })).toBe(false);
  });
  test("all, any and not nest", () => {
    expect(matches({ all: [{ parentAgent: "claude" }, { parentEffort: "high" }] })).toBe(true);
    expect(matches({ all: [{ parentAgent: "claude" }, { parentEffort: "low" }] })).toBe(false);
    expect(matches({ any: [{ parentAgent: "codex" }, { parentEffort: "high" }] })).toBe(true);
    expect(matches({ any: [] })).toBe(false);
    expect(matches({ not: { parentAgent: "codex" } })).toBe(true);
    expect(matches({ not: { parentAgent: "claude" } })).toBe(false);
    expect(matches({ all: [{ not: { any: [{ parentAgent: "codex" }, { parentAgent: "agy" }] } }, { any: [{ parentEffort: "high" }] }] })).toBe(true);
  });
  test("repo, branch and label take globs; repo matches name or path", () => {
    const extra = { repo: "/Users/x/Workspaces/megabrain", branch: "feat/chain-rules", label: "lane CHC" };
    expect(matches({ branch: "feat/*" }, extra)).toBe(true);
    expect(matches({ branch: ["fix/*", "feat/chain-*"] }, extra)).toBe(true);
    expect(matches({ branch: "fix/*" }, extra)).toBe(false);
    expect(matches({ repo: "megabrain" }, extra)).toBe(true);
    expect(matches({ repo: "mega*" }, extra)).toBe(true);
    expect(matches({ repo: "/Users/x/Workspaces/*" }, extra)).toBe(true);
    expect(matches({ label: "lane *" }, extra)).toBe(true);
    expect(matches({ label: "other*" }, extra)).toBe(false);
  });
  test("usage compares the used percent below and above", () => {
    const usage = new Map([["codex:5h", 40], ["claude:weekly", undefined]]);
    expect(matches({ usage: { provider: "codex", window: "5h", below: 95 } }, { usage })).toBe(true);
    expect(matches({ usage: { provider: "codex", window: "5h", below: 40 } }, { usage })).toBe(false);
    expect(matches({ usage: { provider: "codex", window: "5h", above: 39 } }, { usage })).toBe(true);
    expect(matches({ usage: { provider: "codex", window: "5h", above: 10, below: 30 } }, { usage })).toBe(false);
    expect(matches({ usage: { provider: "claude", window: "weekly", below: 99 } }, { usage })).toBe(false);
    expect(matches({ usage: { provider: "agy", window: "5h", below: 99 } }, { usage })).toBe(false);
  });
  test("time matches local days and a from/to window, wrapping midnight", () => {
    expect(matches({ time: { days: ["mon", "wed"] } }, { now: wednesday })).toBe(true);
    expect(matches({ time: { days: ["sat", "sun"] } }, { now: wednesday })).toBe(false);
    expect(matches({ time: { from: "09:00", to: "18:00" } }, { now: wednesday })).toBe(true);
    expect(matches({ time: { from: "11:00", to: "18:00" } }, { now: wednesday })).toBe(false);
    expect(matches({ time: { from: "22:00", to: "11:00" } }, { now: wednesday })).toBe(true);
    expect(matches({ time: { from: "22:00", to: "06:00" } }, { now: wednesday })).toBe(false);
  });
  test("the person's example matches claude opus 5.5 or codex astra with the listed efforts", () => {
    const rule: Rule = { any: [
      { parentAgent: "claude", parentModel: "claude-opus-5-5", parentEffort: ["low", "medium", "high"] },
      { parentAgent: "codex", parentModel: "gpt-6-astra", parentEffort: ["medium", "high"] },
    ] };
    expect(matches(rule)).toBe(true);
    expect(matches(rule, { parent: { agent: "codex", model: "gpt-6-astra", effort: "high" } })).toBe(true);
    expect(matches(rule, { parent: { agent: "codex", model: "gpt-6-astra", effort: "low" } })).toBe(false);
    expect(matches(rule, { parent: { agent: "claude", model: "claude-opus-5-5", effort: "xhigh" } })).toBe(false);
  });
  test("reasons name what matched and what did not", () => {
    const result = evaluateRule({ parentAgent: "codex" }, context());
    expect(result.matched).toBe(false);
    expect(result.reasons.join(" ")).toContain("parentAgent");
  });
});

describe("selection", () => {
  const step = { agent: "codex", model: "m" };
  test("old single-field selectors keep their meaning and specificity", () => {
    const config: ChainConfig = { chains: { broad: { when: { parentAgent: "claude" }, steps: [step] }, narrow: { when: { parentAgent: "claude", parentEffort: "high" }, steps: [step] } }, defaultSteps: [] };
    expect(selectChain(config, undefined, { agent: "claude", effort: "high" })).toMatchObject({ kind: "selected", name: "narrow" });
    expect(selectChain(config, undefined, { agent: "claude", effort: "low" })).toMatchObject({ kind: "selected", name: "broad" });
  });
  test("priority beats specificity", () => {
    const config: ChainConfig = { chains: { narrow: { when: { parentAgent: "claude", parentEffort: "high" }, steps: [step] }, loud: { when: { parentAgent: "claude" }, priority: 5, steps: [step] } }, defaultSteps: [] };
    expect(selectChain(config, undefined, { agent: "claude", effort: "high" })).toMatchObject({ name: "loud" });
  });
  test("equal priority prefers the more specific rule across any and all", () => {
    const config: ChainConfig = { chains: {
      anyOne: { when: { any: [{ parentAgent: "claude" }, { parentAgent: "codex" }] }, steps: [step] },
      allTwo: { when: { all: [{ parentAgent: "claude" }, { parentEffort: "high" }] }, steps: [step] },
    }, defaultSteps: [] };
    expect(selectChain(config, undefined, { agent: "claude", effort: "high" })).toMatchObject({ name: "allTwo" });
  });
  test("a full tie falls to the chain name, never ambiguous", () => {
    const config: ChainConfig = { chains: { zeta: { when: { parentAgent: "claude" }, steps: [step] }, alpha: { when: { parentAgent: "claude" }, steps: [step] } }, defaultSteps: [] };
    expect(selectChain(config, undefined, { agent: "claude" })).toMatchObject({ kind: "selected", name: "alpha" });
  });
  test("extra inputs reach the matcher and usage decides", () => {
    const config: ChainConfig = { chains: { cheap: { when: { all: [{ parentAgent: "claude" }, { usage: { provider: "codex", window: "5h", below: 50 } }] }, steps: [step] } }, defaultSteps: [] };
    const low = selectChain(config, undefined, { agent: "claude" }, "name", { usage: new Map([["codex:5h", 10]]) });
    const high = selectChain(config, undefined, { agent: "claude" }, "name", { usage: new Map([["codex:5h", 80]]) });
    expect(low).toMatchObject({ kind: "selected", name: "cheap" });
    expect(high.kind).toBe("default");
  });
  test("the person's real chains file selects the same chains as before", () => {
    const real = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/chains-real-shape.json"), "utf8")) as ChainConfig;
    for (const agent of ["claude", "codex", "agy"]) expect(selectChain(real, undefined, { agent, model: "x", effort: "high" })).toMatchObject({ kind: "selected", name: agent });
    expect(selectChain(real, undefined, { agent: "grok" }).kind).toBe("default");
    expect(selectChain(real, undefined, {}).kind).toBe("default");
  });
});

describe("step when", () => {
  test("explain skips a step whose rule does not match", async () => {
    const root = fixtureRoot();
    try {
      writeChains(root.state, { chains: { c: { when: {}, steps: [
        { ...luna, when: { parentEffort: ["low"] } },
        { agent: "claude", model: "claude-sonnet-5", effort: "high", when: { branch: "feat/*" } },
        { agent: "claude", model: "claude-sonnet-5", effort: "high" },
      ] } }, defaultSteps: [] });
      const result = await chainExplain({ parentAgent: "claude", parentModel: "claude-opus-5-5", parentEffort: "high", branch: "feat/x" }, root.environment);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.value.chosen).toBe("c");
      expect(result.value.steps.map((entry) => [entry.index, entry.skipped])).toEqual([[1, true], [2, false], [3, false]]);
      expect(result.value.steps[0].reason).toContain("parentEffort");
    } finally { root.cleanup(); }
  });
});

describe("explain", () => {
  test("lists every candidate with matched, specificity, priority and reasons", async () => {
    const root = fixtureRoot();
    try {
      writeChains(root.state, { chains: {
        claude: { when: { parentAgent: "claude" }, steps: [luna] },
        opus: { when: { parentAgent: "claude", parentModel: "claude-opus-5-5" }, steps: [luna] },
        codex: { when: { parentAgent: "codex" }, steps: [luna] },
      }, defaultSteps: [] });
      const run = await executeChain(["explain", "--parent-agent", "claude", "--parent-model", "claude-opus-5-5", "--parent-effort", "high", "--json"], root.environment);
      expect(run.kind).toBe("ok");
      if (run.kind !== "ok") return;
      const out = JSON.parse(run.value);
      expect(out.chosen).toBe("opus");
      const byName = Object.fromEntries(out.candidates.map((c: { name: string }) => [c.name, c]));
      expect(byName.opus).toMatchObject({ matched: true, specificity: 2, priority: 0 });
      expect(byName.claude).toMatchObject({ matched: true, specificity: 1 });
      expect(byName.codex).toMatchObject({ matched: false });
      expect(byName.codex.reasons.length).toBeGreaterThan(0);
      expect(out.steps[0]).toMatchObject({ index: 1, skipped: false });
    } finally { root.cleanup(); }
  });
  test("falls back to defaultSteps with chosen null", async () => {
    const root = fixtureRoot();
    try {
      writeChains(root.state, { chains: { codex: { when: { parentAgent: "codex" }, steps: [luna] } }, defaultSteps: [{ agent: "claude", model: "claude-sonnet-5", effort: "high" }] });
      const result = await chainExplain({ parentAgent: "agy" }, root.environment);
      expect(result.kind === "ok" && result.value.chosen).toBeNull();
      expect(result.kind === "ok" && result.value.steps).toHaveLength(1);
    } finally { root.cleanup(); }
  });
});

describe("validation messages name the path", () => {
  test("an unknown effort for the model", async () => {
    const root = fixtureRoot();
    try {
      const when = { any: [{ parentAgent: "claude", parentModel: "claude-opus-5-5", parentEffort: ["low"] }, { parentAgent: "codex", parentModel: "gpt-6-astra", parentEffort: ["medium", "ultra"] }] };
      const result = await executeChain(["add", "bad", "--when", JSON.stringify(when), "--steps", JSON.stringify([luna])], root.environment);
      expect(result).toMatchObject({ kind: "failed" });
      if (result.kind === "failed") expect(result.error).toContain('when.any[1].parentEffort: unknown effort "ultra" for gpt-6-astra');
    } finally { root.cleanup(); }
  });
  test("an unknown model, an unknown key and a malformed rule", async () => {
    const root = fixtureRoot();
    try {
      const run = async (when: unknown) => {
        const result = await executeChain(["save", "bad", "--when", JSON.stringify(when), "--steps", JSON.stringify([luna])], root.environment);
        return result.kind === "failed" ? result.error : "ok";
      };
      expect(await run({ all: [{ parentAgent: "codex", parentModel: "nope" }] })).toContain('when.all[0].parentModel: unknown model "nope"');
      expect(await run({ parentAgnet: "codex" })).toContain('when.parentAgnet: unknown field');
      expect(await run({ any: "codex" })).toContain("when.any: expected an array of rules");
      expect(await run({ not: { usage: { provider: "codex", window: "1h" } } })).toContain('when.not.usage.window: expected "5h" or "weekly"');
      expect(await run({ time: { days: ["funday"] } })).toContain('when.time.days[0]: unknown day "funday"');
      expect(await run({ time: { from: "9am" } })).toContain("when.time.from: expected HH:MM");
    } finally { root.cleanup(); }
  });
  test("a bad step when names the step", async () => {
    const root = fixtureRoot();
    try {
      const result = await executeChain(["save", "bad", "--when", "{}", "--steps", JSON.stringify([{ ...luna, when: { parentAgent: 3 } }])], root.environment);
      expect(result.kind === "failed" && result.error).toContain("steps[0].when.parentAgent: expected a string or an array of strings");
    } finally { root.cleanup(); }
  });
  test("--allow-unknown-model lets an unregistered parent model through", async () => {
    const root = fixtureRoot();
    try {
      const result = await executeChain(["save", "free", "--allow-unknown-model", "--when", JSON.stringify({ parentModel: "brand-new" }), "--steps", JSON.stringify([luna])], root.environment);
      expect(result.kind).toBe("ok");
    } finally { root.cleanup(); }
  });
  test("saveChain stores the new grammar and priority as given; list prints it as stored", async () => {
    const root = fixtureRoot();
    try {
      const when = { any: [{ parentAgent: "claude", parentEffort: ["low", "high"] }, { not: { branch: "main" } }] };
      expect((saveChain("flex", { when, priority: 3, steps: [luna] }, root.environment)).kind).toBe("ok");
      const listed = await executeChain(["list", "--json"], root.environment);
      expect(listed.kind).toBe("ok");
      if (listed.kind === "ok") expect(JSON.parse(listed.value).chains[0]).toMatchObject({ name: "flex", priority: 3, when });
    } finally { root.cleanup(); }
  });
});

describe("step edit and move", () => {
  const three = [luna, { agent: "claude", model: "claude-sonnet-5", effort: "high" }, { agent: "codex", model: "gpt-6-astra", effort: "high" }];
  test("edit patches a step in place and keeps its other fields", async () => {
    const root = fixtureRoot();
    try {
      writeChains(root.state, { chains: { c: { when: {}, steps: three } }, defaultSteps: [] });
      const result = editStep("c", 1, { effort: "high", until: { usedPercent: 90, window: "5h" }, when: { branch: "feat/*" } }, root.environment);
      expect(result.kind).toBe("ok");
      const stored = JSON.parse(readFileSync(join(root.state, "chains.json"), "utf8")).chains.c.steps;
      expect(stored[0]).toEqual({ agent: "codex", model: "gpt-6-luna", effort: "high", until: { usedPercent: 90, window: "5h" }, when: { branch: "feat/*" } });
      expect(stored[1]).toEqual(three[1]);
      expect(editStep("c", 1, { until: null, when: null }, root.environment).kind).toBe("ok");
      const cleared = JSON.parse(readFileSync(join(root.state, "chains.json"), "utf8")).chains.c.steps[0];
      expect(cleared.until).toBeUndefined();
      expect(cleared.when).toBeUndefined();
    } finally { root.cleanup(); }
  });
  test("edit rejects bad index, unknown model and a bad rule without writing", async () => {
    const root = fixtureRoot();
    try {
      writeChains(root.state, { chains: { c: { when: {}, steps: three } }, defaultSteps: [] });
      const chains = () => JSON.parse(readFileSync(join(root.state, "chains.json"), "utf8")).chains;
      expect(editStep("c", 1, { effort: "medium" }, root.environment).kind).toBe("ok"); // first read normalises the file; snapshot after it
      const before = chains();
      expect(editStep("c", 0, { effort: "high" }, root.environment)).toMatchObject({ kind: "failed" });
      expect(editStep("c", 9, { effort: "high" }, root.environment)).toMatchObject({ kind: "failed" });
      expect(editStep("missing", 1, { effort: "high" }, root.environment)).toMatchObject({ kind: "failed" });
      expect(editStep("c", 1, { model: "nope" }, root.environment)).toMatchObject({ kind: "failed" });
      expect(editStep("c", 1, { when: { bogus: 1 } }, root.environment)).toMatchObject({ kind: "failed" });
      expect(chains()).toEqual(before);
    } finally { root.cleanup(); }
  });
  test("move reorders steps", async () => {
    const root = fixtureRoot();
    try {
      writeChains(root.state, { chains: { c: { when: {}, steps: three } }, defaultSteps: [] });
      expect(moveStep("c", 3, 1, root.environment).kind).toBe("ok");
      expect(JSON.parse(readFileSync(join(root.state, "chains.json"), "utf8")).chains.c.steps.map((s: { model: string }) => s.model)).toEqual(["gpt-6-astra", "gpt-6-luna", "claude-sonnet-5"]);
      expect(moveStep("c", 1, 5, root.environment)).toMatchObject({ kind: "failed" });
      expect(moveStep("c", 0, 1, root.environment)).toMatchObject({ kind: "failed" });
      expect(moveStep("c", 1, 0, root.environment)).toMatchObject({ kind: "failed" });
    } finally { root.cleanup(); }
  });
  test("the CLI verbs wire to the same operations", async () => {
    const root = fixtureRoot();
    try {
      writeChains(root.state, { chains: { c: { when: {}, steps: three } }, defaultSteps: [] });
      const edited = await executeChain(["step", "edit", "c", "2", "--effort", "medium", "--when", JSON.stringify({ label: "x*" }), "--until", JSON.stringify({ usedPercent: 80, window: "weekly" }), "--json"], root.environment);
      expect(edited.kind).toBe("ok");
      const cleared = await executeChain(["step", "edit", "c", "2", "--no-until", "--no-when", "--json"], root.environment);
      expect(cleared.kind).toBe("ok");
      const moved = await executeChain(["step", "move", "c", "1", "3", "--json"], root.environment);
      expect(moved.kind).toBe("ok");
      const stored = JSON.parse(readFileSync(join(root.state, "chains.json"), "utf8")).chains.c.steps;
      expect(stored.map((s: { model: string }) => s.model)).toEqual(["claude-sonnet-5", "gpt-6-astra", "gpt-6-luna"]);
      expect(stored[0]).toEqual({ agent: "claude", model: "claude-sonnet-5", effort: "medium" });
    } finally { root.cleanup(); }
  });
});

describe("priority flag and dry run", () => {
  test("--priority is stored, and list omits a zero priority", async () => {
    const root = fixtureRoot();
    try {
      expect((await executeChain(["save", "hi", "--when", "{}", "--steps", JSON.stringify([luna]), "--priority", "4", "--json"], root.environment)).kind).toBe("ok");
      expect((await executeChain(["add", "zero", "--when", "{}", "--steps", JSON.stringify([luna]), "--priority", "0"], root.environment)).kind).toBe("ok");
      expect((await executeChain(["add", "none", "--when", "{}", "--steps", JSON.stringify([luna])], root.environment)).kind).toBe("ok");
      const listed = await executeChain(["list", "--json"], root.environment);
      const chains = listed.kind === "ok" ? JSON.parse(listed.value).chains : [];
      const byName = Object.fromEntries(chains.map((c: { name: string }) => [c.name, c]));
      expect(byName.hi.priority).toBe(4);
      expect("priority" in byName.zero).toBe(false);
      expect("priority" in byName.none).toBe(false);
      expect((await executeChain(["save", "bad", "--when", "{}", "--steps", JSON.stringify([luna]), "--priority", "x"], root.environment)).kind).toBe("failed");
    } finally { root.cleanup(); }
  });
  test("--dry-run --json validates without writing and exits 0 when ok", async () => {
    const root = fixtureRoot();
    try {
      const result = await executeChain(["save", "probe", "--dry-run", "--json", "--when", JSON.stringify({ parentAgent: "claude" }), "--steps", JSON.stringify([luna])], root.environment);
      expect(result).toMatchObject({ kind: "ok" });
      if (result.kind === "ok") { expect(JSON.parse(result.value)).toEqual({ ok: true, errors: [] }); expect(result.exitCode ?? 0).toBe(0); }
      expect(() => readFileSync(join(root.state, "chains.json"), "utf8")).toThrow();
    } finally { root.cleanup(); }
  });
  test("--dry-run --json reports path-style errors with exit 2 and writes nothing", async () => {
    const root = fixtureRoot();
    try {
      const when = { any: [{ parentAgent: "claude" }, { parentAgent: "codex", parentModel: "gpt-6-astra", parentEffort: "ultra" }] };
      const result = await executeChain(["save", "probe", "--dry-run", "--json", "--when", JSON.stringify(when), "--steps", JSON.stringify([{ ...luna, model: "nope" }])], root.environment);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.exitCode).toBe(2);
      const body = JSON.parse(result.value);
      expect(body.ok).toBe(false);
      expect(body.errors).toContainEqual({ path: "when.any[1].parentEffort", message: 'unknown effort "ultra" for gpt-6-astra' });
      expect(body.errors.some((e: { path: string }) => e.path === "steps[0].model")).toBe(true);
      expect(() => readFileSync(join(root.state, "chains.json"), "utf8")).toThrow();
    } finally { root.cleanup(); }
  });
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "megabrain-chain-rules-root-"));
  const state = mkdtempSync(join(tmpdir(), "megabrain-chain-rules-state-"));
  mkdirSync(join(root, ".megabrain"), { recursive: true });
  const registry: ModelRegistry = { version: 1, models: [
    { agent: "claude", model: "claude-opus-5-5", reasoning: { separateAxis: true, levels: ["low", "medium", "high", "xhigh"] }, provenance: { kind: "sourced" } },
    { agent: "claude", model: "claude-sonnet-5", reasoning: { separateAxis: true, levels: ["low", "medium", "high"] }, provenance: { kind: "sourced" } },
    { agent: "codex", model: "gpt-6-astra", reasoning: { separateAxis: true, levels: ["low", "medium", "high"] }, provenance: { kind: "sourced" } },
    { agent: "codex", model: "gpt-6-luna", reasoning: { separateAxis: true, levels: ["low", "medium", "high"] }, provenance: { kind: "sourced" } },
  ] };
  writeFileSync(join(root, ".megabrain/models.json"), JSON.stringify(registry));
  return {
    state,
    environment: { MEGABRAIN_STATE_DIR: state, HOME: state, MEGABRAIN_ROOT: root },
    cleanup() { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); },
  };
}
function writeChains(state: string, config: unknown): void { writeFileSync(join(state, "chains.json"), JSON.stringify(config)); }
