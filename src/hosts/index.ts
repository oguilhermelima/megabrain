import { orca } from "./orca.js";
import { superset } from "./superset.js";
import type { HostProvider } from "./types.js";

const registry = new Map<string, HostProvider>([
  [orca.id, orca],
  [superset.id, superset],
]);

export function registerHost(host: HostProvider): void {
  registry.set(host.id, host);
}

export function unregisterHost(hostId: string): void {
  registry.delete(hostId);
}

export function getHost(hostId: string): HostProvider | undefined {
  return registry.get(hostId);
}

export type { CreateTerminal, HostCommand, HostProvider, SendText, TerminalTarget } from "./types.js";
export { runHostSend } from "./send.js";
