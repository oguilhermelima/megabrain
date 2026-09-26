import { styleText } from "node:util";
import { homedir } from "node:os";
import * as clack from "@clack/prompts";
import type { MachineAgent } from "../../core/agent-directories.js";

export type SkillMode = "none" | "global" | "project";

export class SetupCancelled extends Error {
  constructor() {
    super("setup cancelled");
  }
}

export type AgentChoice = Readonly<{ agent: MachineAgent; installed: boolean; configDir: string | undefined }>;
export type ModuleChoice = Readonly<{ module: string; selectedByDefault: boolean; skippedReason: string | undefined; unavailable?: boolean }>;
export type HostSummary = Readonly<{ orca: boolean; superset: boolean; tmux: boolean }>;
export type ReviewPlan = Readonly<{
  agents: readonly MachineAgent[];
  skill: SkillMode;
  tmux: "yes" | "no";
  modules: readonly string[];
  skippedDefaults: readonly string[];
}>;

export type StepHandle = Readonly<{ done: (message: string) => void; fail: (message: string) => void }>;

// Everything the machine installer asks or shows in an interactive terminal. The non-interactive
// path (--yes, explicit flags, no TTY) never touches this, so scripted installs keep their plain,
// line-oriented output.
export type MachinePrompter = Readonly<{
  intro: (version: string, agents: readonly AgentChoice[], hosts: HostSummary) => void;
  agents: (choices: readonly AgentChoice[], initial: readonly MachineAgent[]) => Promise<MachineAgent[]>;
  skill: (initial: SkillMode) => Promise<SkillMode>;
  tmux: (initial: boolean) => Promise<"yes" | "no">;
  modules: (choices: readonly ModuleChoice[]) => Promise<string[]>;
  confirm: (message: string, initial: boolean) => Promise<boolean>;
  review: (plan: ReviewPlan) => Promise<boolean>;
  step: (label: string) => StepHandle;
  info: (message: string) => void;
  warn: (message: string) => void;
  outro: (message: string) => void;
}>;

const AGENT_LABELS: Readonly<Record<MachineAgent, string>> = { claude: "Claude Code", codex: "Codex", agy: "Antigravity (agy)" };

const MODULE_INFO: Readonly<Record<string, Readonly<{ label: string; hint: string; group: string }>>> = {
  "tmux-runtime": { label: "tmux split panes", hint: "shell wrapper plus child panes beside the parent", group: "Agents" },
  orchestration: { label: "Orchestration", hint: "dispatch and supervise agents in Orca, Superset or tmux", group: "Agents" },
  "orchestration-hooks": { label: "Turn-end hooks", hint: "tell the parent when a child finishes its turn", group: "Agents" },
  worktree: { label: "Shared worktrees", hint: "one worktree folder for Orca and Superset", group: "Agents" },
  "simulator-web": { label: "Web browsers", hint: "Playwright Chromium and Firefox for web testing", group: "Testing" },
  "simulator-native": { label: "iOS simulators", hint: "Appium with the XCUITest driver", group: "Testing" },
  "simulator-tv": { label: "Apple TV simulator", hint: "tvOS on the shared XCUITest toolchain", group: "Testing" },
  "tv-adb": { label: "Android TV", hint: "physical or emulated device over adb", group: "Testing" },
};

const tidy = (path: string | undefined): string => {
  if (path === undefined) return "";
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
};
const dim = (text: string): string => styleText("dim", text);
const bold = (text: string): string => styleText("bold", text);
const ok = (text: string): string => styleText("green", text);
const off = (text: string): string => styleText("gray", text);

function settled<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) {
    clack.cancel("Setup cancelled. Nothing else was changed.");
    throw new SetupCancelled();
  }
  return value as Exclude<T, symbol>;
}

function moduleLabel(module: string): string {
  return MODULE_INFO[module]?.label ?? module;
}

export function createClackPrompter(): MachinePrompter {
  return {
    intro: (version, agents, hosts) => {
      clack.intro(`${styleText(["bgCyan", "black", "bold"], " megabrain ")} ${dim(`setup · v${version}`)}`);
      const width = Math.max(...agents.map((choice) => AGENT_LABELS[choice.agent].length));
      const mark = (found: boolean, label: string, detail = "", pad = 0): string =>
        `${found ? ok("●") : off("○")} ${found ? label.padEnd(pad) : off(label.padEnd(pad))}${detail.length > 0 ? `  ${dim(detail)}` : ""}`;
      const agentLines = agents.map((choice) => mark(choice.installed, AGENT_LABELS[choice.agent], choice.installed ? tidy(choice.configDir) : "not installed", width));
      const hostLines = [mark(hosts.orca, "Orca"), mark(hosts.superset, "Superset"), mark(hosts.tmux, "tmux")];
      clack.note([bold("Agents"), ...agentLines, "", bold("Workspace"), hostLines.join("   ")].join("\n"), "Found on this machine");
    },
    agents: async (choices, initial) => {
      const installed = choices.filter((choice) => choice.installed);
      if (installed.length === 0) {
        clack.log.warn("No agent CLI was found on PATH, so there is nowhere to install the skill.");
        return [];
      }
      return settled(await clack.multiselect<MachineAgent>({
        message: `Which agents should get the megabrain skill? ${dim("(a = all)")}`,
        options: choices.map((choice) => ({
          value: choice.agent,
          label: AGENT_LABELS[choice.agent],
          ...(choice.installed ? {} : { hint: "not installed" }),
          disabled: !choice.installed,
        })),
        initialValues: initial.filter((agent) => installed.some((choice) => choice.agent === agent)),
        required: false,
      }));
    },
    skill: async (initial) => settled(await clack.select<SkillMode>({
      message: "Where should the skill live?",
      options: [
        { value: "global", label: "Everywhere", hint: "every project, in each agent's own config" },
        { value: "project", label: "Only this project", hint: "inside the current folder" },
        { value: "none", label: "Skip the skill" },
      ],
      initialValue: initial === "none" ? "none" : initial,
    })),
    tmux: async (initial) => {
      const answer = settled(await clack.confirm({
        message: `Run agents inside tmux? ${dim("children open as split panes beside you")}`,
        initialValue: initial,
      }));
      return answer ? "yes" : "no";
    },
    modules: async (choices) => {
      // One short question per group: plain multiselect is the prompt that can show an option as
      // unavailable (struck through, with why) and keep "a = all" from ever selecting it.
      const groupOrder = ["Agents", "Testing"];
      const titles: Readonly<Record<string, string>> = { Agents: "Agent tooling", Testing: "Testing surfaces" };
      const picked: string[] = [];
      for (const group of groupOrder) {
        const members = choices.filter((choice) => (MODULE_INFO[choice.module]?.group ?? "Agents") === group);
        if (members.length === 0) continue;
        const selectable = members.filter((choice) => choice.unavailable !== true);
        if (selectable.length === 0) {
          clack.log.info(`${titles[group] ?? group}: ${members.map((choice) => `${moduleLabel(choice.module)} ${off(`(${choice.skippedReason ?? "unavailable"})`)}`).join(", ")}`);
          continue;
        }
        const answer = settled(await clack.multiselect<string>({
          message: `${titles[group] ?? group} ${dim("(a = all)")}`,
          options: members.map((choice) => ({
            value: choice.module,
            label: moduleLabel(choice.module),
            hint: choice.unavailable === true ? choice.skippedReason ?? "unavailable" : MODULE_INFO[choice.module]?.hint ?? "",
            disabled: choice.unavailable === true,
          })),
          initialValues: members.filter((choice) => choice.selectedByDefault && choice.unavailable !== true).map((choice) => choice.module),
          required: false,
        }));
        picked.push(...answer);
      }
      return picked;
    },
    confirm: async (message, initial) => settled(await clack.confirm({ message, initialValue: initial })),
    review: async (plan) => {
      const list = (values: readonly string[]): string => (values.length === 0 ? off("none") : values.join(", "));
      const skillText = plan.skill === "global" ? "everywhere" : plan.skill === "project" ? "this project only" : off("skipped");
      const lines = [
        `${dim("Agents ")}  ${list(plan.agents.map((agent) => AGENT_LABELS[agent]))}`,
        `${dim("Skill  ")}  ${skillText}`,
        `${dim("tmux   ")}  ${plan.tmux === "yes" ? "split panes" : off("off")}`,
        `${dim("Modules")}  ${list(plan.modules.filter((module) => module !== "tmux-runtime").map(moduleLabel))}`,
        ...plan.skippedDefaults.map((line) => `${off("skip   ")}  ${off(line)}`),
      ];
      clack.note(lines.join("\n"), "Ready to install");
      return settled(await clack.confirm({ message: "Apply these changes?", initialValue: true }));
    },
    step: (label) => {
      const spinner = clack.spinner();
      spinner.start(label);
      return { done: (message) => spinner.stop(message), fail: (message) => spinner.error(message) };
    },
    info: (message) => clack.log.info(message),
    warn: (message) => clack.log.warn(message),
    outro: (message) => clack.outro(message),
  };
}

export { moduleLabel };

export function agentLabel(agent: MachineAgent): string {
  return AGENT_LABELS[agent];
}
