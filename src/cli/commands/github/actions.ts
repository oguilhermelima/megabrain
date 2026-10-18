import type { ProcessAdapter } from "../../../adapters/proc.js";
import { failed, ok, type Result } from "../../../core/result.js";
import { usageMessage } from "../../../core/usage.js";
import { parse as parseYaml } from "yaml";
import { gh, ghText, resolveRepository } from "./client.js";
import type { Environment } from "./index.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const str = (value: unknown): string => typeof value === "string" ? value : "";
const num = (value: unknown): number => typeof value === "number" ? value : 0;
const nullable = (value: unknown): string | null => typeof value === "string" ? value : null;
const usage = (verb: string): Result<never> => failed(usageMessage(`github-${verb}` as never), 2);
const RUN_STATUSES = new Set(["queued", "in_progress", "completed", "waiting", "requested", "pending"]);
const CONCLUSIONS = new Set(["success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral", "stale"]);

function run(value: unknown) {
  const r = row(value);
  const actor = row(r.actor);
  const prs = Array.isArray(r.pull_requests) ? r.pull_requests : [];
  return {
    id: num(r.id), name: str(r.name), title: str(r.display_title), event: str(r.event), branch: str(r.head_branch), sha: str(r.head_sha),
    status: RUN_STATUSES.has(str(r.status)) ? str(r.status) : "pending",
    conclusion: CONCLUSIONS.has(str(r.conclusion)) ? str(r.conclusion) : null,
    number: num(r.run_number), attempt: num(r.run_attempt), actor: str(actor.login), createdAt: str(r.created_at), updatedAt: str(r.updated_at),
    startedAt: nullable(r.run_started_at), url: str(r.html_url), prNumber: prs.length > 0 ? num(row(prs[0]).number) || null : null,
  };
}

const INPUT_TYPES = new Set(["string", "boolean", "choice", "number", "environment"]);
type WorkflowInput = Readonly<{ name: string; description: string; required: boolean; type: "string" | "boolean" | "choice" | "number" | "environment"; default: string | boolean | number | null; options?: string[] }>;

function workflowInputs(source: string): { dispatchable: boolean; inputs: WorkflowInput[] } {
  let document: unknown;
  try { document = parseYaml(source); }
  catch { return { dispatchable: false, inputs: [] }; }
  const root = row(document);
  const triggerValue = root.on;
  const triggers = row(triggerValue);
  const dispatch = triggers.workflow_dispatch;
  const dispatched = dispatch !== undefined || triggerValue === "workflow_dispatch" || (Array.isArray(triggerValue) && triggerValue.includes("workflow_dispatch"));
  if (!dispatched) return { dispatchable: false, inputs: [] };
  const declared = row(row(dispatch).inputs);
  const inputs = Object.entries(declared).map(([name, value]): WorkflowInput => {
    const input = row(value);
    const rawType = str(input.type);
    const type = INPUT_TYPES.has(rawType) ? rawType as WorkflowInput["type"] : "string";
    const defaultValue = input.default;
    const defaultInput = typeof defaultValue === "string" || typeof defaultValue === "boolean" || typeof defaultValue === "number" ? defaultValue : null;
    const options = Array.isArray(input.options) ? input.options.filter((option): option is string => typeof option === "string") : [];
    return { name, description: str(input.description), required: input.required === true, type, default: defaultInput, ...(options.length === 0 ? {} : { options }) };
  });
  return { dispatchable: true, inputs };
}

function workflow(value: unknown, metadata: { dispatchable: boolean; inputs: WorkflowInput[] }) {
  const r = row(value);
  return { id: num(r.id), name: str(r.name), path: str(r.path), state: str(r.state), ...metadata };
}

const unavailableWorkflowMetadata = (): { dispatchable: boolean; inputs: WorkflowInput[] } => ({ dispatchable: false, inputs: [] });

async function workflowMetadata(process: ProcessAdapter, repo: string, value: unknown): Promise<{ dispatchable: boolean; inputs: WorkflowInput[] }> {
  const path = str(row(value).path);
  if (path === "" || path.startsWith("dynamic/")) return unavailableWorkflowMetadata();
  const endpoint = `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const fetched = await gh(process, ["api", endpoint], { name: "gh api workflow contents" });
  if (fetched.kind !== "ok") return unavailableWorkflowMetadata();
  const content = row(fetched.value);
  if (content.encoding !== "base64" || typeof content.content !== "string") return unavailableWorkflowMetadata();
  const source = Buffer.from(content.content.replace(/\s/g, ""), "base64").toString("utf8");
  try { return workflowInputs(source); }
  catch { return unavailableWorkflowMetadata(); }
}

function parse(verb: string, args: readonly string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (a === "--json") json = true;
    else if (["--branch", "--workflow", "--status", "--limit", "--after", "--job", "--ref", "--inputs"].includes(a)) {
      const v = args[++i]; if (v === undefined || v.startsWith("--")) return null; flags[a] = v;
    } else if (a.startsWith("--")) return null;
    else positional.push(a);
  }
  const expected = verb === "runs" ? 1 : verb === "run-action" ? 3 : 2;
  if (positional.length !== expected || positional.some((p) => p === "")) return null;
  if (["run", "run-log", "run-action"].includes(verb) && !/^[1-9]\d*$/.test(positional[1] ?? "")) return null;
  if (verb === "run-log" && (!flags["--job"] || !/^[1-9]\d*$/.test(flags["--job"]))) return null;
  if (verb === "workflow-dispatch" && (!flags["--ref"] || (flags["--inputs"] !== undefined && !validJson(flags["--inputs"])))) return null;
  if (verb === "run-action" && !["rerun", "rerun-failed", "cancel"].includes(positional[2] ?? "")) return null;
  const limit = flags["--limit"] === undefined ? 30 : Number(flags["--limit"]);
  if (verb === "runs" && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) return null;
  return { positional, flags, json, limit };
}
function validJson(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "string");
  } catch { return false; }
}

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const LOG_LIMIT = 1_000_000;
export async function executeActions(verb: string, args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const parsed = parse(verb, args);
  if (parsed === null) return usage(verb);
  const [selector = "", id = ""] = parsed.positional;
  const repository = await resolveRepository(selector, environment, process);
  if (repository.kind !== "ok") return repository;
  const repo = repository.value.nameWithOwner;
  let output: unknown;
  let plain = "";
  if (verb === "runs") {
    const page = parsed.flags["--after"] ?? "1";
    if (!/^\d+$/.test(page) || Number(page) < 1) return usage(verb);
    const workflows = await gh(process, ["api", `repos/${repo}/actions/workflows?per_page=100`], { name: "gh api actions workflows" });
    if (workflows.kind !== "ok") return workflows;
    const workflowRows = Array.isArray(row(workflows.value).workflows) ? row(workflows.value).workflows as unknown[] : [];
    const metadataResults: { dispatchable: boolean; inputs: WorkflowInput[] }[] = [];
    for (let offset = 0; offset < workflowRows.length; offset += 5) {
      const batch = await Promise.all(workflowRows.slice(offset, offset + 5).map((item) => workflowMetadata(process, repo, item)));
      metadataResults.push(...batch);
    }
    const workflowRowsWithMetadata = workflowRows.map((item, index) => {
      const metadata = metadataResults[index];
      return workflow(item, metadata ?? unavailableWorkflowMetadata());
    });
    const requestedWorkflow = parsed.flags["--workflow"];
    const matchedWorkflow = requestedWorkflow === undefined ? undefined
      : workflowRows.find((item) => str(row(item).name) === requestedWorkflow || String(row(item).id) === requestedWorkflow);
    const resolvedWorkflow = matchedWorkflow === undefined ? undefined : row(matchedWorkflow).id;
    const selectedWorkflow = resolvedWorkflow === undefined ? requestedWorkflow : String(resolvedWorkflow);
    const runsQuery = [`per_page=${parsed.limit}`, `page=${page}`, ...(parsed.flags["--branch"] ? [`branch=${encodeURIComponent(parsed.flags["--branch"]!)}`] : []), ...(selectedWorkflow ? [`workflow_id=${encodeURIComponent(selectedWorkflow)}`] : []), ...(parsed.flags["--status"] ? [`status=${encodeURIComponent(parsed.flags["--status"]!)}`] : [])].join("&");
    const runs = await gh(process, ["api", `repos/${repo}/actions/runs?${runsQuery}`], { name: "gh api actions runs" });
    if (runs.kind !== "ok") return runs;
    const list = row(runs.value);
    const raw = Array.isArray(list.workflow_runs) ? list.workflow_runs : [];
    output = { runs: raw.map(run), workflows: workflowRowsWithMetadata, next: raw.length === parsed.limit ? String(Number(page) + 1) : null };
    plain = `${raw.length} workflow runs\n`;
  } else if (verb === "run") {
    const [detail, jobs] = await Promise.all([
      gh(process, ["api", `repos/${repo}/actions/runs/${id}`], { name: "gh api actions run" }),
      gh(process, ["api", `repos/${repo}/actions/runs/${id}/jobs?per_page=100`], { name: "gh api actions jobs" }),
    ]);
    if (detail.kind !== "ok") return detail;
    if (jobs.kind !== "ok") return jobs;
    const jobsRaw = Array.isArray(row(jobs.value).jobs) ? row(jobs.value).jobs as unknown[] : [];
    output = { ...run(detail.value), jobs: jobsRaw.map((j) => { const x = row(j); return { id: num(x.id), name: str(x.name), status: str(x.status), conclusion: nullable(x.conclusion), startedAt: nullable(x.started_at), completedAt: nullable(x.completed_at), url: str(x.html_url), steps: (Array.isArray(x.steps) ? x.steps : []).map((s) => { const y = row(s); return { number: num(y.number), name: str(y.name), status: str(y.status), conclusion: nullable(y.conclusion), startedAt: nullable(y.started_at), completedAt: nullable(y.completed_at) }; }) }; }) };
    plain = `${str(row(detail.value).name)} ${str(row(detail.value).status)}\n`;
  } else if (verb === "run-log") {
    const jobList = await gh(process, ["api", `repos/${repo}/actions/runs/${id}/jobs?per_page=100`], { name: "gh api actions jobs" });
    if (jobList.kind !== "ok") return jobList;
    const jobs = Array.isArray(row(jobList.value).jobs) ? row(jobList.value).jobs as unknown[] : [];
    if (!jobs.some((job) => String(row(job).id) === parsed.flags["--job"])) return failed(`job ${parsed.flags["--job"]} does not belong to workflow run ${id}`);
    const result = await ghText(process, ["api", `repos/${repo}/actions/jobs/${parsed.flags["--job"]}/logs`], { name: "gh api actions job logs" });
    if (result.kind !== "ok") return result;
    const log = result.value.replace(ANSI, "");
    const truncated = log.length > LOG_LIMIT;
    output = { log: log.slice(0, LOG_LIMIT), truncated };
    plain = log.slice(0, LOG_LIMIT);
  } else if (verb === "run-action") {
    const action = parsed.positional[2] ?? "";
    const suffix = action === "rerun" ? "rerun" : action === "rerun-failed" ? "rerun-failed-jobs" : "cancel";
    const sent = await gh(process, ["api", "-X", "POST", `repos/${repo}/actions/runs/${id}/${suffix}`], { name: `gh api actions ${suffix}`, empty: true, retry: false });
    if (sent.kind !== "ok") return sent;
    output = { runId: Number(id), action };
    plain = `${action} requested for run ${id}\n`;
  } else {
    const fields = parsed.flags["--inputs"] === undefined ? [] : Object.entries(JSON.parse(parsed.flags["--inputs"])).flatMap(([k, v]) => ["-f", `inputs[${k}]=${String(v)}`]);
    const sent = await gh(process, ["api", "-X", "POST", `repos/${repo}/actions/workflows/${id}/dispatches`, "-f", `ref=${parsed.flags["--ref"]}`, ...fields], { name: "gh api actions workflow dispatch", empty: true, retry: false });
    if (sent.kind !== "ok") return sent;
    output = { workflow: id, ref: parsed.flags["--ref"] };
    plain = `dispatched ${id} on ${parsed.flags["--ref"]}\n`;
  }
  return ok(parsed.json ? `${JSON.stringify(output, null, 2)}\n` : plain);
}
