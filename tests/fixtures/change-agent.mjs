#!/usr/bin/env node

import { appendFileSync } from "node:fs";

let interrupts = 0;
let draft = "";
let submitted = false;
const agent = process.env.MB_AGENT ?? "codex";
const decoder = new TextDecoder("utf-8");

function render() {
  process.stdout.write("\u001b[2J\u001b[H");
  const idle = submitted || interrupts >= 2;
  if (agent === "claude") {
    process.stdout.write(idle ? "❯\n" : "✳ Working · thinking\nesc to interrupt\n❯\n");
    return;
  }
  if (idle) {
    process.stdout.write(`› ${draft || "Ask Codex to do anything"}\n`);
    if (submitted) process.stdout.write("• Working (1s • esc to interrupt)\n");
    return;
  }
  process.stdout.write("• Working (1s • esc to interrupt)\n");
  process.stdout.write("esc to interrupt\n");
  process.stdout.write(`› ${draft}\n`);
}

process.stdout.write("\u001b[?25l");
process.stdin.setRawMode(true);
process.stdin.resume();
render();

process.stdin.on("data", (bytes) => {
  for (const character of decoder.decode(bytes, { stream: true })) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x1b) {
      interrupts += 1;
      render();
    } else if (codePoint === 0x15) {
      draft = "";
      render();
    } else if (codePoint === 0x09 || (agent === "claude" && codePoint === 0x0d)) {
      submitted = true;
      appendFileSync(process.env.MB_CHANGE_LOG ?? "/tmp/megabrain-change-agent.log", `${draft}\n`);
      render();
    } else if (codePoint === 0x7f || codePoint === 0x08) {
      draft = draft.slice(0, -1);
      render();
    } else if (codePoint >= 0x20) {
      draft += character;
      render();
    }
  }
});
