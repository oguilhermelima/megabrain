export function terminalExitMessage(status: string, output: string): string {
  const code = status === "unknown" ? "an unknown code" : `code ${status}`;
  const detail = output.trim();
  return `The terminal process exited with ${code}.${detail === "" ? "" : `\n\n${detail}`}`;
}
