# One ownership model for chats and sessions

Status: proposal (phase 1, investigation only — no behaviour changed). Measured on 2026-10-16 against
`main` at `b2b1794d` and the person's live machine (read-only; the state database and JSON files were
copied to a scratch state directory before any `megabrain` call).

## The problem in one paragraph

The sidebar row list is the union of five independent sources, each keyed by its own identifier, and
deduplicated after the fact in the renderer by guessing which identifiers mean the same
conversation. Nobody records "this conversation is ours, and it is this chat / this terminal / this
dispatch" in one place, so ownership is re-derived from process ancestry on every poll. When that
derivation changes (a process dies, the app restarts, a coordinator spawns workers inside an app
terminal, a chat switches to its TUI), rows split, reappear as dead ghosts, or turn up under the
wrong owner with a close action that does something else than the person expects.

## 1. Inventory: every source of a sidebar row

The sidebar renders, per worktree, `worktreeItems(chats, terminals, sessions)`
(`apps/desktop/src/advanced/row-model.ts:32-69`): native chats first, then app terminals, then
agent sessions that neither claimed.

| # | Source | Producer (file:line) | Identity | Appears when | Disappears when | Close / remove / release / hide |
|---|---|---|---|---|---|---|
| A | Native chat | chatd `ChatStore` in `~/.megabrain/chats/<id>/chat.json`; created by `chat start` (`src/chat/daemon.ts:174`), listed by `chat list`, polled with projects (`apps/desktop/src/advanced/Advanced.tsx:92`) | chat id (uuid); `agentSessionId` filled later from the agent's first output (`daemon.ts:426`, `:508`, `:550`) or by guessing on return from terminal mode (`daemon.ts:787`) | `chat start` — including an empty start with no message (`apps/desktop/src/launcher/Launcher.tsx:188`, `launchEmpty`) | Only `chat remove` (`daemon.ts:753-768`). Never on its own: suspended and empty chats persist forever | Close = `chat remove` (`Advanced.tsx:444-449`); stops the agent and deletes the chat directory. A chat cannot be hidden |
| B | App terminal, live this run | Tauri `TerminalManager` (`apps/desktop/src-tauri/src/terminal.rs:318-325`), React state `terminals` (`apps/desktop/src/terminal/terminal-list.ts:37-41`) | item id (`terminal-…`), PTY session id, tmux target `megabrain-app:mb-app-<id>`, native PTY child pid | Launcher, ⌘T, worktree menu, Resume, **and every native chat switched to terminal mode** (`apps/desktop/src/native-chat/NativeChatView.tsx:202-208` calls `api.openTerminal` with the tmux engine, which creates an `mb-app-<id>` session and records it) | Close | Native: kill process tree. Tmux: `kill-session` only if the name starts `mb-app-` on `megabrain-app` (`terminal.rs:62-64`, `:572-586`), which also forgets the record; any other tmux target is only detached. App quit detaches (`terminal.rs:52-58`) |
| C | App terminal, restored | `terminal list --app` (`src/cli/commands/terminal-app.ts:83-118`) = union of live `mb-app-*` sessions on `megabrain-app` and every record in `~/.megabrain/app-terminals.json`; merged by `restoreAppTerminals` (`terminal-list.ts:136-160`) | `mb-app-<id>` session name; the item id is remembered in `localStorage` (`megabrain.terminals.ids`) | Every app start, for every record, alive or not. A dead one comes back `exited` "so it can be closed" | Only when closed with `kill` (`terminal-list.ts:193-197`), which forgets the record | Close = `terminal close --app <id>` + forget |
| D | Agent session from logs/registries | `megabrain projects --json --origin megabrain` (`src/cli/commands/projects.ts:747-789`) via `sessionsForMachine` (`:464-470`): Claude `~/.claude/sessions/<pid>.json` (`:255-281`), Grok `~/.grok/active_sessions.json` (`:328-349`), Codex rollouts of the last 7 days (`:371-424`). agy is not read at all | `agent:sessionId`; plus `processId` (registry pid, or for Codex the first live codex process **whose cwd equals the rollout's cwd**, `:378-389`, `:413`) | Live: always. Ended: up to 5 per worktree, Claude 1 day / Codex 7 days (`:508-511`). Filtered to `origin === "megabrain"` (`:507`) — see E | Process gone and outside the window; or origin flips to external | Close: if `owned-sessions.json` has it → `session release` (kill its tmux session). If its process descends from an app terminal → `session release` kills that tmux session or the PTY pid (`src/cli/commands/session.ts:83-97`). Otherwise Close hides it (`hidden-sessions.json`) |
| E | Origin rule that gates D | `sessionOrigin` (`src/core/session-origin.ts:79-82`): `megabrain` if in `owned-sessions.json`, or its id is some native chat's `agentSessionId` (`projects.ts:775`), or its pid — or the matched dispatch's `agentPid` — has an ancestor that is `megabrain-desktop` or **any process of the `megabrain-app` tmux server** (`session-origin.ts:23-34`) | — | — | — | — |
| F | Owned session | `session own` (`session.ts:45-69`) resumes the session in `mb-<agent>-<id8>` on `megabrain-app` and writes `~/.megabrain/owned-sessions.json` | `agent:sessionId` → tmux session | `session own` / Open here | `session release` only. The entry survives the agent exiting | Release kills the tmux session and deletes the entry. Closing an app terminal attached to it only **detaches** (name is not `mb-app-`) |
| G | Dispatch link | `dispatchForSession` (`projects.ts:476-485`): exact match on `agentThreadId/agentSessionId/grokSessionId/codexSessionId`, else **any dispatch of the same agent in the same worktree created within ±10 minutes** | dispatch id | Decorates D: replaces the title with the dispatch label, sets `waiting` | — | No close of its own |
| H | Hidden sessions | `~/.megabrain/hidden-sessions.json` via `settings get/set hidden-sessions`; `apps/desktop/src/advanced/hidden-sessions.ts:29-42`; applied before folding (`apps/desktop/src/advanced/Sidebar.tsx:547-548`, `:1480-1506`) | `agent:sessionId` | — | Hidden until the person shows it again | Applies to D rows only |
| I | Folding (dedupe) | `worktreeItems` (`row-model.ts:32-69`) | A chat claims the session whose id equals its `agentSessionId`; a terminal claims by `launch.resume`, else the **first** unclaimed session whose `terminalPid` or tmux session matches (`terminal-list.ts:116-120`) | — | — | — |

Other files that hold row state: `sidebar-state.json` (collapsed projects, per-worktree row order keyed
`chat:<id>` / `terminal:<id>` / `session:<agent:id>`), `localStorage` `megabrain.panes` (layout) and
`megabrain.terminals.ids`.

## 2. Snapshot of the person's state (2026-10-16 ~21:10 UTC)

Taken with the app's own CLI (`/private/tmp/megabrain-app/…/megabrain-cli`) against a copy of the state.
Live context: the desktop app is running (test build); every agent TUI the person uses runs in **Orca**
terminals; the `megabrain-app` tmux server is **not running**; `owned-sessions.json` is `{}`;
`native-sessions.json` is empty; the engine setting is `tmux`.

### What the app's sidebar shows (it asks for `--origin megabrain`)

| Row | Count | Class |
|---|---|---|
| Native chats with a conversation (title + agent session id) | 4 | ours and wanted |
| Native chat open right now in a pane, no turn yet (canto-space) | 1 | ours and wanted (open) |
| Native chats with no turn ever, no agent session, `suspended` (Canto, juntin ×2) | 3 | ours and dead — empty placeholders left by Start with no message |
| Native chat in terminal mode, no turn, no agent session, its TUI gone (juntin) | 1 | ours and dead |
| Restored app terminal `mb-app-ccbf5391…` (juntin, title "claude", command `claude --dangerously-skip-permissions`, tmux session gone) | 1 | ours and dead; very likely the TUI of the terminal-mode chat above, i.e. also a duplicate |
| Agent session rows | 0 | — |
| **Total rows** | **10** | wanted 5 · dead 5 (1 of them also a duplicate) · foreign 0 |

Also measured: `hidden-sessions.json` holds 2 ids, neither of which any source reports any more (stale,
harmless). Three `chat events --follow` processes follow the same canto-space chat (a follower leak,
out of scope here but worth a ticket).

### What `projects` reports without the filter (the CLI default, and what an "Other sessions" group would draw from)

| Class | Count | Of which dispatch workers |
|---|---|---|
| Foreign live (Claude in Orca) | 6 | 2 — one is this audit's own worker session |
| Foreign ended (Codex rollouts ≤ 7 days) | 32 | 29 |
| **Total** | **38** | **31** |

Of the 31 dispatch links, 25 are exact id matches and **6 rest only on the ±10-minute heuristic**.

### Classes counted, as the brief asks

| Class | In the app today | In the unfiltered list |
|---|---|---|
| ours and wanted | 5 | 0 |
| ours, duplicate of another row | 1 (counted inside "dead") | 0 |
| ours and dead | 5 | 0 |
| foreign live | 0 | 6 (2 are dispatch workers) |
| foreign ended | 0 | 32 (29 are dispatch workers) |

Reading: today, with every TUI in Orca, the "rows appearing on their own" that the person sees in the
app are megabrain's own leftovers — empty chats and dead terminal records — not foreign sessions. The
foreign/dispatch problem is latent: it returns the moment the person runs agents (or a coordinator)
inside the app's tmux terminals, which is the default engine now.

## 3. Why rows reappear — concrete paths, ranked

1. **Every tmux terminal the app ever opened is resurrected on the next start, dead or alive.**
   `terminal list --app` unions live sessions with *every* record in `app-terminals.json`
   (`terminal-app.ts:99-117`); a record is forgotten only by an explicit close with kill
   (`terminal.rs:584`). An agent that exits, a tmux server that dies, a machine reboot — the record
   stays, and `restoreAppTerminals` brings it back as an `exited` row the person must close
   (`terminal-list.ts:136-160`). Observed: 1 such row now.
2. **A native chat's terminal mode creates a second, independent conversation row.** Switching to
   terminal opens an ordinary app tmux terminal (`NativeChatView.tsx:202-208`), recorded in
   `app-terminals.json` like any other. After an app restart it is restored as a standalone "claude"
   terminal beside the chat (1). While the chat has no `agentSessionId` yet, the TUI's own session is
   not claimed by the chat (`row-model.ts:52-56` claims by id only) and, being under `megabrain-app`,
   it is origin `megabrain` (`session-origin.ts:23-34`) — a second row for one conversation.
   Removing the chat does not kill or forget that tmux terminal (`Advanced.tsx:444-449`).
3. **Empty chats are persisted and never collected.** `launchEmpty` (`Launcher.tsx:188`) calls
   `chat start` with no message; chatd writes a record at once (`daemon.ts:174`); nothing ever removes
   it except a manual close. Observed: 4 of 9 chats have never had a turn.
4. **Returning from terminal mode adopts the newest log in the folder, whoever wrote it.**
   `discoverSessionId` (`src/chat/session-log.ts:224-250`) picks the most recently modified
   `.jsonl` in the cwd's Claude project directory (or the newest Codex rollout with that cwd). In a
   folder where a coordinator or any other agent is running, the chat adopts *that* session: it then
   claims the other agent's row, `importTerminalTurns` (`daemon.ts:800-810`) imports its turns, and
   the TUI's real session becomes an unclaimed row. Not observed in today's snapshot; structural.
5. **Dispatch workers of a coordinator running inside an app tmux terminal become the person's rows,
   and Close on them kills the coordinator.** `orchestrate spawn` runs `tmux split-window` without
   `-L` (`src/hosts/tmux.ts:195-202`, `:256-257`), so inside an app terminal (`$TMUX` points at
   `megabrain-app`) the workers land on the app's server. They descend from the `megabrain-app`
   server → origin `megabrain`; `appTarget` maps them to the coordinator's `mb-app-*` session
   (`session-origin.ts:70-75`); the terminal claims only the first matching session
   (`row-model.ts:45-50`), so every other worker is its own "owned" row whose Close runs
   `session release`, which `kill-session`s the coordinator's tmux session
   (`session.ts:89-91`) — ending the coordinator and all its workers. Structural; not observed today
   because the coordinator runs in Orca.
6. **Ownership is inferred from ancestry on every poll, so it flips.** A session the app launched
   stops being `megabrain` the moment its process leaves the table (`descendsFromMegabrain` returns
   false for an unknown pid), so an app-launched conversation that ended vanishes from the filtered
   list instead of showing as ended-and-resumable, while an `owned-sessions.json` entry keeps a dead
   session "owned" forever (no expiry; release is the only exit). The person experiences both as
   "I have to close and release things".
7. **Codex liveness is by folder, not by process.** Every 7-day rollout whose cwd equals the cwd of
   any live `codex` process gets that pid and `working` (`projects.ts:378-389`, `:413`). One Codex
   running in a repo's main checkout makes every Codex conversation of the last week in that folder
   look live, and in the app view they become `megabrain` the moment that one process is under the
   app's tmux server.
8. **The dispatch link guesses by time.** `dispatchForSession` (`projects.ts:476-485`) attaches any
   dispatch created within ±10 minutes in the same worktree, rewriting the row's title to the
   dispatch's label. 6 of 31 links today are guesses.
9. **Two identities for "the app owns this tmux session".** App terminals are `mb-app-<id>`; owned
   sessions are `mb-<agent>-<id8>` on the same server. Close kills only the first kind
   (`terminal.rs:62-64`); release only the second. A terminal attached to an owned session only
   detaches on close, so the row stays with a "Release" action.

Not causes (checked): resume keeps the session id for both agents (the registry shows
`claude --resume fa2f6670…` running as `fa2f6670…`; `codex resume <id>` reuses the rollout id), so
hidden-session ids do not drift on resume. A fork (`--fork-session`) would mint a new id; nothing in
megabrain forks today.

## 4. The model: one registry of conversations

### Identity

A **conversation** is one agent session. Its key is `agent:sessionId` once known. Until the agent
reports its id (a chat before its first turn, a TUI just launched), the conversation has a
**provisional key** — `chat:<chatId>` or `terminal:<appTerminalId>` — which is promoted to
`agent:sessionId` exactly once, when the id is learned from evidence that names this process (the
agent's own output for a chat; the registry entry whose `pid` descends from this terminal's pane for a
terminal). Never from "newest file in the folder".

Every other identifier is an **alias** on the conversation: `chatId`, `appTerminalId` (the
`mb-app-<id>` / owned `mb-<agent>-…` tmux session), native PTY pid, agent pid, `dispatchId`.

### Storage

`~/.megabrain/conversations.json` (0600, atomic write, `version: 1`), owned by the CLI:

```json
{
  "version": 1,
  "conversations": {
    "claude:6f6916fb-…": {
      "owner": "app-chat",
      "cwd": "/Users/…/megabrain",
      "aliases": { "chatId": "6c297588-…", "tmux": null, "pid": null, "dispatchId": null },
      "createdAt": "…",
      "hidden": false
    },
    "terminal:ccbf5391-…": {
      "owner": "app-terminal",
      "cwd": "/Users/…/juntin",
      "aliases": { "tmux": "megabrain-app:mb-app-ccbf5391-…", "chatId": null, "pid": null, "dispatchId": null },
      "createdAt": "…",
      "hidden": false
    }
  }
}
```

Dispatch and foreign conversations are **not stored**: they are derived per listing from the dispatch
table (exact ids only) and from the agent registries, and keyed the same way. Only what megabrain
created and the person's explicit hide choices are persisted.

### Owners and their rules

| Owner | Who writes it | Is ours | Lives until |
|---|---|---|---|
| `app-chat` | chatd on `chat start` (promoted when the agent reports its id); its terminal mode adds a `tmux` alias to the **same** entry instead of opening an independent terminal record | yes | `chat remove` |
| `app-terminal` | the app on terminal create (native or tmux); `session own` writes the same owner with the `mb-<agent>-…` tmux alias | yes | Close; or automatically when its process/tmux session is gone **and** no agent session was ever attached (a dead shell has nothing to resume) |
| `dispatch` | derived: a session whose id equals a dispatch's recorded agent session id, or whose pid descends from the dispatch's `tmuxPane` / `agentPid` | no (it is the coordinator's) | follows the dispatch |
| `foreign` | derived: every other session the registries report | no | follows the agent |

Precedence when one session matches several: `dispatch` beats `app-terminal` ancestry (a worker that
happens to sit under an app terminal is still the coordinator's), and an explicit `app-chat` /
`app-terminal` entry beats ancestry.

### What appears by default

- **Ours** (`app-chat`, `app-terminal`): always, live or not, one row each. An ended conversation of
  ours with a known agent session shows as ended and resumes on click. A chat that never had a turn
  is not persisted at all: `chat start` without a message creates the conversation in memory and
  writes it on the first send (or the empty pane simply closes).
- **Foreign**: only when live **and** inside a registered project, collapsed under an
  **Other sessions** group per worktree. Ended foreign conversations never, unless the person turns on
  "Show ended".
- **Dispatch workers**: never in the person's list, unless they turn on "Show agent workers"; then
  nested under the coordinator's row when the coordinator is a row, else under Other sessions.
- **Hidden** (`hidden: true` on the conversation, keyed by the conversation key, so it survives
  promotion and alias changes): out of the list until shown again.

### What Close means — one action, no release step for the person

| Owner | Close does |
|---|---|
| `app-chat` | Stops the agent, kills the tmux alias if its terminal mode left one, deletes the chat, drops the entry. The agent's log stays, so Resume can reopen it. |
| `app-terminal` | Kills the native process tree or the tmux session (either naming scheme), drops the entry. If the tmux session also hosts dispatch panes, the confirmation names them first. |
| `dispatch` | Hides it (it is not the person's to end; the coordinator closes its own workers). |
| `foreign` | Hides it (today's behaviour). |

"Release" disappears from the person's vocabulary: `session release` stays as a CLI verb and becomes
the implementation of Close for an owned session.

### Migration from today's files (JSON only; no database migration)

Run once by the CLI the first time it needs the registry, guarded by a `migratedFrom` field:

1. `chats/*/chat.json` → `app-chat` entries (key `agent:agentSessionId`, else `chat:<id>`).
   Chats with no turn ever (no `agentSessionId`, no user event) are **not deleted** by migration; they
   get `hidden: true` so they leave the list and the person can still show them. Deleting the
   person's records stays a manual Close.
2. `app-terminals.json` → `app-terminal` entries for records whose tmux session is alive. A dead record
   whose command resumed a known session becomes that conversation's ended `app-terminal` row; a dead
   record with no session is dropped (it is what the person keeps closing by hand). A record that is
   the terminal-mode TUI of a chat (same cwd, command equal to that chat's `terminalCommand`) is
   folded into the chat's entry as its `tmux` alias.
3. `owned-sessions.json` → `app-terminal` entries with the `mb-<agent>-…` alias; entries whose tmux
   session is gone are dropped.
4. `hidden-sessions.json` → `hidden: true` on derived conversations by key; ids no source reports are
   kept in a small `hiddenKeys` list so a foreign session hidden today stays hidden.
5. The old files are left in place and read-only for one release (rollback = older binary, which still
   reads them), then removed by a later task.

## 5. Implementation tasks (for dispatch)

Each task names the files it touches and the tests that prove it. Tests are written first, in their
own commit, per the repo's rule.

1. **Conversation registry module.** New `src/core/conversations.ts` (read, atomic write, promote
   provisional key, add/remove alias, hide/unhide) beside `src/core/session-ownership.ts`.
   Tests: `tests/unit/conversations.test.ts` — promotion keeps aliases and `hidden`; two writers do not
   lose an entry (rename-based write); unknown version reads as empty.
2. **Migration from today's JSON.** `src/core/conversations-migrate.ts`, called from the registry's
   first read. Reads `chats/`, `app-terminals.json`, `owned-sessions.json`, `hidden-sessions.json`.
   Tests: `tests/unit/conversations-migrate.test.ts` with fixtures copied from the shapes measured here
   (titles and ids fake): 9 chats → 9 entries, 4 empty ones hidden; dead terminal record dropped; dead
   owned entry dropped; terminal-mode TUI record folded into its chat; idempotent on a second run.
3. **chatd writes the registry and stops guessing session ids.** `src/chat/daemon.ts` (start, first
   session id at `:426`/`:508`/`:550`, remove at `:753-768`, mode switch at `:771-797`),
   `src/chat/session-log.ts:224-250` (`discoverSessionId` accepts only a log whose writer pid
   descends from the chat's own terminal, i.e. matched through the Claude registry / Codex process, not
   by mtime). Empty `chat start` keeps the chat in memory until the first send.
   Tests: `tests/unit/chat-terminal-turns.test.ts` gains "a second agent writing in the same folder is
   not adopted"; `tests/unit/chat.test.ts` gains "a start without a message leaves no record after the
   daemon restarts"; "remove kills the terminal-mode tmux alias".
4. **One terminal record per conversation.** `apps/desktop/src-tauri/src/terminal.rs` (create records
   through the CLI registry; close kills `mb-<agent>-…` too; AppQuit unchanged),
   `apps/desktop/src-tauri/src/app_terminals.rs` and `src/core/app-terminals.ts` (become thin readers of
   the registry), `src/cli/commands/terminal-app.ts` (list returns only live sessions plus dead ones
   with a known conversation). `NativeChatView.tsx` passes the chat id so the terminal attaches to the
   chat's entry.
   Tests: `apps/desktop/src-tauri/src/terminal_tests.rs` (close kills owned-session names on
   `megabrain-app`, never default-server sessions); `tests/unit/terminal-app.test.ts` (dead record with
   no conversation is not listed; chat terminal is not listed as a standalone terminal).
5. **`projects` lists conversations, not sessions.** `src/cli/commands/projects.ts`: join machine
   sessions to the registry; emit one row per conversation with `owner`
   (`app-chat|app-terminal|dispatch|foreign`) and its aliases; drop the ±10-minute dispatch guess
   (`:476-485`, exact ids and pane ancestry only); Codex liveness by the process's own rollout (open
   files via `lsof -p <pid>`), not by cwd (`:378-389`); add agy. `src/core/session-origin.ts` keeps
   ancestry only as evidence for promotion and dispatch detection. Keep `--origin` accepted as an
   alias for one release.
   Tests: `tests/unit/session-origin.test.ts` and a new `tests/unit/projects-conversations.test.ts`:
   a worker under an app terminal is `dispatch`, not `app-terminal`; two Codex rollouts in one folder
   with one live process → one live row; a session within 10 minutes of an unrelated dispatch carries
   no dispatch id; one row per conversation when a chat, its TUI and its log all report it.
6. **Dispatch panes never land on the app's tmux server.** `src/hosts/tmux.ts` (`createTmuxSession`,
   split calls at `:182-202`, `:256-257`): when the caller's `$TMUX` socket is `megabrain-app`, spawn
   on megabrain's own dispatch server with `-L`. Tests: `tests/unit/terminal-tmux.test.ts` — with
   `TMUX=/…/megabrain-app,…` every tmux argv for a spawn carries the dispatch server.
7. **Sidebar renders the conversation list.** `apps/desktop/src/advanced/row-model.ts` (replace
   claim-by-guess with the `owner` and aliases from projects; no `claimRun`),
   `apps/desktop/src/terminal/terminal-list.ts` (`restoreAppTerminals` only for registry entries),
   `apps/desktop/src/advanced/Sidebar.tsx` (Other sessions group, collapsed; toggles "Show ended" and
   "Show agent workers"), `apps/desktop/src/api/schema.ts` (owner field),
   `apps/desktop/src/advanced/Advanced.tsx:92-95` (stop calling `sessionsOfOrigin`).
   Tests: `row-model.test.ts` (one row per conversation for chat + TUI + log; worker rows absent by
   default), `terminal-list.test.ts` (no restore of an unregistered tmux session).
8. **One Close per owner.** `apps/desktop/src/advanced/Advanced.tsx:452-498` (`requestClose` keyed by
   owner; Release dialog removed), `apps/desktop/src/chat/session-ownership.ts` (`closable` from
   owner), `apps/desktop/src/advanced/item-menus.ts`, `src/cli/commands/session.ts` (release removes the
   registry entry; refuses a tmux session that hosts dispatch panes unless confirmed),
   `apps/desktop/src/advanced/hidden-sessions.ts` → registry `hidden`.
   Tests: `item-menus.test.ts` (each owner has exactly one close entry and no Release),
   `tests/unit/app-session-ownership.test.ts` (closing a terminal attached to an owned session kills
   it and drops the entry), `tests/unit/session-ownership.test.ts`.
9. **Retire the old files.** After one release: stop reading `owned-sessions.json`,
   `app-terminals.json`, `hidden-sessions.json`; `settings get/set hidden-sessions` maps to the
   registry. Tests: the migration test asserts the files are no longer read once `migratedFrom` is set.

Order: 1 → 2 → (3, 4, 6 in parallel; disjoint files) → 5 → 7 → 8 → 9. Tasks 3, 4 and 6 are where
rows stop being *created* wrongly; 5, 7 and 8 are where they stop being *shown* and *closed* wrongly.

## Open questions for the person

- Empty chats from before the change: hide (proposed) or delete outright on migration?
- Should a dispatch worker ever be closable from the app (as `orchestrate close` on the coordinator's
  behalf), or only hidden (proposed)?
- Ended conversations of ours: show for how long — forever while the record exists (proposed), or the
  same 1-day / 7-day windows as today?
