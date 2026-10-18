export type SummaryTrigger = { newTurns: number; totalTurns: number; lastActivityAt: string; now: Date; idleMinutes: number; minNewTurns: number; maxTurns: number };

/** One policy shared by app chats and external sessions. Time alone never makes work due. */
export function summaryDue(input: SummaryTrigger): boolean {
  if (input.totalTurns < input.minNewTurns || input.newTurns <= 0) return false;
  if (input.newTurns >= input.maxTurns) return true;
  const lastActivity = Date.parse(input.lastActivityAt);
  return Number.isFinite(lastActivity) && input.now.getTime() - lastActivity >= input.idleMinutes * 60_000 && input.newTurns >= input.minNewTurns;
}
