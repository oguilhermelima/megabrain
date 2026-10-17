import { REF_KINDS, type Ref, type RefKind } from "./types.js";

const URL_REF = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/(\d+)/g;
const PR_REF = /\b(?:PRs?|pull requests?|pull)\s*#?(\d+)\b/gi;
const ISSUE_REF = /(?:^|[^\w&/#-])#(\d{1,6})\b/g;
const COMMIT_REF = /\bcommits?\s+([0-9a-f]{7,40})\b/gi;
const COMMIT_BRACKET = /\[[\w./-]+\s+([0-9a-f]{7,40})\]/g;
const BRANCH_REF = /(?:^|[\s[("'`=:])((?:feat|fix|refactor|chore|docs|test|perf|polish)\/[\w.-]+(?:\/[\w.-]+)*)/g;

/** Issues, PRs, commits and branches named in text, found by pattern alone, each once. The model is not trusted for numbers. */
export function extractRefs(text: string): Ref[] {
  const found = new Map<string, Ref>();
  const add = (ref: Ref): void => {
    const key = `${ref.kind}:${ref.id}`;
    const known = found.get(key);
    if (known === undefined) found.set(key, ref);
    else if (known.url === undefined && ref.url !== undefined) known.url = ref.url;
  };
  for (const match of text.matchAll(URL_REF)) add({ kind: match[1] === "pull" ? "pr" : "issue", id: match[2] as string, url: match[0] });
  const prs = new Set([...text.matchAll(PR_REF)].map((match) => match[1] as string));
  for (const id of prs) add({ kind: "pr", id });
  for (const match of text.matchAll(ISSUE_REF)) if (!prs.has(match[1] as string)) add({ kind: "issue", id: match[1] as string });
  for (const match of text.matchAll(COMMIT_REF)) add({ kind: "commit", id: (match[1] as string).toLowerCase() });
  for (const match of text.matchAll(COMMIT_BRACKET)) add({ kind: "commit", id: match[1] as string });
  for (const match of text.matchAll(BRANCH_REF)) add({ kind: "branch", id: (match[1] as string).replace(/[.,;:)]+$/, "") });
  return [...found.values()];
}

const SHAPE: Record<RefKind, RegExp> = { issue: /^\d{1,7}$/, pr: /^\d{1,7}$/, commit: /^[0-9a-f]{7,40}$/, branch: /^\S+$/, file: /^\S+$/ };

export function isWellFormedRef(value: unknown): value is Ref {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (typeof ref.kind !== "string" || !(REF_KINDS as readonly string[]).includes(ref.kind) || typeof ref.id !== "string") return false;
  if (!SHAPE[ref.kind as RefKind].test(ref.id)) return false;
  return (["url", "title", "state"] as const).every((field) => ref[field] === undefined || typeof ref[field] === "string");
}

/** Refs merged by kind and id; the first title, url and state seen are kept, later ones only fill gaps. */
export function mergeRefs(...lists: ReadonlyArray<readonly Ref[]>): Ref[] {
  const merged = new Map<string, Ref>();
  for (const ref of lists.flat()) {
    const key = `${ref.kind}:${ref.id}`;
    const known = merged.get(key);
    if (known === undefined) { merged.set(key, { ...ref }); continue; }
    for (const field of ["url", "title", "state"] as const) if (known[field] === undefined && ref[field] !== undefined) known[field] = ref[field];
  }
  return [...merged.values()];
}
