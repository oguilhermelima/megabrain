export type Fact = {
  readonly id: string;
  readonly measurement: string;
  readonly scope: { readonly type: "global" } | { readonly type: "repository"; readonly repository: string };
  readonly provenance: { readonly who: string; readonly when: string; readonly command: string };
};

export type FactStore = { readonly version: 1; readonly facts: readonly Fact[] };
export type FactValidation = { readonly kind: "valid" } | { readonly kind: "invalid"; readonly message: string };
export type FactOperation<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "invalid"; readonly message: string };

export function emptyStore(): FactStore { return { version: 1, facts: [] }; }
export function factIdValid(id: string): boolean { return id.length > 0 && /^[A-Za-z0-9._-]+$/.test(id); }
export function factStringValid(value: string): boolean { return !/[\n\r]/.test(value); }

export function validateStore(value: unknown): FactValidation {
  if (typeof value !== "object" || value === null) return { kind: "invalid", message: "invalid fact store: expected version 1 and a facts array" };
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.facts)) return { kind: "invalid", message: "invalid fact store: expected version 1 and a facts array" };
  const ids = new Set<string>();
  for (const item of root.facts) {
    if (typeof item !== "object" || item === null) return { kind: "invalid", message: "invalid fact store: facts must contain valid JSON objects" };
    const fact = item as Record<string, unknown>;
    const id = typeof fact.id === "string" ? fact.id : "";
    if (!factIdValid(id)) return { kind: "invalid", message: "invalid fact: id must contain only letters, numbers, dot, underscore, and hyphen" };
    if (ids.has(id)) return { kind: "invalid", message: `invalid fact ${id}: duplicate id` };
    ids.add(id);
    if (typeof fact.measurement !== "string" || fact.measurement.length === 0) return { kind: "invalid", message: `fact ${id} is missing measurement` };
    const scope = fact.scope;
    if (typeof scope !== "object" || scope === null || typeof (scope as Record<string, unknown>).type !== "string") return { kind: "invalid", message: `fact ${id} has invalid scope: expected global or repository` };
    const scopeRecord = scope as Record<string, unknown>;
    if (scopeRecord.type === "global") {
      if (Object.keys(scopeRecord).length !== 1) return { kind: "invalid", message: `fact ${id} has unsupported scope fields` };
    } else if (scopeRecord.type === "repository") {
      if (typeof scopeRecord.repository !== "string" || scopeRecord.repository.length === 0) return { kind: "invalid", message: `fact ${id} repository scope is missing repository` };
      if (Object.keys(scopeRecord).some((key) => !["type", "repository"].includes(key))) return { kind: "invalid", message: `fact ${id} has unsupported scope fields` };
    } else return { kind: "invalid", message: `fact ${id} has invalid scope: expected global or repository` };
    const provenance = fact.provenance;
    if (typeof provenance !== "object" || provenance === null) return { kind: "invalid", message: `fact ${id} is missing provenance.who` };
    const source = provenance as Record<string, unknown>;
    for (const key of ["who", "when", "command"] as const) {
      if (typeof source[key] !== "string" || source[key].length === 0) return { kind: "invalid", message: `fact ${id} is missing provenance.${key}` };
    }
    const when = source.when as string;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(when)) return { kind: "invalid", message: `fact ${id} has a provenance.when that is not an ISO-8601 timestamp: ${when}` };
    if (Object.keys(source).some((key) => !["who", "when", "command"].includes(key))) return { kind: "invalid", message: `fact ${id} provenance must contain only who, when, and command` };
    if ([id, fact.measurement as string, source.who as string, when, source.command as string].some((field) => !factStringValid(field))) return { kind: "invalid", message: `fact ${id} contains a newline in a field` };
  }
  return { kind: "valid" };
}

export function addFact(store: FactStore, fact: Fact): FactOperation<FactStore> {
  if (store.facts.some((entry) => entry.id === fact.id)) return { kind: "invalid", message: `fact already exists: ${fact.id}` };
  return { kind: "ok", value: { ...store, facts: [...store.facts, fact] } };
}
export function editFact(store: FactStore, id: string, edited: FactStore): FactOperation<FactStore> {
  if (!store.facts.some((entry) => entry.id === id)) return { kind: "invalid", message: `fact not found: ${id}` };
  if (!edited.facts.some((entry) => entry.id === id)) return { kind: "invalid", message: `edited fact not found: ${id}` };
  return { kind: "ok", value: edited };
}
export function removeFact(store: FactStore, id: string): FactOperation<FactStore> {
  if (!store.facts.some((entry) => entry.id === id)) return { kind: "invalid", message: `fact not found: ${id}` };
  return { kind: "ok", value: { ...store, facts: store.facts.filter((entry) => entry.id !== id) } };
}
export function factInScope(store: FactStore, repository: string): readonly Fact[] { return store.facts.filter((entry) => entry.scope.type === "global" || entry.scope.repository === repository); }
export function renderFact(fact: Fact): string { return `- ${fact.id}: ${fact.measurement} (measured by ${fact.provenance.who} at ${fact.provenance.when}; rerun: ${fact.provenance.command})`; }
export function formatFactList(store: FactStore): string {
  const pad = (value: string, width: number) => value.padEnd(width);
  const rows = [ `${pad("ID", 24)} ${pad("SCOPE", 12)} ${pad("MEASURED_BY", 32)} MEASUREMENT` ];
  for (const fact of store.facts) rows.push(`${pad(fact.id, 24)} ${pad(fact.scope.type, 12)} ${pad(fact.provenance.who, 32)} ${fact.measurement}`);
  return `${rows.join("\n")}\n`;
}
