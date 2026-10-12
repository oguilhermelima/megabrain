// Decides whether a shell command an agent is about to run uses machine resources megabrain
// governs, and what to run instead. The original command is always kept byte for byte inside
// --shell, so routing never changes what runs, only how it is admitted, held and logged.

export type ResourceRoute =
  | Readonly<{ action: "rewrite"; command: string }>
  | Readonly<{ action: "deny"; reason: string }>;

type Kind = "orb" | "server" | "docker" | "migrate" | "megabrain";
type Found = Readonly<{ kind: Kind; name: string }>;

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
// Flags of a package manager that take the next word as their value.
const VALUE_FLAGS = new Set(["--filter", "-F", "--dir", "-C", "--cwd", "--workspace", "-w", "--prefix"]);
// Wrappers that run the following words as a program.
const RUNNERS = new Set(["npx", "bunx", "pnpx", "nohup", "env", "time", "exec"]);
const SERVER_SCRIPT = /^(dev|start|serve|preview|watch)(?::[\w.-]+)?$/;
const SERVER_TOOLS: Readonly<Record<string, RegExp>> = {
  next: /^(dev|start)$/, vite: /^(|dev|serve|preview)$/, nodemon: /^.*$/, expo: /^start$/,
  astro: /^dev$/, nuxt: /^dev$/, remix: /^dev$/, turbo: /^(dev|watch|run)$/,
};
const DOCKER_VERBS = new Set(["run", "start", "build", "exec", "create", "up", "buildx"]);
const PRIORITY: readonly Kind[] = ["megabrain", "orb", "server", "docker", "migrate"];

export const ORB_REFUSAL = "megabrain starts and stops OrbStack: run docker work through megabrain proc run --needs docker -- <command>, and OrbStack stops on its own once no megabrain process holds it.";

// Splits on unquoted && || ; | & and newlines, then into words, honouring quotes and escapes.
function segments(command: string): string[][] {
  const result: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | "\"" | undefined;
  const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
  const endSegment = () => { endWord(); if (words.length > 0) result.push(words); words = []; };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === "\"" && index + 1 < command.length) word += command[++index];
      else word += character;
      continue;
    }
    if (character === "'" || character === "\"") { quote = character; inWord = true; continue; }
    if (character === "\\" && index + 1 < command.length) { word += command[++index]; inWord = true; continue; }
    if (character === "&" || character === "|" || character === ";" || character === "\n") { endSegment(); continue; }
    if (character === " " || character === "\t") { endWord(); continue; }
    word += character; inWord = true;
  }
  endSegment();
  return result;
}

function program(words: readonly string[]): string[] {
  let rest = [...words];
  for (;;) {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0] ?? "")) rest = rest.slice(1);
    const head = (rest[0] ?? "").split("/").pop() ?? "";
    if (RUNNERS.has(head)) { rest = rest.slice(1); while ((rest[0] ?? "").startsWith("-")) rest = rest.slice(1); continue; }
    return [head, ...rest.slice(1)];
  }
}

function classify(words: readonly string[]): Found | undefined {
  const [head = "", ...args] = program(words);
  if (head === "megabrain") return { kind: "megabrain", name: "" };
  if (head === "orb" && ["start", "stop", "restart"].includes(args[0] ?? "")) return { kind: "orb", name: "orb" };
  if (head === "docker" || head === "docker-compose") {
    const verbs = args.filter((word) => !word.startsWith("-"));
    const verb = verbs[0] === "compose" ? verbs[1] : head === "docker-compose" ? verbs[0] : verbs[0];
    return verb !== undefined && DOCKER_VERBS.has(verb) ? { kind: "docker", name: "docker" } : undefined;
  }
  if (head === "prisma") return ["migrate", "db"].includes(args[0] ?? "") ? { kind: "migrate", name: "migrate" } : undefined;
  if (head === "drizzle-kit") return ["migrate", "push"].includes(args[0] ?? "") ? { kind: "migrate", name: "migrate" } : undefined;
  const tool = SERVER_TOOLS[head];
  if (tool !== undefined) return tool.test(args[0] ?? "") ? { kind: "server", name: "dev" } : undefined;
  if (PACKAGE_MANAGERS.has(head)) {
    let index = 0;
    while (index < args.length && (args[index] ?? "").startsWith("-")) index += VALUE_FLAGS.has(args[index] ?? "") ? 2 : 1;
    let verb = args[index];
    if (verb === "exec" || verb === "dlx" || verb === "x") return classify(args.slice(index + 1));
    if (verb === "run" || verb === "run-script") verb = args[index + 1];
    if (verb !== undefined && SERVER_SCRIPT.test(verb)) return { kind: "server", name: verb.replaceAll(":", "-") };
  }
  return undefined;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function routeResourceCommand(command: string): ResourceRoute | undefined {
  const found = segments(command).map(classify).filter((item): item is Found => item !== undefined);
  const strongest = PRIORITY.map((kind) => found.find((item) => item.kind === kind)).find((item) => item !== undefined);
  if (strongest === undefined || strongest.kind === "megabrain") return undefined;
  if (strongest.kind === "orb") return { action: "deny", reason: ORB_REFUSAL };
  if (strongest.kind === "server") return { action: "rewrite", command: `megabrain proc start --name ${strongest.name} --shell ${quote(command)}` };
  const needs = strongest.kind === "docker" ? " --needs docker" : "";
  return { action: "rewrite", command: `megabrain proc run --name ${strongest.name}${needs} --shell ${quote(command)}` };
}
