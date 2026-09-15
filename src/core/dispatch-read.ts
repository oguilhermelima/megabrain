export type DispatchRead = Readonly<{ dispatchId: string; pane: string; source: "tmux" | "file" | "host"; truncated: boolean; text: string }>;
export function formatDispatchRead(value: DispatchRead, json: boolean, cap: number): string {
  if (json) return `${JSON.stringify(value, null, 2)}\n`;
  return `source: ${value.source}\n${value.truncated ? `truncated: transcript exceeds ${cap} bytes, oldest lines dropped\n` : ""}${value.text}\n`;
}
export function capTranscript(value: string, maxBytes: number): Readonly<{ text: string; truncated: boolean }> {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  const decoded = new TextDecoder().decode(bytes.slice(bytes.length - maxBytes));
  return { text: decoded.slice(decoded.indexOf("\n") + 1), truncated: true };
}
