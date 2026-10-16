import type { Model } from "./model.js";

export type ChainStep = Readonly<Record<string, unknown>>;
export type ChainDefinition = Readonly<{
  readonly when?: Rule;
  readonly priority?: number;
  readonly steps: readonly ChainStep[];
}>;

// A Rule is a Condition (every present field must hold) optionally combined with all/any/not,
// which nest. Fields take one string or an array of strings meaning any of.
export type Values = string | readonly string[];
export type UsageCondition = Readonly<{ provider: string; window: string; below?: number; above?: number }>;
export type TimeCondition = Readonly<{ days?: readonly string[]; from?: string; to?: string }>;
export type Rule = Readonly<{
  parentAgent?: Values; parentModel?: Values; parentEffort?: Values;
  repo?: Values; branch?: Values; label?: Values;
  usage?: UsageCondition; time?: TimeCondition;
  all?: readonly Rule[]; any?: readonly Rule[]; not?: Rule;
}>;
export type MatchContext = Readonly<{
  parent: Readonly<{ agent?: string; model?: string; effort?: string }>;
  repo?: string; branch?: string; label?: string;
  /** Used percent per `${provider}:${window}`; absent or undefined means unknown. */
  usage?: ReadonlyMap<string, number | undefined>;
  now?: Date;
}>;
export type RuleEvaluation = Readonly<{ matched: boolean; specificity: number; reasons: readonly string[] }>;
export type ChainConfig = Readonly<{
  readonly chains: Readonly<Record<string, ChainDefinition>>;
  readonly defaultSteps: readonly ChainStep[];
  readonly usageLimits?: Readonly<{
    readonly liveProviders?: readonly string[];
    readonly cacheTtlSeconds?: number;
    readonly timeoutSeconds?: number;
    readonly notice?: Readonly<{ readonly enabled?: boolean; readonly intervalSeconds?: number }>;
  }>;
}>;

const valueFields = ["parentAgent", "parentModel", "parentEffort", "repo", "branch", "label"] as const;
const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function asList(value: Values): readonly string[] { return typeof value === "string" ? [value] : value; }
function glob(pattern: string, text: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(text);
}
function isGlob(value: string): boolean { return /[*?]/.test(value); }
function minutes(text: string): number { const [hour, minute] = text.split(":"); return Number(hour) * 60 + Number(minute); }

function inputFor(field: typeof valueFields[number], context: MatchContext): string | undefined {
  switch (field) {
    case "parentAgent": return context.parent.agent;
    case "parentModel": return context.parent.model;
    case "parentEffort": return context.parent.effort;
    case "repo": return context.repo;
    case "branch": return context.branch;
    default: return context.label;
  }
}
function valueMatches(field: typeof valueFields[number], pattern: string, actual: string): boolean {
  if (field === "repo") return glob(pattern, actual) || glob(pattern, actual.replace(/\/+$/, "").split("/").pop() ?? actual);
  return glob(pattern, actual);
}

function leaf(rule: Rule, context: MatchContext): { matched: boolean; count: number; reasons: string[] } {
  let matched = true; let count = 0; const reasons: string[] = [];
  const check = (name: string, ok: boolean, good: string, bad: string): void => { count += 1; if (!ok) matched = false; reasons.push(`${name}: ${ok ? good : bad}`); };
  for (const field of valueFields) {
    const wanted = rule[field]; if (wanted === undefined) continue;
    const actual = inputFor(field, context); const list = asList(wanted);
    if (actual === undefined || actual === "") check(field, false, "", `needs ${list.join(" | ")} but the input is unknown`);
    else check(field, list.some((pattern) => valueMatches(field, pattern, actual)), `${actual} is in ${list.join(" | ")}`, `${actual} is not in ${list.join(" | ")}`);
  }
  if (rule.usage !== undefined) {
    const { provider, window, below, above } = rule.usage; const used = context.usage?.get(`${provider}:${window}`);
    if (used === undefined) check("usage", false, "", `${provider} ${window} usage is unknown`);
    else check("usage", (below === undefined || used < below) && (above === undefined || used > above), `${provider} ${window} at ${used}%`, `${provider} ${window} at ${used}% is outside${below === undefined ? "" : ` below ${below}`}${above === undefined ? "" : ` above ${above}`}`);
  }
  if (rule.time !== undefined) {
    const now = context.now ?? new Date(); const current = now.getHours() * 60 + now.getMinutes(); const { days: wanted, from, to } = rule.time;
    let ok = wanted === undefined || wanted.includes(days[now.getDay()]);
    if (ok && (from !== undefined || to !== undefined)) {
      const start = from === undefined ? 0 : minutes(from); const end = to === undefined ? 1440 : minutes(to);
      ok = start <= end ? current >= start && current < end : current >= start || current < end;
    }
    check("time", ok, "inside the window", "outside the window");
  }
  return { matched, count, reasons };
}

/** Evaluates a rule. Specificity counts the constrained fields along the matched path. */
export function evaluateRule(rule: Rule, context: MatchContext): RuleEvaluation {
  const own = leaf(rule, context);
  let matched = own.matched; let specificity = own.count; const reasons = [...own.reasons];
  for (const child of rule.all ?? []) { const result = evaluateRule(child, context); reasons.push(...result.reasons.map((reason) => `all: ${reason}`)); if (!result.matched) matched = false; specificity += result.specificity; }
  if (rule.any !== undefined) {
    const results = rule.any.map((child) => evaluateRule(child, context)); const hits = results.filter((result) => result.matched);
    for (const result of results) reasons.push(...result.reasons.map((reason) => `any: ${reason}`));
    if (hits.length === 0) { matched = false; reasons.push("any: no alternative matched"); } else specificity += Math.max(...hits.map((hit) => hit.specificity));
  }
  if (rule.not !== undefined) {
    const result = evaluateRule(rule.not, context);
    reasons.push(...result.reasons.map((reason) => `not: ${reason}`));
    if (result.matched) { matched = false; reasons.push("not: the negated rule matched"); } else specificity += staticSpecificity(rule.not);
  }
  return { matched, specificity: matched ? specificity : staticSpecificity(rule), reasons };
}
function staticSpecificity(rule: Rule): number {
  let count = valueFields.filter((field) => rule[field] !== undefined).length + (rule.usage === undefined ? 0 : 1) + (rule.time === undefined ? 0 : 1);
  for (const child of rule.all ?? []) count += staticSpecificity(child);
  if (rule.any !== undefined && rule.any.length > 0) count += Math.max(...rule.any.map(staticSpecificity));
  if (rule.not !== undefined) count += staticSpecificity(rule.not);
  return count;
}

/** The `${provider}:${window}` keys a rule needs live usage for. */
export function usageKeys(rule: Rule | undefined): string[] {
  if (rule === undefined) return [];
  const keys = rule.usage === undefined ? [] : [`${rule.usage.provider}:${rule.usage.window}`];
  for (const child of [...(rule.all ?? []), ...(rule.any ?? []), ...(rule.not === undefined ? [] : [rule.not])]) keys.push(...usageKeys(child));
  return keys;
}
export function chainUsageKeys(config: ChainConfig): string[] {
  const rules = Object.values(config.chains).flatMap((chain) => [chain.when, ...chain.steps.map((step) => step.when as Rule | undefined)]);
  return [...new Set(rules.flatMap(usageKeys))];
}

export type ChainCandidate = Readonly<{ name: string; matched: boolean; specificity: number; priority: number; reasons: readonly string[] }>;
export type StepExplanation = Readonly<{ index: number; step: ChainStep; skipped: boolean; reason: string }>;
export type ChainExplanation = Readonly<{ candidates: readonly ChainCandidate[]; chosen: string | null; steps: readonly StepExplanation[] }>;

/** Per step: skipped unless its `when` rule matches. Indexes are 1-based. */
export function explainSteps(steps: readonly ChainStep[], context: MatchContext): StepExplanation[] {
  return steps.map((step, offset) => {
    const rule = step.when as Rule | undefined;
    if (rule === undefined) return { index: offset + 1, step, skipped: false, reason: "no step rule" };
    const result = evaluateRule(rule, context);
    return { index: offset + 1, step, skipped: !result.matched, reason: result.matched ? "step rule matched" : `step rule did not match; ${result.reasons.filter((reason) => !/: (\S+ )?is in /.test(reason)).join("; ")}` };
  });
}

export function explainChains(config: ChainConfig, context: MatchContext): ChainExplanation {
  const candidates = Object.entries(config.chains).map(([name, chain]): ChainCandidate => {
    const result = evaluateRule(chain.when ?? {}, context);
    return { name, matched: result.matched, specificity: result.specificity, priority: chain.priority ?? 0, reasons: result.reasons };
  });
  const winner = candidates.filter((candidate) => candidate.matched).sort((a, b) => b.priority - a.priority || b.specificity - a.specificity || (a.name < b.name ? -1 : 1))[0];
  const steps = winner === undefined ? config.defaultSteps : config.chains[winner.name].steps;
  return { candidates, chosen: winner?.name ?? null, steps: explainSteps(steps, context) };
}

export type RuleIssue = Readonly<{ path: string; message: string }>;
const fieldNames = new Set<string>([...valueFields, "usage", "time", "all", "any", "not"]);

function stringList(value: unknown, path: string, issues: RuleIssue[]): readonly string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0)) return value as string[];
  issues.push({ path, message: Array.isArray(value) && value.length === 0 ? "must not be empty" : "expected a string or an array of strings" });
  return [];
}
const asRecord = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Field-by-field validation of a rule; paths read like `when.any[1].parentEffort`. Registry checks run only when a registry is given. */
export function validateRule(value: unknown, path: string, registry?: readonly Model[]): RuleIssue[] {
  const issues: RuleIssue[] = []; const rule = asRecord(value);
  if (rule === undefined) return [{ path, message: "expected an object" }];
  for (const key of Object.keys(rule)) if (!fieldNames.has(key)) issues.push({ path: `${path}.${key}`, message: "unknown field" });
  const lists: Partial<Record<typeof valueFields[number], readonly string[]>> = {};
  for (const field of valueFields) if (rule[field] !== undefined) lists[field] = stringList(rule[field], `${path}.${field}`, issues);
  if (rule.usage !== undefined) {
    const usage = asRecord(rule.usage); const base = `${path}.usage`;
    if (usage === undefined) issues.push({ path: base, message: "expected an object" });
    else {
      if (typeof usage.provider !== "string" || !["codex", "claude", "agy", "grok"].includes(usage.provider)) issues.push({ path: `${base}.provider`, message: 'expected "codex", "claude", "agy" or "grok"' });
      if (usage.window !== "5h" && usage.window !== "weekly") issues.push({ path: `${base}.window`, message: 'expected "5h" or "weekly"' });
      for (const bound of ["below", "above"]) if (usage[bound] !== undefined && (typeof usage[bound] !== "number" || usage[bound] < 0 || usage[bound] > 100)) issues.push({ path: `${base}.${bound}`, message: "expected a percent between 0 and 100" });
      if (usage.below === undefined && usage.above === undefined) issues.push({ path: base, message: "needs below or above" });
      for (const key of Object.keys(usage)) if (!["provider", "window", "below", "above"].includes(key)) issues.push({ path: `${base}.${key}`, message: "unknown field" });
    }
  }
  if (rule.time !== undefined) {
    const time = asRecord(rule.time); const base = `${path}.time`;
    if (time === undefined) issues.push({ path: base, message: "expected an object" });
    else {
      if (time.days !== undefined) {
        if (!Array.isArray(time.days) || time.days.length === 0) issues.push({ path: `${base}.days`, message: "expected a non-empty array of days" });
        else time.days.forEach((day, index) => { if (typeof day !== "string" || !days.includes(day)) issues.push({ path: `${base}.days[${index}]`, message: `unknown day "${String(day)}"; expected ${days.slice(1).concat(days[0]).join(", ")}` }); });
      }
      for (const edge of ["from", "to"]) if (time[edge] !== undefined && (typeof time[edge] !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time[edge]))) issues.push({ path: `${base}.${edge}`, message: "expected HH:MM" });
      for (const key of Object.keys(time)) if (!["days", "from", "to"].includes(key)) issues.push({ path: `${base}.${key}`, message: "unknown field" });
    }
  }
  for (const key of ["all", "any"] as const) {
    if (rule[key] === undefined) continue;
    const children = rule[key];
    if (!Array.isArray(children)) issues.push({ path: `${path}.${key}`, message: "expected an array of rules" });
    else children.forEach((child, index) => issues.push(...validateRule(child, `${path}.${key}[${index}]`, registry)));
  }
  if (rule.not !== undefined) issues.push(...validateRule(rule.not, `${path}.not`, registry));
  if (registry !== undefined) issues.push(...registryIssues(lists, path, registry));
  return issues;
}

function registryIssues(lists: Partial<Record<typeof valueFields[number], readonly string[]>>, path: string, registry: readonly Model[]): RuleIssue[] {
  const issues: RuleIssue[] = []; const models = (lists.parentModel ?? []).filter((model) => !isGlob(model)); const agents = (lists.parentAgent ?? []).filter((agent) => !isGlob(agent));
  const scope = (model: string) => registry.filter((entry) => entry.model === model && (agents.length === 0 || agents.includes(entry.agent)));
  for (const model of models) if (scope(model).length === 0) issues.push({ path: `${path}.parentModel`, message: `unknown model "${model}"${agents.length > 0 ? ` for ${agents.join(" | ")}` : ""}` });
  const known = models.flatMap(scope).filter((entry) => entry.reasoning.separateAxis === true);
  if (known.length > 0 && models.length === lists.parentModel?.length) {
    const levels = new Set(known.flatMap((entry) => entry.reasoning.levels ?? []));
    for (const effort of (lists.parentEffort ?? []).filter((value) => !isGlob(value))) if (!levels.has(effort)) issues.push({ path: `${path}.parentEffort`, message: `unknown effort "${effort}" for ${models.join(" | ")}` });
  }
  return issues;
}

function priorityIssue(priority: unknown): RuleIssue[] { return priority === undefined || (typeof priority === "number" && Number.isFinite(priority)) ? [] : [{ path: "priority", message: "expected a number" }]; }
/** Rule-level issues of a stored chain: its `when`, its priority and every step `when`. */
export function validateChainRules(chain: Readonly<{ when?: unknown; priority?: unknown; steps?: unknown }>, registry?: readonly Model[]): RuleIssue[] {
  const issues = [...priorityIssue(chain.priority)];
  if (chain.when !== undefined) issues.push(...validateRule(chain.when, "when", registry));
  if (Array.isArray(chain.steps)) chain.steps.forEach((step, index) => { const when = asRecord(step)?.when; if (when !== undefined) issues.push(...validateRule(when, `steps[${index}].when`, registry)); });
  return issues;
}

export type ChainSelection =
  | { readonly kind: "selected"; readonly name: string; readonly steps: readonly ChainStep[]; readonly usedDefault: boolean; readonly reason: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "not-found"; readonly name: string }
  | { readonly kind: "default"; readonly name: "defaultSteps"; readonly steps: readonly ChainStep[]; readonly reason: string };

export function selectChain(
  config: ChainConfig,
  explicitName: string | undefined,
  parent: MatchContext["parent"],
  explicitSource: "name" | "flag" = "name",
  extra: Omit<MatchContext, "parent"> = {},
): ChainSelection {
  if (explicitName !== undefined && explicitName.length > 0) {
    const chain = config.chains[explicitName];
    if (chain !== undefined) return { kind: "selected", name: explicitName, steps: chain.steps, usedDefault: false, reason: explicitSource === "flag" ? "explicit --chain requested" : "explicit name given" };
    return { kind: "not-found", name: explicitName };
  }
  const explanation = explainChains(config, { parent, ...extra });
  const winner = explanation.candidates.find((candidate) => candidate.name === explanation.chosen);
  if (winner !== undefined) return { kind: "selected", name: winner.name, steps: config.chains[winner.name].steps, usedDefault: false, reason: `selector match with ${winner.specificity} field(s)${winner.priority !== 0 ? ` at priority ${winner.priority}` : ""}` };
  const hasSelectorFields = Object.values(config.chains).some((chain) => chain.when !== undefined && Object.keys(chain.when).length > 0);
  const reason = hasSelectorFields && (parent.agent === undefined || parent.agent.length === 0)
    ? "parent agent is unknown; no selector matched; using defaultSteps"
    : "no selector matched; using defaultSteps";
  return { kind: "default", name: "defaultSteps", steps: config.defaultSteps, reason };
}
