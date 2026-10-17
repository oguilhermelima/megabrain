import { REF_KINDS, type Ref, type RefKind } from "./types.js";

export type RefEvidence = { source?: Ref["source"]; origin?: Ref["origin"]; at?: string };
const URL_REF = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/(\d+)/g;
const PR_REF = /\b(?:PRs?|pull requests?|pull)\s*#?(\d+)\b/gi;
const ISSUE_REF = /(?:^|[^\w&/#-])#(\d{1,6})\b/g;
const COMMIT_REF = /\b(?:commit|commits)\s+([0-9a-f]{7,40})\b/gi;
const COMMIT_BRACKET = /\[[\w./-]+\s+([0-9a-f]{7,40})\]/g;
const GIT_HASH_LINE = /^\s*([0-9a-f]{7,40})(?:\s|$)/gim;
const BRANCH_REF = /(?:^|[\s[("'`=:])((?:feat|fix|refactor|chore|docs|test|perf|polish)\/[\w.-]+(?:\/[\w.-]+)*)/g;
const HEX_COLOR = /^(?:[a-f\d]{6}|[a-f\d]{3})$/i;

function validNumber(id: string): boolean { return /^[1-9]\d{0,4}$/.test(id); }
function make(kind: RefKind, id: string, evidence: RefEvidence): Ref {
  const measured = evidence.at !== undefined || evidence.origin !== undefined;
  return { kind, id, ...(measured && evidence.origin !== undefined ? { origin: evidence.origin } : {}), ...(measured && evidence.source !== undefined ? { source: evidence.source } : {}), ...(evidence.at === undefined ? {} : { firstAt: evidence.at, lastAt: evidence.at, count: 1 }) };
}

/** Extracts refs only from evidence of the appropriate kind; plain text cannot establish a commit or branch. */
export function extractRefs(text: string, evidence: RefEvidence = {}): Ref[] {
  const found = new Map<string, Ref>();
  const add = (ref: Ref): void => {
    const key = `${ref.kind}:${ref.id}`;
    const known = found.get(key);
    if (known === undefined) { found.set(key, ref); return; }
    if (ref.count !== undefined) known.count = (known.count ?? 0) + ref.count;
    if (ref.lastAt !== undefined && (known.lastAt === undefined || ref.lastAt > known.lastAt)) known.lastAt = ref.lastAt;
    if (known.url === undefined && ref.url !== undefined) known.url = ref.url;
  };
  for (const match of text.matchAll(URL_REF)) {
    const id = match[2] as string;
    if (validNumber(id)) add({ ...make(match[1] === "pull" ? "pr" : "issue", id, { ...evidence, source: evidence.source ?? "gh-output" }), url: match[0] });
  }
  const prs = new Set<string>();
  for (const match of text.matchAll(PR_REF)) {
    const id = match[1] as string;
    if (validNumber(id)) { prs.add(id); add(make("pr", id, evidence)); }
  }
  for (const match of text.matchAll(ISSUE_REF)) {
    const id = match[1] as string;
    if (!validNumber(id) || prs.has(id) || (HEX_COLOR.test(id) && (id.length === 6 || /[a-f]/i.test(id)) && !new RegExp(`(?:color|background|border|fill|stroke)\\s*[:=][^\\n]{0,24}#${id}\\b`, "i").test(text))) continue;
    // Bare three digit values are ambiguous with CSS shorthand; explicit issue and PR forms were handled above.
    if (id.length === 3 && evidence.source !== "gh-output" && new RegExp(`(?:color|background|border|fill|stroke)\\s*[:=][^\\n]{0,24}#${id}\\b`, "i").test(text)) continue;
    add(make("issue", id, evidence));
  }
  if (evidence.source === "git-output") {
    for (const match of text.matchAll(COMMIT_REF)) add(make("commit", (match[1] as string).toLowerCase(), evidence));
    for (const match of text.matchAll(COMMIT_BRACKET)) add(make("commit", (match[1] as string).toLowerCase(), evidence));
    for (const match of text.matchAll(GIT_HASH_LINE)) add(make("commit", (match[1] as string).toLowerCase(), evidence));
    for (const match of text.matchAll(BRANCH_REF)) add(make("branch", (match[1] as string).replace(/[.,;:)]+$/, ""), evidence));
  }
  if (evidence.source === "megabrain-output") for (const match of text.matchAll(BRANCH_REF)) add(make("branch", (match[1] as string).replace(/[.,;:)]+$/, ""), evidence));
  return [...found.values()].sort((a, b) => text.indexOf(a.id) - text.indexOf(b.id));
}

export function isWellFormedRef(value: unknown): value is Ref {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (typeof ref.kind !== "string" || !(REF_KINDS as readonly string[]).includes(ref.kind) || typeof ref.id !== "string") return false;
  const kind = ref.kind as RefKind;
  if (kind === "issue" || kind === "pr") { if (!validNumber(ref.id)) return false; }
  else if (kind === "commit") { if (!/^[0-9a-f]{7,40}$/i.test(ref.id)) return false; }
  else if (!/^\S+$/.test(ref.id)) return false;
  return (["url", "title", "state", "origin", "source", "firstAt", "lastAt"] as const).every((field) => ref[field] === undefined || typeof ref[field] === "string")
    && (ref.count === undefined || (typeof ref.count === "number" && Number.isInteger(ref.count) && ref.count > 0))
    && (ref.origin === undefined || ref.origin === "created" || ref.origin === "mentioned")
    && (ref.source === undefined || ["git-output", "gh-output", "megabrain-output", "text"].includes(String(ref.source)));
}

/** Merges repeated evidence by kind and id, retaining the earliest creation and latest mention metadata. */
export function mergeRefs(...lists: ReadonlyArray<readonly Ref[]>): Ref[] {
  const merged = new Map<string, Ref>();
  for (const ref of lists.flat()) {
    const key = `${ref.kind}:${ref.id}`;
    const known = merged.get(key);
    if (known === undefined) { merged.set(key, { ...ref }); continue; }
    for (const field of ["url", "title", "state"] as const) if (known[field] === undefined && ref[field] !== undefined) known[field] = ref[field];
    if (ref.origin === "created") known.origin = "created";
    if (ref.source !== undefined) known.source = ref.source;
    if (ref.firstAt !== undefined && (known.firstAt === undefined || ref.firstAt < known.firstAt)) known.firstAt = ref.firstAt;
    if (ref.lastAt !== undefined && (known.lastAt === undefined || ref.lastAt > known.lastAt)) known.lastAt = ref.lastAt;
    if (ref.count !== undefined) known.count = (known.count ?? 0) + ref.count;
  }
  return [...merged.values()];
}

export function rankAndCapRefs(refs: readonly Ref[], limit = 12): Ref[] {
  const ranked = [...refs].sort((a, b) => Number(b.origin === "created") - Number(a.origin === "created") || (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || (b.count ?? 0) - (a.count ?? 0));
  const counts = new Map<RefKind, number>();
  return ranked.filter((ref) => { const count = counts.get(ref.kind) ?? 0; if (count >= limit) return false; counts.set(ref.kind, count + 1); return true; });
}
