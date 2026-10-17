import { isAbsolute, relative } from "node:path";
import type { ChatEvent } from "../chat/store.js";
import type { Ref, TranscriptLine } from "./types.js";

/** A conversation entry from an app chat's events or from an agent's own session log. */
export type DistillTurn = Pick<ChatEvent, "kind" | "text" | "tool"> & { at: string; images?: { path: string }[] };

const TOOL_LINE_CHARS = 140;
const OUTCOME_CHARS = 120;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
const RUN_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);

function clip(text: string, chars: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= chars ? one : `${one.slice(0, chars - 1).trimEnd()}…`;
}

function inputOf(raw: string | undefined): Record<string, unknown> {
  try { const value: unknown = JSON.parse(raw ?? ""); return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  return null;
}

function pathOf(input: Record<string, unknown>): string | null {
  return str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
}

function patchPaths(raw: string): string[] {
  return [...raw.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((match) => (match[1] as string).trim());
}

function toolLine(turn: DistillTurn): string {
  const name = turn.tool?.name ?? turn.text;
  const input = inputOf(turn.tool?.input);
  if (EDIT_TOOLS.has(name)) {
    const path = pathOf(input) ?? patchPaths(turn.tool?.input ?? "")[0] ?? null;
    return clip(`edited ${path ?? name}`, TOOL_LINE_CHARS);
  }
  if (RUN_TOOLS.has(name)) return clip(`ran ${str(input.command) ?? str(input.cmd) ?? name}`, TOOL_LINE_CHARS);
  if (READ_TOOLS.has(name)) return clip(`${name === "Read" ? "read" : "looked up"} ${pathOf(input) ?? str(input.pattern) ?? str(input.query) ?? str(input.url) ?? name}`, TOOL_LINE_CHARS);
  if (name === "Agent" || name === "Task") return clip(`delegated ${str(input.description) ?? str(input.prompt) ?? "a task"}`, TOOL_LINE_CHARS);
  return clip(`used ${name}`, TOOL_LINE_CHARS);
}

/**
 * The conversation worth keeping: person and agent text in full, each tool call as one line (a command carries the
 * first words of its result), images as paths. Thinking, state noise and tool output are left out.
 */
export function distill(turns: readonly DistillTurn[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const pending: Array<{ name: string; index: number; done: boolean }> = [];
  const push = (line: Omit<TranscriptLine, "cursor">): number => lines.push({ cursor: String(lines.length), ...line }) - 1;
  for (const turn of turns) {
    if (turn.kind === "user") {
      const images = turn.images?.map((image) => image.path) ?? [];
      push({ at: turn.at, role: "person", text: turn.text, ...(images.length > 0 ? { images } : {}) });
    } else if (turn.kind === "assistant") {
      if (turn.text.trim() !== "") push({ at: turn.at, role: "agent", text: turn.text });
    } else if (turn.kind === "tool-call") {
      const index = push({ at: turn.at, role: "tool", text: toolLine(turn) });
      pending.push({ name: turn.tool?.name ?? turn.text, index, done: false });
    } else if (turn.kind === "tool-result") {
      const name = turn.tool?.name ?? "tool";
      const call = [...pending].reverse().find((entry) => !entry.done && entry.name === name);
      const line = call === undefined ? undefined : lines[call.index];
      if (call === undefined || line === undefined) continue;
      call.done = true;
      if (turn.tool?.status === "error") line.text = clip(`${line.text} [failed]`, TOOL_LINE_CHARS + OUTCOME_CHARS);
      else if (RUN_TOOLS.has(name)) {
        const outcome = clip(turn.text.split("\n").filter((part) => part.trim() !== "").slice(0, 2).join(" "), OUTCOME_CHARS);
        if (outcome !== "") line.text = `${line.text}: ${outcome}`;
      }
    }
  }
  return lines;
}

/** Files the agent edited, relative to the working folder when inside it. */
export function editedFiles(turns: readonly DistillTurn[], cwd: string): Ref[] {
  const ids = new Set<string>();
  for (const turn of turns) {
    if (turn.kind !== "tool-call" || turn.tool === undefined || !EDIT_TOOLS.has(turn.tool.name)) continue;
    const input = inputOf(turn.tool.input);
    for (const path of [pathOf(input), ...patchPaths(turn.tool.input ?? "")]) {
      if (path === null) continue;
      const relativePath = isAbsolute(path) ? relative(cwd, path) : path;
      ids.add(relativePath.startsWith("..") || /\s/.test(relativePath) ? path : relativePath);
    }
  }
  return [...ids].filter((id) => !/\s/.test(id)).map((id) => ({ kind: "file" as const, id }));
}

/** Everything the turns said and ran, as one string for the mechanical ref patterns. */
export function rawText(turns: readonly DistillTurn[]): string {
  return turns.map((turn) => `${turn.text}\n${turn.tool?.input ?? ""}`).join("\n");
}

/** The lines after the first `covered` user messages: what a summary covering that many has not seen. */
export function linesAfter(lines: readonly TranscriptLine[], covered: number): TranscriptLine[] {
  if (covered === 0) return [...lines];
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.role !== "person") continue;
    if (seen === covered) return lines.slice(index);
    seen += 1;
  }
  return [];
}
