import { doubleQuote, shellArgument, unavailableKey, unavailableLiveness, type Agent } from "./types.js";

export const agy: Agent = {
  id: "agy",
  matchesDescriptor: (descriptor) => descriptor === "agy" || /^agy_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: () => unavailableLiveness("agy"),
  commandLine: ({ model, agentArgs }) => {
    const parts = ["agy", "--dangerously-skip-permissions"];
    if (model !== null) parts.push("--model", doubleQuote(model));
    parts.push(...agentArgs.map(shellArgument));
    return { kind: "ok", value: parts.join(" ") };
  },
  submitKey: () => unavailableKey("agy", "submit"),
  interruptKey: () => unavailableKey("agy", "interrupt"),
};
