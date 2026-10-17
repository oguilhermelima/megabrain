import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { failed, ok, type Result } from "../../core/result.js";
import { usageMessage, usageText, type UsageKey } from "../../core/usage.js";
import { artifactFormat, artifactRevisions, createArtifact, listArtifacts, removeArtifact, showArtifact, updateArtifact, ARTIFACT_KINDS, type Artifact, type ArtifactKind } from "../../knowledge/artifacts.js";
import { applyMegabrainTheme } from "../../knowledge/artifact-theme.js";

type Environment = Readonly<Record<string, string | undefined>>;
/** Where a relative path or a missing --project points, and how stdin is read; tests replace both. */
export type ArtifactIo = { cwd?: string; stdin?: () => Promise<string>; stderr?: (text: string) => void };
type Flags = { positional: string[]; values: Record<string, string>; topics: string[]; stdin: boolean; json: boolean };

const VALUE_FLAGS = ["--title", "--kind", "--file", "--project", "--chat", "--theme", "--revision"];
const VERBS: Readonly<Record<string, UsageKey>> = { guide: "artifact-guide", new: "artifact-new", create: "artifact-create", update: "artifact-update", list: "artifact-list", show: "artifact-show", remove: "artifact-remove" };
const isArtifactKind = (kind: string): kind is ArtifactKind => (ARTIFACT_KINDS as readonly string[]).includes(kind);

const ARTIFACT_GUIDE = {
  kinds: {
    diagram: { when: "Architecture, flows, sequences, or comparisons; prefer artifacts-diagram for rich diagrams.", structure: ["Title and purpose", "Main elements", "Relationships and direction", "Legend and source links"] },
    plan: { when: "Steps that need owners, risks, and checkpoints.", structure: ["Goal and scope", "Steps with owner and status", "Risks and mitigations", "Checkpoints and exit criteria"] },
    doc: { when: "A reference or report worth keeping.", structure: ["Summary", "Context and evidence", "Findings or instructions", "References and next steps"] },
  },
  writing: ["Put the subject first; use short sections.", "Link issues, PRs, and branches by number and title.", "Keep one artifact per subject: keep the id from create and use artifact update <id>; find it with artifact list --chat <chat-id>."],
  theme: "HTML can use --theme megabrain for the local dark palette and light-mode variant. diagram-design supports style profiles: edit references/style-guide.md or save and load a profile using references/profiles.md with paper #000000, ink #f5f5f7, accent #8e9cff, system fonts, and 24px/32px radii.",
  workflow: "Use megabrain artifact new to write a starter, fill the printed path, then create it; for a later version use update. --theme megabrain also themes existing HTML on create or update.",
} as const;

function guide(flags: Flags): Result<string> {
  const kind = flags.values["--kind"];
  if (kind !== undefined && !isArtifactKind(kind)) return failed("--kind must be diagram, plan or doc", 2);
  const kinds = kind === undefined ? ARTIFACT_GUIDE.kinds : { [kind]: ARTIFACT_GUIDE.kinds[kind as keyof typeof ARTIFACT_GUIDE.kinds] };
  if (flags.json) return print({ kinds, writing: ARTIFACT_GUIDE.writing, theme: ARTIFACT_GUIDE.theme, workflow: ARTIFACT_GUIDE.workflow });
  const sections = Object.entries(kinds).map(([name, details]) => `${name}: ${details.when}\n  Structure: ${details.structure.join("; ")}`).join("\n");
  return ok(`${sections}\n\nWriting: ${ARTIFACT_GUIDE.writing.join(" ")}\n\nTheme: ${ARTIFACT_GUIDE.theme}\n\nWorkflow: ${ARTIFACT_GUIDE.workflow}\n`);
}

function stateDir(environment: Environment): string { return environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain"); }
function print(value: unknown): Result<string> { return ok(`${JSON.stringify(value, null, 2)}\n`); }

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

function parse(args: readonly string[]): Flags | null {
  const flags: Flags = { positional: [], values: {}, topics: [], stdin: false, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") flags.json = true;
    else if (arg === "--stdin") flags.stdin = true;
    else if (arg === "--topic" || VALUE_FLAGS.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return null;
      if (arg === "--topic") flags.topics.push(value);
      else if (flags.values[arg] !== undefined) return null;
      else flags.values[arg] = value;
      index += 1;
    } else if (arg.startsWith("--")) return null;
    else flags.positional.push(arg);
  }
  return flags;
}

/** The content from --file or --stdin, exactly one, and the format its file name or text says. */
async function contentOf(flags: Flags, io: ArtifactIo): Promise<Result<{ content: string; format: "html" | "markdown" }> | null> {
  const file = flags.values["--file"];
  if ((file === undefined) === !flags.stdin) return null;
  if (file !== undefined) {
    const path = resolve(io.cwd ?? process.cwd(), file);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return failed(`cannot read ${path}`, 1);
    }
    return ok({ content, format: artifactFormat(content, path) });
  }
  const content = await (io.stdin ?? readStdin)();
  return ok({ content, format: artifactFormat(content) });
}

const line = (artifact: Artifact): string => `${artifact.updatedAt.slice(0, 10)} ${artifact.id} ${artifact.kind} ${artifact.projectName} ${artifact.title}`;

function starterContent(title: string, kind: ArtifactKind): { extension: string; content: string } {
  const escapedTitle = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  if (kind === "diagram") return { extension: ".html", content: `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapedTitle}</title></head><body><main>\n  <header><h1>${escapedTitle}</h1><p>Purpose: </p></header>\n  <section aria-label="Diagram"><!-- Add the diagram here --></section>\n  <footer><h2>Legend and sources</h2><p></p></footer>\n</main></body></html>\n` };
  const markdown = kind === "plan"
    ? `# ${title}\n\n## Goal and scope\n\n## Steps\n\n| Step | Owner | Status |\n| --- | --- | --- |\n|  |  |  |\n\n## Risks and mitigations\n\n## Checkpoints\n\n## Exit criteria\n`
    : `# ${title}\n\n## Summary\n\n## Context and evidence\n\n## Findings or instructions\n\n## References\n\n## Next steps\n`;
  return { extension: ".md", content: markdown };
}

function writeStarter(cwd: string, title: string, kind: ArtifactKind): Result<string> {
  const { extension, content } = starterContent(title, kind);
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "artifact";
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const path = join(cwd, `${slug}${suffix === 0 ? "" : `-${suffix + 1}`}${extension}`);
    try {
      writeFileSync(path, kind === "diagram" ? applyMegabrainTheme(content) : content, { flag: "wx", mode: 0o600 });
      return ok(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return failed(`cannot write starter ${path}: ${error instanceof Error ? error.message : String(error)}`, 1);
    }
  }
  return failed(`cannot find an unused starter filename for ${basename(title)}${extension}`, 1);
}

/** The artifact verbs. Artifacts are plain files under the state directory, so none needs the database or the chat daemon. */
export async function executeArtifact(args: readonly string[], environment: Environment, io: ArtifactIo = {}): Promise<Result<string>> {
  const [verb, ...rest] = args;
  const key = verb === undefined ? undefined : VERBS[verb];
  if (key === undefined) return verb === "-h" || verb === "--help" ? ok(usageText("artifact")) : failed(usageMessage("artifact"), 2);
  if (rest.includes("-h") || rest.includes("--help")) return ok(usageText(key));
  const usage = failed(usageMessage(key), 2);
  const flags = parse(rest);
  if (flags === null) return usage;
  const dir = stateDir(environment);
  const cwd = io.cwd ?? process.cwd();
  const project = flags.values["--project"] === undefined ? undefined : resolve(cwd, flags.values["--project"]);
  if (verb === "guide") {
    if (flags.positional.length || flags.stdin || flags.topics.length || Object.keys(flags.values).some((name) => name !== "--kind")) return usage;
    return guide(flags);
  }
  if (verb === "new") {
    const [title] = flags.positional;
    const kind = flags.values["--kind"];
    if (title === undefined || title.trim() === "" || flags.positional.length !== 1 || kind === undefined || !isArtifactKind(kind) || flags.stdin || flags.topics.length || flags.values["--file"] !== undefined || flags.values["--title"] !== undefined || flags.values["--theme"] !== undefined) return usage;
    const chatId = flags.values["--chat"] ?? environment.MEGABRAIN_CHAT_ID ?? null;
    const path = writeStarter(cwd, title.trim(), kind);
    if (path.kind !== "ok") return path;
    return flags.json ? print({ title: title.trim(), kind, project: project ?? cwd, chatId, path: path.value }) : ok(`${path.value}\n`);
  }
  if (verb === "create") {
    const title = flags.values["--title"];
    const kind = flags.values["--kind"];
    if (flags.positional.length > 0 || title === undefined || kind === undefined || flags.values["--revision"] !== undefined) return usage;
    const input = await contentOf(flags, io);
    if (input === null) return usage;
    if (input.kind !== "ok") return input;
    if (flags.values["--theme"] !== undefined && flags.values["--theme"] !== "megabrain") return failed("--theme must be megabrain", 2);
    if (flags.values["--theme"] !== undefined && input.value.format !== "html") return failed("--theme megabrain requires HTML content", 2);
    const content = flags.values["--theme"] === "megabrain" ? applyMegabrainTheme(input.value.content) : input.value.content;
    const created = await createArtifact(dir, { title, kind: kind as ArtifactKind, ...input.value, content, project: project ?? cwd, topics: flags.topics, chatId: flags.values["--chat"] ?? environment.MEGABRAIN_CHAT_ID ?? null });
    if (created.kind !== "ok") return created;
    const { similar, ...artifact } = created.value;
    if (similar !== undefined) (io.stderr ?? ((text) => globalThis.process.stderr.write(text)))(`An artifact with this title already exists in this chat. Use megabrain artifact update ${similar[0]!.id} for a new revision of the same artifact.\n`);
    return flags.json ? print({ ...artifact, action: "created", ...(similar === undefined ? {} : { similar }) }) : ok(`created artifact ${artifact.id} ${artifact.path}\n`);
  }
  if (verb === "update") {
    const [id] = flags.positional;
    if (id === undefined || flags.positional.length > 1 || flags.values["--kind"] !== undefined || flags.values["--project"] !== undefined || flags.values["--chat"] !== undefined || flags.values["--revision"] !== undefined || flags.topics.length > 0) return usage;
    const input = await contentOf(flags, io);
    if (input === null) return usage;
    if (input.kind !== "ok") return input;
    if (flags.values["--theme"] !== undefined && flags.values["--theme"] !== "megabrain") return failed("--theme must be megabrain", 2);
    if (flags.values["--theme"] !== undefined && input.value.format !== "html") return failed("--theme megabrain requires HTML content", 2);
    const content = flags.values["--theme"] === "megabrain" ? applyMegabrainTheme(input.value.content) : input.value.content;
    const updated = await updateArtifact(dir, id, { ...input.value, content, ...(flags.values["--title"] === undefined ? {} : { title: flags.values["--title"] }) });
    if (updated.kind !== "ok") return updated;
    return flags.json ? print(updated.value) : ok(`${updated.value.id} revision ${updated.value.revision}\n`);
  }
  if (verb === "list") {
    if (flags.positional.length > 0 || flags.stdin || Object.keys(flags.values).some((name) => !["--project", "--chat"].includes(name)) || flags.topics.length > 1) return usage;
    const artifacts = await listArtifacts(dir, { ...(project === undefined ? {} : { project }), ...(flags.topics[0] === undefined ? {} : { topic: flags.topics[0] }), ...(flags.values["--chat"] === undefined ? {} : { chatId: flags.values["--chat"] }) });
    return flags.json ? print({ artifacts }) : ok(artifacts.map((artifact) => `${line(artifact)}\n`).join(""));
  }
  const [id] = flags.positional;
  const revisionText = flags.values["--revision"];
  const revision = revisionText === undefined ? undefined : Number(revisionText);
  if (id === undefined || flags.positional.length > 1 || flags.stdin || flags.topics.length > 0 || Object.keys(flags.values).some((name) => name !== "--revision") || (verb === "remove" && revisionText !== undefined) || (revisionText !== undefined && (!/^\d+$/.test(revisionText) || !Number.isSafeInteger(revision) || (revision ?? 0) < 1))) return usage;
  if (verb === "show") {
    const artifact = await showArtifact(dir, id, revision);
    if (artifact === null) return failed(revision === undefined ? `unknown artifact: ${id}` : `unknown artifact revision ${revision} for ${id}`, 1);
    if (!flags.json) return ok(artifact.content.endsWith("\n") ? artifact.content : `${artifact.content}\n`);
    // The versions updates replaced, oldest first, named and dated but without their content.
    const revisions = (await artifactRevisions(dir, id)).map(({ revision, title, updatedAt, replacedAt }) => ({ revision, title, updatedAt, replacedAt }));
    return print({ ...artifact, revisions });
  }
  const removed = await removeArtifact(dir, id);
  if (removed.kind !== "ok") return removed;
  return flags.json ? print({ removed: removed.value }) : ok(`removed ${removed.value}\n`);
}
