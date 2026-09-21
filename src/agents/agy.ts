import { unavailableKey, unavailableLiveness, type Agent } from "./types.js";

export const agy: Agent = {
  id: "agy",
  matchesDescriptor: (descriptor) => descriptor === "agy" || /^agy_[0-9]+-[0-9]+-[0-9]+_agent$/.test(descriptor),
  classifyLiveness: () => unavailableLiveness("agy"),
  submitKey: () => unavailableKey("agy", "submit"),
  interruptKey: () => unavailableKey("agy", "interrupt"),
};
