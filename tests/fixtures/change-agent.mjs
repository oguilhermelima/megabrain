#!/usr/bin/env node

import { appendFileSync } from "node:fs";

let interrupts = 0;
let draft = "";
let submitted = false;

function render() {
  process.stdout.write("\u001b[2J\u001b[H");
  if (submitted || interrupts >= 2) {
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
  for (const byte of bytes) {
    if (byte === 0x1b) {
      interrupts += 1;
      render();
    } else if (byte === 0x15) {
      draft = "";
      render();
    } else if (byte === 0x09) {
      submitted = true;
      appendFileSync(process.env.MB_CHANGE_LOG ?? "/tmp/megabrain-change-agent.log", `${draft}\n`);
      render();
    } else if (byte === 0x7f || byte === 0x08) {
      draft = draft.slice(0, -1);
      render();
    } else if (byte >= 0x20) {
      draft += Buffer.from([byte]).toString("utf8");
      render();
    }
  }
});
