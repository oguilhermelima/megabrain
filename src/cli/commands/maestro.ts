import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { awaitProcAdmission } from "../../core/proc-queue.js";
import { resolveStateDirectory } from "../../core/state.js";
import { findJavaHome, maestroBinary, maestroEnvironment, readMaestroRecord } from "../../core/maestro.js";
import { usageText } from "../../core/usage.js";
import { recordSimulatorOwner } from "../../core/native-sim-owner.js";
import { systemClock } from "../../core/clock.js";
import { readWebDevices } from "../../core/web-device.js";
import { parseAllDocuments } from "yaml";

type Environment = Readonly<Record<string, string | undefined>>;
type Emit = (text: string) => void;
type Flow = Readonly<{ path: string; name: string; appId: string | null; kind?: "native" | "web"; url?: string }>;
type RunState = "running" | "passed" | "failed" | "stopped";
type RunRecord = Readonly<{ runId: string; flow: string; worktree: string; device: string; pid: number; state: RunState; startedAt: string; finishedAt?: string; exitCode?: number }>;

const FLOW_ROOTS = [".maestro", "maestro"];
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const STEP = /^(.*)\.\.\. (COMPLETED|FAILED|SKIPPED|WARNED)$/;
const DEBUG_MARKER = /^==== Debug output/;
const DRIVER_START_FAILURE = /Failed to connect to \/127\.0\.0\.1:|XCUITest.{0,80}(?:driver|start)|(?:driver|status check).{0,80}(?:timed out|timeout)/i;
const PRIVACY_GRANT_FAILURE = /privacy|simctl.{0,80}grant|CommandFailed:\s*null/i;
const PERCENT_POINT = /^\s*(?:\d+%\s*,\s*\d+%|\d+\s*,\s*\d+)\s*$/;

const keyFor = (worktree: string): string => createHash("sha256").update(worktree).digest("hex").slice(0, 16);
const worktreeRoot = (environment: Environment, worktree: string): string => join(resolveStateDirectory(environment), "maestro", keyFor(worktree));

async function resolveWorktree(explicit: string | undefined, process: ProcessAdapter): Promise<string> {
  if (explicit !== undefined) return resolve(explicit);
  const top = await process.run("git", ["rev-parse", "--show-toplevel"], { timeoutMs: 5_000 });
  return resolve(top.kind === "ok" && top.value.stdout.trim() !== "" ? top.value.stdout.trim() : globalThis.process.cwd());
}

function flowFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...flowFiles(path));
    else if ([".yaml", ".yml"].includes(extname(entry.name)) && !/^config\.ya?ml$/.test(entry.name)) found.push(path);
  }
  return found;
}

// The header is everything before the first "---"; only its top-level scalars are read.
function headerValue(text: string, key: string): string | null {
  const header = text.split(/^---\s*$/m)[0] ?? "";
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(header);
  return match?.[1]?.replace(/^["']|["']$/g, "") ?? null;
}

function validatePercentagePoints(text: string, path: string): string | undefined {
  const documents = parseAllDocuments(text);
  const syntaxError = documents.flatMap((document) => document.errors)[0];
  if (syntaxError) {
    const line = syntaxError.linePos?.[0]?.line ?? 1;
    return `${path}:${line}: invalid flow YAML: ${syntaxError.message}`;
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*point:\s*["']?([^"'#\r\n]+?)["']?\s*$/.exec(lines[index] ?? "");
    if (!match?.[1]?.includes("%")) continue;
    const value = match[1].trim();
    if (!PERCENT_POINT.test(value)) return `${path}:${index + 1}: invalid percentage point "${value}"; coordinates must be whole percentages`;
  }
}

export function listFlows(worktree: string): Flow[] {
  const flows = FLOW_ROOTS.flatMap((root) => flowFiles(join(worktree, root)));
  return flows.map((file) => {
    const text = readFileSync(file, "utf8");
    const url = headerValue(text, "url");
    const value: Flow = url ? { path: relative(worktree, file), name: headerValue(text, "name") ?? basename(file, extname(file)), appId: null, kind: "web", url }
      : { path: relative(worktree, file), name: headerValue(text, "name") ?? basename(file, extname(file)), appId: headerValue(text, "appId"), kind: "native" };
    return value;
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function parseOptions(args: readonly string[], allowed: readonly string[]): Result<{ values: Record<string, string>; json: boolean; positional: string[] }> {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--json") json = true;
    else if (allowed.includes(argument)) {
      const value = args[++index];
      if (value === undefined || value === "" || value.startsWith("--")) return failed(`${argument} requires a value`, 2);
      values[argument] = value;
    } else if (argument.startsWith("-")) return failed(`unknown maestro option: ${argument}`, 2);
    else positional.push(argument);
  }
  return ok({ values, json, positional });
}

function readRecord(directory: string): RunRecord | undefined {
  try { return JSON.parse(readFileSync(join(directory, "run.json"), "utf8")) as RunRecord; } catch { return undefined; }
}
const writeRecord = (directory: string, record: RunRecord): void => writeFileSync(join(directory, "run.json"), `${JSON.stringify(record, null, 2)}\n`);

function alive(pid: number): boolean {
  try { globalThis.process.kill(pid, 0); return pid > 0; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function latestRun(environment: Environment, worktree: string): { directory: string; record: RunRecord } | undefined {
  const root = worktreeRoot(environment, worktree);
  if (!existsSync(root)) return undefined;
  const latest = readdirSync(root).filter((name) => existsSync(join(root, name, "run.json"))).sort().at(-1);
  if (latest === undefined) return undefined;
  const directory = join(root, latest);
  const record = readRecord(directory);
  if (record === undefined) return undefined;
  // A run whose process is gone without a verdict was killed from outside.
  return { directory, record: record.state === "running" && !alive(record.pid) ? { ...record, state: "failed" } : record };
}

function allRuns(environment: Environment, worktree: string): Array<{ directory: string; record: RunRecord }> {
  const root = worktreeRoot(environment, worktree);
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().reverse().flatMap((name) => {
    const directory = join(root, name);
    const record = readRecord(directory);
    if (record === undefined) return [];
    return [{ directory, record: record.state === "running" && !alive(record.pid) ? { ...record, state: "failed" as const } : record }];
  });
}

/** The simulators a Maestro run is going on right now, across every worktree. */
export function activeRunDevices(environment: Environment): Set<string> {
  const base = join(resolveStateDirectory(environment), "maestro");
  const devices = new Set<string>();
  if (!existsSync(base)) return devices;
  for (const key of readdirSync(base)) {
    const worktree = join(base, key);
    if (!statSync(worktree).isDirectory()) continue;
    for (const name of readdirSync(worktree)) {
      const record = readRecord(join(worktree, name));
      if (record?.state === "running" && alive(record.pid)) devices.add(record.device);
    }
  }
  return devices;
}

export function activeRunForDevice(environment: Environment, udid: string): string | undefined {
  const base = join(resolveStateDirectory(environment), "maestro");
  if (!existsSync(base)) return undefined;
  for (const key of readdirSync(base)) for (const name of readdirSync(join(base, key))) {
    const record = readRecord(join(base, key, name));
    if (record?.device === udid && record.state === "running" && alive(record.pid)) return record.runId;
  }
  return undefined;
}

function findFiles(directory: string, pattern: RegExp): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? findFiles(path, pattern) : pattern.test(path) ? [path] : [];
  });
}

async function resolveDevice(requested: string | undefined, process: ProcessAdapter): Promise<Result<string>> {
  if (requested !== undefined && UUID.test(requested)) return ok(requested);
  const listed = await process.run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  if (listed.kind !== "ok") return failed(`could not list booted simulators: ${listed.error}`);
  const booted = Object.entries((JSON.parse(listed.value.stdout) as { devices: Record<string, Array<{ udid: string; name: string }>> }).devices)
    .filter(([runtime]) => /iOS/.test(runtime)).flatMap(([, devices]) => devices);
  const match = requested === undefined ? booted[0] : booted.find((device) => device.name === requested);
  return match === undefined
    ? failed(requested === undefined ? "no iOS simulator is booted; boot one with xcrun simctl boot <udid>" : `no booted iOS simulator is named ${requested}; boot it first or pass its udid`)
    : ok(match.udid);
}

function supportsWebVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = [2, 11, 0];
  for (let index = 0; index < minimum.length; index += 1) if (actual[index] !== minimum[index]) return actual[index]! > minimum[index]!;
  return true;
}

function flowsVerb(args: readonly string[], process: ProcessAdapter): Promise<Result<string>> {
  return (async () => {
    const parsed = parseOptions(args, ["--worktree"]);
    if (parsed.kind !== "ok") return parsed;
    const worktree = await resolveWorktree(parsed.value.values["--worktree"], process);
    const flows = listFlows(worktree);
    if (parsed.value.json) return ok(`${JSON.stringify(flows, null, 2)}\n`);
  return ok(flows.length === 0 ? "no flows found under .maestro or maestro\n" : `${flows.map((flow) => `${flow.path}\t${flow.name}\t${flow.kind === "web" ? "web: " + flow.url : flow.appId ?? "-"}`).join("\n")}\n`);
  })();
}

async function runVerb(args: readonly string[], environment: Environment, process: ProcessAdapter, emit: Emit | undefined): Promise<Result<string>> {
  const parsed = parseOptions(args, ["--worktree", "--device", "--admission"]);
  if (parsed.kind !== "ok") return parsed;
  const { values, json, positional } = parsed.value;
  if (positional.length !== 1) return failed(usageText("maestro-run"), 2);
  const admission = values["--admission"];
  if (admission !== undefined && admission !== "wait" && admission !== "fail") return failed("--admission must be wait or fail", 2);
  const record = readMaestroRecord(environment);
  if (record === undefined || !existsSync(maestroBinary(environment))) return failed("Maestro is not installed; run megabrain install simulator-maestro");
  const javaHome = await findJavaHome({ ...environment, JAVA_HOME: record.javaHome }, process);
  if (javaHome === undefined) return failed(`no JDK 17 or newer at ${record.javaHome}; reinstall with megabrain install simulator-maestro`);
  const worktree = await resolveWorktree(values["--worktree"], process);
  const flowPath = resolve(worktree, positional[0] ?? "");
  const flow = relative(worktree, flowPath);
  if (flow.startsWith("..") || isAbsolute(flow) || !existsSync(flowPath) || !statSync(flowPath).isFile()) return failed(`flow not found in ${worktree}: ${positional[0]}`);
  const flowText = readFileSync(flowPath, "utf8");
  const pointError = validatePercentagePoints(flowText, positional[0] ?? flow);
  if (pointError) return failed(pointError);
  const webFlow = headerValue(flowText, "url") !== null;
  let device: Result<string>;
  if (webFlow) {
    const version = await process.run(maestroBinary(environment), ["--version"], { timeoutMs: 10_000, env: maestroEnvironment(environment, javaHome) });
    if (version.kind !== "ok") return failed(`could not determine Maestro version for web support: ${version.error}`);
    const actualVersion = /\d+\.\d+\.\d+/.exec(`${version.value.stdout}\n${version.value.stderr}`)?.[0] ?? "unknown";
    if (!supportsWebVersion(actualVersion)) return failed(`Maestro web flows require version 2.11.0 or newer; found ${actualVersion}. Run megabrain install simulator-maestro to update.`);
    if (values["--device"] && !readWebDevices(environment).some((item) => item.id === values["--device"])) return failed(`web device not found: ${values["--device"]}`);
    device = ok(values["--device"] ?? "maestro-web");
  } else {
    device = await resolveDevice(values["--device"], process);
    if (device.kind !== "ok") return device;
  }
  const ownerNotice = webFlow ? undefined : await recordSimulatorOwner(device.value, values["--worktree"] ?? worktree, environment, process, systemClock);
  const admitted = await awaitProcAdmission({ name: "maestro-run", worktree, mode: admission ?? "wait" }, environment, process);
  if (admitted.kind !== "ok") return admitted;

  if (webFlow && values["--device"]) {
    console.error(`Maestro web runs in its own headless Chromium; it cannot attach to ${values["--device"]}.`);
  }

  const runId = `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 6)}`;
  const directory = join(worktreeRoot(environment, worktree), runId);
  const artifacts = join(directory, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const collected: string[] = [];
  const log: string[] = [];
  const send = (event: Record<string, unknown>): void => {
    const line = json ? `${JSON.stringify(event)}\n` : textLine(event);
    log.push(`${JSON.stringify(event)}\n`);
    if (emit === undefined) collected.push(line); else emit(line);
  };
  const startedMs = Date.now();
  const commandArgs = webFlow
    ? ["--no-ansi", "test", "--headless", "--platform", "web", "--test-output-dir", artifacts, flowPath]
    : ["--no-ansi", "--udid", device.value, "test", "--test-output-dir", artifacts, flowPath];
  const child = spawn(maestroBinary(environment), commandArgs, {
    cwd: worktree, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...maestroEnvironment(environment, javaHome) },
  });
  let current: RunRecord = { runId, flow, worktree, device: device.value, pid: child.pid ?? 0, state: "running", startedAt: new Date(startedMs).toISOString() };
  writeRecord(directory, current);
  send({ type: "start", state: "running", runId, flow, device: device.value, artifacts: directory });
  if (ownerNotice) console.error(ownerNotice);

  let index = 0;
  let lastLine = startedMs;
  let held: { index: number; command: string; durationMs: number } | undefined;
  let errorLines: string[] = [];
  const flush = (): void => {
    if (held === undefined) return;
    const shot = findFiles(artifacts, /screenshots\/step-\d+.*\.png$/).at(-1);
    send({ type: "step", index: held.index, command: held.command, status: "failed", durationMs: held.durationMs, screenshot: shot ?? null, error: errorLines.join("\n").trim() });
    held = undefined;
  };
  let pending = "";
  const onLine = (line: string): void => {
    if (held !== undefined) {
      if (DEBUG_MARKER.test(line)) flush(); else errorLines.push(line);
      return;
    }
    const step = STEP.exec(line);
    if (step?.[1] === undefined || step[2] === undefined) return;
    index += 1;
    const now = Date.now();
    const base = { index, command: step[1].trim(), durationMs: now - lastLine };
    lastLine = now;
    if (step[2] === "FAILED") { held = base; errorLines = []; return; }
    const named = /^Take screenshot (.+)$/.exec(base.command)?.[1];
    const screenshot = named === undefined ? undefined : findFiles(artifacts, new RegExp(`takeScreenshot/${named.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.png$`))[0];
    send({ type: "step", ...base, status: step[2] === "SKIPPED" ? "skipped" : "passed", screenshot: screenshot ?? null, error: null });
  };
  const drain = (chunk: string): void => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", drain);
  child.stderr.on("data", drain);
  const exitCode = await new Promise<number>((resolveCode) => {
    let settled = false;
    let timedOut = false;
    const finish = (code: number) => { if (settled) return; settled = true; clearTimeout(timeout); resolveCode(timedOut ? 124 : code); };
    const timeout = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) globalThis.process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch {}
      const force = setTimeout(() => { try { if (child.pid) globalThis.process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} }, 5_000);
      force.unref();
    }, 30 * 60_000);
    child.once("error", () => finish(127));
    child.once("close", (code, signal) => finish(code ?? (signal === null ? 1 : 128)));
  });
  if (pending !== "") onLine(pending);
  flush();

  const stopped = readRecord(directory)?.state === "stopped";
  current = { ...current, state: stopped ? "stopped" : exitCode === 0 ? "passed" : "failed", exitCode, finishedAt: new Date().toISOString() };
  writeRecord(directory, current);
  send({ type: "run", state: current.state, runId, flow, device: device.value, exitCode, durationMs: Date.now() - startedMs, artifacts: directory });
  writeFileSync(join(directory, "events.jsonl"), log.join(""));
  return ok(collected.join(""), exitCode);
}

function textLine(event: Record<string, unknown>): string {
  if (event.type === "step") return `${event.status === "passed" ? "ok  " : event.status === "failed" ? "FAIL" : "skip"} ${event.index} ${event.command} (${event.durationMs} ms)${event.error ? `\n${event.error}` : ""}\n`;
  return event.type === "start" ? `run ${event.runId} on ${event.device}\n` : `run ${event.state} (exit ${event.exitCode}, ${event.durationMs} ms)\nartifacts: ${event.artifacts}\n`;
}

async function statusVerb(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const parsed = parseOptions(args, ["--worktree"]);
  if (parsed.kind !== "ok") return parsed;
  const worktree = await resolveWorktree(parsed.value.values["--worktree"], process);
  const latest = latestRun(environment, worktree);
  const body = latest === undefined ? { worktree, state: "none" } : { ...latest.record, artifacts: latest.directory };
  return ok(parsed.value.json ? `${JSON.stringify(body, null, 2)}\n` : latest === undefined ? "no maestro runs for this worktree\n" : `${latest.record.state} ${latest.record.flow} on ${latest.record.device} (run ${latest.record.runId})\n`);
}

async function runsVerb(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const parsed = parseOptions(args, ["--worktree"]);
  if (parsed.kind !== "ok") return parsed;
  const worktree = await resolveWorktree(parsed.value.values["--worktree"], process);
  const runs = allRuns(environment, worktree).map(({ directory, record }) => ({
    ...record,
    durationMs: record.finishedAt === undefined ? null : Date.parse(record.finishedAt) - Date.parse(record.startedAt),
    artifacts: directory,
  }));
  if (parsed.value.json) return ok(`${JSON.stringify(runs, null, 2)}\n`);
  return ok(runs.length === 0 ? "no maestro runs for this worktree\n" : `${runs.map((run) => `${run.state}\t${run.flow}\t${run.startedAt}\t${run.runId}`).join("\n")}\n`);
}

const FLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const flowTemplate = (name: string, web = false): string => web ? `# A Maestro web flow: https://docs.maestro.dev/get-started/supported-platform/web-browser
url: https://example.com
name: ${name}
---
- launchApp
- assertVisible: Example Domain
` : `# A Maestro flow: https://docs.maestro.dev
appId: com.example.app # the bundle id of the app under test
name: ${name}
---
- launchApp
- takeScreenshot: ${name}
`;

async function newVerb(args: readonly string[], process: ProcessAdapter): Promise<Result<string>> {
  const web = args.includes("--web");
  const parsed = parseOptions(args.filter((arg) => arg !== "--web"), ["--worktree"]);
  if (parsed.kind !== "ok") return parsed;
  const { values, json, positional } = parsed.value;
  if (positional.length !== 1) return failed(usageText("maestro-new"), 2);
  const name = (positional[0] ?? "").replace(/\.ya?ml$/, "");
  if (!FLOW_NAME.test(name)) return failed(`a flow name is letters, digits, - and _, starting with a letter or digit: ${positional[0]}`, 2);
  const worktree = await resolveWorktree(values["--worktree"], process);
  const path = join(".maestro", `${name}.yaml`);
  const file = join(worktree, path);
  if (existsSync(file)) return failed(`a flow already exists at ${path}`);
  mkdirSync(join(worktree, ".maestro"), { recursive: true });
  writeFileSync(file, flowTemplate(name, web), { flag: "wx" });
  return ok(json ? `${JSON.stringify({ path })}\n` : `created ${path}\n`);
}

async function stopVerb(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const parsed = parseOptions(args, ["--worktree"]);
  if (parsed.kind !== "ok") return parsed;
  const worktree = await resolveWorktree(parsed.value.values["--worktree"], process);
  const latest = latestRun(environment, worktree);
  if (latest === undefined || latest.record.state !== "running") return failed("no running maestro run for this worktree");
  writeRecord(latest.directory, { ...latest.record, state: "stopped" });
  try { globalThis.process.kill(-latest.record.pid, "SIGTERM"); } catch { /* already gone */ }
  return ok(parsed.value.json ? `${JSON.stringify({ runId: latest.record.runId, state: "stopped" }, null, 2)}\n` : `stopped run ${latest.record.runId}\n`);
}

/** Maestro flows of a worktree: list or create them, run one under admission with per-step events, and manage and list the runs. */
export async function executeMaestro(args: readonly string[], environment: Environment, process: ProcessAdapter, emit?: Emit): Promise<Result<string>> {
  const [verb, ...rest] = args;
  if (verb === undefined || verb === "-h" || verb === "--help") return ok(usageText("maestro"));
  if (rest.includes("-h") || rest.includes("--help")) return ok(usageText(verb === "flows" ? "maestro-flows" : verb === "run" ? "maestro-run" : verb === "status" ? "maestro-status" : verb === "runs" ? "maestro-runs" : verb === "new" ? "maestro-new" : "maestro-stop"));
  if (verb === "flows") return flowsVerb(rest, process);
  if (verb === "run") return runVerb(rest, environment, process, emit);
  if (verb === "status") return statusVerb(rest, environment, process);
  if (verb === "stop") return stopVerb(rest, environment, process);
  if (verb === "runs") return runsVerb(rest, environment, process);
  if (verb === "new") return newVerb(rest, process);
  return failed("maestro requires flows|run|status|stop|runs|new", 2);
}
