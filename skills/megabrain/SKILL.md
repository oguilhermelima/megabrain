---
name: megabrain
description: >-
  Use megabrain to delegate work to other coding agents and supervise them, to create Git
  worktrees that Orca and Superset.sh both see, to open agent terminals, to read agent usage
  limits and pick a provider, and to drive iOS and tvOS simulators, Android TV over adb, and
  Playwright MCP browser testing. Use when the user asks to hand work to another agent,
  parallelize across agents, spawn or supervise a worker, check on a dispatch, create or finish
  a shared worktree, or set up simulator or browser testing. Also use when a chat needs to
  answer a question from an agent it started.
---

# megabrain

One command surface for delegating to other coding agents and for the worktrees, terminals and
device setups that work needs. Run `megabrain <command> --help` for the exact flags of any
command; the help output is the authority, and the lines below are shortened for reading.

## Database integrity

```
megabrain db check [--json] — recommended when you need to check SQLite integrity, foreign keys, schema version, and database path.
megabrain db backup [--json] — recommended when you need to create a consistent backup before a risky database operation.
megabrain db import <dir> [--replace] [--json] — recommended when you need to import a legacy state directory into the SQLite database.
megabrain db migrate [--dry-run] [--json] — recommended when you need to preview or perform the one-time legacy JSON migration.
megabrain db show <dispatch-id-or-suffix>|--terminal <id>|--install-state|--models|--tmux-session <name> [--json] — recommended when you need to inspect a dispatch record, message history, or another stored record.
```

`db check` reports SQLite integrity, foreign key violations, the schema version, and the state
database path. `db backup` writes a consistent SQLite backup under the state directory and keeps
the newest seven backups. `db migrate --dry-run --json` previews legacy JSON import and parity
without changing the state directory; `db migrate --json` runs it and refuses when the cutover
marker already exists. `db show` reads dispatches and auxiliary records from SQLite.

## Worktree registry and prune

`worktree list` shows each worktree's age, purpose, origin, and whether megabrain created it.
Create with `--label <text>` to record a purpose; otherwise the first line of `--prompt` is used.
Older worktrees without a registry entry appear as discovered with unknown age.
Repo names provided during create and inferred during adopt are available to resolve later
`--repo` selectors when Orca is unavailable or its lookup fails.

```
megabrain worktree prune [--older-than <days>] [--repo <name|path>] [--dry-run] [--yes] [--json] — recommended when you need to review or remove old worktrees safely.
```

Prune defaults to a dry run. It reports each candidate's age, disk size, purpose, and reason.
Only old, clean worktrees with no open dispatch, no unpushed commits, and a branch merged into a
known base are eligible. Unknown status is kept. Add `--yes` to remove eligible worktrees and
their merged local branches through the normal finish flow.

## Delegating work to another agent

**Start here: `megabrain orchestrate spawn --prompt <brief> [--worktree <path>]`.** When no
`--agent` is supplied, spawn asks the chain module to choose the agent, model and effort. Chains
start empty, so add one with `megabrain chain add <name> ...` first. Use `chain run` as the
explicit chain runner when you want its ordered fallback across steps and usage-window checks.

```
megabrain orchestrate spawn --repo <name|path> --branch <branch> [--agent <id>] [--chain <name>] [--model <id>] [--base <ref>] [--name <slug>] [--effort <level>] [--prompt <text>] [--label <text>] [--worktree <path>] [--tmux true|false] [--terminal <name>|auto|none] [--browser] [--context-ceiling <N%|Nk>] [--compact-at <N%|Nk>] [--loop] [--max-iterations <n>] [--agent-arg <flag>] [--json] — recommended when you need to start a child agent on a new or existing worktree.
megabrain orchestrate policy <dispatch-id-or-suffix> [--context-ceiling <N%|Nk>] [--compact-at <N%|Nk>] [--loop|--no-loop] [--max-iterations <n>] [--json] — recommended when you need to change context policies on an active dispatch.
```

`--chain <name>` bypasses selector matching on both commands. An explicit `--agent` wins over
chain selection and works with no chain configured. Explicit `--model` and `--effort` override
those fields when the chain supplies the agent:

```
megabrain chain run [name] [--chain <name>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--repo <name|path>] [--branch <branch>] [--base <ref>] [--name <slug>] [--worktree <path>] [--prompt <text>] [--label <text>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json] — recommended when you need to launch work through a named or automatically selected fallback chain.
```

Either way: pass `--worktree <path>` to reuse a checkout that already exists, or `--repo` plus
`--branch` to have one created.

Every dispatch has a chat name: `--label` when supplied, otherwise its worktree branch. `orchestrate
list` shows the name, and `db show <dispatch-id-or-suffix>` includes `chatName`. tmux pane titles use
`agent · name` and set `@megabrain_agent`, `@megabrain_name`, and `@megabrain_state`; Orca tabs use
the same title, and Claude starts with `--name <chat name>`.

Typed and queued messages have three parts: `<icon> <agent> · <chat name> <status words>`, one
plain-language summary sentence of at most 140 characters, and a details pointer. The status words
are `finished`, `has a question`, `is stuck`, `reply`, and `new direction`, with icons ✅, ❓, ⚠️, 💬,
and 🔀. A parent-bound message points to `megabrain orchestrate watch <last-eight-id>`; a
child-bound message uses the coordinator's agent and chat name and points to `megabrain check` for
the full text. Orca receives all three parts on one line joined with ` — `.

The spawn preamble tells children to start `megabrain done` and `megabrain ask` with one
plain-language sentence: what changed or what they need. That sentence has no file names, commands,
or test counts; technical detail follows it.

The watch, read, ack, reply, stop, change, and close commands accept a unique dispatch ID suffix of
at least eight characters. They resolve within the dispatches owned by the current caller. An
ambiguous suffix lists the matching IDs. `db show` accepts the same minimum suffix length and
searches all dispatches, including archived ones.

A dispatch runs either as a tmux split or as a tab in the orchestrator that owns the session.
**Neither Orca nor Superset is required.** From a plain terminal the caller is local, identified by
its agent session or, with no agent, by its shell's tty; children run in tmux and `spawn` reports
`deliveryChannel: hook-and-watch`, because a local parent has no terminal to type into: mail waits
in the queue, the parent's Stop hook surfaces it, and `orchestrate watch` reads it. Inside tmux a
session identifies itself by its own session and pane, and the child pane is removed outright when
you close it. The orchestrators are only what an IDE-tab dispatch and shared worktrees need. `megabrain context` reports which of the three a session is in. Prompt budgets are 262144 bytes through argv and 12000 bytes
through tmux; over the limit is refused before anything is created, never truncated.

## Supervising what you started

```
megabrain orchestrate list [--mine|--all|--orphans|--uncertain] [--archived] [--json] — recommended when you need to find active, archived, orphaned, or uncertain dispatches.
megabrain orchestrate adopt <dispatch-id-or-suffix> [--force] [--json] — recommended when you need to take ownership of an existing dispatch in this coordinator session.
megabrain orchestrate liveness <dispatch-id-or-suffix> [--json] — recommended when you need to check the child terminal execution state without waiting for a message.
megabrain orchestrate watch <dispatch-id-or-suffix> [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode nudge|poll] [--consumer <id>] [--generation <number>] [--full] [--json] — recommended when you need to wait for or retrieve a child message delivery that can be replayed until acknowledged.
megabrain orchestrate ack <dispatch-id-or-suffix> <delivery-id> [--consumer <id>] [--generation <number>] [--close] [--json] — recommended when you need to mark a child message delivery as handled, optionally closing a finished dispatch.
megabrain orchestrate queue [<dispatch-id-or-suffix>] [--json] — recommended when you need to list queued messages you own.
megabrain orchestrate queue cancel <item-id> [--json] — recommended when you need to cancel a queued message you own.
megabrain orchestrate reply <dispatch-id-or-suffix> --text <answer> [--supersede] [--json] — recommended when you need to send an answer to a child that has asked a question.
megabrain orchestrate stop <dispatch-id-or-suffix> [--json] — recommended when you need to interrupt a working child while keeping its pane and dispatch open.
megabrain orchestrate change <dispatch-id-or-suffix> --text <text> [--idle-timeout <seconds>] [--attempts <n>] [--json] — recommended when you need to redirect a child that is working on the wrong thing or replace queued directions.
megabrain orchestrate read <dispatch-id-or-suffix> [--lines <count>] [--json] — recommended when you need to inspect the child terminal transcript or scrollback to see what it actually did.
megabrain orchestrate reconcile <dispatch-id-or-suffix> [--all] [--json] — recommended when you need to refresh a dispatch record from its terminal without starting it again.
megabrain orchestrate close <dispatch-id-or-suffix> [--force-release] [--json] — recommended when you need to release a finished dispatch and its pane after reading the child output.
megabrain supervise [--status|--stop] — recommended when you need to check, or stop, the watcher that reports stuck or dead children to their parent.
megabrain orchestrate prune [--older-than <days>] [--state <list>] [--archive|--delete] [--dry-run] [--json] — recommended when you need to archive or delete old terminal dispatch records.
```

`watch` returns a delivery that **replays until acked**, so nothing is lost if you read it and
do not act. Ack it once you have acted; acking twice is safe and reports `duplicate`.
When no delivery is available, watch and check report status `empty`; a timeout is not implied.

**Do not assume you will be told.** When a child runs `ask` or `done`, a live Codex parent receives
the full message through `codex queue`. Other messages use the parent's terminal only after the
agent is idle and the composer is empty. A busy terminal or foreign draft starts a detached retry
for up to ten minutes; it stops when `check` pulls the delivery or it is acknowledged. The queue
is the truth, and `db show` records whether delivery used `queue`, `typed`, `deferred`, or `failed`.
If you are waiting on a worker, use `watch` rather than relying on a terminal notice.

When your own turn ends, megabrain checks the dispatches you own and blocks once, one line per
message, for child mail whose delivery ended failed. That is what makes a missed pointer recover
instead of being lost, and it is why a notice can appear immediately after you finish
speaking. It stays quiet for a dispatch you already have a `watch` open on.

The same notice flags a dispatch in state `done` whose terminal is still retained. Use
`megabrain orchestrate ack <dispatch-id-or-suffix> <delivery-id> --close` when appropriate: it acknowledges
the delivery and releases the finished dispatch in one call.

Nothing removes a finished dispatch on its own. `prune` archives terminal ones past an
age threshold, and archives rather than deletes by default because a dispatch's message
queue is the record of what actually happened. It never touches a dispatch that is still
open, and a state it does not recognise counts as open.

Reading the dispatch record is not reading the message. A failure's `reason` field is the
symptom; the child's own message in the queue is usually the cause. Look at the messages before
concluding anything about a failed dispatch.

**Closing a finished dispatch is your job, not the child's.** When a child reports `done`, read
what it says, verify what you can, and then close it. Nothing closes it for you: the child cannot,
because it would be killing the pane it is running in, and `close` refuses that unconditionally.
A dispatch left open holds a pane and keeps appearing in `orchestrate list`.

Close after you have read the pane, not before. `orchestrate read` reads the terminal's own
scrollback, and closing destroys it: the queue keeps every message, but the transcript that shows
what the agent actually did is gone. A `done` is a claim, and the pane is where you check it.

```sh
megabrain orchestrate read <dispatch-id-or-suffix> [--lines <count>] [--json] — recommended when you need to inspect the child terminal transcript or scrollback to see what it actually did.
megabrain orchestrate close <dispatch-id-or-suffix> [--force-release] [--json] — recommended when you need to release a finished dispatch and its pane after reading the child output.
```

`close` refuses to close the pane it is running in, and `--force-release` does not override that.
Close only dispatches you started, one at a time. In tmux the pane is removed outright; Superset
leaves it visible as `Desconectado` until the human dismisses it with the pane X, because no CLI
verb removes it.

Every tmux dispatch starts a persisted transcript stream when its pane is spawned. `orchestrate
read` uses the live pane while available and falls back to that transcript after the pane is gone;
the response identifies the source. Closing and pruning stop the stream before releasing the
dispatch session. `orchestrate reply` rejects a settled dispatch with a non-zero status and asks
you to open a new dispatch rather than queueing an undeliverable message.

`orchestrate change` supersedes queued directions first, then interrupts a working child until its
composer is idle and stable (10 seconds per wait, up to three interrupts by default). It submits
only into an empty composer and clears a draft only when it matches the direction being sent. A
foreign draft is preserved; if delivery cannot happen now, a detached deliverer retries for up to
ten minutes. `--idle-timeout` changes each idle and confirmation wait, and `--attempts` sets a limit
from one to three. If the direction exceeds the 12000-byte tmux limit, the child receives a pointer
to `megabrain check`; the full text remains queued.

`megabrain supervise` is started by `orchestrate spawn` and watches every open dispatch from the
agent's own session records, never from silence. It sends the parent one message of type supervise per
finding (usage-limit, rate-limited, server-error, network, auth-required, dialog-waiting,
prompt-unsubmitted, prompt-lost, process-exited, pane-gone) with a recommended action, and only
auto-recovers an unsubmitted prompt. Spawn has no receipt deadline: the supervisor reads the first
prompt from the terminal (delivered-working, queued, delivered, unsubmitted, lost) and only unsubmitted
and lost are findings; a queued or working prompt is never one, however long it lasts. For a lost
prompt, resend the brief with `orchestrate reply`. Read it with `orchestrate watch`; `megabrain supervise --status` and `--stop`
inspect and end the watcher.

## If you are the child

```
megabrain received — recommended when you need to confirm that the dispatched prompt was received before starting work.
megabrain ask "question" | megabrain ask --text "question" — recommended when you need to ask the coordinator for a decision that affects the work.
megabrain check [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode poll] [--consumer <id>] [--generation <number>] [--full] [--json] — recommended when you need to poll for a reply from the coordinator after asking a question.
megabrain ack <delivery-id> [--consumer <id>] [--generation <number>] [--json] — recommended when you need to acknowledge a reply delivery after acting on it.
megabrain done "summary" | megabrain done --text "summary" — recommended when you need to report the completed work and what was verified to the coordinator.
```

`received` confirms prompt delivery by writing a durable message to the queue. The parent does not
wait for it, so send it before starting work, and the supervisor tells a busy child from a failed one
by its terminal. A
reply reaches you only if you look for it. `ask` queues the question and returns; it does not
block. Poll with
`check` and do not proceed on a default when the answer would change the work.
`done` is not optional: the task is not finished until the signal is sent. Sending it does not
close your pane and is not meant to: the coordinator closes you once it has read what you left
behind.

## Chains, limits and models

```
megabrain chain list [--json] — recommended when you need to inspect the configured agent-selection chains.
megabrain chain limits [--json] [--enable <providers>] [--disable <providers>] [--notice-on|--notice-off] [--notice-interval <seconds>] — recommended when you need to inspect or change provider usage-limit settings and notices.
megabrain chain add <name> --when <json> --steps <json> [--step <json>] [--parent-agent <agent>] [--parent-model <model>] [--parent-effort <effort>] [--allow-unknown-model] [--json] — recommended when you need to define a chain with matching rules and ordered agent steps.
megabrain chain edit <name> [--allow-unknown-model] [--json] — recommended when you need to change an existing chain configuration.
megabrain chain delete <name> [--json] — recommended when you need to remove a chain that is no longer used.
megabrain chain repair <name> --step <number> --model <id> [--effort <level>] [--json] — recommended when you need to replace a broken or unavailable model in a chain step.
megabrain model list|add|refresh ... — recommended when you need to see available model registry operations.
```

A chain name is chosen by the operator. Fresh state has no chains. `orchestrate spawn` and `run`
prefer an explicit `--chain`, then the most specific matching `parentAgent`, `parentModel` and
`parentEffort` selectors, then `defaultSteps`. Equal-specificity matches fail rather than choose
arbitrarily, and an unknown parent value satisfies no selector.

`run` delegates every launch to `orchestrate spawn`; it does not duplicate runtime or terminal
creation. A limit condition may skip a step; a launch failure always advances to the next one.
An unknown limit counts as usable. Codex limits come from the newest rollout on disk; Claude and
agy are unknown stubs, so a chain that depends on their windows will always see them as usable.
New providers belong in `lib/module-chain.sh` under `megabrain_chain_limit_read`.

An `until` clause accepts `usedPercent` and `window`, with optional `onUnknown` set to `take` or
`skip`. The default is `take`. Codex usage read from disk is a floor from the last recorded turn,
because the turn that exhausts a window is never recorded. If a recorded reset time has passed,
the code reports the reading as unknown and explains that the window has reset. The turn-end hook
detects a usage-limit refusal in the agent's own output, marks the dispatch as refused, and resumes
the chain at the next step.

## Worktrees and terminals

```
megabrain worktree create --repo <name|path> --branch <branch> [--from <ref>] [--base <ref>] [--parent <branch:branch|path:path>] [--no-parent] [--issue <number>] [--linear-issue <identifier-or-url>] [--pr <number>] [--name <slug>] [--agent <id>] [--model <id>] [--effort <level>] [--prompt <text>] [--label <text>] [--tmux true|false] [--json] — recommended when you need to create and register a shared worktree for a task.
megabrain worktree pr <branch|path|slug> [--base <ref>] [--title <text>] [--body <text>] [--json] — recommended when you need to open a pull request for a worktree branch.
megabrain stack create <branch> --on <parent> [--repo <path>] | show|pr [--draft]|sync|merge [--yes] [--provider github|gitlab] — recommended when you need to manage dependent branches and pull or merge requests.
megabrain worktree finish <branch|path|slug> [--delete-branch] [--base <ref>] [--force] [--json] — recommended when you need to remove a completed worktree after its safety checks pass.
megabrain worktree list [--repo <name|path>] [--tree|--flat] [--json] — recommended when you need to find registered worktrees and inspect their parent relationships.
megabrain worktree adopt <path|branch> [--json] — recommended when you need to register an existing worktree missing from one orchestrator.
megabrain terminal create [--worktree <path>] [--command <cmd>] [--title <text>] [--port <port>] [--terminal <name>|auto|none] [--json] — recommended when you need to open a managed terminal in a worktree: a tab in Orca or Superset when the session runs there, otherwise a tmux window.
megabrain terminal list [--worktree <path>] [--json] — recommended when you need to find managed terminals and check whether they are alive.
megabrain terminal open --session <tmux session> [--terminal <name>|auto|none] [--server <tmux -L name>] [--json] — recommended when you need to open a native terminal window attached to an existing tmux session, or print the attach command.
megabrain terminal default [<name>|auto|none|--clear] — recommended when you need to show, set or clear the default native terminal.
megabrain terminal restart <selector> [--command <cmd>] [--wait-port <port>] [--timeout <seconds>] [--json] — recommended when you need to restart a managed terminal after its command or server needs a fresh run.
megabrain terminal close <selector> [--json] — recommended when you need to close a managed terminal and remove its local record.
```

`worktree create` does the git worktree add and registers the workspace so Orca and Superset both
see it from the start. `--parent` accepts the documented Orca selector subset `branch:<branch>` or
`path:<path>` and explicitly stacks the new worktree under that existing worktree; without it,
megabrain does not infer a parent. `adopt` registers the missing side of a worktree that exists on only one.
The direct parent branch becomes the Superset sidebar tag after replacing `/` with `-`, so equivalent
branch and path selectors share one folder. Orca preserves the full nested lineage; Superset has
flat folders, so siblings share their parent's folder while a grandchild is grouped by its direct
parent rather than its ancestor. JSON reports the selector, canonical parent branch and whether Orca
lineage and Superset grouping were each set; a decoration failure does not undo the checkout.
`--issue` and `--linear-issue` are applied through the same post-checkout Orca update; a missing or
failing Orca update is reported in JSON without undoing the Git checkout. `--pr` is passed to
Superset's workspace creation for review flows; verified PR-head checkout is a Superset capability,
so an Orca-only or bare host cannot provide that part of the flow.
`worktree pr` uses the recorded Git stack parent as the base, otherwise the repository default, unless
`--base` overrides it. Its default title is the branch name and its default body is empty. It refuses
to call `gh pr create` when the branch has no commits ahead of its base, and distinguishes missing gh
from unauthenticated gh. The command requires gh only when opening the PR.
`stack create` registers a new dependent worktree and records its parent branch. `stack pr` uses
GitHub's native stacked pull request API when available and falls back to chained PRs if it is not;
GitLab uses chained merge requests with `glab`. `stack sync` and `stack merge` require `--yes`, show
their plan, and refuse to merge branches with local commits that have not been pushed.
Human `worktree list` prints the stack as a tree; `--flat` preserves the path/branch table and JSON
remains flat with parent and optional pull-request fields. Pull-request state is best-effort and does
not make listing depend on gh or Orca.
`finish` performs all refusal checks before removing the worktree. An unmerged branch is refused
unless `--force` is given, and a refusal leaves the worktree and branch intact. Under `--json`, every
non-help refusal returns `deleted: false` with a `refusal` code/message and keeps a non-zero status;
remover failures use `error` instead. The remover's output is captured and reported as megabrain's
own error on failure; successful remover JSON is not passed through as megabrain output. `terminal create` with no
`--command` runs the worktree's `.superset/config.json` run script. Superset tabs come back
untitled; only Orca tabs carry a title. Terminal identities, commands and creation times are
stored in the SQLite state database, so `terminal list` reports `alive` or `dead`,
and retains a host-gone terminal as `stale`. `terminal restart` accepts `id:`, `title:`, `port:` or
`worktree:` selectors, kills only the recorded process tree after proving a port listener belongs
to it, waits for the old port to be free, and optionally waits for it to listen again with
`--wait-port`. `terminal open` shows a tmux session in the operator's own terminal: Terminal.app, iTerm2, Ghostty,
WezTerm, kitty, Alacritty, gnome-terminal, Konsole, xterm or Windows Terminal. The choice is the
`--terminal` flag, then `MEGABRAIN_TERMINAL`, then the file set by `terminal default`, then detection
from the environment, then none (print the attach command). `orchestrate spawn` and `terminal create`
take the same flag and open a viewer on their own for a caller outside Orca, Superset and tmux (or when
`--terminal` names one); the result's `viewer` reports `terminal`, `opened`, `attachCommand` and `error`,
and a viewer that cannot open never fails the command. Only Terminal.app has been opened and
inspected on a real machine; the others are tested with a recording fake and `megabrain doctor
terminal-openers` marks them unverified. `terminal close` removes the host terminal and local record, and reports when the
host already forgot it or process identity was unavailable.

## Setup and diagnosis

```
megabrain context [--json] — recommended when you need to identify the orchestration host and runtime available in this session.
megabrain doctor [module-id] [--json] — recommended when you need to check whether a module or the whole installation is healthy.
megabrain install [module-id] [--agents claude,codex,agy|none] [--skill none|global|project] [--modules list|all|none] [--tmux yes|no] [--yes] [--browser chromium|firefox|both] [--revert] — recommended when you need to configure megabrain for an agent or install, update, or remove its modules and skills.
```

`doctor --json` is machine readable for every module; operator advice goes to stderr so it stays
out of the JSON. Use the `simulator-native` and `simulator-tv` module ids to diagnose Apple
simulator setup, and install `simulator-web` for browser testing. Install `orchestration-hooks` to get the child turn-end safety hook, which
reports a child whose turn ended without `ask` or `done`. The installed hook command invokes the
compiled binary directly — `MEGABRAIN_HOOK_AGENT=<agent> <absolute real path to the binary> hook
turn-end`, per agent config (Claude's `Stop` hook, Codex/agy `hooks.json`, Cursor's
`afterAgentResponse`, Grok's `~/.grok/hooks/megabrain.json`) — there is no wrapper script. `doctor` recognises a legacy entry left by an
older install (pointing at the now-deleted `hooks/megabrain-turn-end.sh`) and reports it as
needing migration; `megabrain install orchestration-hooks` replaces it in place.

The installable module ids include `tv-adb` and `skill-sync`. During normal command invocations,
`skill-sync` compares the shipped skill with each registered agent copy and repairs drift; `--help`
and `doctor` skip that runtime repair. A per-target stamp makes unchanged copies nearly free.
`megabrain doctor skill-sync` reports drift as `skill-sync`.

`megabrain doctor` adds `compiled-binary` automatically when `.build/megabrain` is stale compared
with `src`; it is a diagnostic rather than an installable module, so a healthy binary is omitted
from the no-argument report. Ask for `megabrain doctor compiled-binary` to check it explicitly.

`doctor` also counts `leakedDispatchSessions`: tmux sessions still held by finished dispatches.
`orchestrate prune` can release those sessions while archiving or deleting eligible dispatch
records. A split dispatch that shares the coordinator's tmux session does not own that session, so
it is never counted or released.

## Devices and browsers

Native simulator commands read the optional project config at the repository root,
`.megabrain/native.json`. They find it by walking up to the Git root, so they work from any
subdirectory; relative `appPath` values resolve against that root, while absolute values are used
as given. Set `MEGABRAIN_NATIVE_WORKTREE` to point the lookup at another directory. The file must
have `"version": 1` and `surfaces.phone` and/or `surfaces.tv`; a surface can define `appPath`,
`bundleId`, `urlTemplate`, `metroPort`, `device`, and `controlFrame`. `native build` reads
`appPath`; `sim ensure` reads `device`; `app reload` reads `bundleId`, `urlTemplate`, `metroPort`,
and `device`; `health` reads `bundleId`, `device`, `metroPort`, and `controlFrame`; `crashes` reads
`bundleId`. This repository's `.megabrain/native.json` is a short example.

```
megabrain native appium start|stop|status — recommended when you need to check, start, or stop the shared Appium server for simulator work.
megabrain native sim list <phone|tv> [--json] — recommended when you need to find available iOS or tvOS simulators.
megabrain native sim ensure <phone|tv> [--device <name-or-udid>] [--timeout <seconds>] [--json] — recommended when you need to boot and prepare the requested Apple simulator.
megabrain native runtime list [<ios|tvos>] (--installed|--available) [--json] — recommended when you need to check which Apple simulator runtimes are installed or available.
megabrain native runtime install <ios|tvos> <version> [--json] — recommended when you need to install an Apple simulator runtime needed by a device.
megabrain native app reload <phone|tv> [--route <r>] [--bundle-id <id>] [--url-template <tpl>] [--device <name-or-udid>] [--metro-port <p>] [--timeout <s>] [--json] — recommended when you need to restart a native app and navigate it to a route.
megabrain native health <phone|tv> [--bundle-id <id>] [--device <name-or-udid>] [--metro-port <p>] [--control-frame <path>] [--json] — recommended when you need to verify that the native app is rendering on its simulator.
megabrain native crashes <phone|tv> [--last N] [--json] — recommended when you need to inspect recent native app crash reports.
megabrain native build <phone|tv> [--runtime <version>] [--device <name-or-udid>] [--json] — recommended when you need to build, install, and launch the configured native app.
megabrain native capture <phone|tv> (--screens FILE | --screen NAME --route PATH) [--output-root DIR] [--surface NAME] [--capture-id ID] [--theme NAME] [--viewport NAME] [--device <name-or-udid>] [--bundle-id ID] [--metro-port <p>] [--timeout <s>] [--stable-window <seconds>] [--json] — recommended when you need stable screenshots of one or more native simulator routes and a capture manifest.
megabrain native navigate <phone|tv> <path> [--metro-port <p>] [--timeout <s>] [--json] — recommended when you need to open a specific route in the running native app.
megabrain native eval <phone|tv> <expression> [--metro-port <p>] [--timeout <s>] [--json] — recommended when you need to read native app state through Metro.
megabrain tv connect <ip> [--port <port>] — recommended when you need to connect an Android TV device over adb.
megabrain tv disconnect [<ip>] — recommended when you need to disconnect an Android TV device from adb.
megabrain doctor [module-id] [--json] — recommended when you need to check whether a module or the whole installation is healthy.
megabrain doctor [module-id] [--json] — recommended when you need to check whether a module or the whole installation is healthy.
megabrain install [module-id] [--agents claude,codex,agy|none] [--skill none|global|project] [--modules list|all|none] [--tmux yes|no] [--yes] [--browser chromium|firefox|both] [--revert] — recommended when you need to configure megabrain for an agent or install, update, or remove its modules and skills.
megabrain install [module-id] [--agents claude,codex,agy|none] [--skill none|global|project] [--modules list|all|none] [--tmux yes|no] [--yes] [--browser chromium|firefox|both] [--revert] — recommended when you need to configure megabrain for an agent or install, update, or remove its modules and skills.
megabrain web [--device SLUG|--category NAME|--viewport WxH] ... — recommended when you need to see browser viewport and visual-testing operations.
megabrain web viewport set|show|devices ... — recommended when you need to set viewport dimensions, inspect the current settings, or manage device presets.
megabrain web devices list [FILTER] [--orientation portrait|landscape|all] | add SLUG --viewport WxH --source SOURCE [options] | remove SLUG — recommended when you need to list, add, or remove named viewport device presets.
megabrain web capture --url URL --screen NAME [--settle default|scroll] [--scroll-timeout MS] [options] — recommended when you need to capture a browser screenshot after the page reaches the requested state.
megabrain web measure --url URL --screen NAME [--settle default|scroll] [--scroll-timeout MS] [options] — recommended when you need to measure browser element geometry and computed styles.
megabrain web session save --url URL --output FILE [options] — recommended when you need to save a headful browser session for a workflow that needs a signed-in profile.
megabrain web userscript install|list|remove ... — recommended when you need to install, list, or remove userscripts in the Chromium profile.
```

`native health` may reuse a still-live Appium session from an earlier call, so a session can outlive
the call that created it. Appium expires an idle session after 60 seconds; that expiry releases the
reusable session.

`simulator-web` uses pinned Playwright 1.62.1 and keeps separate persistent Chromium and Firefox profiles under
`~/.megabrain/playwright`, with a configurable viewport and extension versions pinned at
install time. Chromium is the userscript profile. To install or refresh a script, place it in
`~/.megabrain/userscripts/` and run `megabrain web userscript install <file.user.js>`; the tool
enables Chrome's one-time userScripts permission and sends the script through Violentmonkey.
`list` reports scripts installed in the Chromium profile, and `remove` removes one from that
profile while leaving the source file available for editing. Firefox has no userscript command.
`web viewport set` accepts category presets (mobile, tablet, laptop, desktop, or ultrawide, each
with named size variants), raw dimensions, or a curated device slug. Categories set viewport size
only; they do not emulate a device user agent, pixel ratio, or touch support. Registry-backed
device slugs resolve through Playwright's installed registry; owned laptop and desktop slugs use
documented CSS viewport sizes. Use `megabrain web devices` to filter the available slugs; portrait
is the default and landscape/all are explicit options.
The set command accepts `--browser chromium|firefox|both`, `--viewport WxH`, `--device SLUG`,
`--category NAME`, `--width W --height H`, and `--orientation portrait|landscape`.

## Testing surfaces

Use `megabrain web capture` for screenshots, `megabrain web measure` for geometry and styles, and
the Playwright MCP for interactive browser steps. Keep browser testing headless. Never automate
`megabrain web session save`: it is headful by design. Do not use Computer Use or Orca's embedded
browser for testing; Computer Use moves the operator's real mouse. Check the screenshot, measured
state, or rendered app after an action; a successful exit code alone does not prove it happened.

For iOS and tvOS, use `megabrain native appium status` (then `start` if needed), `native sim ensure`,
`native navigate`, `native eval`, and `native health`. Every Appium session must include
`appium:isHeadless: true`. `native navigate` and `native eval` use Metro's inspector. Do not use
`xcrun simctl openurl` to navigate: it only delivers a URL and can leave a system alert over the app.
Check `native health`, the evaluated value, or a changed screenshot after navigation.

## tmux

```
megabrain tmux tune [--yes] [--dry-run] [--revert] [--json] — recommended when you need to apply or remove the native tmux theme and agent badges.
megabrain tmux wrapper [--yes] [--dry-run] [--revert] [--json] — recommended when you need to install or remove the shell wrapper for hand-typed agent commands.
```

`tune` applies tmux’s native theme and shows agent badges, chat name, and state in pane headers.
`--revert` removes the managed source block and reloads the remaining tmux config. `wrapper` installs the zsh wrapper for hand-typed agent commands. When the `tmux-runtime`
module is installed a child opens as a split pane; otherwise it opens as a tab in the IDE that
launched the session. Override per call with `--tmux true|false`.

## Where state lives

Dispatches, messages, deliveries, terminals, install state, models, and tmux sessions live in
`$MEGABRAIN_STATE_DIR/megabrain.db`, defaulting to `~/.megabrain/megabrain.db`. Use `db show` to
inspect records, `db check` for integrity and foreign keys, `db backup` for a consistent backup,
`db migrate --dry-run --json` to preview cutover, and `db import <dir>` for an explicit import.
Migration moves transcripts to `~/.megabrain/transcripts/<dispatch-id>.txt` and seals the legacy
JSON tree under `~/.megabrain/legacy/json-<UTC timestamp>/`; a fresh state with no legacy JSON has
no snapshot. For rollback, restore that snapshot and run the previous binary. SQLite changes made
after cutover are lost by that rollback; restore a database backup to retain them.
Direct-parent ownership is required for `reply` and `close`.

Before any megabrain call in tests, export `MEGABRAIN_STATE_DIR` to an isolated temporary
directory so tests never touch `~/.megabrain`.
