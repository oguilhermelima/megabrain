# megabrain recipes

- Read shared worktree, orchestration, simulator, and browser instructions at https://github.com/oguilhermelima/megabrain/blob/main/AGENTS.md.
- Run megabrain install [module-id] [--agents claude,codex,agy,grok|none] [--skill none|global|project] [--modules list|all|none] [--tmux yes|no] [--yes] [--browser chromium|firefox|both] [--revert] [--plan] [--json]. — recommended when you need to configure megabrain for an agent or install, update, or remove its modules and skills.
- Run megabrain doctor [module-id] [--json]. — recommended when you need to check whether a module or the whole installation is healthy.
- Run megabrain db check [--json]. — recommended when you need to check SQLite integrity, foreign keys, schema version, and database path.
- Run megabrain db backup [--json]. — recommended when you need to create a consistent backup before a risky database operation.
- Run megabrain db import <dir> [--replace] [--json]. — recommended when you need to import a legacy state directory into the SQLite database.
- Run megabrain db migrate [--dry-run] [--json]. — recommended when you need to preview or perform the one-time legacy JSON migration.
- Run megabrain db show <dispatch-id-or-suffix>|--terminal <id>|--install-state|--models|--delivery-channels|--tmux-session <name> [--json]. — recommended when you need to inspect a dispatch record, message history, or another stored record.
- Run megabrain context [--json]. — recommended when you need to identify the orchestration host and runtime available in this session.
- Run megabrain worktree create --repo <name|path> --branch <branch> [--from <ref>] [--base <ref>] [--parent <branch:branch|path:path>] [--no-parent] [--issue <number>] [--linear-issue <identifier-or-url>] [--pr <number>] [--name <slug>] [--agent <id>] [--model <id>] [--effort <level>] [--prompt <text>] [--label <text>] [--tmux true|false] [--json]. — recommended when you need to create and register a shared worktree for a task.
- Run megabrain worktree pr <branch|path|slug> [--base <ref>] [--title <text>] [--body <text>] [--json]. — recommended when you need to open a pull request for a worktree branch.
- Run megabrain stack create <branch> --on <parent> [--repo <path>] | show|pr [--draft]|sync|merge [--yes] [--provider github|gitlab]. — recommended when you need to manage dependent branches and pull or merge requests.
- Run megabrain worktree finish <branch|path|slug> [--delete-branch] [--base <ref>] [--force] [--json]. — recommended when you need to remove a completed worktree after its safety checks pass.
- Run megabrain worktree list [--repo <name|path>] [--tree|--flat] [--json]. — recommended when you need to find registered worktrees and inspect their parent relationships.
- Run megabrain worktree adopt <path|branch> [--json]. — recommended when you need to register an existing worktree missing from one orchestrator.
- Run megabrain worktree prune [--older-than <days>] [--repo <name|path>] [--dry-run] [--yes] [--json]. — recommended when you need to review or remove old worktrees safely.
- Run megabrain repo list|add|clone|remove|github .... — recommended when you need to manage megabrain's local project registry.
- Run megabrain repo list [--json]. — recommended when you need to list registered repositories.
- Run megabrain repo add <path> [--json]. — recommended when you need to import a local Git checkout.
- Run megabrain repo clone <url> --into <dir> [--json]. — recommended when you need to clone and register a GitHub repository.
- Run megabrain repo remove <name|path> [--json]. — recommended when you need to remove a repository from the registry without deleting files.
- Run megabrain repo github [--owner <login>] [--json]. — recommended when you need to browse repositories available through GitHub CLI.
- Run megabrain projects [--json]. — recommended when you need to list registered projects, their Git worktrees, and agent sessions.
- Run megabrain terminal create [--worktree <path>] [--command <cmd>] [--title <text>] [--port <port>] [--terminal <name>|auto|none] [--json]. — recommended when you need to open a managed terminal in a worktree: a tab in Orca or Superset when the session runs there, otherwise a tmux window.
- Run megabrain terminal list [--worktree <path>] [--json]. — recommended when you need to find managed terminals and check whether they are alive.
- Run megabrain terminal open --session <tmux session> [--terminal <name>|auto|none] [--server <tmux -L name>] [--json]. — recommended when you need to open a native terminal window attached to an existing tmux session, or print the attach command.
- Run megabrain terminal default [<name>|auto|none|--clear]. — recommended when you need to show, set or clear the default native terminal.
- Run megabrain terminal restart <selector> [--command <cmd>] [--wait-port <port>] [--timeout <seconds>] [--json]. — recommended when you need to restart a managed terminal after its command or server needs a fresh run.
- Run megabrain terminal close <selector> [--json]. — recommended when you need to close a managed terminal and remove its local record.
- Run megabrain orchestrate spawn --repo <name|path> --branch <branch> [--agent <id>] [--chain <name>] [--model <id>] [--base <ref>] [--name <slug>] [--effort <level>] [--prompt <text>] [--label <text>] [--worktree <path>] [--tmux true|false] [--terminal <name>|auto|none] [--admission wait|fail] [--browser] [--context-ceiling <N%|Nk>] [--compact-at <N%|Nk>] [--loop] [--max-iterations <n>] [--agent-arg <flag>] [--json]. — recommended when you need to start a child agent with context limits or a bounded loop.
- Run megabrain orchestrate policy <dispatch-id-or-suffix> [--context-ceiling <N%|Nk>] [--compact-at <N%|Nk>] [--loop|--no-loop] [--max-iterations <n>] [--operator] [--json]. — recommended when you need to change context policies on an active dispatch.
- Run megabrain orchestrate list [--mine|--all|--orphans|--uncertain] [--archived] [--json]. — recommended when you need to find active, archived, orphaned, or uncertain dispatches.
- Run megabrain orchestrate adopt <dispatch-id-or-suffix> [--force] [--json]. — recommended when you need to take ownership of an existing dispatch in this coordinator session.
- Run megabrain orchestrate prune [--older-than <days>] [--state <list>] [--archive|--delete] [--dry-run] [--json]. — recommended when you need to archive or delete old terminal dispatch records.
- Run megabrain orchestrate reconcile <dispatch-id-or-suffix> [--all] [--operator] [--json]. — recommended when you need to refresh a dispatch record from its terminal without starting it again.
- Run megabrain orchestrate liveness <dispatch-id-or-suffix> [--operator] [--json]. — recommended when you need to check the child terminal execution state without waiting for a message.
- Run megabrain orchestrate watch <dispatch-id-or-suffix> [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode nudge|poll] [--consumer <id>] [--generation <number>] [--full] [--json]. — recommended when you need to wait for or retrieve a child message delivery that can be replayed until acknowledged.
- Run megabrain orchestrate queue [<dispatch-id-or-suffix>] [--all] [--operator] [--json]. — recommended when you need to list your queued messages, including closed dispatches with --all.
- Run megabrain orchestrate queue cancel <item-id> [--reason <text>] [--operator] [--json]. — recommended when you need to cancel one of your queued messages.
- Run megabrain orchestrate read <dispatch-id-or-suffix> [--lines <count>] [--operator] [--json]. — recommended when you need to inspect the child terminal transcript or scrollback to see what it actually did.
- Run megabrain orchestrate transcript <dispatch-id-or-suffix> [--since <cursor>] [--limit <n>] [--operator] [--json] | --session <agent:id> [--since <cursor>] [--limit <n>] [--json]. — recommended when you need the ordered chat events from an agent's session log.
- Run megabrain orchestrate ack <dispatch-id-or-suffix> <delivery-id> [--consumer <id>] [--generation <number>] [--close] [--operator] [--json]. — recommended when you need to mark a child message delivery as handled, optionally closing a finished dispatch.
- Run megabrain orchestrate reply <dispatch-id-or-suffix> --text <answer> [--supersede] [--operator] [--json]. — recommended when you need to send an answer to a child that has asked a question.
- Run megabrain orchestrate stop <dispatch-id-or-suffix> [--operator] [--json]. — recommended when you need to interrupt a working child while keeping its pane and dispatch open.
- Run megabrain orchestrate change <dispatch-id-or-suffix> --text <text> [--idle-timeout <seconds>] [--attempts <n>] [--operator] [--json]. — recommended when you need to redirect a child that is working on the wrong thing or replace queued directions.
- Run megabrain orchestrate close <dispatch-id-or-suffix> [--force-release] [--operator] [--json]. — recommended when you need to release a finished dispatch and its pane after reading the child output.
- Run megabrain supervise [--status|--stop]. — recommended when you need to check, or stop, the watcher that reports stuck or dead children to their parent.
- Run megabrain status [--json]. — recommended when you need to see the watcher, every open dispatch with its supervisor finding, the queue, managed processes, machine load and delivery channels in one call.
- Run megabrain settings [--json]. — recommended when you need one read of the settings shown in the desktop app.
- Run megabrain resources [--json|--all] | enable|disable|status | policy show|set [--max-agents N] [--min-available-mib M] [--max-pressure normal|elevated] [--max-container-suites N] | off. — recommended when you need to inspect machine and dispatch resource usage or manage opt-in history.
- Run megabrain proc start|run|list|status|stop|restart|logs .... — recommended when you need to start, inspect, stop, restart, or read logs for a managed process.
- Run megabrain proc start --name <n> [--worktree <path>] [--cwd <dir>] [--port <p>] [--env K=V] [--terminal name|auto|none] [--shell <string>] [--admission wait|fail] [--needs docker] [--slot container-suite] [--json] -- <command and arguments>. — recommended when you need to start a command in a managed tmux session.
- Run megabrain proc run --name <n> [--worktree <path>] [--cwd <dir>] [--env K=V] [--shell <string>] [--admission wait|fail] [--needs docker] [--slot container-suite] -- <command and arguments>. — recommended when you need to run a command in the foreground under admission, a container suite slot, or a docker hold.
- Run megabrain proc list [--json]. — recommended when you need to list managed processes.
- Run megabrain proc status <name> [--json] [--force]. — recommended when you need to inspect a managed process.
- Run megabrain proc stop <name> [--force]. — recommended when you need to stop a managed process.
- Run megabrain proc restart <name> [--force]. — recommended when you need to restart a managed process.
- Run megabrain proc logs <name> [--tail N] [--since 5m|ISO] [--grep <regex>] [--errors] [--full] [--follow] [--json]. — recommended when you need to read managed process logs.
- Run megabrain ask "question" | megabrain ask --text "question". — recommended when you need to ask the coordinator for a decision that affects the work.
- Run megabrain done "summary" | megabrain done --text "summary". — recommended when you need to report the completed work and what was verified to the coordinator.
- Run megabrain received. Do this before starting work; prompt delivery depends on this receipt.
- Run megabrain check [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode poll] [--consumer <id>] [--generation <number>] [--full] [--json]. — recommended when you need to poll for a reply from the coordinator after asking a question.
- Run megabrain ack <delivery-id> [--consumer <id>] [--generation <number>] [--json]. — recommended when you need to acknowledge a reply delivery after acting on it.
- Run megabrain chain list [--json]. — recommended when you need to inspect the configured agent-selection chains.
- Run megabrain chain limits [--json] [--enable <providers>] [--disable <providers>] [--notice-on|--notice-off] [--notice-interval <seconds>]. — recommended when you need to inspect or change provider usage-limit settings and notices.
- Run megabrain chain add <name> --when <json> --steps <json> [--step <json>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--allow-unknown-model] [--json]. — recommended when you need to define a chain with matching rules and ordered agent steps.
- Run megabrain chain save <name> --when <json> --steps <json> [--allow-unknown-model] [--json]. — recommended when you need to create or replace a chain without opening an editor.
- Run megabrain chain edit <name> [--allow-unknown-model] [--json]. — recommended when you need to change an existing chain configuration.
- Run megabrain chain delete <name> [--json]. — recommended when you need to remove a chain that is no longer used.
- Run megabrain chain repair <name> --step <number> --model <id> [--effort <level>] [--json]. — recommended when you need to replace a broken or unavailable model in a chain step.
- Run megabrain chain run [name] [--chain <name>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--repo <name|path>] [--branch <branch>] [--base <ref>] [--name <slug>] [--worktree <path>] [--prompt <text>] [--label <text>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json]. — recommended when you need to launch work through a named or automatically selected fallback chain.
- Run megabrain model list [--json]. — recommended when you need to inspect models available to agent selection.
- Run megabrain model add <agent> <model> --reasoning <levels>. — recommended when you need to add a model and its supported reasoning levels to the registry.
- Run megabrain model refresh <agent>. — recommended when you need to refresh one agent provider’s model registry.
- Run megabrain native appium start.
- Run megabrain native appium status.
- Run megabrain native appium stop.
- Run megabrain native sim list <phone|tv> [--json]. — recommended when you need to find available iOS or tvOS simulators.
- Run megabrain native sim ensure <phone|tv> [--device <name-or-udid>] [--timeout <seconds>] [--json]. — recommended when you need to boot and prepare the requested Apple simulator.
- Run megabrain native runtime list [<ios|tvos>] (--installed|--available) [--json]. — recommended when you need to check which Apple simulator runtimes are installed or available.
- Run megabrain native runtime install <ios|tvos> <version> [--json]. — recommended when you need to install an Apple simulator runtime needed by a device.
- Run megabrain native health <phone|tv> [--bundle-id <id>] [--device <name-or-udid>] [--metro-port <p>] [--control-frame <path>] [--json]. — recommended when you need to verify that the native app is rendering on its simulator.
- Run megabrain native navigate <phone|tv> <path> [--metro-port <p>] [--timeout <s>] [--json]. — recommended when you need to open a specific route in the running native app.
- Run megabrain native eval <phone|tv> <expression> [--metro-port <p>] [--timeout <s>] [--json]. — recommended when you need to read native app state through Metro.
- Run megabrain native crashes <phone|tv> [--last N] [--json]. — recommended when you need to inspect recent native app crash reports.
- Run megabrain native build <phone|tv> [--runtime <version>] [--device <name-or-udid>] [--json]. — recommended when you need to build, install, and launch the configured native app.
- Run megabrain native capture <phone|tv> (--screens FILE | --screen NAME --route PATH) [--output-root DIR] [--surface NAME] [--capture-id ID] [--theme NAME] [--viewport NAME] [--device <name-or-udid>] [--bundle-id ID] [--metro-port <p>] [--timeout <s>] [--stable-window <seconds>] [--json]. — recommended when you need stable screenshots of one or more native simulator routes and a capture manifest.
- Run megabrain native app reload <phone|tv> [--route <r>] [--bundle-id <id>] [--url-template <tpl>] [--device <name-or-udid>] [--metro-port <p>] [--timeout <s>] [--json]. — recommended when you need to restart a native app and navigate it to a route.
- Run megabrain tv connect <ip> [--port <port>]. — recommended when you need to connect an Android TV device over adb.
- Run megabrain tv disconnect [<ip>]. — recommended when you need to disconnect an Android TV device from adb.
- Run megabrain tmux tune [--yes] [--dry-run] [--revert] [--json]. — recommended when you need to apply or remove the native tmux theme and agent badges.
- Run megabrain tmux wrapper [--yes] [--dry-run] [--revert] [--json]. — recommended when you need to install or remove the shell wrapper for hand-typed agent commands.
- Run megabrain web [--device SLUG|--category NAME|--viewport WxH] .... — recommended when you need to see browser viewport and visual-testing operations.
- Run megabrain web viewport set|show|devices .... — recommended when you need to set viewport dimensions, inspect settings, or manage device presets.
- Run megabrain web viewport set [--browser chromium|firefox|both] [--viewport WxH|--device SLUG|--category NAME|--width W --height H] [--orientation portrait|landscape]. — recommended when you need to set the browser viewport or device emulation for visual checks.
- Run megabrain web devices list [FILTER] [--orientation portrait|landscape|all] | add SLUG --viewport WxH --source SOURCE [options] | remove SLUG. — recommended when you need to list, add, or remove named viewport device presets.
- Run megabrain web capture --url URL --screen NAME [--settle default|scroll] [--scroll-timeout MS] [options]. — recommended when you need to capture a browser screenshot after the page reaches the requested state.
- Run megabrain web measure --url URL --screen NAME [--settle default|scroll] [--scroll-timeout MS] [options]. — recommended when you need to measure browser element geometry and computed styles.
- Run megabrain web session save --url URL --output FILE [options]. — recommended when you need to save a headful browser session for a workflow that needs a signed-in profile.
- Run megabrain web viewport show [--browser chromium|firefox|both]. — recommended when you need to inspect the current browser viewport settings.
- Run megabrain web userscript install|list|remove .... — recommended when you need to install, list, or remove userscripts in the Chromium profile.
- Run megabrain web userscript install <file.user.js> [--viewport WxH|--device SLUG|--category NAME] [--orientation portrait|landscape]. — recommended when you need to install a userscript in the Chromium browser profile.
- Run megabrain web userscript list. — recommended when you need to inspect userscripts installed in the Chromium profile.
- Run megabrain web userscript remove <file.user.js> [--viewport WxH|--device SLUG|--category NAME] [--orientation portrait|landscape]. — recommended when you need to remove a userscript from the Chromium profile.

## State database

Dispatches and other runtime state live in `$MEGABRAIN_STATE_DIR/megabrain.db` (default
`~/.megabrain/megabrain.db`). Use `megabrain db show` to inspect records, `db check` for integrity
and foreign keys, `db backup` for a consistent backup, `db migrate --dry-run --json` to preview a
legacy JSON cutover, and `db import <dir>` for an explicit import. The first non-`db` command
imports legacy state, verifies parity, moves transcripts to
`~/.megabrain/transcripts/<dispatch-id>.txt`, and seals the remaining tree under
`~/.megabrain/legacy/json-<UTC>/`. A fresh state with no legacy JSON has no snapshot. For rollback,
restore the snapshot and run the previous binary; database changes made after cutover are lost.
Tests must export `MEGABRAIN_STATE_DIR` to an isolated temporary directory before any megabrain call.
