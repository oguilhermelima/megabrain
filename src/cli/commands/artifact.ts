import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { failed, ok, type Result } from "../../core/result.js";
import { usageMessage, usageText, type UsageKey } from "../../core/usage.js";
import { artifactFormat, createArtifact, listArtifacts, removeArtifact, showArtifact, updateArtifact, type Artifact, type ArtifactKind } from "../../knowledge/artifacts.js";

type Environment = Readonly<Record<string, string | undefined>>;
/** Where a relative path or a missing --project points, and how stdin is read; tests replace both. */
export type ArtifactIo = { cwd?: string; stdin?: () => Promise<string> };
type Flags = { positional: string[]; values: Record<string, string>; topics: string[]; stdin: boolean; json: boolean };

const VALUE_FLAGS = ["--title", "--kind", "--file", "--project", "--chat"];
const VERBS: Readonly<Record<string, UsageKey>> = { create: "artifact-create", update: "artifact-update", list: "artifact-list", show: "artifact-show", remove: "artifact-remove" };

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

  if (verb === "create") {
    const title = flags.values["--title"];
    const kind = flags.values["--kind"];
    if (flags.positional.length > 0 || title === undefined || kind === undefined) return usage;
    const input = await contentOf(flags, io);
    if (input === null) return usage;
    if (input.kind !== "ok") return input;
    const created = await createArtifact(dir, { title, kind: kind as ArtifactKind, ...input.value, project: project ?? cwd, topics: flags.topics, chatId: flags.values["--chat"] ?? null });
    if (created.kind !== "ok") return created;
    return flags.json ? print(created.value) : ok(`${created.value.id} ${created.value.path}\n`);
  }
  if (verb === "update") {
    const [id] = flags.positional;
    if (id === undefined || flags.positional.length > 1 || flags.values["--kind"] !== undefined || flags.values["--project"] !== undefined || flags.values["--chat"] !== undefined || flags.topics.length > 0) return usage;
    const input = await contentOf(flags, io);
    if (input === null) return usage;
    if (input.kind !== "ok") return input;
    const updated = await updateArtifact(dir, id, { ...input.value, ...(flags.values["--title"] === undefined ? {} : { title: flags.values["--title"] }) });
    if (updated.kind !== "ok") return updated;
    return flags.json ? print(updated.value) : ok(`${updated.value.id} revision ${updated.value.revision}\n`);
  }
  if (verb === "list") {
    if (flags.positional.length > 0 || flags.stdin || Object.keys(flags.values).some((name) => name !== "--project") || flags.topics.length > 1) return usage;
    const artifacts = await listArtifacts(dir, { ...(project === undefined ? {} : { project }), ...(flags.topics[0] === undefined ? {} : { topic: flags.topics[0] }) });
    return flags.json ? print({ artifacts }) : ok(artifacts.map((artifact) => `${line(artifact)}\n`).join(""));
  }
  const [id] = flags.positional;
  if (id === undefined || flags.positional.length > 1 || flags.stdin || flags.topics.length > 0 || Object.keys(flags.values).length > 0) return usage;
  if (verb === "show") {
    const artifact = await showArtifact(dir, id);
    if (artifact === null) return failed(`unknown artifact: ${id}`, 1);
    return flags.json ? print(artifact) : ok(artifact.content.endsWith("\n") ? artifact.content : `${artifact.content}\n`);
  }
  const removed = await removeArtifact(dir, id);
  if (removed.kind !== "ok") return removed;
  return flags.json ? print({ removed: removed.value }) : ok(`removed ${removed.value}\n`);
}
