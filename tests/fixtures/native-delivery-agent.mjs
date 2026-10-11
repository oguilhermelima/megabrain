#!/usr/bin/env node

import { appendFileSync, existsSync } from "node:fs";

const [release, received] = process.argv.slice(2);
let input = "";
let idle = false;
function render() {
  process.stdout.write("\u001b[2J\u001b[H");
  process.stdout.write(idle ? "IDLE\n" : "BUSY\n");
  process.stdout.write(`❯ ${input}\n`);
}
process.stdin.setRawMode(true);
process.stdin.resume();
render();
const timer = setInterval(() => {
  if (!idle && existsSync(release)) { idle = true; render(); }
}, 20);
process.stdin.on("data", (bytes) => {
  for (const byte of bytes) {
    if (!idle) continue;
    if (byte === 0x0d) {
      appendFileSync(received, input);
      input = "";
    } else if (byte >= 0x20) input += String.fromCharCode(byte);
  }
  render();
});
process.on("exit", () => clearInterval(timer));
