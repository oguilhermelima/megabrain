#!/usr/bin/env node

import { appendFileSync } from "node:fs";

let draft = "";
let paste = false;
let pending = "";
let submissions = 0;

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\u001b[?2004hREADY\n");

process.stdin.on("data", (chunk) => {
  pending += chunk.toString("utf8");
  while (pending.length > 0) {
    if (!paste && pending.startsWith("\u001b[200~")) {
      pending = pending.slice(6);
      paste = true;
    } else if (paste && pending.includes("\u001b[201~")) {
      const end = pending.indexOf("\u001b[201~");
      draft += pending.slice(0, end);
      draft = draft.replace(/\r\n?/g, "\n");
      pending = pending.slice(end + 6);
      paste = false;
    } else if (!paste && (pending[0] === "\r" || pending[0] === "\n")) {
      pending = pending.slice(1);
      submissions += 1;
      appendFileSync(process.env.MB_MULTILINE_LOG, `SUBMISSION ${submissions}\n${draft}\nEND SUBMISSION\n`);
      draft = "";
    } else if (paste) {
      const sentinel = "\u001b[201~";
      const keep = Math.min(pending.length, sentinel.length - 1);
      const safeLength = pending.length - keep;
      if (safeLength > 0) {
        draft += pending.slice(0, safeLength);
        pending = pending.slice(safeLength);
      } else break;
    } else {
      draft += pending[0];
      pending = pending.slice(1);
    }
  }
});
