import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The port a run command will bind, and how that was found. `fragment` is the text in the run
 * command that sets it (so a caller can rewrite it in place); `override` is what to append to the
 * command to move the framework to another port, with {port} standing for it, or null when no
 * argument can: the port is fixed inside a package script, or the server reads only PORT.
 */
export type ScriptPort = Readonly<{
  port: number;
  framework: string | null;
  source: "command" | "script" | "env-file" | "package-json" | "default";
  detail: string;
  fragment: string | null;
  override: string | null;
}>;

type Framework = Readonly<{ name: string; label: string; port: number; override: string | null; readsPortEnv: boolean }>;

// Ordered: the first match names the framework. Each pattern requires the serving subcommand, so
// a build or lint script never matches.
const frameworks: ReadonlyArray<readonly [RegExp, Framework]> = [
  [/(?:^|[\s/])next(?:\s+(?:dev|start)\b|\s*$|\s+-)/, { name: "next", label: "next", port: 3000, override: "--port {port}", readsPortEnv: true }],
  [/(?:^|[\s/])vite\s+preview\b/, { name: "vite", label: "vite preview", port: 4173, override: "--port {port}", readsPortEnv: false }],
  [/(?:^|[\s/])vite(?:\s+(?:dev|serve)\b|\s*$|\s+-)/, { name: "vite", label: "vite", port: 5173, override: "--port {port}", readsPortEnv: false }],
  [/(?:^|[\s/])astro\s+(?:dev|start|preview)\b/, { name: "astro", label: "astro", port: 4321, override: "--port {port}", readsPortEnv: false }],
  [/(?:^|[\s/])remix\s+vite:dev\b/, { name: "remix", label: "remix vite:dev", port: 5173, override: "--port {port}", readsPortEnv: false }],
  [/(?:^|[\s/])(?:remix\s+dev|remix-serve)\b/, { name: "remix", label: "remix", port: 3000, override: null, readsPortEnv: true }],
  [/(?:^|[\s/])expo\s+start\b/, { name: "expo", label: "expo", port: 8081, override: "--port {port}", readsPortEnv: false }],
  [/(?:^|[\s/])(?:storybook\s+dev|start-storybook)\b/, { name: "storybook", label: "storybook", port: 6006, override: "--port {port}", readsPortEnv: false }],
  [/(?:^|[\s/])rails\s+(?:s|server)\b/, { name: "rails", label: "rails server", port: 3000, override: "-p {port}", readsPortEnv: true }],
  [/(?:^|\s)bin\/dev\b/, { name: "rails", label: "bin/dev", port: 3000, override: null, readsPortEnv: true }],
  [/manage\.py\s+runserver\b/, { name: "django", label: "django runserver", port: 8000, override: "{port}", readsPortEnv: false }],
];

const explicitPatterns: ReadonlyArray<readonly [RegExp, "flag" | "env"]> = [
  [/(?:^|\s)(--port(?:=|\s+)(\d{1,5}))(?=\s|$)/, "flag"],
  [/(?:^|\s)(-p(?:=|\s*)(\d{1,5}))(?=\s|$)/, "flag"],
  [/runserver\s+((?:[\w.[\]]*:)?(\d{1,5}))(?=\s|$)/, "flag"],
  [/(?:^|\s)(PORT=["']?(\d{1,5})["']?)(?=\s|$)/, "env"],
];

const envFiles = [".env.local", ".env.development.local", ".env.development", ".env"];

const valid = (port: number) => Number.isInteger(port) && port > 0 && port < 65536;

function framework(text: string): Framework | null {
  return frameworks.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function explicit(text: string): { fragment: string; port: number; kind: "flag" | "env" } | null {
  for (const [pattern, kind] of explicitPatterns) {
    const match = pattern.exec(text);
    const port = Number(match?.[2]);
    if (match?.[1] !== undefined && valid(port)) return { fragment: match[1], port, kind };
  }
  return null;
}

function packageJson(root: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** The package script a `<manager> [run] <name>` command runs, with its name. */
function packageScript(manifest: Record<string, unknown> | null, command: string): { name: string; text: string } | null {
  const name = /^\s*(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/.exec(command)?.[1];
  const scripts = manifest?.scripts;
  if (name === undefined || typeof scripts !== "object" || scripts === null) return null;
  const text = (scripts as Record<string, unknown>)[name];
  return typeof text === "string" ? { name, text } : null;
}

function envFilePort(root: string): { file: string; port: number } | null {
  for (const file of envFiles) {
    let contents: string;
    try { contents = readFileSync(join(root, file), "utf8"); } catch { continue; }
    const port = Number(/^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{1,5})["']?\s*(?:#.*)?$/m.exec(contents)?.[1]);
    if (valid(port)) return { file, port };
  }
  return null;
}

/** The port `command`, run in `root`, will bind; null when nothing says. */
export function detectScriptPort(root: string, command: string | null | undefined): ScriptPort | null {
  if (command === null || command === undefined || command.trim() === "") return null;
  const manifest = packageJson(root);
  const script = packageScript(manifest, command);
  const known = framework(command) ?? (script === null ? null : framework(script.text));
  const override = known?.override ?? null;

  const own = explicit(command);
  if (own !== null) return { port: own.port, framework: known?.name ?? null, source: "command", detail: `${own.fragment} in the run command`, fragment: own.fragment, override };

  const inScript = script === null ? null : explicit(script.text);
  if (script !== null && inScript !== null) {
    return { port: inScript.port, framework: known?.name ?? null, source: "script", detail: `${inScript.fragment} in the ${script.name} script`, fragment: null, override: inScript.kind === "flag" ? null : override };
  }

  if (known === null || known.readsPortEnv) {
    const fromEnv = envFilePort(root);
    if (fromEnv !== null) return { port: fromEnv.port, framework: known?.name ?? null, source: "env-file", detail: `${fromEnv.file} sets PORT=${fromEnv.port}`, fragment: null, override };
  }

  if (known === null) {
    const config = manifest?.config;
    const port = Number(typeof config === "object" && config !== null ? (config as Record<string, unknown>).port : undefined);
    return valid(port) ? { port, framework: null, source: "package-json", detail: `package.json config.port is ${port}`, fragment: null, override: null } : null;
  }

  return { port: known.port, framework: known.name, source: "default", detail: `${known.label} listens on ${known.port} by default`, fragment: null, override };
}
