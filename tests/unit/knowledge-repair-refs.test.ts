import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairKnowledgeRefs } from "../../src/knowledge/repair-refs.js";
import { openProject } from "../../src/knowledge/store.js";
import type { Topic } from "../../src/knowledge/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("knowledge ref repair", () => {
  test("dry run predicts cleanup, real repair drops noise, caps refs and reruns idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-repair-")); roots.push(root);
    const stateDir = join(root, "state"), repo = join(root, "repo");
    mkdirSync(stateDir); mkdirSync(repo);
    const project = openProject(stateDir, repo);
    const topic: Topic = { id: "t", project: repo, title: "Topic", kind: "feat", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", aliases: [], sections: { overview: "", state: "", pitfalls: "", open: "" }, decisions: [], chats: [], keyMessages: [], refs: [{ kind: "issue", id: "0" }, { kind: "commit", id: "abcdef0" }, ...Array.from({ length: 14 }, (_, index) => ({ kind: "issue" as const, id: String(index + 1), lastAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, count: 1 }))] };
    project.saveTopic(topic);
    expect(await repairKnowledgeRefs({ stateDir, dryRun: true })).toMatchObject({ changed: 1, dryRun: true });
    expect(project.topic("t")?.refs).toHaveLength(16);
    expect(await repairKnowledgeRefs({ stateDir })).toMatchObject({ changed: 1, dryRun: false });
    expect(project.topic("t")?.refs).toHaveLength(12);
    expect(project.revisions("t")).toHaveLength(1);
    expect(await repairKnowledgeRefs({ stateDir })).toMatchObject({ changed: 0 });
    expect(project.revisions("t")).toHaveLength(1);
  });
});
