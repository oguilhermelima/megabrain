# megabrain

**Hand work to another coding agent, and get it back.**

A local orchestrator that spawns agents, keeps the conversation with them durable, and tears them
down when the work is done.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) ![Shell](https://img.shields.io/badge/shell-bash%203.2%2B-lightgrey.svg) ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue.svg) ![Agents](https://img.shields.io/badge/agents-codex%20%7C%20claude%20%7C%20agy-orange.svg)

[Why](#why) · [Install](#install) · [Chains](#chains-choosing-who-does-the-work) · [Orchestration](#orchestration-the-conversation-that-outlives-the-terminal) · [Where it runs](#where-it-runs) · [Devices](#devices-and-browsers) · [Examples](#examples) · [Testing](#testing) · [Limits](#limits)

## Why

Running a second agent is easy. Knowing what it did, answering its question, and cleaning it up
afterwards is where the work leaks. megabrain keeps that loop in one place, on a queue that
outlives the terminal it was typed in.

## Features

- 🧠 **Picks the provider for you.** A chain reads real usage windows and takes the first step
  with room left, reporting which it chose and why it skipped the others.
- 📬 **A queue, not a keystroke.** Every message is written before anything is typed. A lost
  pointer costs a notification, never a message.
- 🪟 **tmux on its own.** No Orca, no Superset, no IDE: inside tmux a session identifies itself by
  its own pane, and closing a child removes that pane outright.
- 🌱 **Worktrees both orchestrators can see.** One `git worktree add` registered on both sides, so
  a card and a checkout never disagree.
- 🔁 **Recoverable by design.** Deliveries replay until acknowledged, a stalled child is reported
  at its own turn end, and `reconcile` settles a dispatch against reality.
- 🧹 **Nothing accumulates.** `prune` archives finished dispatches and refuses to touch a live one.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/oguilhermelima/megabrain/main/install.sh | bash
```

It downloads the rest itself, asks what to configure, and links `megabrain` into
`~/.local/bin`. Pass the answers to skip the questions:

```sh
curl -fsSL https://raw.githubusercontent.com/oguilhermelima/megabrain/main/install.sh \
  | bash -s -- --agents codex --skill global --agents-md global --yes
```

`--agents` names the agent CLIs you already have; the installer refuses one it cannot find on
PATH rather than configuring something that is not there. Use `none` to configure no agent.

Absent `--modules`, the installer takes the core set: orchestration, orchestration-hooks,
worktree, and tmux-runtime when tmux is already on PATH.

> [!NOTE]
> Clone only to work on megabrain itself: `git clone … && ./install.sh` installs from the
> checkout instead of downloading, so your edits are what gets linked.

### Homebrew

The personal tap installs the CLI:

```sh
brew tap oguilhermelima/megabrain
brew install oguilhermelima/megabrain/megabrain
```

This is a tap formula, not a Homebrew-core package. Homebrew cannot write to an agent's home
directory, so it installs the CLI and megabrain keeps the agent skill synchronized at runtime.
That is why a `brew upgrade` also keeps registered agent copies of the skill current.

```sh
megabrain doctor          # what is installed and what is missing
megabrain context --json  # tmux, orca, or superset
```

## Chains: choosing who does the work

A chain is an ordered list of steps. Each step names an agent, a model and an effort, and
`orchestrate spawn` takes the first step from the selected chain. `chain run` remains available
as the explicit form when you want chain-step fallback and usage-window decisions. You describe
the preference once; the choice is made against reality every time.

```sh
megabrain orchestrate spawn --worktree ~/code/api --prompt "$(cat brief.md)" --json
```

```json
{"ok":true,"dispatch":"dispatch-20260908-…","runtime":"tmux"}
```

The selected chain and step are recorded in the dispatch metadata. Use `chain run` when you
want the explicit chain runner and its fallback across steps:

```sh
megabrain chain run --worktree ~/code/api --prompt "$(cat brief.md)" --json
```

```json
{"ok":true,"chain":"my-chain","step":1,"totalSteps":2,"agent":"codex",
 "reason":"no earlier steps skipped; selector match with 1 field(s)",
 "dispatch":{"dispatch":"dispatch-20260908-…","runtime":"tmux"}}
```

The result always says which step it took and why the earlier ones were skipped, and that reason
is recorded in the dispatch. When your first choice is exhausted you get the second one with an
explanation, instead of a failure you have to diagnose.

Dispatch workers do not inherit the Playwright MCP by default. Use `--browser` on `orchestrate
spawn` or `chain run` when the brief needs browser access; Codex receives a layered configuration
override that disables or enables only `mcp_servers.playwright`. Interactive Codex keeps its
global browser MCP unchanged. A worker without browser access is told to report that requirement
and rerun with `--browser`.

**Chains start empty and must be added.** A chain is named by the operator, not automatically
after a parent or child agent. Add one with `chain add`, then `orchestrate spawn` prefers an
explicit `--chain`, then the most specific selector matching `parentAgent`, `parentModel` and
`parentEffort`, then `defaultSteps`. `chain run` follows the same selection order. Two selectors
of equal specificity fail rather than pick arbitrarily.

```sh
megabrain chain add my-chain --parent-agent codex \
  --step '{"agent":"claude","model":"claude-sonnet-5","effort":"high"}'
megabrain chain list --json      # the steps, in order, with their selectors
megabrain chain limits --json    # what each provider window says right now
megabrain chain repair <name> --step 2 --model <id> --effort high
megabrain model list             # the registered models and reasoning levels
```

Pass `--chain <name>` to either spawn command to bypass selector matching. An explicit `--agent`
on `orchestrate spawn` is the escape hatch and bypasses chains entirely; `--model` and `--effort`
may override those fields when the agent comes from a chain.

> [!NOTE]
> A limit condition skips a step; a launch failure advances to the next one. An unknown limit
> counts as usable, so a provider megabrain cannot read is tried rather than skipped. Codex
> windows come from the newest rollout on disk and are a floor from the last recorded turn: the
> turn that exhausts a window is never recorded. Claude and agy are stubs and always report
> unknown. A Codex snapshot whose reset time has passed is reported as unknown with a reason that
> the recorded window has reset.

An `until` clause accepts `usedPercent` and `window`, with optional `onUnknown: take` or
`onUnknown: skip`. The default is `take`; `skip` moves to the next step when the usage reading is
not trustworthy. If the agent itself prints the usage-limit refusal, the turn-end hook marks that
dispatch as refused and the chain continues at the next step.

## Orchestration: the conversation that outlives the terminal

Spawning is the easy half. The hard half is that a child asks questions, a pane closes, a machine
sleeps, and the answer has to survive all of it. Every message is written to an append-only queue
**before** anything is typed into a terminal.

```sh
megabrain orchestrate watch <id> --json         # blocks until there is mail
megabrain orchestrate reply <id> --text "..."   # answer a question
megabrain orchestrate ack <id> <delivery-id>    # mark it consumed
megabrain orchestrate read <id>                 # what the agent actually did
megabrain orchestrate reconcile <id>            # settle its state against reality
megabrain orchestrate close <id>                # take the pane back
```

### Managed terminals

Terminal creation returns the host identity in JSON and records it with the worktree, command,
title, creation time, process identity and optional caller-supplied port:

```sh
megabrain terminal create --worktree ~/code/api --title 'DEV api' \
  --command 'pnpm dev' --port 3000 --json
megabrain terminal list --json
megabrain terminal restart port:3000 --wait-port 3000 --timeout 30 --json
megabrain terminal close id:<terminal-id> --json
```

The registry lives under `$MEGABRAIN_STATE_DIR/terminals/`. Listing keeps a terminal whose host
identity disappeared and marks it `stale`, while a host-known process is reported as `alive` or
`dead`. The create wrapper asks the process to publish its own PID before replacing the command
with `exec`, so identity is not inferred from a port scan. If the marker is not published, the
terminal is closed and no record is created. The optional `--port` value is recorded as caller
knowledge and is never discovered automatically.
Restart selectors are `id:`, `title:`, `port:` and `worktree:`. Restart signals the recorded
process-tree root only after proving that a port listener descends from that root, waits for the
old port to be free before creating the replacement, and reports the new identity and port wait
time. Close removes the host terminal and local record; it explicitly reports when the host has
already forgotten the terminal or when process identity was unavailable.

From inside a child, the same queue from the other side:

```sh
megabrain received              # confirm that the prompt was received
megabrain ask "question"        # ask, then poll for the answer
megabrain check --timeout 120
megabrain ack <delivery-id>      # acknowledge a child-side delivery
megabrain done "what I verified"
```

Three properties do the work:

- **A delivery replays until it is acknowledged.** Reading one and not acting on it loses nothing.
- **Typing is a nudge, not the delivery.** A pointer lands in the parent's terminal to say there
  is mail. If the pane is gone or the composer is busy, the notice is lost and the message is not.
- **Your own turn end is a second chance.** When you finish speaking, megabrain points at any
  dispatch of yours holding unread mail, once per message, so a missed nudge recovers.

> [!IMPORTANT]
> Closing a finished child is the coordinator's job. Nothing does it for you, and the child cannot:
> it would be killing the pane it runs in. Read the pane first — closing destroys the scrollback,
> and a `done` is a claim the transcript is where you check.

Every tmux dispatch starts recording its pane output when it is spawned. `orchestrate read` reads
the live pane while it exists and falls back to the persisted transcript after the pane is gone;
its output says which source it used. Closing or pruning stops that recording before releasing the
dispatch session.

`orchestrate reply` refuses a dispatch already in a settled state such as `done`, `failed`,
`closed`, `circuit_broken`, or `timeout`. It exits non-zero and tells you to open a new dispatch,
instead of queuing a reply that cannot be delivered.

`orchestrate stop` interrupts a working child without closing its terminal. Its guarantees depend
on the host: tmux proves working liveness and refuses a pending-check frame before sending Escape;
Orca proves terminal identity and sends `--interrupt`, but cannot observe working liveness or the
pending-check frame; Superset refuses because `terminals send` has no interrupt capability. A refusal
names the missing proof or capability. `orchestrate change` supersedes queued directions, records
withdrawals for delivered directions, and applies the same host-specific interrupt rules.

## Where it runs

A dispatch runs as a **tmux split** or as a **tab in an orchestrator**, and the two are not rivals.

| | tmux | Orca / Superset |
| --- | --- | --- |
| Needs | tmux | the app and its CLI |
| Identity | its own session and pane | the managed terminal id |
| Child appears as | a split beside you | a tab in the IDE |
| `close` | removes the pane outright | leaves `Desconectado` until dismissed |
| Shared worktrees | not on its own | yes |

**They compose.** The usual setup is a tmux session running inside an orchestrator's terminal: the
IDE gives you cards, tabs and shared worktrees, and tmux gives you cheap panes and a real close.
`megabrain context` reports which one a session is in.

**And tmux stands alone.** With neither app installed, a session inside tmux identifies itself by
its own session and pane, so the whole delegate-supervise-close loop works on a bare Linux box.

### The shell wrapper: every agent starts in tmux

`megabrain tmux wrapper` installs a shell function for `claude`, `codex` and `agy`, so typing the
agent's name opens it inside its own tmux session instead of in the bare terminal. Nothing about
how you start an agent changes.

```sh
megabrain tmux wrapper --yes    # zsh or bash, chosen from $SHELL
```

The session is named `megabrain-<agent>-<pid>` — a fixed prefix and the shell's pid, never the
repository — and it is recorded under `~/.megabrain/sessions/`, with the directory it was started
in. So `agy` in `~/Workspaces/stack` becomes `megabrain-agy-67074`, and megabrain can tell you what
is running where.

Such a session is a **main** session: it has no parent, no queue and no completion signal, which is
exactly right for an agent you started yourself. A dispatch is the other thing — a child, with a
mailbox — and only `orchestrate spawn` creates one.

The wrapper stands aside when it would get in the way: already inside tmux, a non-interactive
invocation, `--print`, `exec`, `--version`, `--help`, or `MEGABRAIN_NO_TMUX` set. It also falls
back to the plain command if tmux fails to start, so a broken tmux never costs you the agent.

### Worktrees: one folder, both apps

Point both apps at a single directory for worktrees. Every checkout then appears in the same place
in both IDEs, and a card and a folder never disagree about where the work is.

```sh
superset settings set worktreeBaseDir ~/Workspaces/Worktrees
megabrain worktree create --repo api --branch feat/rate-limit --json
```

To stack a worktree under an existing checkout, opt in explicitly with an Orca `branch:` or
`path:` selector:

```sh
megabrain worktree create --repo api --branch feat/rate-limit-ui \
  --parent branch:feat/rate-limit --json
```

The parent branch is the canonical grouping key. Superset receives it as a sidebar tag with `/`
replaced by `-`, so `feat/rate-limit` becomes `feat-rate-limit` regardless of whether the parent
was selected by branch or path. `--base` remains independent: it controls the Git starting point,
while `--parent` decorates the two app views. Use `--no-parent` to state explicitly that the new
worktree is a root; `--parent` and `--no-parent` cannot be combined.

Orca shows the complete nested lineage for a multi-level stack. Superset has only flat sidebar
folders: siblings share the folder named for their direct parent branch, while a grandchild is
grouped by its direct parent rather than its ancestor. The JSON result reports independently
whether Orca lineage and Superset grouping were set; a failure in either decoration does not fail
the Git checkout.

Link worktrees to the issues they implement during creation:

```sh
megabrain worktree create --repo api --branch feat/rate-limit-ui \
  --parent branch:feat/rate-limit --issue 42 --linear-issue ENG-7 --json
```

The links are applied by Orca after the checkout. If Orca is unavailable or rejects the update,
the checkout remains and JSON reports the link failure. For a review workspace, `--pr` is passed
to Superset's verified PR-head flow. That part is Superset-specific; an Orca-only or bare host
cannot verify and check out a PR head through this option.

Open a pull request from a worktree with the stack-safe base selected automatically:

```sh
megabrain worktree pr ~/Workspaces/Worktrees/feat-rate-limit-ui --json
```

The parent branch is used as the base for a stacked worktree, while a root worktree uses the
repository default. `--base` overrides either choice. The default title is the branch name and the
default body is empty. megabrain refuses to invoke `gh pr create` when there are no commits ahead
of the selected base, and reports missing gh separately from an unauthenticated gh.

When finishing with `--delete-branch`, the recorded parent is used as the merge base for a
stacked worktree; a root worktree uses the repository default. Pass `--base <ref>` to override
the recorded base. If the recorded parent was already deleted, finish falls back to the
repository default and reports both the missing parent and the base it judged.

`worktree finish` performs every refusal check, including branch merge status, before removing
anything. A refusal leaves the worktree and branch intact. Under `--json`, output from the
orchestrator or Git remover is captured and converted into megabrain's own error instead of being
printed as if it were megabrain's JSON. Every non-help refusal also returns a JSON object with
`deleted: false` and a `refusal` code/message; the command keeps a non-zero status so callers can
distinguish an incomplete finish without parsing stderr. Remover failures use `error` instead of
`refusal`.

`megabrain worktree list` shows the stack as a tree and includes pull-request state when gh can
answer cheaply. Use `--flat` for the original path/branch table; JSON remains a flat, scriptable
array and does not require gh or Orca to list the local stack.

> [!TIP]
> Keep it beside your repositories rather than inside one — `~/Workspaces/Worktrees` next to
> `~/Workspaces/api`. A worktree nested inside its own repository confuses tooling that walks up
> looking for a git root. `megabrain worktree adopt` registers a checkout that only one side knows
> about, and `megabrain worktree finish` removes it from both.

## Devices and browsers

Beyond agents, megabrain installs and checks the prerequisites for the things agents need to
drive. Each is a module, so you install only what you use and `doctor` tells you what is missing.

| Module | What it sets up | Platform |
| --- | --- | --- |
| `simulator-web` | Playwright MCP with pinned Chromium and Firefox profiles | macOS, Linux |
| `tv-adb` | Android TV over adb | macOS, Linux |
| `simulator-native` | iOS and tvOS simulators, via Appium and XCUITest | **macOS only** |
| `simulator-tv` | the Apple TV simulator on the same toolchain | **macOS only** |

```sh
megabrain install simulator-web
megabrain install tv-adb
# Or install only one browser: --browser chromium, --browser firefox, or --browser both
megabrain install simulator-web --browser chromium
```

```sh
megabrain native appium start|status|stop   # one shared Appium server, not one per project
megabrain native sim list phone             # list available iOS simulators
megabrain native sim ensure phone --device <name-or-udid>  # boot and wait for an iOS simulator
megabrain native app reload phone --route <route> --bundle-id <id>  # terminate and open a deep link
megabrain tv connect 192.168.1.50           # pair an Android TV
megabrain tv disconnect
megabrain doctor simulator-native           # what is missing and how to get it
```

`megabrain doctor skill-sync` checks the installed copies of this skill. During normal command
invocations, megabrain compares and repairs registered agent copies when needed; `--help` and
`doctor` skip that runtime repair. A per-target stamp makes an unchanged copy a no-op. Drift is
reported as `skill-sync` rather than being hidden behind another module's status.

`native sim list` shows each available simulator's name, state and identifier. Device selectors accept
either the simulator name or its identifier; an ambiguous name must be disambiguated with the
identifier. `native sim ensure`
waits until `simctl` reports the selected device as `Booted`, bounded by
`--timeout`; a boot failure and a wait timeout are reported separately. The optional
`.megabrain/native.json` file in each worktree supplies `phone` and `tv` surface defaults. URL
templates use `{route}`, `{metro_port}`, `{bundle_id}`, and `{device}` placeholders, so the
same command supports structurally different links such as `exp://127.0.0.1:8082/--/{route}`
and `canto:///{route}`. A surface's optional `device` value in `.megabrain/native.json` supplies
the default name or identifier for both simulator commands. `native app reload` checks Metro when a port is configured, terminates
the app (a stopped app is harmless), and opens the URL; it reports no claim about the app's
rendered screen.

The two simulator modules need the Xcode Simulator, Appium and the XCUITest driver, so they exist
only on macOS; asked for elsewhere they report `unsupported: macOS only` rather than half
installing. `tv-adb` needs Android platform-tools and `simulator-web` uses pinned Playwright 1.62.1;
it needs Node.js, npm, npx, and
the selected Playwright browser. Chromium uses a configurable 1280x720 default viewport, uBlock Origin Lite,
and Violentmonkey; Firefox uses its own persistent profile with full uBlock Origin and the signed
Violentmonkey add-on. Extension versions are resolved and pinned when the module is installed,
so a browser run does not change behavior behind the operator's back. Chromium is the profile
that supports userscripts: Playwright can reach its extension options page and enable Chrome's
userScripts permission. Firefox's moz-extension pages are not reachable through Playwright, so
userscripts are intentionally Chromium-only.

Userscripts live in `~/.megabrain/userscripts/`. The module enables the one-time Chrome
userScripts permission automatically when installing or refreshing a script:

```sh
megabrain web userscript install hello.user.js
megabrain web userscript list
megabrain web userscript remove hello.user.js
```

The browser viewport defaults to 1280x720. Persist a different size in the installed profile,
or use a Playwright device preset for a named device:

```sh
megabrain web viewport set --category mobile
megabrain web --device iphone17pro
megabrain web devices iphone --orientation portrait
megabrain web viewport show
```

Categories are testing conventions, not device emulation: they set only the viewport. The
available categories are mobile (390x844, with mobile-small and mobile-large variants), tablet
(768x1024), desktop (1920x1080, with laptop, monitor, and QHD variants), and ultrawide
(3440x1440, with a 2560x1080 variant). The mobile, tablet, and desktop conventions follow
BrowserStack's 2026 screen-resolution guide, which sources StatCounter; ultrawide values are
availability conventions because no market-share figures were found.

Userscript install and removal also accept `--viewport WIDTHxHEIGHT`, `--category NAME`, or
`--device SLUG` for a one-time override. Device slugs are curated and stable: registry-backed
slugs resolve through Playwright's registry, while laptop and desktop slugs use owned CSS viewport
sizes. Use `megabrain web devices [FILTER] --orientation portrait|landscape|all` to inspect the
available presets. Unknown slugs are refused with matching registry suggestions when available.

Visual parity workflows use non-persistent browser contexts, so one private storage state can be
used by multiple captures without profile locking. Save a signed-in session once, then pass it to
capture or measure:

```sh
megabrain web session save --url http://localhost:3000/login --output .megabrain/session.json
megabrain web capture --url http://localhost:3000/movie/42 --screen details \
  --content-id movie-42 --theme dark --device macbookpro14 \
  --storage-state .megabrain/session.json --output-root visual-captures
megabrain web measure --screens screens.json --storage-state .megabrain/session.json
```

Capture writes candidate/ by default. Use `--baseline` deliberately; an existing baseline is
never replaced unless `--replace-baseline` is also present. The output is grouped as
side/surface/content-id/theme/viewport/screen, where a viewport such as 1512x982@2x records CSS
dimensions and device scale factor without resizing the PNG. Viewport capture is the default;
`--full-page` is explicit. A screens JSON file is processed sequentially in declaration order so
results are deterministic; separate invocations can safely run in parallel with the same session
state. Geometry is measured during the same settled page visit as the screenshot, after network
idle, fonts, image decoding, reduced motion, disabled animations, and a frozen clock.

Custom devices are stored separately from installed browser profiles and use private file mode:

```sh
megabrain web devices add office --viewport 1512x982 --device-scale-factor 2
megabrain web devices --filter office
```

`doctor` names the missing piece and the command that installs it rather than failing silently.

## Examples

```sh
# Delegate and wait, without the pointer ever touching your composer
id=$(megabrain chain run --worktree ~/code/api --prompt "$(cat brief.md)" --json | jq -r .dispatch.dispatch)
megabrain orchestrate watch "$id" --timeout 1800 --json
```

```sh
# Two workers on disjoint checkouts
megabrain worktree create --repo api --branch feat/rate-limit --json
megabrain worktree create --repo web --branch feat/rate-limit-ui --json
megabrain chain run --worktree ~/Worktrees/feat-rate-limit --prompt "$(cat api.md)"
megabrain chain run --worktree ~/Worktrees/feat-rate-limit-ui --prompt "$(cat web.md)"
```

```sh
# Which provider still has room, before committing to one
megabrain chain limits --json | jq -r '.[] | "\(.provider) \(.window): \(.status)"'
```

```sh
# Settle everything after a machine restart, then take the space back
megabrain orchestrate reconcile --all --json
megabrain orchestrate prune --dry-run --json
megabrain orchestrate prune --older-than 7
```

```sh
# Record a measurement so the next session does not re-derive it
megabrain fact add bash-version --measurement 'macOS ships bash 3.2.57' \
  --who tester --when 2026-09-08T12:00:00Z --command 'bash --version'
```

## How it works

The queue is the product. Panes and tabs are launch and notification surfaces around it.

```text
Parent --spawn--> tmux split or IDE tab --starts--> Child
  |                                                   |
  | parent messages                                   | received + child messages
  v                                                   v
  +------------------------> DURABLE QUEUE <----------+
                                  |              |
                                  | child reads  | parent reads
                                  v              v
                                Child          Parent

terminal keystroke ---------------------> nudge only
```

Prompt delivery is confirmed by the child writing a received message to the durable queue. The
parent sends the prompt as a best-effort transport action, waits for that receipt, and retries a
bounded number of times when it does not arrive. A keystroke typed into a terminal is only a nudge
that may wake a participant; the message it points at is already durable.

## Testing

```sh
for t in tests/*.sh; do bash "$t"; done   # the authority: macOS, bash 3.2
bash tests/container/run.sh               # the safety net: nothing of yours to damage
```

The container mounts the checkout read-only and copies it in, so a test cannot reach the host
tree, your tmux server or your agent configuration. It runs bash 5 on Linux, which catches
portability bugs macOS hides, but it is not the target platform, so the local run stays the
authority. By default, the container runner uses nproc's available CPU count for its workers;
set MEGABRAIN_TEST_JOBS to override it. Each run preserves per-test output in a unique
directory under
${MEGABRAIN_TEST_OUTPUT_DIR:-/tmp/megabrain-suite-results}; failures.log names every failing test
and contains its complete output, so failure evidence survives piping the command's stdout.

> [!WARNING]
> A run is only fully isolated with all three of `HOME`, `MEGABRAIN_STATE_DIR` and
> `MEGABRAIN_FACTS_FILE`. The state directory alone does not cover the fact store, which lives in
> the installation root. `tests/test-sandbox-isolation.sh` proves the three are enough.

## Limits

megabrain coordinates local tools. It is not a hosted service, a billing system, or a replacement
for the agent CLIs it drives.

- The live usage reader uses an undocumented endpoint and may break without notice. It reads a
  credential only for an enabled live read and never refreshes an expired one.
- Codex reasoning spellings are inferred; only `xhigh` is verified.
- The agy usage provider is not implemented and always reports its window as unknown.
- Superset leaves a closed pane visible as `Desconectado` until a human dismisses it, and a
  main-type workspace cannot be pruned from the CLI. tmux has neither limitation.
- Installing the turn-end hook changes agent hook configuration and can require trusting the next
  Codex launch once, interactively.

## Troubleshooting

`megabrain doctor <module>` names the missing prerequisite. If a dispatch goes quiet,
`megabrain orchestrate watch` reads its queue and `megabrain orchestrate reconcile` settles its
state against reality.

> [!NOTE]
> A dispatch record's `reason` is the symptom. The child's own message in the queue is usually the
> cause, so read the messages before concluding anything about a failure.

Exit codes: `0` succeeded · `1` an operational check or action failed · `2` an invalid command,
module, option or argument.

`AGENTS.md` carries every command with its full flags, and `megabrain <command> --help` is the
authority on any single one.
