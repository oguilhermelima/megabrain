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
export function composerHoldsText(agent: string, screen: string, text: string): boolean {
  if (text === "") return false;
  if (withoutWhitespace(screen).includes(withoutWhitespace(text))) return true;
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
