import { agentLabel, type MachinePrompter } from "./install-ui.js";

export type JsonPrompter = MachinePrompter & Readonly<{
  /** Writes the closing result event; every run in JSON mode ends with exactly one. */
  finish: (success: boolean, configured: readonly string[], fallbackMessage: string) => void;
}>;

// Drives the machine install for a program instead of a person: every question is answered from
// the flags or the defaults the terminal would have offered, and everything the terminal would
// show becomes one JSON object per line. A removal is confirmed only by --yes, never by default.
export function createJsonPrompter(write: (text: string) => void, yes: boolean): JsonPrompter {
  const emit = (event: Readonly<Record<string, unknown>>): void => write(`${JSON.stringify(event)}\n`);
  const failures: { module: string; message: string }[] = [];
  let outro = "";
  return {
    intro: (version, agents, hosts) => emit({
      type: "intro",
      version,
      hosts,
      agents: agents.map((choice) => ({ agent: choice.agent, label: agentLabel(choice.agent), installed: choice.installed, configDir: choice.configDir ?? null })),
    }),
    agents: async (_choices, initial) => [...initial],
    skill: async (initial) => initial,
    tmux: async (initial) => initial ? "yes" : "no",
    modules: async (choices) => choices.filter((choice) => choice.selectedByDefault).map((choice) => choice.module),
    confirm: async (message) => {
      emit({ type: "confirm", message, answer: yes });
      return yes;
    },
    review: async () => true,
    step: (label, module) => {
      const identity = module === undefined ? { label } : { module, label };
      emit({ type: "step", ...identity, state: "start" });
      return {
        done: (message) => emit({ type: "step", ...identity, state: "done", message }),
        fail: (message) => {
          if (module !== undefined) failures.push({ module, message });
          emit({ type: "step", ...identity, state: "fail", message });
        },
      };
    },
    info: (message) => emit({ type: "info", message }),
    warn: (message) => emit({ type: "warn", message }),
    outro: (message) => { outro = message; },
    finish: (success, configured, fallbackMessage) => emit({
      type: "result",
      ok: success,
      message: outro.length > 0 ? outro : fallbackMessage,
      configured: [...configured],
      failed: failures,
    }),
  };
}
