import { failed, ok, unknown, type Result } from "./result.js";

export const dispatchStates = ["spawning", "running", "waiting_for_reply", "done", "failed", "orphaned", "closed", "circuit_broken"] as const;
export const processStates = ["starting", "start-unproven", "running", "succeeded", "failed", "stopping", "stopped", "stop-unproven", "abandoned", "exited"] as const;
export const terminalStates = ["owned", "retained", "missing", "released"] as const;

// The dispatch states a coordinator still expects progress from. Mirrors the shell
// MEGABRAIN_DISPATCH_OPEN_STATES constant (lib/common.sh): used to decide which dispatches the
// turn-end hook's parent-notify scan should look at at all.
export const openDispatchStates = ["spawning", "running", "waiting_for_reply"] as const;

export type DispatchAxis = "dispatch" | "process" | "terminal";
export type DispatchStateValue = typeof dispatchStates[number];
export type ProcessStateValue = typeof processStates[number];
export type TerminalStateValue = typeof terminalStates[number];

const transitionTable: Readonly<Record<DispatchAxis, Readonly<Record<string, readonly string[]>>>> = {
  dispatch: {
    spawning: ["spawning", "running", "failed", "closed"],
    running: ["running", "waiting_for_reply", "done", "failed", "orphaned", "closed"],
    waiting_for_reply: ["waiting_for_reply", "running", "done", "failed", "orphaned", "closed"],
    done: ["done", "failed", "orphaned", "closed"],
    failed: ["failed", "circuit_broken", "closed"],
    orphaned: ["orphaned", "running", "waiting_for_reply", "done", "failed", "circuit_broken", "closed"],
    closed: ["closed"],
    circuit_broken: ["circuit_broken"],
  },
  process: {
    starting: ["starting", "running", "start-unproven", "failed", "stopping", "stopped", "stop-unproven", "abandoned"],
    "start-unproven": ["start-unproven", "running", "failed", "stopping", "stopped", "stop-unproven", "abandoned"],
    running: ["running", "succeeded", "failed", "stopping", "stopped", "abandoned", "exited"],
    stopping: ["stopping", "stopped", "stop-unproven", "running", "failed", "abandoned"],
    "stop-unproven": ["stop-unproven", "failed", "stopped", "abandoned"],
    succeeded: ["succeeded"],
    failed: ["failed"],
    stopped: ["stopped"],
    abandoned: ["abandoned"],
    exited: ["exited", "running", "succeeded"],
  },
  terminal: {
    owned: ["owned", "missing", "retained", "released"],
    // A reconciled proof of identity lets a retained terminal be adopted again.
    retained: ["retained", "owned", "missing", "released"],
    missing: ["missing", "retained", "released"],
    released: ["released"],
  },
} as const;

const statesByAxis: Readonly<Record<DispatchAxis, readonly string[]>> = {
  dispatch: dispatchStates,
  process: processStates,
  terminal: terminalStates,
};

function isAxis(value: string): value is DispatchAxis {
  return value in statesByAxis;
}

export function checkDispatchTransition(axis: string, from: string, to: string): Result<void> {
  if (!isAxis(axis)) return unknown(`state transition axis cannot be determined: ${axis}`);
  const states = statesByAxis[axis];
  if (!states.includes(from)) return unknown(`${axis} state cannot be determined: ${from}`);
  if (!states.includes(to)) return unknown(`${axis} state cannot be determined: ${to}`);
  return transitionTable[axis][from].includes(to)
    ? ok(undefined)
    : failed(`illegal ${axis} state transition: ${from} -> ${to}`);
}
