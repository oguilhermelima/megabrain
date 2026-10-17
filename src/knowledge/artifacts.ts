import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { failed, ok, type Result } from "../core/result.js";
import { resolveProject } from "./project-id.js";

// Artifacts: diagrams, plans and docs an agent files for a project. Each one is a folder,
// $MEGABRAIN_STATE_DIR/knowledge/<project-id>/artifacts/<id>/, holding artifact.json, its content
// (index.html or doc.md) and revisions.jsonl, where every update appends the version it replaces.
// HTML is saved without its Google Fonts links so it renders offline in the app's sandboxed frame.

export const ARTIFACT_KINDS = ["diagram", "plan", "doc"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ArtifactFormat = "html" | "markdown";

/** The largest content kept, in bytes: a diagram-design page is tens of kilobytes, so this leaves room without letting a log in. */
export const ARTIFACT_MAX_BYTES = 1024 * 1024;

type Stored = {
  id: string;
  title: string;
  kind: ArtifactKind;
  format: ArtifactFormat;
  /** The repository's main checkout path, its folder name, and its knowledge folder (project-id.ts). */
  project: string;
  projectName: string;
  projectId: string;
  topics: string[];
  chatId: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
};
export type Artifact = Stored & { path: string };
export type ArtifactWithContent = Artifact & { content: string };
/** A replaced version, as revisions.jsonl keeps it. */
export type ArtifactRevision = Stored & { content: string; replacedAt: string };

export type CreateInput = { title: string; kind: ArtifactKind; content: string; format: ArtifactFormat; project: string; topics: readonly string[]; chatId: string | null; now?: string };
export type UpdateInput = { content: string; format: ArtifactFormat; title?: string; now?: string };
export type ListFilter = { project?: string; topic?: string };

const ID = /^art-[0-9a-z-]+$/;
const contentFile = (format: ArtifactFormat): string => (format === "html" ? "index.html" : "doc.md");
const knowledgeDir = (stateDir: string): string => join(stateDir, "knowledge");
const artifactsDir = (stateDir: string, project: string): string => join(knowledgeDir(stateDir), project, "artifacts");

const FONT_HOST = /fonts\.(googleapis|gstatic)\.com/i;

/** The HTML without Google Fonts: its <link> tags (stylesheets and preconnects) and its @import rules. Fonts fall back to the page's own font stacks. */
export function stripGoogleFonts(html: string): string {
  return html
    .replace(/[ \t]*<link\b[^>]*>[ \t]*\n?/gi, (tag) => (FONT_HOST.test(tag) ? "" : tag))
    .replace(/[ \t]*@import\s+url\(\s*(['"]?)[^'")]*fonts\.googleapis\.com[^'")]*\1\s*\)[^;]*;[ \t]*\n?/gi, "")
    .replace(/[ \t]*@import\s+(['"])[^'"]*fonts\.googleapis\.com[^'"]*\1[^;]*;[ \t]*\n?/gi, "");
}

/** HTML or Markdown: a file's extension decides when it names one, else whether the text opens with an HTML element. */
export function artifactFormat(content: string, fileName?: string): ArtifactFormat {
  const extension = fileName === undefined ? "" : extname(fileName).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "html";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  return /^\s*<(!doctype\s+html|html|head|body|svg|div|section|main|style|meta)\b/i.test(content) ? "html" : "markdown";
}

function validate(kind: string, format: ArtifactFormat, content: string): Result<void> {
  if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) return failed("--kind must be diagram, plan or doc", 2);
  if (kind === "diagram" && format !== "html") return failed("a diagram must be HTML", 2);
  if (content.trim() === "") return failed("the artifact is empty", 2);
  const bytes = Buffer.byteLength(content);
  if (bytes > ARTIFACT_MAX_BYTES) return failed(`the artifact is ${bytes} bytes; the limit is ${ARTIFACT_MAX_BYTES}`, 1);
  return ok(undefined);
}

function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

function readStored(dir: string): Stored | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, "artifact.json"), "utf8")) as Stored;
    return typeof value.id === "string" && typeof value.title === "string" ? value : null;
  } catch {
    return null;
  }
}

const withPath = (dir: string, stored: Stored): Artifact => ({ ...stored, path: join(dir, contentFile(stored.format)) });

/** The folder of an artifact, whichever project holds it; null for an unknown or malformed id. */
function findDir(stateDir: string, id: string): string | null {
  if (!ID.test(id) || !existsSync(knowledgeDir(stateDir))) return null;
  for (const project of readdirSync(knowledgeDir(stateDir))) {
    const dir = join(artifactsDir(stateDir, project), id);
    if (existsSync(join(dir, "artifact.json"))) return dir;
  }
  return null;
}

function newId(now: string): string {
  return `art-${now.slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex")}`;
}

export async function createArtifact(stateDir: string, input: CreateInput): Promise<Result<Artifact>> {
  const title = input.title.trim();
  if (title === "") return failed("--title must not be empty", 2);
  const content = input.format === "html" ? stripGoogleFonts(input.content) : input.content;
  const valid = validate(input.kind, input.format, input.content);
  if (valid.kind !== "ok") return valid;
  const project = await resolveProject(input.project);
  const now = input.now ?? new Date().toISOString();
  const stored: Stored = { id: newId(now), title, kind: input.kind, format: input.format, project: project.repo, projectName: project.name, projectId: project.id, topics: [...input.topics], chatId: input.chatId, createdAt: now, updatedAt: now, revision: 1 };
  const dir = join(artifactsDir(stateDir, project.id), stored.id);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, contentFile(stored.format)), content);
  writeAtomic(join(dir, "artifact.json"), `${JSON.stringify(stored, null, 2)}\n`);
  return ok(withPath(dir, stored));
}

export async function updateArtifact(stateDir: string, id: string, input: UpdateInput): Promise<Result<Artifact>> {
  const dir = findDir(stateDir, id);
  const previous = dir === null ? null : readStored(dir);
  if (dir === null || previous === null) return failed(`unknown artifact: ${id}`, 1);
  const title = input.title?.trim() ?? previous.title;
  if (title === "") return failed("--title must not be empty", 2);
  const valid = validate(previous.kind, input.format, input.content);
  if (valid.kind !== "ok") return valid;
  const now = input.now ?? new Date().toISOString();
  const oldFile = join(dir, contentFile(previous.format));
  const oldContent = readFileSync(oldFile, "utf8");
  const revision: ArtifactRevision = { ...previous, content: oldContent, replacedAt: now };
  appendFileSync(join(dir, "revisions.jsonl"), `${JSON.stringify(revision)}\n`);
  const stored: Stored = { ...previous, title, format: input.format, updatedAt: now, revision: previous.revision + 1 };
  writeAtomic(join(dir, contentFile(stored.format)), input.format === "html" ? stripGoogleFonts(input.content) : input.content);
  if (stored.format !== previous.format) rmSync(oldFile, { force: true });
  writeAtomic(join(dir, "artifact.json"), `${JSON.stringify(stored, null, 2)}\n`);
  return ok(withPath(dir, stored));
}

/** Artifacts newest change first, of one project (a path inside it) or every project, optionally only those filed under a topic. */
export async function listArtifacts(stateDir: string, filter: ListFilter): Promise<Artifact[]> {
  if (!existsSync(knowledgeDir(stateDir))) return [];
  const projects = filter.project === undefined ? readdirSync(knowledgeDir(stateDir)) : [(await resolveProject(filter.project)).id];
  const found: Artifact[] = [];
  for (const project of projects) {
    const root = artifactsDir(stateDir, project);
    if (!existsSync(root)) continue;
    for (const id of readdirSync(root)) {
      const stored = readStored(join(root, id));
      if (stored === null || (filter.topic !== undefined && !stored.topics.includes(filter.topic))) continue;
      found.push(withPath(join(root, id), stored));
    }
  }
  return found.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

export async function showArtifact(stateDir: string, id: string): Promise<ArtifactWithContent | null> {
  const dir = findDir(stateDir, id);
  const stored = dir === null ? null : readStored(dir);
  if (dir === null || stored === null) return null;
  const artifact = withPath(dir, stored);
  return { ...artifact, content: readFileSync(artifact.path, "utf8") };
}

/** The versions an artifact's updates replaced, oldest first. */
export async function artifactRevisions(stateDir: string, id: string): Promise<ArtifactRevision[]> {
  const dir = findDir(stateDir, id);
  if (dir === null || !existsSync(join(dir, "revisions.jsonl"))) return [];
  return readFileSync(join(dir, "revisions.jsonl"), "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as ArtifactRevision);
}

export async function removeArtifact(stateDir: string, id: string): Promise<Result<string>> {
  const dir = findDir(stateDir, id);
  if (dir === null) return failed(`unknown artifact: ${id}`, 1);
  rmSync(dir, { recursive: true, force: true });
  return ok(id);
}
