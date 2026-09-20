import { failed, ok, type Result } from "./result.js";

export type NativePlatform = "iOS" | "tvOS";
export type NativeRuntime = { readonly platform: NativePlatform; readonly version: string; readonly build: string; readonly identifier: string };

export function runtimesFromSimctl(value: unknown): Result<NativeRuntime[]> {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { runtimes?: unknown }).runtimes)) return failed("simctl returned invalid runtime data");
  const runtimes: NativeRuntime[] = [];
  for (const entry of (value as { runtimes: unknown[] }).runtimes) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const identifier = typeof item.identifier === "string" ? item.identifier : "";
    const name = typeof item.name === "string" ? item.name : "";
    const version = typeof item.version === "string" ? item.version : "";
    const build = typeof item.buildversion === "string" ? item.buildversion : typeof item.buildVersion === "string" ? item.buildVersion : "";
    const platform = name.startsWith("iOS") || identifier.includes("iOS") ? "iOS" : name.startsWith("tvOS") || identifier.includes("tvOS") ? "tvOS" : undefined;
    if (platform && version && build && identifier) runtimes.push({ platform, version, build, identifier });
  }
  return ok(runtimes);
}

export type NativeKind = "phone" | "tv";
export type NativeCandidate = { readonly udid: string; readonly state: string; readonly name: string };
export type NativeBuildStep = "prebuild" | "pods" | "build" | "install" | "launch";
export type NativeBuildOutcome = { readonly ok: boolean; readonly error?: string };

export type NativeHealth = {
  readonly process: { readonly state: "running" | "not-running" | "unknown"; readonly reason?: string };
  readonly metro: { readonly state: "attached" | "not-attached" | "unknown"; readonly reason?: string };
  readonly tree: { readonly count: number | null; readonly reason?: string };
  readonly frame: { readonly state: "differs" | "identical" | "unknown"; readonly reason?: string };
};

export type NativeHealthResult = NativeHealth & {
  readonly status: "rendered" | "not-rendered" | "loading" | "unknown";
  readonly reason: string;
};

export function evaluateNativeHealth(readings: NativeHealth): NativeHealthResult {
  if (readings.process.state === "not-running") return { ...readings, status: "not-rendered", reason: readings.process.reason ?? "process is not running" };
  if (readings.process.state === "unknown") return { ...readings, status: "unknown", reason: readings.process.reason ?? "process state is unavailable" };
  if (readings.frame.state === "identical") return { ...readings, status: "not-rendered", reason: "screen matches the control frame" };
  if (readings.frame.state === "unknown") return { ...readings, status: "unknown", reason: readings.frame.reason ?? "frame comparison is unavailable" };
  if (readings.tree.count !== null && readings.tree.count <= 1) {
    const noun = readings.tree.count === 1 ? "element" : "elements";
    return { ...readings, status: "loading", reason: `accessibility tree exposes ${readings.tree.count} ${noun}` };
  }
  if (readings.tree.count !== null) return { ...readings, status: "rendered", reason: `frame differs and accessibility tree exposes ${readings.tree.count} elements` };
  if (readings.metro.state === "attached") return { ...readings, status: "rendered", reason: "frame differs and Metro is attached" };
  return { ...readings, status: "unknown", reason: "accessibility tree is unavailable and Metro is not attached" };
}

export function nativeUsage(topic: "native" | "list" | "ensure" | "reload" | "appium" | "health" | "crashes" | "eval" | "navigate" | "capture" | "runtime-list" | "runtime-install" | "build"): string {
  const lines = {
    native: "Usage: megabrain native sim list <phone|tv> [--json]\n       megabrain native sim ensure <phone|tv> [--device <name-or-udid>] [--timeout <seconds>] [--json]\n       megabrain native app reload <phone|tv> [--route <r>] [--bundle-id <id>] [--url-template <tpl>] [--device <name-or-udid>] [--metro-port <p>] [--timeout <s>] [--json]\n       megabrain native eval <phone|tv> <expression> [--metro-port <p>] [--timeout <s>] [--json]\n       megabrain native navigate <phone|tv> <path> [--metro-port <p>] [--timeout <s>] [--json]\n       megabrain native capture <phone|tv> (--screens FILE | --screen NAME --route PATH) [options]\n       megabrain native health <phone|tv> [--bundle-id <id>] [--device <name-or-udid>] [--metro-port <p>] [--control-frame <path>] [--json]\n       megabrain native crashes <phone|tv> [--last N] [--json]\n       megabrain native build <phone|tv> [--runtime <version>] [--json]\n       megabrain native appium start|stop|status\n",
    list: "Usage: megabrain native sim list <phone|tv> [--json]\n",
    ensure: "Usage: megabrain native sim ensure <phone|tv> [--device <name-or-udid>] [--timeout <seconds>] [--json]\n",
    reload: "Usage: megabrain native app reload <phone|tv> [--route <r>] [--bundle-id <id>] [--url-template <tpl>] [--device <name-or-udid>] [--metro-port <p>] [--timeout <s>] [--json]\n",
    appium: "Usage: megabrain native appium start|stop|status\n",
    eval: "Usage: megabrain native eval <phone|tv> <expression> [--metro-port <p>] [--timeout <s>] [--json]\n",
    navigate: "Usage: megabrain native navigate <phone|tv> <path> [--metro-port <p>] [--timeout <s>] [--json]\n",
    capture: "Usage: megabrain native capture <phone|tv> (--screens FILE | --screen NAME --route PATH) [--output-root DIR] [--surface NAME] [--capture-id ID] [--theme NAME] [--viewport NAME] [--device <name-or-udid>] [--bundle-id ID] [--metro-port <p>] [--timeout <s>] [--json]\n",
    health: "Usage: megabrain native health <phone|tv> [--bundle-id <id>] [--device <name-or-udid>] [--metro-port <p>] [--control-frame <path>] [--json]\n",
    crashes: "Usage: megabrain native crashes <phone|tv> [--last N] [--json]\n",
    "runtime-list": "Usage: megabrain native runtime list [<ios|tvos>] (--installed|--available) [--json]\n",
    "runtime-install": "Usage: megabrain native runtime install <ios|tvos> <version> [--json]\n",
    build: "Usage: megabrain native build <phone|tv> [--runtime <version>] [--json]\n",
  } as const;
  return lines[topic];
}

export function validateKind(value: string): Result<NativeKind> {
  if (value === "phone" || value === "tv") return ok(value);
  return failed(`expected simulator kind phone or tv, got: ${value}`, 2);
}

export function validateTimeout(value: string): Result<number> {
  if (!/^[1-9][0-9]*$/.test(value)) return failed(`timeout must be a positive integer: ${value}`, 2);
  return ok(Number(value));
}

export function validateMetroPort(value: string): Result<string> {
  if (value === "" || value === "none") return ok(value);
  if (!/^\d+$/.test(value)) return failed(`metro port must be an integer or none: ${value}`, 2);
  const port = Number(value);
  return port >= 1 && port <= 65535 ? ok(value) : failed(`metro port must be between 1 and 65535`, 2);
}

export function candidatesFromSimctl(value: unknown, kind: NativeKind): Result<NativeCandidate[]> {
  if (typeof value !== "object" || value === null) return failed("simctl returned invalid device data");
  const devices = (value as { devices?: unknown }).devices;
  if (typeof devices !== "object" || devices === null) return ok([]);
  const result: NativeCandidate[] = [];
  for (const [runtime, entries] of Object.entries(devices)) {
    if (!runtime.includes(kind === "phone" ? "iOS" : "tvOS") || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (item.isAvailable !== true || typeof item.udid !== "string" || typeof item.state !== "string" || typeof item.name !== "string") continue;
      result.push({ udid: item.udid, state: item.state, name: item.name });
    }
  }
  return ok(result);
}

export function candidatesForRuntimeFromSimctl(value: unknown, kind: NativeKind, version: string): Result<NativeCandidate[]> {
  if (typeof value !== "object" || value === null) return failed("simctl returned invalid device data");
  const devices = (value as { devices?: unknown }).devices;
  if (typeof devices !== "object" || devices === null) return ok([]);
  const result: NativeCandidate[] = [];
  for (const [runtime, entries] of Object.entries(devices)) {
    if (!runtime.includes(kind === "phone" ? "iOS" : "tvOS") || !runtime.includes(version.replaceAll(".", "-")) || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (item.isAvailable === true && typeof item.udid === "string" && typeof item.state === "string" && typeof item.name === "string") result.push({ udid: item.udid, state: item.state, name: item.name });
    }
  }
  return ok(result);
}

export function selectDevice(kind: NativeKind, candidates: readonly NativeCandidate[], requested: string, bootedOnly: boolean): Result<NativeCandidate> {
  const filtered = candidates.filter((candidate) => !bootedOnly || candidate.state === "Booted");
  const matches = requested.length === 0 ? filtered : filtered.filter((candidate) => candidate.udid === requested || candidate.name === requested);
  const identifierMatches = matches.filter((candidate) => candidate.udid === requested);
  const selected = identifierMatches.length > 0 ? identifierMatches : matches;
  const label = kind === "phone" ? "iOS" : "tvOS";
  const selectorIsName = requested.length > 0 && identifierMatches.length === 0;
  const subject = selectorIsName ? `name ${requested}` : `device ${requested}`;
  if (selected.length === 0) return failed(bootedOnly ? (requested ? `simulator ${subject} is not a booted ${label} simulator` : `no booted ${label} simulator is available; run megabrain native sim ensure ${kind}`) : (requested ? `no ${label} simulator matches ${subject}` : `no ${label} simulator matches the requested kind`));
  if (selected.length > 1) return failed(bootedOnly ? (selectorIsName ? `more than one booted ${label} simulator matches name ${requested}; pass --device <udid>` : `more than one booted ${label} simulator matches; pass --device <udid>`) : (selectorIsName ? `more than one ${label} simulator matches name ${requested}; pass --device <udid>` : `more than one ${label} simulator matches; pass --device <udid>`));
  return ok(selected[0] as NativeCandidate);
}

export function renderNativeUrl(template: string, route: string, metroPort: string, bundleId: string, device: string): Result<string> {
  const rendered = template.replaceAll("{route}", route.replace(/^\//, "")).replaceAll("{metro_port}", metroPort).replaceAll("{bundle_id}", bundleId).replaceAll("{device}", device);
  return rendered.includes("{") || rendered.includes("}") ? failed("URL template contains an unsupported placeholder") : ok(rendered);
}

export function formatNativeList(kind: NativeKind, candidates: readonly NativeCandidate[], json: boolean): string {
  if (json) return `${JSON.stringify({ kind, devices: candidates })}\n`;
  return candidates.map((candidate) => `${candidate.name}\t${candidate.state}\t${candidate.udid}\n`).join("");
}

export function nativeBuildStepFailure(outcomes: Readonly<Record<NativeBuildStep, NativeBuildOutcome>>): NativeBuildStep | undefined {
  for (const step of ["prebuild", "pods", "build", "install", "launch"] as const) {
    if (!outcomes[step].ok) return step;
  }
  return undefined;
}

export function buildXcodebuildArgs(platform: NativePlatform, workspace: string, scheme: string, runtime: string, udid: string, derivedDataPath: string): string[] {
  const sdk = platform === "tvOS" ? "appletvsimulator" : "iphonesimulator";
  return ["-workspace", workspace, "-scheme", scheme, "-sdk", sdk, "-destination", `platform=${platform} Simulator,id=${udid}`, "-derivedDataPath", derivedDataPath, "CODE_SIGNING_ALLOWED=NO", "build"];
}
