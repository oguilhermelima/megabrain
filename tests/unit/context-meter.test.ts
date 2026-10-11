import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { readContextMeter } from "../../src/core/liveness.js";

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`../fixtures/context-meter/${name}`, import.meta.url), "utf8");

describe("readContextMeter", () => {
  test("reads remaining Codex context from the footer as used percentage", async () => {
    const frame = await fixture("codex-footer.txt");
    const meter = readContextMeter("codex", frame);

    expect(meter).toEqual({
      status: "known",
      percentUsed: 95,
      sourceFrame: "GPT-6-Luna medium · Context 5% left · weekly 74% left",
    });
  });

  test("reads Claude's native free-space report and keeps its matching source line", async () => {
    const frame = await fixture("claude-context.txt");
    const meter = readContextMeter("claude", frame);

    expect(meter).toEqual({
      status: "known",
      percentUsed: 27.6,
      sourceFrame: "⛶ Free space: 144.9k (72.4%)",
    });
  });

  test("reads agy's token usage instead of neighboring quota percentages", async () => {
    const frame = await fixture("agy-footer.txt");
    const meter = readContextMeter("agy", frame);

    expect(meter).toEqual({
      status: "known",
      percentUsed: 2.6,
      sourceFrame: "Gemini 3.8 Flash (High) 1M │ 26k/1M ctx │ 41% left │ 57% left",
    });
  });

  test("uses Claude's custom token-count status line only when it is present", () => {
    const frame = "Haiku 4.5 200k │ 54k/200k ctx";
    expect(readContextMeter("claude", frame)).toEqual({
      status: "known",
      percentUsed: 27,
      sourceFrame: frame,
    });
  });

  test("returns unknown for an unrecognised frame, an unknown agent, and a zero-capacity meter", () => {
    expect(readContextMeter("codex", "Context is low")).toEqual({ status: "unknown" });
    expect(readContextMeter("other", "Context 2% left")).toEqual({ status: "unknown" });
    expect(readContextMeter("agy", "Gemini 3.8 Flash 0k/0k ctx")).toEqual({ status: "unknown" });
  });

  test("does not treat quota percentages or a compacted notice as context readings", () => {
    expect(readContextMeter("codex", "weekly 5% left · 5h 3% left\n• Context compacted · 1s")).toEqual({ status: "unknown" });
  });
});
