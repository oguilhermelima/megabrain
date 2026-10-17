import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { mergeTopics, moveChat, renameTopic, setTopicKind, setTopicStatus } from "../../knowledge/edit.js";
import { backfillSummaries } from "../../knowledge/backfill.js";
import { knowledgeContext, listKnowledge, readTranscript, searchKnowledge, showTopic, summarizeTopic, topicFor } from "../../knowledge/library.js";
import { KnowledgePipeline } from "../../knowledge/pipeline.js";
import { registeredProjects, scanProjects } from "../../knowledge/scanner.js";
import { failed, ok, type Result } from "../../core/result.js";
import type { Topic } from "../../knowledge/types.js";
import { usageMessage, usageText } from "../../core/usage.js";

type Environment = Readonly<Record<string, string | undefined>>;
type Flags = { positional: string[]; values: Record<string, string>; json: boolean; dryRun: boolean };

const VALUE_FLAGS = ["--repo", "--limit", "--cwd", "--since"];

function stateDir(environment: Environment): string { return environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? homedir(), ".megabrain"); }
function print(value: unknown): Result<string> { return ok(`${JSON.stringify(value, null, 2)}\n`); }

/** "30d" is that many days back from now; anything else must be a date Date can read. */
function parseSince(value: string, now: Date): Date | null {
  const days = /^(\d+)d$/.exec(value);
  const at = days === null ? new Date(value) : new Date(now.getTime() - Number(days[1]) * 86_400_000);
  return Number.isNaN(at.getTime()) ? null : at;
}

function parse(args: readonly string[]): Flags | null {
  const flags: Flags = { positional: [], values: {}, json: false, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") flags.json = true;
    else if (arg === "--dry-run") flags.dryRun = true;
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
    if (flags.json) return print({ ...topic, ...summarizeTopic(topic) });
    const live = topic.decisions.filter((decision) => decision.supersededBy === undefined);
    return ok([`${topic.title} (${topic.kind}, ${topic.status})`, "", `Overview\n${topic.sections.overview}`, `State\n${topic.sections.state}`, `Decisions\n${live.map((decision) => `- ${decision.text} (${decision.why})`).join("\n")}`, `Pitfalls\n${topic.sections.pitfalls}`, `Open\n${topic.sections.open}`, ""].join("\n"));
  }
  if (verb === "transcript" && flags.positional.length === 1) {
    const found = readTranscript(dir, flags.positional[0] ?? "");
    if (found === null) return failed(`unknown chat: ${flags.positional[0]}`, 1);
    if (flags.json) return print(found);
    return ok(found.events.map((event) => `[${event.cursor}] ${event.role}: ${event.text}`).join("\n").concat("\n"));
  }
  const edited = (result: Result<Topic>): Result<string> => result.kind !== "ok" ? result : flags.json ? print({ topic: summarizeTopic(result.value) }) : ok(`${result.value.id} ${result.value.kind} ${result.value.status} ${result.value.title}\n`);
  const [first, second] = flags.positional;
  const now = new Date();
  if (verb === "rename" && flags.positional.length >= 2) return edited(renameTopic(dir, first as string, flags.positional.slice(1).join(" "), now));
  if (verb === "kind" && flags.positional.length === 2) return edited(setTopicKind(dir, first as string, second as string, now));
  if (verb === "status" && flags.positional.length === 2) return edited(setTopicStatus(dir, first as string, second as string, now));
  if (verb === "merge" && flags.positional.length === 2) return edited(mergeTopics(dir, first as string, second as string, now));
  if (verb === "move-chat" && flags.positional.length === 2) return edited(moveChat(dir, first as string, second as string, now));
  const cwd = flags.values["--cwd"];
  if (verb === "topic-for" && flags.positional.length === 0 && cwd !== undefined) {
    const topics = (await topicFor(dir, cwd)).map(summarizeTopic);
    return flags.json ? print({ topics }) : ok(topics.map((topic) => `${topic.id} ${topic.kind} ${topic.title}\n`).join(""));
  }
  if (verb === "context" && flags.positional.length === 0 && cwd !== undefined) {
    const context = await knowledgeContext(dir, cwd);
    return flags.json ? print({ context }) : ok(context);
  }
  if (verb === "scan" && flags.positional.length === 0) {
    const since = flags.values["--since"] === undefined ? undefined : parseSince(flags.values["--since"], new Date());
    if (since === null) return usage();
    const registered = registeredProjects(environment);
    const projects = repo === undefined ? registered : registered.filter((path) => path === repo || basename(path) === repo);
    if (repo !== undefined && projects.length === 0 && isAbsolute(repo)) projects.push(resolve(repo));
    if (repo !== undefined && projects.length === 0) return failed(`unknown project: ${repo}`, 1);
    const pipeline = new KnowledgePipeline({ stateDir: dir, environment });
    const outcome = await scanProjects({ stateDir: dir, home: environment.HOME ?? homedir(), environment, pipeline, projects, ...(since === undefined ? {} : { since }), ...(limit === undefined ? {} : { maxSessions: limit }), dryRun: flags.dryRun });
    if (flags.json) return print(outcome);
    const lines = outcome.projects.map((plan) => `${plan.repo}: ${plan.inHorizon} sessions in range, ${plan.older} older, about ${plan.estimatedCalls} model calls`);
    return ok(`${[...lines, ...(flags.dryRun ? [] : [`processed ${outcome.processed}`])].join("\n")}\n`);
  }
  if (verb === "backfill" && flags.positional.length === 0 && !flags.dryRun && flags.values["--since"] === undefined) {
    const outcome = await backfillSummaries({ stateDir: dir, pipeline: new KnowledgePipeline({ stateDir: dir, environment }) });
    return flags.json ? print(outcome) : ok(`${JSON.stringify(outcome)}\n`);
  }
  return usage();
}
