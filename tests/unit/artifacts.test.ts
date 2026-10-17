import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectId, resolveProject } from "../../src/knowledge/project-id.js";
import { ARTIFACT_MAX_BYTES, artifactFormat, artifactRevisions, createArtifact, listArtifacts, removeArtifact, showArtifact, stripGoogleFonts, updateArtifact } from "../../src/knowledge/artifacts.js";
import { executeArtifact } from "../../src/cli/commands/artifact.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();

/** A state dir plus a real repository (branch main) with a linked worktree on feat/plan. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-artifacts-")));
  directories.push(root);
  const state = join(root, "state"), repo = join(root, "api"), feature = join(root, "api-plan");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "feat/plan", feature);
  return { root, state, repo, feature, environment: { HOME: root, MEGABRAIN_STATE_DIR: state } };
}

const diagram = `<!doctype html>
<html><head>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&amp;display=swap" rel="stylesheet">
<style>
@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap');
body { font-family: 'Geist', system-ui, sans-serif; }
</style>
</head><body><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg></body></html>
`;

const plan = "# Rollout plan\n\n1. Ship the store.\n2. Ship the page.\n";

describe("project ids", () => {
  test("an id is the repository's folder name and a hash of its real path", () => {
    const w = world();
    expect(projectId(w.repo)).toMatch(/^api-[0-9a-f]{12}$/);
  });

  test("a symlinked path and the real path share one id", () => {
    const w = world();
    const link = join(w.root, "api-link");
    symlinkSync(w.repo, link);
    expect(projectId(link)).toBe(projectId(w.repo));
  });

  test("two repositories with one folder name get two ids", () => {
    const w = world();
    const other = join(w.root, "elsewhere", "api");
    mkdirSync(other, { recursive: true });
    expect(projectId(other)).not.toBe(projectId(w.repo));
    expect(projectId(other)).toMatch(/^api-[0-9a-f]{12}$/);
  });

  test("a name with spaces and capitals becomes a lowercase slug", () => {
    const w = world();
    const odd = join(w.root, "My Repo.v2");
    mkdirSync(odd);
    expect(projectId(odd)).toMatch(/^my-repo-v2-[0-9a-f]{12}$/);
  });

  test("a linked worktree belongs to its main checkout's project", async () => {
    const w = world();
    const main = await resolveProject(w.repo);
    const linked = await resolveProject(join(w.feature));
    expect(main).toEqual({ repo: w.repo, name: "api", id: projectId(w.repo) });
    expect(linked).toEqual(main);
  });

  test("a folder outside git is its own project", async () => {
    const w = world();
    const loose = join(w.root, "notes");
    mkdirSync(loose);
    expect(await resolveProject(loose)).toEqual({ repo: loose, name: "notes", id: projectId(loose) });
  });
});

describe("Google Fonts stripping", () => {
  test("removes font links, preconnects and @import rules, and keeps everything else", () => {
    const stripped = stripGoogleFonts(diagram);
    expect(stripped).not.toContain("fonts.googleapis.com");
    expect(stripped).not.toContain("fonts.gstatic.com");
    expect(stripped).toContain("font-family: 'Geist', system-ui, sans-serif;");
    expect(stripped).toContain("<svg viewBox=\"0 0 10 10\">");
    expect(stripped).toContain("<style>");
  });

  test("leaves other stylesheets alone", () => {
    const html = '<link rel="stylesheet" href="local.css"><p>x</p>';
    expect(stripGoogleFonts(html)).toBe(html);
  });
});

describe("artifact formats", () => {
  test("the file extension decides first", () => {
    expect(artifactFormat("# hi", "plan.md")).toBe("markdown");
    expect(artifactFormat("<p>x</p>", "page.html")).toBe("html");
    expect(artifactFormat("plain", "page.htm")).toBe("html");
  });

  test("without an extension, a document that opens with HTML is HTML", () => {
    expect(artifactFormat(diagram)).toBe("html");
    expect(artifactFormat("  <svg viewBox='0 0 1 1'></svg>")).toBe("html");
    expect(artifactFormat(plan)).toBe("markdown");
    expect(artifactFormat("<!-- a note -->\n# Title")).toBe("markdown");
  });
});

describe("the artifact store", () => {
  test("create writes artifact.json and index.html under the project's knowledge folder, fonts stripped", async () => {
    const w = world();
    const created = await createArtifact(w.state, { title: "Store layout", kind: "diagram", content: diagram, format: "html", project: w.repo, topics: ["topic-a"], chatId: "chat-1" });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") return;
    const artifact = created.value;
    const dir = join(w.state, "knowledge", projectId(w.repo), "artifacts", artifact.id);
    expect(artifact).toMatchObject({ title: "Store layout", kind: "diagram", format: "html", project: w.repo, projectName: "api", projectId: projectId(w.repo), topics: ["topic-a"], chatId: "chat-1", revision: 1, path: join(dir, "index.html") });
    expect(artifact.createdAt).toBe(artifact.updatedAt);
    const stored = JSON.parse(readFileSync(join(dir, "artifact.json"), "utf8"));
    expect(stored).toMatchObject({ id: artifact.id, title: "Store layout", kind: "diagram", topics: ["topic-a"], chatId: "chat-1" });
    const content = readFileSync(join(dir, "index.html"), "utf8");
    expect(content).not.toContain("fonts.googleapis.com");
    expect(content).toContain("<svg");
  });

  test("a markdown plan is stored as doc.md with no chat and no topics", async () => {
    const w = world();
    const created = await createArtifact(w.state, { title: "Rollout", kind: "plan", content: plan, format: "markdown", project: w.repo, topics: [], chatId: null });
    expect(created.kind).toBe("ok");
    if (created.kind !== "ok") return;
    expect(created.value.chatId).toBeNull();
    expect(created.value.path.endsWith("doc.md")).toBe(true);
    expect(readFileSync(created.value.path, "utf8")).toBe(plan);
  });

  test("a diagram must be HTML", async () => {
    const w = world();
    const created = await createArtifact(w.state, { title: "Bad", kind: "diagram", content: plan, format: "markdown", project: w.repo, topics: [], chatId: null });
    expect(created.kind).toBe("failed");
    expect(created.kind === "failed" ? created.error : "").toContain("diagram must be HTML");
    expect(existsSync(join(w.state, "knowledge"))).toBe(false);
  });

  test("plans and docs take HTML too", async () => {
    const w = world();
    const created = await createArtifact(w.state, { title: "Doc", kind: "doc", content: "<p>hi</p>", format: "html", project: w.repo, topics: [], chatId: null });
    expect(created.kind).toBe("ok");
  });

  test("an unknown kind is refused", async () => {
    const w = world();
    const created = await createArtifact(w.state, { title: "x", kind: "slide" as never, content: plan, format: "markdown", project: w.repo, topics: [], chatId: null });
    expect(created.kind).toBe("failed");
    expect(created.kind === "failed" ? created.error : "").toContain("diagram, plan or doc");
  });

  test("content over the size cap is refused, at the cap is kept", async () => {
    const w = world();
    const over = await createArtifact(w.state, { title: "Big", kind: "doc", content: "a".repeat(ARTIFACT_MAX_BYTES + 1), format: "markdown", project: w.repo, topics: [], chatId: null });
    expect(over.kind).toBe("failed");
    expect(over.kind === "failed" ? over.error : "").toContain(String(ARTIFACT_MAX_BYTES));
    const at = await createArtifact(w.state, { title: "Full", kind: "doc", content: "a".repeat(ARTIFACT_MAX_BYTES), format: "markdown", project: w.repo, topics: [], chatId: null });
    expect(at.kind).toBe("ok");
  });

  test("empty content and an empty title are refused", async () => {
    const w = world();
    expect((await createArtifact(w.state, { title: "x", kind: "doc", content: "  \n", format: "markdown", project: w.repo, topics: [], chatId: null })).kind).toBe("failed");
    expect((await createArtifact(w.state, { title: "  ", kind: "doc", content: plan, format: "markdown", project: w.repo, topics: [], chatId: null })).kind).toBe("failed");
  });

  test("update keeps each earlier version in revisions.jsonl, oldest first", async () => {
    const w = world();
    const created = await createArtifact(w.state, { title: "Plan v1", kind: "plan", content: "one", format: "markdown", project: w.repo, topics: [], chatId: null });
    if (created.kind !== "ok") throw new Error("create failed");
    const id = created.value.id;
    const second = await updateArtifact(w.state, id, { content: "two", format: "markdown" });
    const third = await updateArtifact(w.state, id, { content: "three", format: "markdown", title: "Plan v3" });
    expect(second.kind).toBe("ok");
    expect(third.kind === "ok" ? third.value : null).toMatchObject({ title: "Plan v3", revision: 3, createdAt: created.value.createdAt });
    const revisions = await artifactRevisions(w.state, id);
    expect(revisions.map((entry) => [entry.revision, entry.title, entry.content])).toEqual([[1, "Plan v1", "one"], [2, "Plan v1", "two"]]);
    const shown = await showArtifact(w.state, id);
    expect(shown?.content).toBe("three");
  });

  test("an update that turns a doc from markdown into HTML replaces its content file", async () => {
    const w = world();
    const created = await createArtifact(w.state, { title: "Doc", kind: "doc", content: plan, format: "markdown", project: w.repo, topics: [], chatId: null });
    if (created.kind !== "ok") throw new Error("create failed");
    const updated = await updateArtifact(w.state, created.value.id, { content: diagram, format: "html" });
    expect(updated.kind === "ok" ? updated.value.format : null).toBe("html");
    const dir = join(w.state, "knowledge", projectId(w.repo), "artifacts", created.value.id);
    expect(readdirSync(dir).sort()).toEqual(["artifact.json", "index.html", "revisions.jsonl"]);
  });

  test("an update cannot turn a diagram into markdown, and leaves it untouched", async () => {
    const w = world();
    const created = await createArtifact(w.state, { title: "D", kind: "diagram", content: diagram, format: "html", project: w.repo, topics: [], chatId: null });
    if (created.kind !== "ok") throw new Error("create failed");
    const updated = await updateArtifact(w.state, created.value.id, { content: plan, format: "markdown" });
    expect(updated.kind).toBe("failed");
    expect((await showArtifact(w.state, created.value.id))?.revision).toBe(1);
    expect(await artifactRevisions(w.state, created.value.id)).toEqual([]);
  });

  test("update and remove of an unknown id fail", async () => {
    const w = world();
    expect((await updateArtifact(w.state, "art-missing", { content: "x", format: "markdown" })).kind).toBe("failed");
    expect((await removeArtifact(w.state, "art-missing")).kind).toBe("failed");
    expect(await showArtifact(w.state, "art-missing")).toBeNull();
  });

  test("list filters by project and topic, newest change first", async () => {
    const w = world();
    const other = join(w.root, "web");
    mkdirSync(other);
    const a = await createArtifact(w.state, { title: "A", kind: "plan", content: "a", format: "markdown", project: w.repo, topics: ["t1"], chatId: null, now: "2026-10-01T00:00:00.000Z" });
    const b = await createArtifact(w.state, { title: "B", kind: "doc", content: "b", format: "markdown", project: w.repo, topics: ["t2"], chatId: null, now: "2026-10-02T00:00:00.000Z" });
    const c = await createArtifact(w.state, { title: "C", kind: "doc", content: "c", format: "markdown", project: other, topics: ["t1"], chatId: null, now: "2026-10-03T00:00:00.000Z" });
    if (a.kind !== "ok" || b.kind !== "ok" || c.kind !== "ok") throw new Error("create failed");
    expect((await listArtifacts(w.state, {})).map((entry) => entry.title)).toEqual(["C", "B", "A"]);
    expect((await listArtifacts(w.state, { project: w.repo })).map((entry) => entry.title)).toEqual(["B", "A"]);
    expect((await listArtifacts(w.state, { topic: "t1" })).map((entry) => entry.title)).toEqual(["C", "A"]);
    await updateArtifact(w.state, a.value.id, { content: "a2", format: "markdown", now: "2026-10-04T00:00:00.000Z" });
    expect((await listArtifacts(w.state, {})).map((entry) => entry.title)).toEqual(["A", "C", "B"]);
  });

  test("remove deletes the artifact's folder and nothing else", async () => {
    const w = world();
    const a = await createArtifact(w.state, { title: "A", kind: "plan", content: "a", format: "markdown", project: w.repo, topics: [], chatId: null });
    const b = await createArtifact(w.state, { title: "B", kind: "plan", content: "b", format: "markdown", project: w.repo, topics: [], chatId: null });
    if (a.kind !== "ok" || b.kind !== "ok") throw new Error("create failed");
    expect((await removeArtifact(w.state, a.value.id)).kind).toBe("ok");
    expect(existsSync(join(w.state, "knowledge", projectId(w.repo), "artifacts", a.value.id))).toBe(false);
    expect((await listArtifacts(w.state, {})).map((entry) => entry.id)).toEqual([b.value.id]);
  });

  test("creates of the same folded title in one chat get distinct ids and suggest updating the existing id", async () => {
    const w = world();
    const first = await executeArtifact(["create", "--title", "  Leva de correções do QA Social ", "--kind", "doc", "--stdin", "--project", w.repo, "--chat", "chat-1", "--json"], w.environment, { stdin: async () => "old" });
    const original = JSON.parse(String(first.value));
    const warnings: string[] = [];
    const second = await executeArtifact(["create", "--title", "leva de correcoes do qa social", "--kind", "plan", "--stdin", "--project", w.repo, "--chat", "chat-1", "--json"], w.environment, { stdin: async () => "new", stderr: (text) => warnings.push(text) });
    const created = JSON.parse(String(second.value));
    expect(created.id).not.toBe(original.id);
    expect(created).toMatchObject({ revision: 1, kind: "plan", format: "markdown", similar: [{ id: original.id, title: original.title }] });
    expect(warnings).toEqual([expect.stringContaining(`megabrain artifact update ${original.id}`)]);
    expect((await artifactRevisions(w.state, original.id))).toEqual([]);
    const updated = await executeArtifact(["update", original.id, "--stdin", "--json"], w.environment, { stdin: async () => "third" });
    expect(JSON.parse(String(updated.value))).toMatchObject({ id: original.id, revision: 2 });
    expect((await listArtifacts(w.state, { project: w.repo })).length).toBe(2);
  });

  test("artifact list filters by chat id", async () => {
    const w = world();
    const first = await executeArtifact(["create", "--title", "A", "--kind", "doc", "--stdin", "--project", w.repo, "--chat", "chat-a", "--json"], w.environment, { stdin: async () => "a" });
    const second = await executeArtifact(["create", "--title", "B", "--kind", "doc", "--stdin", "--project", w.repo, "--chat", "chat-b", "--json"], w.environment, { stdin: async () => "b" });
    const a = JSON.parse(String(first.value)), b = JSON.parse(String(second.value));
    const listed = await executeArtifact(["list", "--chat", "chat-a", "--json"], w.environment);
    expect(JSON.parse(String(listed.value)).artifacts.map((item: { id: string }) => item.id)).toEqual([a.id]);
    expect(JSON.parse(String(listed.value)).artifacts.map((item: { id: string }) => item.id)).not.toContain(b.id);
  });
});

describe("megabrain artifact", () => {
  const json = (value: { kind: string; value?: unknown; error?: string }) => {
    if (value.kind !== "ok") throw new Error(String(value.error));
    return JSON.parse(String(value.value));
  };

  test("create from a file, then list, show, update from stdin and remove", async () => {
    const w = world();
    const file = join(w.root, "diagram.html");
    writeFileSync(file, diagram);
    const created = json(await executeArtifact(["create", "--title", "Flow", "--kind", "diagram", "--file", file, "--project", w.feature, "--topic", "t1", "--topic", "t2", "--chat", "chat-9", "--json"], w.environment));
    expect(created).toMatchObject({ title: "Flow", kind: "diagram", format: "html", project: w.repo, topics: ["t1", "t2"], chatId: "chat-9", revision: 1 });

    const listed = json(await executeArtifact(["list", "--project", w.repo, "--topic", "t2", "--json"], w.environment));
    expect(listed.artifacts.map((entry: { id: string }) => entry.id)).toEqual([created.id]);

    const shown = json(await executeArtifact(["show", created.id, "--json"], w.environment));
    expect(shown.content).not.toContain("fonts.googleapis.com");
    expect(shown.content).toContain("<svg");

    const updated = json(await executeArtifact(["update", created.id, "--stdin", "--title", "Flow v2", "--json"], w.environment, { stdin: async () => diagram.replace("<rect", "<circle") }));
    expect(updated).toMatchObject({ title: "Flow v2", revision: 2 });

    const removed = json(await executeArtifact(["remove", created.id, "--json"], w.environment));
    expect(removed).toEqual({ removed: created.id });
    expect(json(await executeArtifact(["list", "--json"], w.environment)).artifacts).toEqual([]);
  });

  test("show --json lists the versions updates replaced, oldest first, without their content", async () => {
    const w = world();
    const created = json(await executeArtifact(["create", "--title", "Plan v1", "--kind", "plan", "--stdin", "--project", w.repo, "--json"], w.environment, { stdin: async () => "one" }));
    expect(json(await executeArtifact(["show", created.id, "--json"], w.environment)).revisions).toEqual([]);

    await executeArtifact(["update", created.id, "--stdin", "--json"], w.environment, { stdin: async () => "two" });
    await executeArtifact(["update", created.id, "--stdin", "--title", "Plan v3", "--json"], w.environment, { stdin: async () => "three" });
    const shown = json(await executeArtifact(["show", created.id, "--json"], w.environment));
    expect(shown).toMatchObject({ title: "Plan v3", revision: 3, content: "three" });
    expect(shown.revisions.map((entry: Record<string, unknown>) => Object.keys(entry).sort())).toEqual([
      ["replacedAt", "revision", "title", "updatedAt"],
      ["replacedAt", "revision", "title", "updatedAt"],
    ]);
    expect(shown.revisions.map((entry: { revision: number; title: string }) => [entry.revision, entry.title])).toEqual([[1, "Plan v1"], [2, "Plan v1"]]);
    expect(shown.revisions[0].updatedAt).toBe(created.updatedAt);
    expect(shown.revisions[0].replacedAt <= shown.revisions[1].replacedAt).toBe(true);

    // The plain show still prints the content alone.
    const plain = await executeArtifact(["show", created.id], w.environment);
    expect(plain.kind === "ok" ? plain.value : "").toBe("three\n");
  });

  test("guide is useful in text and structured JSON, and new writes themed starters", async () => {
    const w = world();
    for (const kind of ["diagram", "plan", "doc"]) {
      const guide = await executeArtifact(["guide", "--kind", kind], w.environment);
      expect(guide.kind).toBe("ok");
      expect(String(guide.value).toLowerCase()).toContain(kind);
      const structured = json(await executeArtifact(["guide", "--kind", kind, "--json"], w.environment));
      expect(JSON.stringify(structured).toLowerCase()).toContain(kind);
      expect(JSON.stringify(structured)).toContain("update");
      expect(JSON.stringify(structured)).toContain("artifact list --chat <chat-id>");
      expect(JSON.stringify(structured)).toContain("artifact update <id>");
    }
    const html = json(await executeArtifact(["new", "Flow", "--kind", "diagram", "--project", w.repo, "--chat", "chat-1", "--json"], w.environment, { cwd: w.root }));
    expect(html).toMatchObject({ title: "Flow", kind: "diagram", chatId: "chat-1" });
    const htmlContent = readFileSync(html.path, "utf8");
    expect(htmlContent).toContain("megabrain-theme");
    expect(htmlContent).not.toMatch(/https?:\/\//);
    expect(htmlContent).toContain("prefers-color-scheme: light");
    const markdown = json(await executeArtifact(["new", "Plan", "--kind", "plan", "--project", w.repo, "--json"], w.environment, { cwd: w.root }));
    expect(readFileSync(markdown.path, "utf8")).toContain("## Checkpoints");
  });

  test("create and update inline megabrain theme into unthemed HTML", async () => {
    const w = world();
    const created = json(await executeArtifact(["create", "--title", "Page", "--kind", "doc", "--stdin", "--theme", "megabrain", "--project", w.repo, "--json"], w.environment, { stdin: async () => "<html><body>hello</body></html>" }));
    expect(readFileSync(created.path, "utf8")).toContain("megabrain-theme");
    const updated = json(await executeArtifact(["update", created.id, "--stdin", "--theme", "megabrain", "--json"], w.environment, { stdin: async () => "<html><body>updated</body></html>" }));
    expect(readFileSync(updated.path, "utf8")).toContain("megabrain-theme");
  });

  test("show --revision reads stored content and metadata", async () => {
    const w = world();
    const created = json(await executeArtifact(["create", "--title", "Plan", "--kind", "plan", "--stdin", "--project", w.repo, "--json"], w.environment, { stdin: async () => "one" }));
    await executeArtifact(["update", created.id, "--stdin", "--json"], w.environment, { stdin: async () => "two" });
    expect(json(await executeArtifact(["show", created.id, "--revision", "1", "--json"], w.environment)).content).toBe("one");
  });

  test("create with no --project uses the working folder's project", async () => {
    const w = world();
    const created = json(await executeArtifact(["create", "--title", "Plan", "--kind", "plan", "--stdin", "--json"], w.environment, { cwd: w.feature, stdin: async () => plan }));
    expect(created).toMatchObject({ project: w.repo, format: "markdown" });
  });

  test("create needs exactly one of --file and --stdin, a title and a known kind", async () => {
    const w = world();
    const file = join(w.root, "plan.md");
    writeFileSync(file, plan);
    const stdin = async () => plan;
    for (const args of [
      ["create", "--title", "x", "--kind", "plan"],
      ["create", "--title", "x", "--kind", "plan", "--file", file, "--stdin"],
      ["create", "--kind", "plan", "--file", file],
      ["create", "--title", "x", "--kind", "slides", "--file", file],
      ["create", "--title", "x", "--file", file],
    ]) {
      const result = await executeArtifact([...args, "--project", w.repo], w.environment, { stdin });
      expect(result.kind).toBe("failed");
      expect(result.exitCode).toBe(2);
    }
  });

  test("a markdown file as a diagram is refused", async () => {
    const w = world();
    const file = join(w.root, "plan.md");
    writeFileSync(file, plan);
    const result = await executeArtifact(["create", "--title", "x", "--kind", "diagram", "--file", file, "--project", w.repo], w.environment);
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("diagram must be HTML");
  });

  test("show and remove of an unknown id fail with exit 1", async () => {
    const w = world();
    expect((await executeArtifact(["show", "art-nope"], w.environment)).exitCode).toBe(1);
    expect((await executeArtifact(["remove", "art-nope"], w.environment)).exitCode).toBe(1);
  });

  test("each verb prints its usage line on --help", async () => {
    const w = world();
    for (const verb of ["create", "update", "list", "show", "remove"]) {
      const result = await executeArtifact([verb, "--help"], w.environment);
      expect(result.kind).toBe("ok");
      expect(String(result.kind === "ok" ? result.value : "")).toStartWith(`Usage: megabrain artifact ${verb}`);
    }
  });
});
