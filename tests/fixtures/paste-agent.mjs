#!/usr/bin/env node

// A stand-in agent composer for tmux tests. It asks for bracketed paste like the real agents,
// shows a long paste collapsed to a placeholder, and can swallow the start of its first paste
// (MB_PASTE_SWALLOW=<n>: the first n pastes keep only their last 400 bytes) or stay inside a paste
// that never ends (MB_PASTE_OPEN=<n>: Enter is a newline until ESC [ 201 ~ arrives). Each submission
// is appended to MB_PASTE_LOG, MB_PASTE_RECEIVE=1 answers it with megabrain received, and
// MB_PASTE_ECHO=1 prints the last line it got and goes back to an idle composer. Like the real
// agents, a prompt after -- on its command line is submitted at start and its first line stays on
// screen as the turn it began; MB_PASTE_ARGV=ignore drops it, as an agent that never submits it.

import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let draft = "";
let paste = false;
let pending = "";
let swallow = Number(process.env.MB_PASTE_SWALLOW ?? "0");
let openPastes = Number(process.env.MB_PASTE_OPEN ?? "0");
let working = false;
let holdOpen = false;
let history = "";
const decoder = new TextDecoder("utf-8");

function render() {
  process.stdout.write("\u001b[2J\u001b[H");
  if (history !== "") process.stdout.write(`› ${history}\n\n`);
  if (working) {
    process.stdout.write("• Working (1s • esc to interrupt)\nesc to interrupt\n› \n");
    return;
  }
  if (draft === "") process.stdout.write("› Ask Codex to do anything\n");
  else if (draft.length > 1000) process.stdout.write(`› [Pasted Content ${[...draft].length} chars]\n`);
  else inline();
}

// Like Codex: text that does not fit the pane scrolls, and the first line carries an up arrow.
function inline() {
  const columns = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const width = Math.max(10, columns - 4);
  const wrapped = draft.split("\n").flatMap((row) => (row === "" ? [""] : row.match(new RegExp(`.{1,${width}}`, "g")) ?? [""]));
  const room = Math.max(1, rows - 3);
  const shown = wrapped.length > room ? wrapped.slice(-room) : wrapped;
  const lines = shown.map((row, index) => (index === 0 ? `› ${row}` : `  ${row}`));
  if (wrapped.length > room) lines[0] = `${lines[0].padEnd(columns - 2)}↑`;
  process.stdout.write(`${lines.join("\n")}\n`);
}

function submit() {
  appendFileSync(process.env.MB_PASTE_LOG ?? "/dev/null", `SUBMISSION ${draft.length}\n${draft}\nEND SUBMISSION\n`);
  const lastLine = draft.trimEnd().split("\n").at(-1) ?? "";
  draft = "";
  if (process.env.MB_PASTE_ECHO === "1") {
    // Answer like a quick agent: say what arrived, then show an idle composer again.
    process.stdout.write(`\u001b[2J\u001b[H${history === "" ? "" : `› ${history}\n\n`}agent-response:${lastLine}\n› Ask Codex to do anything\n`);
  } else {
    working = true;
    render();
  }
  if (process.env.MB_PASTE_RECEIVE === "1") execFileSync(process.env.MB_MEGABRAIN ?? "megabrain", ["received"], { stdio: "ignore" });
}

process.stdout.write("\u001b[?2004h\u001b[?25l");
process.stdin.setRawMode(true);
process.stdin.resume();
render();

const separator = process.argv.indexOf("--");
const initialPrompt = separator < 0 ? undefined : process.argv[separator + 1];
if (initialPrompt !== undefined && initialPrompt !== "" && process.env.MB_PASTE_ARGV !== "ignore") {
  history = initialPrompt.split("\n")[0] ?? "";
  draft = initialPrompt;
  submit();
}

process.stdin.on("data", (chunk) => {
  pending += decoder.decode(chunk, { stream: true });
  while (pending.length > 0) {
    if (!paste && pending.startsWith("\u001b[200~")) {
      pending = pending.slice(6);
      paste = true;
      draft = "";
      holdOpen = openPastes > 0;
      if (holdOpen) openPastes -= 1;
    } else if (!paste && pending.startsWith("\u001b[201~")) {
      pending = pending.slice(6);
      holdOpen = false;
    } else if (paste && pending.includes("\u001b[201~")) {
      const end = pending.indexOf("\u001b[201~");
      draft += pending.slice(0, end).replace(/\r\n?/g, "\n");
      if (swallow > 0) {
        swallow -= 1;
        draft = new TextDecoder().decode(new TextEncoder().encode(draft).slice(-400));
      }
      pending = pending.slice(end + 6);
      paste = false;
      render();
    } else if (paste) {
      const keep = Math.min(pending.length, 5);
      const safe = pending.length - keep;
      if (safe <= 0) break;
      draft += pending.slice(0, safe);
      pending = pending.slice(safe);
    } else if (pending[0] === "\r" || pending[0] === "\n") {
      pending = pending.slice(1);
      if (draft !== "" && !holdOpen) submit();
    } else if (pending[0] === "\u0015") {
      pending = pending.slice(1);
      draft = "";
      render();
    } else {
      draft += pending[0];
      pending = pending.slice(1);
      render();
    }
  }
});
