const CLAUDE_PLACEHOLDER = /\[Pasted text #\d+(?: \+(\d+) lines)?\]/g;
const CODEX_PLACEHOLDER = /\[Pasted Content (\d+) chars\]/g;
// Codex collapses a paste past 1000 characters. Below that it types the text inline, and in a pane
// too short to show it all it scrolls the composer and marks its first line with an arrow.
const CODEX_COLLAPSE_CHARS = 1000;
const CODEX_SCROLLED_COMPOSER = /^\s*›.*↑\s*$/m;

function withoutWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

function newlineCount(text: string): number {
  return text.split("\n").length - 1;
}

// A composer shows a short paste as the text itself and collapses a long one into a single
// placeholder that carries a size: Claude counts the newlines, Codex counts code points. Both were
// measured against the real agents (tests/fixtures/composer). A tail-only composer, or several
// placeholders from a paste that was split, never matches.
// Grok draws its composer in a bordered box, so a wrapped paste is split by "│" and a leading "❯".
// A multi-line paste collapses into "[Pasted: N lines]", which counts the lines of the trimmed text.
const GROK_BOX = /[│❯]/g;
const GROK_PLACEHOLDER = /\[Pasted: (\d+) lines?\]/g;
// Antigravity CLI 1.3.3 collapses a multi-line paste into "+N lines", N counting the lines of the
// trimmed text, and a long single line into "N chars" (tests/fixtures/composer/agy-*).
const AGY_PLACEHOLDER = /\[Pasted text #\d+ (?:\+(\d+) lines|(\d+) chars)\]/g;

export function composerHoldsText(agent: string, screen: string, text: string): boolean {
  if (text === "") return false;
  if (agent === "grok") {
    if (withoutWhitespace(screen.replace(GROK_BOX, "")).includes(withoutWhitespace(text.replace(GROK_BOX, "")))) return true;
    const placeholders = [...screen.matchAll(GROK_PLACEHOLDER)];
    const only = placeholders.length === 1 ? placeholders[0] : undefined;
    return only !== undefined && Number(only[1]) === text.trimEnd().split("\n").length;
  }
  if (withoutWhitespace(screen).includes(withoutWhitespace(text))) return true;
  if (agent === "agy") {
    const placeholders = [...screen.matchAll(AGY_PLACEHOLDER)];
    const only = placeholders.length === 1 ? placeholders[0] : undefined;
    if (only === undefined) return false;
    return only[1] !== undefined ? Number(only[1]) === text.trimEnd().split("\n").length : Number(only[2]) === [...text].length;
  }
  if (agent === "claude") {
    const placeholders = [...screen.matchAll(CLAUDE_PLACEHOLDER)];
    const only = placeholders.length === 1 ? placeholders[0] : undefined;
    return only !== undefined && Number(only[1] ?? 0) === newlineCount(text);
  }
  if (agent === "codex") {
    const placeholders = [...screen.matchAll(CODEX_PLACEHOLDER)];
    const only = placeholders.length === 1 ? placeholders[0] : undefined;
    if (only !== undefined) return Number(only[1]) === [...text].length;
    // A scrolled composer shows only the end of the text, which a swallowed paste would also leave;
    // that cannot happen below the collapse size, so the prompt's last line showing there is the proof.
    const tail = withoutWhitespace(text.trimEnd().split("\n").at(-1) ?? "");
    return tail !== "" && [...text].length <= CODEX_COLLAPSE_CHARS && CODEX_SCROLLED_COMPOSER.test(screen) && withoutWhitespace(screen).includes(tail);
  }
  return false;
}

const COMPOSER_RULE = /^\s*─{8,}\s*$/;

function lastLineIndex(lines: readonly string[], matches: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) if (matches(lines[index] ?? "")) return index;
  return -1;
}

function composerRegion(agent: string, screen: string): string | undefined {
  const draft = [...screen.split("\n")].reverse().find((line) => line.startsWith("MEGABRAIN_COMPOSER_DRAFT:"));
  if (draft !== undefined) return draft.slice("MEGABRAIN_COMPOSER_DRAFT:".length);
  const lines = screen.split("\n");
  if (agent === "claude") {
    const rules = lines.flatMap((line, index) => COMPOSER_RULE.test(line) ? [index] : []);
    if (rules.length >= 2) return lines.slice((rules.at(-2) ?? 0) + 1, rules.at(-1)).join("\n").replace(/^\s*❯[  ]?/u, "").replace(/^\s{2}/gmu, "").trimEnd();
  }
  if (agent === "grok") {
    const start = lastLineIndex(lines, (line) => /╭─/.test(line));
    const end = lines.findIndex((line, index) => index > start && /╰─/.test(line));
    if (start >= 0 && end > start) return lines.slice(start + 1, end).map((line) => line.replace(/^\s*│ ?/u, "").replace(/^\s*❯ ?/u, "").trimEnd()).join("\n").trimEnd();
  }
  const prompt = agent === "claude" ? /^\s*❯[  ]?(.*)$/u : agent === "codex" ? /^\s*›[  ]?(.*)$/u : /^\s*[>$] ?(.*)$/u;
  const start = lastLineIndex(lines, (line) => prompt.test(line));
  if (start < 0) return undefined;
  const first = prompt.exec(lines[start] ?? "")?.[1] ?? "";
  const content = [first];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || !/^\s{2,}\S/u.test(line)) break;
    content.push(line.trim());
  }
  return content.join("\n").trimEnd();
}

export function composerReadback(agent: string, screen: string): Readonly<{ region?: string; orcaDraft?: string }> {
  const region = composerRegion(agent, screen);
  const draftLine = [...screen.split("\n")].reverse().find((line) => line.startsWith("MEGABRAIN_COMPOSER_DRAFT:"));
  const orcaDraft = draftLine?.slice("MEGABRAIN_COMPOSER_DRAFT:".length);
  return {
    ...(region === undefined ? {} : { region }),
    ...(orcaDraft === undefined ? {} : { orcaDraft }),
  };
}

// Proves the complete composer payload. Inline text must match in full; collapsed agent paste
// placeholders are accepted only when the placeholder is the entire composer payload.
export function composerExactlyHoldsText(agent: string, screen: string, text: string): boolean {
  if (text === "") return false;
  const region = composerRegion(agent, screen);
  if (region === undefined) return false;
  if (withoutWhitespace(region) === withoutWhitespace(text)) return true;
  const placeholder = agent === "claude" ? /^\[Pasted text #\d+(?: \+\d+ lines)?\]$/u
    : agent === "codex" ? /^\[Pasted Content \d+ chars\]$/u
      : agent === "grok" ? /^\[Pasted: \d+ lines?\]$/u
        : agent === "agy" ? /^\[Pasted text #\d+ (?:\+\d+ lines|\d+ chars)\]$/u
          : undefined;
  if (placeholder?.test(region.trim()) === true) return composerHoldsText(agent, region, text);
  if (agent === "codex" && /^\s*›.*↑\s*$/mu.test(region)) return composerHoldsText(agent, region, text);
  return false;
}
