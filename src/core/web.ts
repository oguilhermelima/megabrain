export type WebPlan =
  | { readonly kind: "run"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly message: string };

const viewportFlags = new Set(["--viewport", "--device", "--category", "--orientation", "--width", "--height"]);

function usage(message: string): WebPlan {
  return { kind: "usage", message };
}

function collectFlags(args: readonly string[], allowed: ReadonlySet<string>): { args: string[]; rest: string[] } | WebPlan {
  const collected: string[] = [];
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (allowed.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) return usage("Usage: megabrain web-viewport-set");
      collected.push(arg, value);
      index += 1;
    } else {
      rest.push(arg);
    }
  }
  return { args: collected, rest };
}

function planDevices(args: readonly string[]): WebPlan {
  const [first, ...tail] = args;
  const action = first === "add" || first === "remove" || first === "list" ? first : "list";
  const remaining = action === first ? tail : args;
  if (action === "add" || action === "remove") return { kind: "run", command: `device-${action}`, args: remaining };
  let filter = "";
  const options: string[] = [];
  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index];
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--filter" || arg === "--orientation" || arg === "--devices-file") {
      const value = remaining[index + 1];
      if (value === undefined || value.length === 0) return usage("Usage: megabrain web-devices");
      options.push(arg, value);
      index += 1;
    } else if (filter.length === 0) {
      filter = arg;
    } else {
      return usage("Usage: megabrain web-devices");
    }
  }
  return { kind: "run", command: "device-list", args: ["--filter", filter, ...options] };
}

function planUserscript(args: readonly string[]): WebPlan {
  const [action = "", ...tail] = args;
  let name = "";
  const options: string[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const arg = tail[index];
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--userscripts" || viewportFlags.has(arg)) {
      const value = tail[index + 1];
      if (value === undefined || value.length === 0) return usage(`Usage: megabrain web-userscript-${action}`);
      options.push(arg, value);
      index += 1;
    } else if (name.length === 0) name = arg;
    else return usage(`Usage: megabrain web-userscript-${action}`);
  }
  if ((action === "install" || action === "remove") && name.length === 0) return usage(`Usage: megabrain web-userscript-${action}`);
  if (action === "list" && name.length > 0) return usage("Usage: megabrain web-userscript-list");
  if (action !== "install" && action !== "list" && action !== "remove") return { kind: "help" };
  return { kind: "run", command: `userscript-${action}`, args: action === "list" ? options : ["--file", name, ...options] };
}

function planViewport(args: readonly string[]): WebPlan {
  const [action = "", ...tail] = args;
  const allowed = new Set(["--browser", "--filter", ...viewportFlags]);
  const parsed = collectFlags(tail, allowed);
  if ("kind" in parsed) return parsed;
  if (parsed.rest.length > 0) return usage(`Usage: megabrain web-viewport-${action || "set"}`);
  if (action === "set") return { kind: "run", command: "viewport-set", args: parsed.args };
  if (action === "show") return { kind: "run", command: "viewport-show", args: parsed.args };
  if (action === "devices") return { kind: "run", command: "device-list", args: parsed.args };
  return { kind: "help" };
}

export function planWeb(args: readonly string[]): WebPlan {
  const [command, ...tail] = args;
  if (command === undefined || command === "-h" || command === "--help") return { kind: "help" };
  if (command === "devices") return planDevices(tail);
  if (command === "userscript") return planUserscript(tail);
  if (command === "viewport") return planViewport(tail);
  if (command === "capture" || command === "measure" || command === "session-save") {
    return tail[0] === "-h" || tail[0] === "--help" ? { kind: "help" } : { kind: "run", command, args: tail };
  }
  if (command === "session") {
    if (tail[0] === "-h" || tail[0] === "--help") return { kind: "help" };
    if (tail[0] !== "save") return usage("Usage: megabrain web-session");
    return { kind: "run", command: "session-save", args: tail.slice(1) };
  }
  if (viewportFlags.has(command)) return { kind: "run", command: "viewport-set", args };
  return usage(`unknown web command: ${command}`);
}
