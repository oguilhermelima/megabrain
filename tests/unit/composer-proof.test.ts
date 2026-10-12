import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { composerExactlyHoldsText, composerHoldsText } from "../../src/core/composer-proof.js";

// Frames and prompts are captured from the real agents in a private tmux server (Claude Code
// 2.1.296, Codex 0.162.1), not written by hand: see tests/fixtures/composer.
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/composer/${name}.txt`, import.meta.url), "utf8");

describe("composerHoldsText", () => {
  const longPrompt = fixture("prompt-58-lines");
  const shortPrompt = fixture("prompt-short");

  test("accepts the single collapsed paste Claude shows for a whole multi-line prompt", () => {
    expect(longPrompt.split("\n").length - 1).toBe(58);
    expect(composerHoldsText("claude", fixture("claude-pasted-58-lines"), longPrompt)).toBe(true);
  });

  test("rejects the tail-only composer a fast send-keys leaves behind in Claude", () => {
    expect(composerHoldsText("claude", fixture("claude-send-keys-fragments"), longPrompt)).toBe(false);
  });

  test("rejects a collapsed paste whose line count differs from the prompt", () => {
    const shorter = longPrompt.split("\n").slice(0, 40).join("\n");
    expect(composerHoldsText("claude", fixture("claude-pasted-58-lines"), shorter)).toBe(false);
  });

  test("rejects several collapsed pastes even when their line counts add up", () => {
    const screen = "──────\n❯ [Pasted text #1 +12 lines][Pasted text #2 +46 lines]\n──────\n";
    expect(composerHoldsText("claude", screen, longPrompt)).toBe(false);
  });

  test("accepts a one-line paste that Claude collapses without a line count", () => {
    expect(composerHoldsText("claude", fixture("claude-pasted-one-line"), "x".repeat(1500))).toBe(true);
    expect(composerHoldsText("claude", fixture("claude-pasted-one-line"), `${"x".repeat(1500)}\nsecond line`)).toBe(false);
  });

  test("accepts a short prompt typed inline, whatever the wrapping", () => {
    expect(composerHoldsText("claude", fixture("claude-short-inline"), shortPrompt)).toBe(true);
    expect(composerHoldsText("codex", fixture("codex-short-inline"), shortPrompt)).toBe(true);
    expect(composerHoldsText("codex", fixture("codex-short-inline"), `${shortPrompt}\nfourth line`)).toBe(false);
  });

  test("accepts Codex's collapsed paste only when the character count matches", () => {
    expect(longPrompt.length).toBe(4660);
    expect(composerHoldsText("codex", fixture("codex-pasted-4660-chars"), longPrompt)).toBe(true);
    expect(composerHoldsText("codex", fixture("codex-pasted-4660-chars"), longPrompt.slice(0, 4659))).toBe(false);
  });

  test("counts Codex characters as code points, not UTF-16 units", () => {
    const text = `${"é".repeat(100)}😀\n${"x".repeat(900)}`;
    const screen = `› [Pasted Content ${[...text].length} chars]\n`;
    expect(text.length).not.toBe([...text].length);
    expect(composerHoldsText("codex", screen, text)).toBe(true);
  });

  test("never mistakes an empty composer for a delivered prompt", () => {
    expect(composerHoldsText("claude", fixture("claude-idle"), longPrompt)).toBe(false);
    expect(composerHoldsText("codex", fixture("codex-idle"), longPrompt)).toBe(false);
    expect(composerHoldsText("codex", fixture("codex-idle"), shortPrompt)).toBe(false);
  });

  test("accepts Codex's scrolled composer when it ends where the prompt ends", () => {
    const prompt = fixture("prompt-900-bytes");
    const frame = fixture("codex-clipped-inline-60x12");
    expect(frame).toContain("↑");
    // A 60x12 pane cannot show 900 bytes: Codex scrolls the composer and marks it with an arrow.
    expect(composerHoldsText("codex", frame, prompt)).toBe(true);
  });

  test("rejects a scrolled Codex composer whose end is not the prompt's end", () => {
    const frame = fixture("codex-clipped-inline-60x12");
    expect(composerHoldsText("codex", frame, `${fixture("prompt-900-bytes")}\nand one more line`)).toBe(false);
  });

  test("rejects a short tail shown without the scroll arrow", () => {
    const frame = fixture("codex-clipped-inline-60x12").replace("↑", " ");
    expect(composerHoldsText("codex", frame, fixture("prompt-900-bytes"))).toBe(false);
  });
});

// Antigravity CLI 1.3.3 frames, captured in a private tmux server (account address redacted).
describe("composerHoldsText for agy", () => {
  const rows = (count: number): string => Array.from({ length: count }, (_, index) => `row ${index} text`).join("\n");

  test("accepts inline text, wrapped or on several lines", () => {
    expect(composerHoldsText("agy", fixture("agy-short-inline"), "short single line probe 123")).toBe(true);
    expect(composerHoldsText("agy", fixture("agy-inline-10-lines"), rows(10))).toBe(true);
    expect(composerHoldsText("agy", fixture("agy-inline-10-lines"), rows(11))).toBe(false);
  });

  test("accepts the collapsed multi-line paste only when its line count matches", () => {
    const prompt = fixture("prompt-agy-40-lines");
    expect(prompt.endsWith("\n")).toBe(true);
    expect(composerHoldsText("agy", fixture("agy-pasted-40-lines"), prompt)).toBe(true);
    expect(composerHoldsText("agy", fixture("agy-pasted-40-lines"), prompt.split("\n").slice(0, 39).join("\n"))).toBe(false);
  });

  test("accepts the collapsed one-line paste only when its character count matches", () => {
    expect(composerHoldsText("agy", fixture("agy-pasted-1001-chars"), "z".repeat(1001))).toBe(true);
    expect(composerHoldsText("agy", fixture("agy-pasted-1001-chars"), "z".repeat(1000))).toBe(false);
  });

  test("never mistakes an empty composer for a delivered prompt", () => {
    expect(composerHoldsText("agy", fixture("agy-idle"), "short single line probe 123")).toBe(false);
  });

  test("proves the whole composer payload, not just a mention on screen", () => {
    expect(composerExactlyHoldsText("agy", fixture("agy-pasted-40-lines"), fixture("prompt-agy-40-lines"))).toBe(true);
    expect(composerExactlyHoldsText("agy", fixture("agy-pasted-1001-chars"), "z".repeat(1001))).toBe(true);
    expect(composerExactlyHoldsText("agy", fixture("agy-short-inline"), "short single line probe")).toBe(false);
  });
});
