export const PROMPT_BUDGET_TMUX_BYTES = 12000;

export function promptByteLength(prompt: string): number {
  return new TextEncoder().encode(prompt).length;
}
