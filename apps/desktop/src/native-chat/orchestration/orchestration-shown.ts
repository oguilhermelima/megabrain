// The chats left in their Orchestration view, kept for the app run like each chat's other views, so
// reopening one (or opening it from another chat's diagram) shows the diagram again.
const shown = new Set<string>()

export const orchestrationShown = (chatId: string): boolean => shown.has(chatId)

export function showOrchestration(chatId: string, on: boolean): void {
  if (on) shown.add(chatId)
  else shown.delete(chatId)
}
