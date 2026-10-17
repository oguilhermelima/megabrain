import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWellFormedRef, mergeRefs, rankAndCapRefs } from "./refs.js";
import { knowledgeRoot, listProjects, openProject } from "./store.js";
import type { Ref, RefKind } from "./types.js";

export type RepairRefsResult = { changed: number; topicsChanged: number; refsBefore: Record<RefKind, number>; refsAfter: Record<RefKind, number>; dryRun: boolean; alreadyDone?: boolean };
const KINDS: RefKind[] = ["issue", "pr", "commit", "branch", "file"];
const MARKER = "refs-repair.json";

function counts(): Record<RefKind, number> { return { issue: 0, pr: 0, commit: 0, branch: 0, file: 0 }; }
function trusted(ref: Ref): boolean {
  if (!isWellFormedRef(ref)) return false;
  if (ref.kind === "commit") return ref.origin === "created" || ref.source === "git-output";
  if (ref.kind === "branch") return ref.origin === "created" || ref.source === "git-output" || ref.source === "megabrain-output";
  return true;
}

/** Removes legacy noise from every topic. Saving a changed topic creates the store's normal revision. */
export async function repairKnowledgeRefs(options: { stateDir: string; repo?: string; dryRun?: boolean; once?: boolean }): Promise<RepairRefsResult> {
  const { stateDir, repo, dryRun = false, once = false } = options;
  const marker = join(knowledgeRoot(stateDir), MARKER);
  if (once && existsSync(marker)) return { changed: 0, topicsChanged: 0, refsBefore: counts(), refsAfter: counts(), dryRun, alreadyDone: true };
  const before = counts(), after = counts();
  let topicsChanged = 0;
  for (const entry of listProjects(stateDir).filter((project) => repo === undefined || project.repo === repo || project.id === repo)) {
    const project = openProject(stateDir, entry.repo);
    for (const topic of project.topics()) {
      for (const ref of topic.refs) if (KINDS.includes(ref.kind)) before[ref.kind] += 1;
      const refs = rankAndCapRefs(mergeRefs(topic.refs.filter(trusted)));
      for (const ref of refs) after[ref.kind] += 1;
      if (JSON.stringify(refs) === JSON.stringify(topic.refs)) continue;
      topicsChanged += 1;
      if (!dryRun) project.saveTopic({ ...topic, refs, updatedAt: new Date().toISOString() });
    }
  }
  if (once && !dryRun) {
    mkdirSync(knowledgeRoot(stateDir), { recursive: true, mode: 0o700 });
    const temporary = `${marker}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ done: true, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(temporary, marker);
  }
  return { changed: topicsChanged, topicsChanged, refsBefore: before, refsAfter: after, dryRun };
}
