export type DispatchRead = Readonly<{ dispatchId: string; pane: string; source: "tmux" | "file" | "host"; truncated: boolean; text: string }>;
export function formatDispatchRead(value: DispatchRead, json: boolean, cap: number): string {
  if (json) return `${JSON.stringify(value, null, 2)}\n`;
  return `source: ${value.source}\n${value.truncated ? `truncated: transcript exceeds ${cap} bytes, oldest lines dropped\n` : ""}${value.text}\n`;
}
export function capTranscript(value: string, maxBytes: number): Readonly<{ text: string; truncated: boolean }> {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  const decoded = new TextDecoder().decode(bytes.slice(bytes.length - maxBytes));
  const newline = decoded.indexOf("\n");
  return { text: newline < 0 ? "" : decoded.slice(newline + 1), truncated: true };
}

type Screen = { readonly rows: string[]; readonly row: number; readonly column: number };

function setCell(screen: string[], row: number, column: number, character: string): void {
  while (screen.length <= row) screen.push("");
  const current = screen[row] ?? "";
  const padded = current.padEnd(column, " ");
  screen[row] = `${padded.slice(0, column)}${character}${padded.slice(column + 1)}`;
}

function renderAnsiText(value: string): string {
  const screen: string[] = [];
  let row = 0;
  let column = 0;
  let index = 0;
  let saved: Screen = { rows: [], row: 0, column: 0 };
  const ensureRow = (target: number): void => { while (screen.length <= target) screen.push(""); };
  const parameter = (parameters: string, position: number, fallback: number): number => {
    const valueAtPosition = parameters.split(";")[position];
    if (valueAtPosition === undefined || valueAtPosition === "") return fallback;
    const parsed = Number(valueAtPosition);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const clearLine = (mode: number): void => {
    ensureRow(row);
    const current = screen[row] ?? "";
    if (mode === 2) { screen[row] = ""; column = 0; }
    else if (mode === 1) screen[row] = current.slice(column).padStart(column, " ");
    else screen[row] = current.slice(0, column);
  };
  const clearScreen = (mode: number): void => {
    if (mode === 2 || mode === 3) {
      screen.splice(0, screen.length);
      row = 0;
      column = 0;
    } else {
      screen.splice(row + 1);
      clearLine(0);
    }
  };
  while (index < value.length) {
    const character = value[index] ?? "";
    if (character !== "\u001b") {
      if (character === "\n") { row += 1; column = 0; }
      else if (character === "\r") column = 0;
      else if (character === "\b") column = Math.max(0, column - 1);
      else if (character === "\t") column += 8 - (column % 8);
      else if (character >= " ") { setCell(screen, row, column, character); column += 1; }
      index += 1;
      continue;
    }
    if (value[index + 1] === "]") {
      index += 2;
      while (index < value.length && value[index] !== "\u0007" && !(value[index] === "\u001b" && value[index + 1] === "\\")) index += 1;
      index += value[index] === "\u001b" ? 2 : 1;
      continue;
    }
    if (value[index + 1] !== "[") { index += 2; continue; }
    let end = index + 2;
    while (end < value.length && !/[A-Za-z@`]/.test(value[end] ?? "")) end += 1;
    if (end >= value.length) break;
    const final = value[end] ?? "";
    const parameters = value.slice(index + 2, end).replace(/^\?/, "");
    const amount = parameter(parameters, 0, 1);
    if (final === "A") row = Math.max(0, row - amount);
    else if (final === "B" || final === "e") row += amount;
    else if (final === "C" || final === "a") column += amount;
    else if (final === "D") column = Math.max(0, column - amount);
    else if (final === "G" || final === "`") column = Math.max(0, amount - 1);
    else if (final === "H" || final === "f") { row = Math.max(0, amount - 1); column = Math.max(0, parameter(parameters, 1, 1) - 1); }
    else if (final === "J") { const mode = Number(parameters); clearScreen(Number.isNaN(mode) ? 0 : mode); }
    else if (final === "K") { const mode = Number(parameters); clearLine(Number.isNaN(mode) ? 0 : mode); }
    else if (final === "s") saved = { rows: [...screen], row, column };
    else if (final === "u") { row = saved.row; column = saved.column; }
    index = end + 1;
  }
  return screen.map((line) => line.trimEnd()).join("\n").replace(/\n+$/, "");
}

export function renderTranscript(value: string, maxBytes: number): Readonly<{ text: string; truncated: boolean }> {
  const capped = capTranscript(value, maxBytes);
  return { text: renderAnsiText(capped.text), truncated: capped.truncated };
}
