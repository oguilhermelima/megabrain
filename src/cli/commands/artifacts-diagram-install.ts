import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { discoverAgentDirectories, type MachineAgent } from "../../core/agent-directories.js";
import { failed, ok, type Result } from "../../core/result.js";

// The artifacts-diagram module: the diagram-design skill (MIT, github.com/cathrynlavery/diagram-design)
// copied into each configured agent's skills folder, its licences beside it, pinned to one tested
// commit. Each copy carries a marker file, so a reinstall replaces only megabrain's own copy, a
// diagram-design the person installed themselves is never touched, and --revert removes only ours.

type Environment = Readonly<Record<string, string | undefined>>;
type ModuleReport = Readonly<{ status: string; reason: string }>;
type Target = Readonly<{ agent: MachineAgent; config: string; skill: string }>;

export const DIAGRAM_DESIGN_COMMIT = "550fd66edff058bc73056c3416b76d69cfe865ba";
const SOURCE_URL = `https://codeload.github.com/cathrynlavery/diagram-design/tar.gz/${DIAGRAM_DESIGN_COMMIT}`;
const MODULE = "artifacts-diagram";
const MARKER = ".megabrain-module.json";
const AGENTS: readonly MachineAgent[] = ["claude", "codex", "agy", "grok"];
const LICENCES = ["LICENSE", "THIRD_PARTY_LICENSES.md"];

const NOTE = `

## Saving with megabrain

This copy was installed by megabrain (module ${MODULE}). When a diagram is finished, file it with its
project so the person finds it on the megabrain app's Artifacts page:

    megabrain artifact create --kind diagram --title "<what it shows>" --file <the .html file> [--topic <id>] --json

File a later version of the same diagram with megabrain artifact update <id> --file <the .html file>.
megabrain strips the Google Fonts links on save, so the diagram renders offline with system fonts.
`;

/** Every agent's diagram-design folder; an agent counts as configured when its configuration folder exists. */
function targets(environment: Environment): Target[] {
  const directories = discoverAgentDirectories(environment);
  return AGENTS.flatMap((agent) => {
    const entry = directories[agent];
    if (entry === undefined) return [];
    return [{ agent, config: entry.config, skill: join(dirname(dirname(entry.globalSkill)), "diagram-design") }];
  });
}

type Marker = { module?: string; commit?: string };

function marker(skill: string): Marker | null {
  try {
    const value = JSON.parse(readFileSync(join(skill, MARKER), "utf8")) as Marker;
    return value.module === MODULE ? value : null;
  } catch {
    return null;
  }
}

/** The release tarball: MEGABRAIN_DIAGRAM_DESIGN_SOURCE may name a local one (tests), else GitHub's archive of the pinned commit. */
async function fetchSource(environment: Environment, directory: string, process: ProcessAdapter): Promise<Result<string>> {
  const override = environment.MEGABRAIN_DIAGRAM_DESIGN_SOURCE;
  if (override !== undefined && override !== "") return existsSync(override) ? ok(override) : failed(`diagram-design source not found: ${override}`);
  const target = join(directory, "diagram-design.tar.gz");
  const fetched = await process.run("curl", ["--fail", "--silent", "--show-error", "--location", SOURCE_URL, "--output", target], { timeoutMs: 300_000 });
  return fetched.kind === "ok" ? ok(target) : failed(`could not download diagram-design ${DIAGRAM_DESIGN_COMMIT}: ${fetched.error}`);
}

/** The skill folder ready to copy: the upstream skill, its licences, the megabrain note and the marker. */
async function stage(environment: Environment, scratch: string, process: ProcessAdapter): Promise<Result<string>> {
  const archive = await fetchSource(environment, scratch, process);
  if (archive.kind !== "ok") return archive;
  const unpacked = join(scratch, "unpacked");
  mkdirSync(unpacked);
  const extracted = await process.run("tar", ["-xzf", archive.value, "-C", unpacked], { timeoutMs: 120_000 });
  if (extracted.kind !== "ok") return failed(`could not unpack diagram-design: ${extracted.error}`);
  const [top, ...rest] = readdirSync(unpacked);
  if (top === undefined || rest.length > 0) return failed("the diagram-design archive does not hold one top folder");
  const root = join(unpacked, top);
  const skill = join(root, "skills", "diagram-design");
  if (!existsSync(join(skill, "SKILL.md"))) return failed("the diagram-design archive has no skills/diagram-design/SKILL.md");
  if (!existsSync(join(root, "LICENSE"))) return failed("the diagram-design archive has no LICENSE");
  const staged = join(scratch, "staged");
  cpSync(skill, staged, { recursive: true });
  for (const licence of LICENCES) if (existsSync(join(root, licence))) cpSync(join(root, licence), join(staged, licence));
  appendFileSync(join(staged, "SKILL.md"), NOTE);
  writeFileSync(join(staged, MARKER), `${JSON.stringify({ module: MODULE, commit: DIAGRAM_DESIGN_COMMIT, source: "https://github.com/cathrynlavery/diagram-design", installedAt: new Date().toISOString() }, null, 2)}\n`);
  return ok(staged);
}

export async function installArtifactsDiagram(environment: Environment, process: ProcessAdapter): Promise<Result<void>> {
  const configured = targets(environment).filter((target) => existsSync(target.config));
  if (configured.length === 0) return failed("no agent is configured: none of Claude, Codex, agy or Grok has a configuration folder");
  const scratch = mkdtempSync(join(tmpdir(), "megabrain-diagram-design-"));
  try {
    const staged = await stage(environment, scratch, process);
    if (staged.kind !== "ok") return staged;
    for (const target of configured) {
      // A diagram-design the person installed is theirs; doctor reports it as such.
      if (existsSync(target.skill) && marker(target.skill) === null) continue;
      rmSync(target.skill, { recursive: true, force: true });
      mkdirSync(dirname(target.skill), { recursive: true });
      cpSync(staged.value, target.skill, { recursive: true });
    }
    return ok(undefined);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Removes the copies megabrain installed, from every agent, and leaves anything else in place. */
export function revertArtifactsDiagram(environment: Environment): Result<string> {
  const removed = targets(environment).filter((target) => marker(target.skill) !== null);
  for (const target of removed) rmSync(target.skill, { recursive: true, force: true });
  return ok(`${MODULE} reverted (${removed.length} ${removed.length === 1 ? "copy" : "copies"} removed)\n`);
}

/** Each configured agent's copy: current at the pinned commit, stale, the person's own, or absent. */
export function artifactsDiagramReport(environment: Environment): ModuleReport {
  const configured = targets(environment).filter((target) => existsSync(target.config));
  if (configured.length === 0) return { status: "missing", reason: "no agent is configured" };
  const states = configured.map((target) => {
    if (!existsSync(target.skill)) return { agent: target.agent, state: "absent" };
    const found = marker(target.skill);
    if (found === null) return { agent: target.agent, state: "not installed by megabrain" };
    const complete = existsSync(join(target.skill, "SKILL.md")) && existsSync(join(target.skill, "LICENSE"));
    return { agent: target.agent, state: found.commit === DIAGRAM_DESIGN_COMMIT && complete ? "current" : "stale" };
  });
  const reason = `diagram-design ${DIAGRAM_DESIGN_COMMIT.slice(0, 12)}: ${states.map(({ agent, state }) => `${agent} ${state}`).join("; ")}`;
  if (!states.some(({ state }) => state === "current" || state === "stale")) return { status: "missing", reason };
  if (states.some(({ state }) => state === "absent" || state === "stale")) return { status: "misconfigured", reason: `${reason}; run megabrain install ${MODULE}` };
  return { status: "ok", reason };
}
