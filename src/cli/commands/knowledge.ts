import { homedir } from "node:os";
import { join } from "node:path";
import { backfillSummaries } from "../../knowledge/backfill.js";
import { knowledgeContext, listKnowledge, readTranscript, searchKnowledge, showTopic, summarizeTopic, topicFor } from "../../knowledge/library.js";
import { KnowledgePipeline } from "../../knowledge/pipeline.js";
import { scanProjects } from "../../knowledge/scanner.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageMessage, usageText } from "../../core/usage.js";

type Environment = Readonly<Record<string, string | undefined>>;
type Flags = { positional: string[]; values: Record<string, string>; json: boolean };

const VALUE_FLAGS = ["--repo", "--limit", "--cwd"];

function stateDir(environment: Environment): string { return environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? homedir(), ".megabrain"); }
function print(value: unknown): Result<string> { return ok(`${JSON.stringify(value, null, 2)}\n`); }

function parse(args: readonly string[]): Flags | null {
  const flags: Flags = { positional: [], values: {}, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") flags.json = true;
    else if (VALUE_FLAGS.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return null;
      flags.values[arg] = value;
      index += 1;
    } else if (arg.startsWith("--")) return null;
    else flags.positional.push(arg);
  }
  return flags;
}

/** The knowledge verbs. Reading verbs only read files; scan and backfill ask the configured summary model. */
export async function executeKnowledge(args: readonly string[], environment: Environment): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("knowledge"));
  const usage = (): Result<string> => failed(usageMessage("knowledge"), 2);
  const [verb, ...rest] = args;
  const flags = parse(rest);
  if (flags === null) return usage();
  const dir = stateDir(environment);
  const repo = flags.values["--repo"];
  const limit = flags.values["--limit"] === undefined ? undefined : Number(flags.values["--limit"]);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) return usage();

  if (verb === "list" && flags.positional.length === 0) {
    const { projects } = listKnowledge(dir, repo === undefined ? {} : { repo });
    if (flags.json) return print({ projects });
    return ok(projects.map((project) => [`${project.project} (${project.repo})${project.enabled ? "" : " [off]"}`, ...project.topics.map((topic) => `  ${topic.updatedAt.slice(0, 10)} ${topic.id} ${topic.kind} ${topic.status} ${topic.title}`)].join("\n")).join("\n").concat(projects.length > 0 ? "\n" : ""));
  }
  if (verb === "search" && flags.positional.length > 0) {
    const { results } = searchKnowledge(dir, flags.positional.join(" "), { ...(repo === undefined ? {} : { repo }), ...(limit === undefined ? {} : { limit }) });
    if (flags.json) return print({ results });
    return ok(results.map((topic) => `${topic.score} ${topic.id} ${topic.kind} ${topic.title}\n  ${topic.overview}\n`).join(""));
  }
  if (verb === "show" && flags.positional.length === 1) {
    const topic = showTopic(dir, flags.positional[0] ?? "");
    if (topic === null) return failed(`unknown topic: ${flags.positional[0]}`, 1);
    if (flags.json) return print(topic);
    const live = topic.decisions.filter((decision) => decision.supersededBy === undefined);
    return ok([`${topic.title} (${topic.kind}, ${topic.status})`, "", `Overview\n${topic.sections.overview}`, `State\n${topic.sections.state}`, `Decisions\n${live.map((decision) => `- ${decision.text} (${decision.why})`).join("\n")}`, `Pitfalls\n${topic.sections.pitfalls}`, `Open\n${topic.sections.open}`, ""].join("\n"));
  }
  if (verb === "transcript" && flags.positional.length === 1) {
    const found = readTranscript(dir, flags.positional[0] ?? "");
    if (found === null) return failed(`unknown chat: ${flags.positional[0]}`, 1);
    if (flags.json) return print(found);
    return ok(found.events.map((event) => `[${event.cursor}] ${event.role}: ${event.text}`).join("\n").concat("\n"));
  }
  const cwd = flags.values["--cwd"];
  if (verb === "topic-for" && flags.positional.length === 0 && cwd !== undefined) {
    const topics = (await topicFor(dir, cwd)).map(summarizeTopic);
    return flags.json ? print({ topics }) : ok(topics.map((topic) => `${topic.id} ${topic.kind} ${topic.title}\n`).join(""));
  }
  if (verb === "context" && flags.positional.length === 0 && cwd !== undefined) {
    const context = await knowledgeContext(dir, cwd);
    return flags.json ? print({ context }) : ok(context);
  }
  if ((verb === "scan" || verb === "backfill") && flags.positional.length === 0) {
    const pipeline = new KnowledgePipeline({ stateDir: dir, environment });
    const outcome = verb === "scan" ? await scanProjects({ stateDir: dir, home: environment.HOME ?? homedir(), environment, pipeline }) : await backfillSummaries({ stateDir: dir, pipeline });
    return flags.json ? print(outcome) : ok(`${JSON.stringify(outcome)}\n`);
  }
  return usage();
}
