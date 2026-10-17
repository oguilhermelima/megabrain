export const USAGE_LINES = {
  "install": "install [module-id] [--agents claude,codex,agy,grok|none] [--skill none|global|project] [--modules list|all|none] [--tmux yes|no] [--yes] [--browser chromium|firefox|both] [--revert] [--plan] [--json]",
  "doctor": "doctor [module-id] [--json]",
  "db-check": "db check [--json]",
  "db-backup": "db backup [--json]",
  "db-import": "db import <dir> [--replace] [--json]",
  "db-migrate": "db migrate [--dry-run] [--json]",
  "db-show": "db show <dispatch-id-or-suffix>|--terminal <id>|--install-state|--models|--delivery-channels|--tmux-session <name> [--json]",
  "context": "context [--json]",
  "sessions-history": "sessions history --cwd <path> [--agent <claude|codex|grok|agy>] [--limit <n>] [--json]",
  "usage-stats": "usage stats [--days <n>] [--provider <claude|codex|grok|agy>] [--json]",
  "agent-command": "agent command <claude|codex|grok|agy> [--resume <id>] [--model <id>] [--effort <level>] --json",
  "agent-update": "agent update [<codex|claude|grok|agy|all>] [--check] [--json]",
  "agent-defaults": "agent defaults [--json]",
  // The caller must opt into operator authority on the command itself.
  "send": "send --session <agent:id> --text <text> --operator [--json]",
  "session-own": "session own <agent:id> [--json]",
  "session-release": "session release <agent:id> [--json]",
  "worktree": "worktree create|pr|finish|archive|archived|unarchive|list|adopt|prune|hide|unhide ...",
  "worktree-create": "worktree create --repo <name|path> --branch <branch> [--from <ref>] [--base <ref>] [--parent <branch:branch|path:path>] [--no-parent] [--issue <number>] [--linear-issue <identifier-or-url>] [--pr <number>] [--name <slug>] [--agent <id>] [--model <id>] [--effort <level>] [--prompt <text>] [--label <text>] [--tmux true|false] [--json]",
  "worktree-pr": "worktree pr <branch|path|slug> [--base <ref>] [--title <text>] [--body <text>] [--json]",
  "worktree-finish": "worktree finish <branch|path|slug> [--delete-branch] [--base <ref>] [--force] [--json]",
  "worktree-archive": "worktree archive <branch|path> [--repo <name|path>] [--force] [--json]",
  "worktree-archived": "worktree archived [--repo <name|path>] [--json]",
  "worktree-unarchive": "worktree unarchive <branch> [--repo <name|path>] [--json]",
  "worktree-list": "worktree list [--repo <name|path>] [--tree|--flat] [--json]",
  "worktree-adopt": "worktree adopt <path|branch> [--json]",
  "worktree-prune": "worktree prune [--older-than <days>] [--repo <name|path>] [--dry-run] [--yes] [--json]",
  "repo": "repo list|add|clone|remove|hide|unhide|scripts|github|discover ...",
  "repo-list": "repo list [--json]",
  "repo-add": "repo add <path> [--json]",
  "repo-clone": "repo clone <url> --into <dir> [--json]",
  "repo-remove": "repo remove <name|path> [--json]",
  "repo-scripts": "repo scripts <name|path> [--run <cmd>] [--build <cmd>] [--install <cmd>] [--json]",
  "repo-run": "repo run <name|path> [--script run|build|install] [--worktree <path>] [--command <cmd>] [--port <p>] [--admission wait|fail] [--json]",
  "repo-stop": "repo stop <name|path> [--script run|build|install] [--worktree <path>] [--force] [--json]",
  "repo-github": "repo github [--owner <login>] [--orgs] [--json]",
  "repo-discover": "repo discover [--roots <paths>] [--json]",
  "maestro": "maestro flows|run|status|stop|runs|new ...",
  "maestro-flows": "maestro flows [--worktree <path>] [--json]",
  "maestro-run": "maestro run <flow> [--worktree <path>] [--device <udid|name>] [--admission wait|fail] [--json]",
  "maestro-status": "maestro status [--worktree <path>] [--json]",
  "maestro-stop": "maestro stop [--worktree <path>] [--json]",
  "maestro-runs": "maestro runs [--worktree <path>] [--json]",
  "maestro-new": "maestro new <name> [--worktree <path>] [--json]",
  "projects": "projects [--json]",
  "port": "port who|free|kill ...",
  "port-who": "port who <port> [--json]",
  "port-free": "port free [--from <port>] [--json]",
  "port-kill": "port kill <port> [--json]",
  "github": "github prs|issues|pr|issue|pr-files|pr-file|review|comment|issue-state|pr-state|threads|thread-reply|thread-resolve|reviewers|request-review|pr-ready|auto-merge|rerun-checks|file-viewed|assignable|image ...",
  "github-prs": "github prs <repo name|path> [--state open|closed|merged|all] [--limit <n>] [--after <cursor>] [--json]",
  "github-issues": "github issues <repo name|path> [--state open|closed|all] [--limit <n>] [--after <cursor>] [--json]",
  "github-pr": "github pr <repo name|path> <number> [--json]",
  "github-issue": "github issue <repo name|path> <number> [--json]",
  "github-pr-files": "github pr-files <repo name|path> <number> [--page <k>] [--per-page <m>] [--no-patch] [--json]",
  "github-pr-file": "github pr-file <repo name|path> <number> <path> [--json]",
  "github-threads": "github threads <repo name|path> <number> [--json]",
  "github-thread-reply": "github thread-reply <repo name|path> <number> <thread id> --body <text> [--json]",
  "github-thread-resolve": "github thread-resolve <repo name|path> <number> <thread id> [--unresolve] [--json]",
  "github-reviewers": "github reviewers <repo name|path> <number> [--json]",
  "github-request-review": "github request-review <repo name|path> <number> --user <login>[,<login>...] [--remove] [--json]",
  "github-pr-ready": "github pr-ready <repo name|path> <number> [--draft] [--json]",
  "github-auto-merge": "github auto-merge <repo name|path> <number> --method merge|squash|rebase [--disable] [--json]",
  "github-rerun-checks": "github rerun-checks <repo name|path> <number> [--failed] [--json]",
  "github-file-viewed": "github file-viewed <repo name|path> <number> <path> [--unviewed] [--json]",
  "github-assignable": "github assignable <repo name|path> [--query <text>] [--json]",
  "github-image": "github image <repo name|path> <url> [--json]",
  "github-review": "github review <repo name|path> <number> --event approve|request-changes|comment --body <text> [--comments <json>] [--json]",
  "github-comment": "github comment <repo name|path> <number> --body <text> [--json]",
  "github-issue-state": "github issue-state <repo name|path> <number> open|closed [--reason completed|not planned] [--json]",
  "github-pr-state": "github pr-state <repo name|path> <number> merge|close|reopen [--method merge|squash|rebase] [--json]",
  "code": "code open <root> [--json] | goto <root> <path> [--line N] [--json] | stop <root> [--json]",
  "stack": "stack create <branch> --on <parent> [--repo <path>] | show|pr [--draft]|sync|merge [--yes] [--branch <member>] [--provider github|gitlab]",
  "terminal-create": "terminal create [--worktree <path>] [--command <cmd>] [--title <text>] [--port <port>] [--terminal <name>|auto|none] [--json]",
  "terminal-list": "terminal list [--worktree <path>] [--json] | --app [--server <tmux -L name>] [--json]",
  "terminal-open": "terminal open --session <tmux session> [--terminal <name>|auto|none] [--server <tmux -L name>] [--json]",
  "terminal-default": "terminal default [<name>|auto|none|--clear]",
  "terminal-restart": "terminal restart <selector> [--command <cmd>] [--wait-port <port>] [--timeout <seconds>] [--json]",
  "terminal-close": "terminal close <selector> [--json] | --app <id> [--server <tmux -L name>] [--json]",
  "orchestrate-spawn": "orchestrate spawn --repo <name|path> --branch <branch> [--agent <id>] [--chain <name>] [--model <id>] [--base <ref>] [--name <slug>] [--effort <level>] [--prompt <text>] [--label <text>] [--worktree <path>] [--tmux true|false] [--terminal <name>|auto|none] [--admission wait|fail] [--browser] [--context-ceiling <N%|Nk>] [--compact-at <N%|Nk>] [--loop] [--max-iterations <n>] [--agent-arg <flag>] [--json]",
  "orchestrate-policy": "orchestrate policy <dispatch-id-or-suffix> [--context-ceiling <N%|Nk>] [--compact-at <N%|Nk>] [--loop|--no-loop] [--max-iterations <n>] [--operator] [--json]",
  "orchestrate-adopt": "orchestrate adopt <dispatch-id-or-suffix> [--force] [--json]",
  "orchestrate-list": "orchestrate list [--mine|--all|--orphans|--uncertain] [--archived] [--json]",
  "orchestrate-prune": "orchestrate prune [--older-than <days>] [--state <list>] [--archive|--delete] [--dry-run] [--json]",
  "orchestrate-reconcile": "orchestrate reconcile <dispatch-id-or-suffix> [--all] [--operator] [--json]",
  "orchestrate-liveness": "orchestrate liveness <dispatch-id-or-suffix> [--operator] [--json]",
  "orchestrate-watch": "orchestrate watch <dispatch-id-or-suffix> [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode nudge|poll] [--consumer <id>] [--generation <number>] [--full] [--json]",
  "orchestrate-read": "orchestrate read <dispatch-id-or-suffix> [--lines <count>] [--operator] [--json]",
  "orchestrate-transcript": "orchestrate transcript <dispatch-id-or-suffix> [--since <cursor>] [--limit <n>] [--operator] [--json] | --session <agent:id> [--since <cursor>] [--limit <n>] [--json]",
  "orchestrate-ack": "orchestrate ack <dispatch-id-or-suffix> <delivery-id> [--consumer <id>] [--generation <number>] [--close] [--operator] [--json]",
  "orchestrate-queue": "orchestrate queue [<dispatch-id-or-suffix>] [--all] [--operator] [--json]",
  "orchestrate-queue-cancel": "orchestrate queue cancel <item-id> [--reason <text>] [--operator] [--json]",
  "orchestrate-reply": "orchestrate reply <dispatch-id-or-suffix> --text <answer> [--supersede] [--operator] [--json]",
  "orchestrate-stop": "orchestrate stop <dispatch-id-or-suffix> [--operator] [--json]",
  "orchestrate-change": "orchestrate change <dispatch-id-or-suffix> --text <text> [--idle-timeout <seconds>] [--attempts <n>] [--operator] [--json]",
  "supervise": "supervise [--status|--stop]",
  "settings": "settings [--json [--only <keys>]] | set terminal-engine native|tmux | get sidebar-folders|sidebar-state|shortcuts|hidden-sessions|usage-order|chat-summaries|knowledge|agents|agents-update|models|worktree-location|device-idle-minutes | set sidebar-folders|sidebar-state|shortcuts|hidden-sessions|usage-order|chat-summaries|knowledge|agents|agents-update|models|worktree-location|device-idle-minutes <json> | get project-appearance [--json] | set project-appearance <repo path> [--name <text>|--no-name] [--color <#rrggbb>|--no-color] [--picture <image file>|--no-picture] [--json]",
  "chat": "chat list --json | start --agent <claude|codex> --cwd <path> [--model <model>] [--effort <level>] [--approvals] [--parts <json>] --json | send <id> --parts <json> [--fresh] [--json] | queue list|add|edit|move|remove|clear|send-now|steer <id> [<item>] [--parts <json>] [--to <index>] --json | interrupt <id> | approve <id> <approvalId> --decision allow|allow-session|deny | stop <id> | remove <id> [--json] | events <id> [--since <cursor>] [--follow] --json | artifacts <chat-id> --json | artifact <chat-id> <artifact-id> --json | model <id> <model> [--effort <level>] [--json] | mode <id> chat|terminal --json | terminal-command <id> --json | daemon status|drain [--json] | rename <id> <title> [--json] | summarize <id> [--json] | summaries <id> --json | search <text> --json",
  "chat-artifacts": "chat artifacts <chat-id> --json",
  "chat-artifact": "chat artifact <chat-id> <artifact-id> [--revision <n>] --json",
  "knowledge": "knowledge list [--repo <name|path>] --json | show <topic-id> --json | search <text> [--repo <name|path>] [--limit <n>] --json | transcript <chat-id> --json | topic-for --cwd <path> [--json] | context --cwd <path> [--json] | scan [--repo <name|path>] [--since <ISO date|Nd>] [--limit <n>] [--dry-run] [--json] | backfill [--json] | repair-refs [--repo <path>] [--dry-run] [--json] | rename <topic-id> <title> [--json] | kind <topic-id> <kind> [--json] | status <topic-id> <status> [--json] | merge <topic-id> <into-topic-id> [--json] | move-chat <chat-id> <topic-id> [--json]",
  "summaries": "summaries list [--repo <name|path>] [--branch <branch>] [--limit <n per branch>] --json | search <text> [--repo <name|path>] [--branch <branch>] [--limit <n>] --json | show <id> --json | context --cwd <path> [--limit <n>] [--json]",
  "artifact": "artifact guide|new|create|update|list|show|remove ...",
  "artifact-guide": "artifact guide [--kind diagram|plan|doc] [--json]",
  "artifact-new": "artifact new <title> --kind diagram|plan|doc [--project <repo path>] [--chat <id>] [--json]",
  "artifact-create": "artifact create --title <title> --kind diagram|plan|doc (--file <path>|--stdin) [--project <repo path>] [--topic <id>]... [--chat <id>] [--theme megabrain] [--json]",
  "artifact-update": "artifact update <id> (--file <path>|--stdin) [--title <title>] [--theme megabrain] [--json]",
  "artifact-list": "artifact list [--project <repo path>] [--topic <id>] [--chat <id>] [--json]",
  "artifact-show": "artifact show <id> [--revision <n>] [--json]",
  "artifact-remove": "artifact remove <id> [--json]",
  "status": "status [--json]",
  "resources": "resources [--json|--all] | enable|disable|status | policy show|set [--max-agents N] [--min-available-mib M] [--max-pressure normal|elevated] [--max-container-suites N] | off",
  "proc": "proc start|run|list|status|stop|restart|logs ...",
  "proc-start": "proc start --name <n> [--worktree <path>] [--cwd <dir>] [--port <p>] [--env K=V] [--terminal name|auto|none] [--shell <string>] [--admission wait|fail] [--needs docker] [--slot container-suite] [--json] -- <command and arguments>",
  "proc-run": "proc run --name <n> [--worktree <path>] [--cwd <dir>] [--env K=V] [--shell <string>] [--admission wait|fail] [--needs docker] [--slot container-suite] -- <command and arguments>",
  "proc-list": "proc list [--json]",
  "proc-status": "proc status <name> [--json] [--force]",
  "proc-stop": "proc stop <name> [--force]",
  "proc-restart": "proc restart <name> [--force]",
  "proc-logs": "proc logs <name> [--tail N] [--since 5m|ISO] [--grep <regex>] [--errors] [--full] [--follow] [--json]",
  "orchestrate-close": "orchestrate close <dispatch-id-or-suffix> [--force-release] [--operator] [--json]",
  "ask": "ask \"question\" | megabrain ask --text \"question\"",
  "done": "done \"summary\" | megabrain done --text \"summary\"",
  "received": "received",
  "check": "check [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode poll] [--consumer <id>] [--generation <number>] [--full] [--json]",
  "ack": "ack <delivery-id> [--consumer <id>] [--generation <number>] [--json]",
  "chain": "chain list|limits|add|save|edit|delete|run|repair|explain|step ...",
  "chain-list": "chain list [--json]",
  "chain-limits": "chain limits [--json] [--enable <providers>] [--disable <providers>] [--notice-on|--notice-off] [--notice-interval <seconds>]",
  "chain-add": "chain add <name> --when <json> --steps <json> [--priority <n>] [--dry-run] [--step <json>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--allow-unknown-model] [--json]",
  "chain-save": "chain save <name> --when <json> --steps <json> [--priority <n>] [--dry-run] [--allow-unknown-model] [--json]",
  "chain-explain": "chain explain [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--repo <name|path>] [--branch <branch>] [--label <text>] [--json]",
  "chain-step": "chain step edit <name> <n> [--agent <id>] [--model <id>] [--effort <level>] [--until <json>|--no-until] [--when <json>|--no-when] [--json] | chain step move <name> <from> <to> [--json]",
  "chain-edit": "chain edit <name> [--allow-unknown-model] [--json]",
  "chain-delete": "chain delete <name> [--json]",
  "chain-repair": "chain repair <name> --step <number> --model <id> [--effort <level>] [--json]",
  "chain-run": "chain run [name] [--chain <name>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--repo <name|path>] [--branch <branch>] [--base <ref>] [--name <slug>] [--worktree <path>] [--prompt <text>] [--label <text>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json]",
  "model": "model list|add|refresh ...",
  "model-list": "model list [--json]",
  "model-add": "model add <agent> <model> --reasoning <levels>",
  "model-refresh": "model refresh <agent>",
  "native-appium": "native appium start|stop|status",
  "native-input": "native input start|status|stop|tap|swipe|scroll|type|key|button|frame <udid> ... [--wait] [--timeout seconds] [--json]",
  "native-sim-list": "native sim list <phone|tv> [--json]",
  "native-runtime-list": "native runtime list [<ios|tvos>] (--installed|--available) [--json]",
  "native-runtime-install": "native runtime install <ios|tvos> <version> [--json]",
  "native-sim-ensure": "native sim ensure <phone|tv> [--device <name-or-udid>] [--worktree <path>] [--timeout <seconds>] [--json]",
  "native-sim-claim": "native sim claim <udid> --worktree <path> [--json]",
  "native-sim-release": "native sim release <udid> [--json]",
  "native-sim-rename": "native sim rename <udid> <name> [--json]",
  "native-sim-idle": "native sim idle [--sweep [--all]] [--touch] [--json]",
  "native-sim-screenshot": "native sim screenshot <udid> [--json]",
  "native-sim-shutdown": "native sim shutdown <udid> [--json]",
  "native-sim-restart": "native sim restart <udid> [--timeout <seconds>] [--json]",
  "native-app-reload": "native app reload <phone|tv> [--route <r>] [--bundle-id <id>] [--url-template <tpl>] [--device <name-or-udid>] [--metro-port <p>] [--timeout <s>] [--json]",
  "native-health": "native health <phone|tv> [--bundle-id <id>] [--device <name-or-udid>] [--metro-port <p>] [--control-frame <path>] [--json]",
  "native-crashes": "native crashes <phone|tv> [--last N] [--json]",
  "native-build": "native build <phone|tv> [--runtime <version>] [--device <name-or-udid>] [--json]",
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

const ADDITIONAL_USAGE_LINES = {
  "native-eval": "native eval <phone|tv> <expression> [--metro-port <p>] [--timeout <s>] [--json]",
  "native-navigate": "native navigate <phone|tv> <path> [--metro-port <p>] [--timeout <s>] [--json]",
  "native-capture": "native capture <phone|tv> (--screens FILE | --screen NAME --route PATH) [--output-root DIR] [--surface NAME] [--capture-id ID] [--theme NAME] [--viewport NAME] [--device <name-or-udid>] [--bundle-id ID] [--metro-port <p>] [--timeout <s>] [--stable-window <seconds>] [--json]",
  "native-capture-summary": "native capture <phone|tv> (--screens FILE | --screen NAME --route PATH) [options]",
  "web-error-viewport-set": "web-viewport-set",
  "web-error-devices": "web-devices",
  "web-error-session": "web-session",
  "web-error-userscript-list": "web-userscript-list",
  "web-error-userscript-action": "web-userscript-{action}",
  "web-error-viewport-action": "web-viewport-{action}",
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

export function usageActionMessage(key: "web-error-viewport-action" | "web-error-userscript-action", action: string): string {
  return `Usage: megabrain ${usageLine(key).replace("{action}", action)}`;
}

export function childMessageErrorUsage(type: "ask" | "done"): string {
  return usageText(type);
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
  install [options]                    Configure agents, skills, and modules
  doctor [module-id]                   Check one module or all modules
  db check [--json]                    Check SQLite integrity and foreign keys
  db backup [--json]                   Create and rotate a SQLite backup
  db import <dir> [--replace] [--json] Import JSON state into SQLite
  db migrate [--dry-run] [--json]      Migrate and seal legacy JSON state
  db show <dispatch-id-or-suffix>|--terminal <id>|--install-state|--models|--delivery-channels|--tmux-session <name> [--json] Show stored records
  context [--json]                     Detect the current orchestration host
  agent update [<id|all>] [--check]     Check versions or update installed agents
  send --session <agent:id> --text ...  Send a message to any agent session as the operator
  repo list|add|clone|remove|scripts|github|discover ... Manage the local project registry
  projects [--json]                     List projects, worktrees, and agent sessions
  usage stats [--days <n>] [--provider <id>] [--json] Token usage per day and provider from the agents' logs
  port who|free|kill ...                Find, free and stop port listeners
  github prs|issues|pr|issue|pr-files|pr-file|review|comment|issue-state|pr-state|threads|thread-reply|thread-resolve|reviewers|request-review|pr-ready|auto-merge|rerun-checks|file-viewed|assignable|image ... Read, review and manage GitHub pull requests and issues
  code open <root> [--json] | goto <root> <path> [--line N] [--json] | stop <root> [--json] Open Code for a project
  worktree create ...                  Create a shared Orca/Superset worktree (--from <ref>)
  worktree finish ...                  Finish a shared worktree
  worktree archive|archived|unarchive  Put a branch away (folder removed, branch kept) and bring it back
  worktree list [--repo <name|path>]   List shared-root worktrees with registry metadata
  worktree adopt <path|branch>         Register an existing worktree in Superset
  worktree prune ...                   Prune old, safe worktrees (dry-run unless --yes)
  stack create|show|pr|sync|merge ... Manage dependent branches and pull or merge requests
  terminal create ...                  Open a terminal in the current orchestrator
  terminal list [--worktree <path>]    List terminals created by megabrain
  terminal open --session <name> ...   Open a native terminal window attached to a tmux session
  terminal default [<name>|--clear]    Show or set the default native terminal
  terminal restart <selector> ...      Restart a terminal created by megabrain
  terminal close <selector> ...        Close a terminal created by megabrain
  orchestrate spawn ...                Create a worktree and start an agent (--browser opts into browser MCP)
  orchestrate list [--all|--orphans|--uncertain] [--archived] [--json]  List managed dispatches
  orchestrate prune ...                Archive or delete old terminal dispatches
  orchestrate reconcile <dispatch-id-or-suffix>  Reconcile an open dispatch without respawning
  orchestrate liveness <dispatch-id-or-suffix>     Read execution state from a dispatch terminal
  orchestrate watch <dispatch-id-or-suffix> ...  Watch a dispatch file channel for child messages
  orchestrate queue [<dispatch-id-or-suffix>] ... List queued messages (--all includes closed dispatches)
  orchestrate read <dispatch-id-or-suffix> ...   Read a tmux dispatch pane
  orchestrate transcript ...              Read ordered agent conversation events
  orchestrate ack <dispatch-id-or-suffix> ...    Acknowledge a delivery batch
  orchestrate reply <dispatch-id-or-suffix> ...  Queue and safely deliver a reply (--supersede replaces old replies)
  orchestrate stop <dispatch-id-or-suffix> ...   Interrupt a working child without closing its pane
  orchestrate change <dispatch-id-or-suffix> ... Replace queued direction and interrupt the child
  orchestrate close <dispatch-id-or-suffix> ...  Close a Superset dispatch terminal
  supervise [--status|--stop]           Inspect or stop the open-dispatch watcher
  settings [--json [--only <keys>]]    Read the settings shown in the desktop app, or only some keys
  settings set terminal-engine ...     Choose the embedded terminal engine
  settings get|set sidebar-folders     Read or replace the desktop sidebar's project folders
  settings get|set sidebar-state       Read or replace what the desktop sidebar folded and its row order
  settings get|set hidden-sessions     Read or replace the sessions the desktop sidebar closed
  settings get|set usage-order         Read or replace the order and hidden providers of the desktop usage readout
  settings get|set chat-summaries      Read or replace the chat summary switch, model, cadence and automatic titles
  settings get|set knowledge           Read or replace which projects are summarised, curated into topics, scanned and given as agent context
  settings get|set agents              Read or replace the desktop app's default agent and the agents turned off
  settings get|set agents-update       Read or replace automatic agent update policy
  settings get|set worktree-location   Read or replace where new worktrees are created (megabrain, repo or custom folder)
  settings get|set device-idle-minutes Read or replace the minutes before a simulator megabrain booted goes to sleep (0 = never)
  settings get|set shortcuts           Read or replace the desktop app's changed shortcut keys
  settings get|set project-appearance  Read or change a project's name, color and picture (megabrain only)
  resources [--json|--all]               Measure machine and open-dispatch resources
  proc start|list|status|stop|restart|logs ...  Run and inspect managed processes
  chain list|limits|add|save|edit|delete|run|explain|step ...  Manage ordered child-agent chains
  model list|add|refresh ...            Manage the versioned model registry
  web [--device ...]|viewport|devices|userscript|capture|measure|session-save ...  Configure browser and visual parity workflows
  ask "question"                       Ask the coordinator and use its native delivery path
  done "summary"                        Report completion through the native delivery path
  check [options]                       Check for replies from the direct coordinator
  ack <delivery-id> [options]          Acknowledge a child reply delivery
  received                            Confirm receipt of a dispatch prompt
  native sim list <phone|tv> ...       List available Apple simulators
  native runtime list ...              List installed or known Apple runtimes
  native runtime install ...           Install an Apple simulator runtime
  native appium start|stop|status      Manage the shared Appium server
  native build <phone|tv> ...          Build, install and launch a native app
  native sim ensure <phone|tv> ...     Boot a requested Apple simulator
  native sim screenshot <udid> ...     Capture a booted simulator's screen
  native app reload <phone|tv> ...     Terminate and deep-link an app
  native health <phone|tv> ...         Check whether an app is rendering
  tv connect <ip> [--port <port>]      Connect an Android TV over adb
  tv disconnect [<ip>]                 Disconnect an Android TV
  tmux tune [--yes|--dry-run|--revert] Tune global tmux configuration
  tmux wrapper [--yes|--dry-run|--revert] Install the agent tmux wrapper
`;
