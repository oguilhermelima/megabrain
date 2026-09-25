export const USAGE_LINES = {
  "install": "install [module-id] [--browser chromium|firefox|both] [--yes] [--revert]",
  "doctor": "doctor [module-id] [--json]",
  "context": "context [--json]",
  "worktree": "worktree create|pr|finish|list|adopt ...",
  "worktree-create": "worktree create --repo <name|path> --branch <branch> [--from <ref>] [--base <ref>] [--parent <branch:branch|path:path>] [--no-parent] [--issue <number>] [--linear-issue <identifier-or-url>] [--pr <number>] [--name <slug>] [--agent <id>] [--model <id>] [--effort <level>] [--prompt <text>] [--label <text>] [--tmux true|false] [--agent-arg <flag>] [--json]",
  "worktree-pr": "worktree pr <branch|path|slug> [--base <ref>] [--title <text>] [--body <text>] [--json]",
  "worktree-finish": "worktree finish <branch|path|slug> [--delete-branch] [--base <ref>] [--force] [--json]",
  "worktree-list": "worktree list [--repo <name|path>] [--tree|--flat] [--json]",
  "worktree-adopt": "worktree adopt <path|branch> [--json]",
  "terminal-create": "terminal create [--worktree <path>] [--command <cmd>] [--title <text>] [--port <port>] [--json]",
  "terminal-list": "terminal list [--worktree <path>] [--json]",
  "terminal-restart": "terminal restart <selector> [--command <cmd>] [--wait-port <port>] [--timeout <seconds>] [--json]",
  "terminal-close": "terminal close <selector> [--json]",
  "orchestrate-spawn": "orchestrate spawn --repo <name|path> --branch <branch> [--agent <id>] [--chain <name>] [--model <id>] [--base <ref>] [--name <slug>] [--effort <level>] [--prompt <text>] [--label <text>] [--worktree <path>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json]",
  "orchestrate-list": "orchestrate list [--all|--orphans|--uncertain] [--json]",
  "orchestrate-prune": "orchestrate prune [--older-than <days>] [--state <list>] [--archive|--delete] [--dry-run] [--json]",
  "orchestrate-reconcile": "orchestrate reconcile <dispatch-id> [--all] [--json]",
  "orchestrate-liveness": "orchestrate liveness <dispatch-id> [--json]",
  "orchestrate-watch": "orchestrate watch <dispatch-id> [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode nudge|poll] [--consumer <id>] [--generation <number>] [--full] [--json]",
  "orchestrate-read": "orchestrate read <dispatch-id> [--lines <count>] [--json]",
  "orchestrate-ack": "orchestrate ack <dispatch-id> <delivery-id> [--consumer <id>] [--generation <number>] [--close] [--json]",
  "orchestrate-reply": "orchestrate reply <dispatch-id> --text <answer> [--supersede] [--json]",
  "orchestrate-stop": "orchestrate stop <dispatch-id> [--json]",
  "orchestrate-change": "orchestrate change <dispatch-id> --text <text> [--json]",
  "orchestrate-close": "orchestrate close <dispatch-id> [--force-release] [--json]",
  "ask": "ask \"question\"",
  "done": "done \"summary\"",
  "received": "received",
  "check": "check [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode poll] [--consumer <id>] [--generation <number>] [--full] [--json]",
  "ack": "ack <delivery-id> [--consumer <id>] [--generation <number>] [--json]",
  "chain": "chain list|limits|add|edit|delete|run|repair ...",
  "chain-list": "chain list [--json]",
  "chain-limits": "chain limits [--json] [--enable <providers>] [--disable <providers>] [--notice-on|--notice-off] [--notice-interval <seconds>]",
  "chain-add": "chain add <name> --when <json> --steps <json> [--step <json>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--allow-unknown-model] [--json]",
  "chain-edit": "chain edit <name> [--allow-unknown-model] [--json]",
  "chain-delete": "chain delete <name> [--json]",
  "chain-repair": "chain repair <name> --step <number> --model <id> [--effort <level>] [--json]",
  "chain-run": "chain run [name] [--chain <name>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--repo <name|path>] [--branch <branch>] [--base <ref>] [--name <slug>] [--worktree <path>] [--prompt <text>] [--label <text>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json]",
  "model": "model list|add|refresh ...",
  "model-list": "model list [--json]",
  "model-add": "model add <agent> <model> --reasoning <levels>",
  "model-refresh": "model refresh <agent>",
  "native-appium": "native appium start|stop|status",
  "native-sim-list": "native sim list <phone|tv> [--json]",
  "native-runtime-list": "native runtime list [<ios|tvos>] (--installed|--available) [--json]",
  "native-runtime-install": "native runtime install <ios|tvos> <version> [--json]",
  "native-sim-ensure": "native sim ensure <phone|tv> [--device <name-or-udid>] [--timeout <seconds>] [--json]",
  "native-app-reload": "native app reload <phone|tv> [--route <r>] [--bundle-id <id>] [--url-template <tpl>] [--device <name-or-udid>] [--metro-port <p>] [--timeout <s>] [--json]",
  "native-health": "native health <phone|tv> [--bundle-id <id>] [--device <name-or-udid>] [--metro-port <p>] [--control-frame <path>] [--json]",
  "native-crashes": "native crashes <phone|tv> [--last N] [--json]",
  "native-build": "native build <phone|tv> [--runtime <version>] [--json]",
  "tv-connect": "tv connect <ip> [--port <port>]",
  "tv-disconnect": "tv disconnect [<ip>]",
  "tmux-tune": "tmux tune [--yes] [--dry-run] [--revert] [--json]",
  "tmux-wrapper": "tmux wrapper [--yes] [--dry-run] [--revert] [--json]",
  "web": "web [--device SLUG|--category NAME|--viewport WxH] ...",
  "web-capture": "web capture --url URL --screen NAME [--settle default|scroll] [--scroll-timeout MS] [options]",
  "web-measure": "web measure --url URL --screen NAME [--settle default|scroll] [--scroll-timeout MS] [options]",
  "web-session": "web session save --url URL --output FILE [options]",
  "web-viewport": "web viewport set|show|devices ...",
  "web-viewport-set": "web viewport set [--browser chromium|firefox|both] [--viewport WxH|--device SLUG|--category NAME|--width W --height H] [--orientation portrait|landscape]",
  "web-viewport-show": "web viewport show [--browser chromium|firefox|both]",
  "web-devices": "web devices list [FILTER] [--orientation portrait|landscape|all] | add SLUG --viewport WxH --source SOURCE [options] | remove SLUG",
  "web-userscript": "web userscript install|list|remove ...",
  "web-userscript-install": "web userscript install <file.user.js> [--viewport WxH|--device SLUG|--category NAME] [--orientation portrait|landscape]",
  "web-userscript-list": "web userscript list",
  "web-userscript-remove": "web userscript remove <file.user.js> [--viewport WxH|--device SLUG|--category NAME] [--orientation portrait|landscape]",
} as const;

const USAGE_ACTION_TEMPLATES = {
  "web-viewport-action": "web-viewport-{action}",
  "web-userscript-action": "web-userscript-{action}",
} as const;

const CHILD_MESSAGE_ERROR_USAGE = {
  ask: 'ask "question" | megabrain ask --text "question"',
  done: 'done "summary" | megabrain done --text "summary"',
} as const;

const ADDITIONAL_USAGE_LINES = {
  "native-eval": "native eval <phone|tv> <expression> [--metro-port <p>] [--timeout <s>] [--json]",
  "native-navigate": "native navigate <phone|tv> <path> [--metro-port <p>] [--timeout <s>] [--json]",
  "native-capture": "native capture <phone|tv> (--screens FILE | --screen NAME --route PATH) [--output-root DIR] [--surface NAME] [--capture-id ID] [--theme NAME] [--viewport NAME] [--device <name-or-udid>] [--bundle-id ID] [--metro-port <p>] [--timeout <s>] [--stable-window <seconds>] [--json]",
  "native-capture-summary": "native capture <phone|tv> (--screens FILE | --screen NAME --route PATH) [options]",
} as const;

const ALL_USAGE_LINES = { ...USAGE_LINES, ...ADDITIONAL_USAGE_LINES } as const;

export type UsageKey = keyof typeof ALL_USAGE_LINES;



export function usageLine(key: UsageKey): string {
  return ALL_USAGE_LINES[key];
}

export function usageText(key: UsageKey): string {
  return `Usage: megabrain ${usageLine(key)}\n`;
}

export function usageMessage(key: UsageKey): string {
  return `Usage: megabrain ${usageLine(key)}`;
}

export function usageActionMessage(key: "web-viewport-action" | "web-userscript-action", action: string): string {
  return `Usage: megabrain ${USAGE_ACTION_TEMPLATES[key].replace("{action}", action)}`;
}

export function childMessageErrorUsage(type: keyof typeof CHILD_MESSAGE_ERROR_USAGE): string {
  return `Usage: megabrain ${CHILD_MESSAGE_ERROR_USAGE[type]}\n`;
}

export function usageGroup(keys: readonly UsageKey[]): string {
  return keys.map((key, index) => `${index === 0 ? "Usage: " : "       "}megabrain ${usageLine(key)}\n`).join("");
}

export function usageTable(): string {
  return Object.entries(USAGE_LINES).map(([key, line]) => `${key}\t${line}\n`).join("");
}

export const ROOT_USAGE = `Usage: megabrain <command> [options]

Commands:
  version|-V|--version                   Print the megabrain version
  install [module-id] [--browser ...]   Install one module or choose modules interactively
  doctor [module-id]                   Check one module or all modules
  context [--json]                     Detect the current orchestration host
  worktree create ...                  Create a shared Orca/Superset worktree (--from <ref>)
  worktree finish ...                  Finish a shared worktree
  worktree list [--repo <name|path>]   List shared-root worktrees
  worktree adopt <path|branch>         Register an existing worktree in Superset
  terminal create ...                  Open a terminal in the current orchestrator
  terminal list [--worktree <path>]    List terminals created by megabrain
  terminal restart <selector> ...      Restart a terminal created by megabrain
  terminal close <selector> ...        Close a terminal created by megabrain
  orchestrate spawn ...                Create a worktree and start an agent (--browser opts into browser MCP)
  orchestrate list [--all|--orphans|--uncertain] [--json]  List managed dispatches
  orchestrate prune ...                Archive or delete old terminal dispatches
  orchestrate reconcile <dispatch-id>  Reconcile an open dispatch without respawning
  orchestrate liveness <dispatch-id>     Read execution state from a dispatch terminal
  orchestrate watch <dispatch-id> ...  Watch a dispatch file channel for child messages
  orchestrate read <dispatch-id> ...   Read a tmux dispatch pane
  orchestrate ack <dispatch-id> ...    Acknowledge a delivery batch
  orchestrate reply <dispatch-id> ...  Queue a reply for a child dispatch (--supersede replaces old replies)
  orchestrate stop <dispatch-id> ...   Interrupt a working child without closing its pane
  orchestrate change <dispatch-id> ... Replace queued direction and interrupt the child
  orchestrate close <dispatch-id> ...  Close a Superset dispatch terminal
  chain list|limits|add|edit|delete|run ...  Manage ordered child-agent chains
  model list|add|refresh ...            Manage the versioned model registry
  web [--device ...]|viewport|devices|userscript|capture|measure|session-save ...  Configure browser and visual parity workflows
  ask "question"                       Ask the direct coordinator from a child dispatch
  done "summary"                        Mark a child dispatch done
  check [options]                       Check for replies from the direct coordinator
  ack <delivery-id> [options]          Acknowledge a child reply delivery
  received                            Confirm receipt of a dispatch prompt
  native sim list <phone|tv> ...       List available Apple simulators
  native runtime list ...              List installed or known Apple runtimes
  native runtime install ...           Install an Apple simulator runtime
  native appium start|stop|status      Manage the shared Appium server
  native build <phone|tv> ...          Build, install and launch a native app
  native sim ensure <phone|tv> ...     Boot a requested Apple simulator
  native app reload <phone|tv> ...     Terminate and deep-link an app
  native health <phone|tv> ...         Check whether an app is rendering
  tv connect <ip> [--port <port>]      Connect an Android TV over adb
  tv disconnect [<ip>]                 Disconnect an Android TV
  tmux tune [--yes|--dry-run|--revert] Tune global tmux configuration
  tmux wrapper [--yes|--dry-run|--revert] Install the agent tmux wrapper
`;
