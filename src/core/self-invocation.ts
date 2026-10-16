/**
 * The command and leading arguments that run this same megabrain again. A compiled binary reports a
 * virtual /$bunfs/ script in argv[1], which is not spawnable; only a real script path is passed on.
 */
export function selfInvocation(execPath: string, argv: readonly string[], args: readonly string[] = []): { command: string; args: string[] } {
  const script = argv[1];
  const entryArguments = script !== undefined && !script.startsWith("/$bunfs/") ? [script] : [];
  return { command: execPath, args: [...entryArguments, ...args] };
}

/**
 * Runs inline JavaScript through this executable. A compiled binary only behaves as the bun CLI,
 * and so accepts -e, when BUN_BE_BUN is set; the caller must keep that variable out of its children.
 */
export function runtimeScript(execPath: string, script: string, payload: string): { command: string; args: string[]; env: Record<string, string> } {
  return { command: execPath, args: ["-e", script, payload], env: { BUN_BE_BUN: "1" } };
}
