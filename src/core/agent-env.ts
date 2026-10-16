type Environment = Readonly<Record<string, string | undefined>>;

// Variables that say which agent session or host pane a process belongs to. A process megabrain
// starts for the person must not inherit them from whatever shell opened the app.
const MARKER = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_.*|ORCA_.*|SUPERSET_.*|CODEX_.*|GROK_.*|ANTIGRAVITY_.*|AI_AGENT|MEGABRAIN_(DISPATCH|SESSION|PARENT|CHILD).*|TMUX|TMUX_PANE)$/;

// The person's own configuration, which only looks like a marker: provider switches, credentials and
// limits for Claude, and Codex's home directory.
const KEPT = /^(CLAUDE_CODE_(USE_|OAUTH_|API_KEY|DISABLE_|MAX_).*|CODEX_HOME)$/;

export function isAgentMarker(name: string): boolean {
  return MARKER.test(name) && !KEPT.test(name);
}

export function scrubAgentEnvironment(environment: Environment): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !isAgentMarker(name)));
}
