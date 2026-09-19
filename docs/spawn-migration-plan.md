# Spawn migration plan

`orchestrate spawn` is the last verb still implemented in bash. This plan covers separating it from
`worktree create`, moving it to TypeScript, and the two abstractions that have to exist first.

Read `docs/spawn-map.md` alongside this. That file is the source-traced description of what spawn
does today; this one is what to do about it.

## The decision

Spawn does not know how to create a worktree. It knows who does.

`--worktree <name>` on a target that does not exist means spawn resolves that the worktree is
missing, calls the command that owns worktree creation, receives a path, and continues. If worktree
registration changes later, spawn does not change.

That is the whole boundary, and it is the difference between delegation and composition: the
knowledge of how to build a worktree lives in exactly one place, and spawn holds a reference to it
rather than a copy.

Spawn is an orchestrator. Depending on what it is given, it arranges the conditions for an agent to
work, and the agent is told fewer rules rather than more. Every rule that currently lives in an
operator's notes about which command to run first is a rule that belongs here.

## The contract between the two halves

The map states the real cost of separating them, and it is not the function boundary:

> The current code does not require the worktree and dispatch halves to share a function; it
> requires them to share ownership and cleanup information.

So the contract that passes from worktree to dispatch carries:

- the path and the branch
- the workspace id and the host terminal capability, so dispatch does not rediscover them
- the base and its provenance
- the parent and issue link outcomes
- **whether this invocation created the worktree**

The last field is the one that matters most. Without it, a dispatch failure has no way to know it
must not remove a worktree it did not create. Issue #44 is that defect in its current form: a launch
failure runs `git worktree remove --force` and `git branch -D` even though the agent is already
running and may have written files. The separation makes that impossible by construction, and #44
fixes it in bash beforehand so the hazard does not wait for this work.

## The flag split

From the map, and it is cleaner than the current help suggests:

| owner | flags |
| --- | --- |
| dispatch | `--agent`, `--chain`, `--model`, `--effort`, `--prompt`, `--label`, `--tmux`, `--browser`, `--agent-arg` |
| worktree | `--repo`, `--branch`, `--base`, `--name`, `--worktree` |
| both | `--json`, which affects output and nested chain forwarding but is not dispatch state |

The parser also silently accepts `--from`, `--parent`, `--no-parent`, `--issue`, `--linear-issue`
and `--pr`, which spawn's help does not advertise. They belong to worktree creation and should be
explicit there rather than retained as undocumented spawn flags.

`--orchestrate` is not an operator flag. It is the marker that suppresses the TypeScript route for
`worktree create`, which is how "spawn has not migrated yet" got encoded. It disappears when spawn
has its own command path.

## Two strategies, discovered rather than designed

### Agents

Per-agent rules are currently spread across eight sites, half bash and half TypeScript:

| site | what it decides |
| --- | --- |
| `lib/module-worktree.sh:3-5` | how to pass model and effort: Codex uses `-c model="%s"`, Claude uses `--model`, agy takes `--model` only |
| `lib/module-worktree.sh:7+` | the valid model ids for agy |
| `lib/module-tmux-runtime.sh:380-388` | which key submits: Claude is `Enter`, Codex is `Tab`; `Escape` interrupts both |
| `lib/module-orchestration-hooks.sh:13-15` | the hook config path |
| `lib/module-orchestration-hooks.sh:56-58` | which trust prompt each one shows |
| `lib/module-chain.sh:646,673` | chain selection branches |
| `src/core/context.ts:41-59` | identity detection |
| `src/core/liveness.ts:5-7` | the pane-text patterns that mean working, idle or blocked |

Adding a fourth agent today means finding all eight. The agy turn-end hook has never fired because
one line among them points at `~/.agy/hooks.json` while agy reads `~/.gemini/config/hooks.json`, and
nothing owns "everything about agy" where that would have been noticed.

So: `src/agents/{claude,codex,agy}.ts` behind one interface, with the members taken from that table
rather than invented. Every implementation implements everything. An implementation that cannot do
something returns a refusal rather than degrading silently, using the existing
`refusal: { code, message }` convention already used in `src/core/parent-queue.ts` and
`src/core/worktree-write.ts`.

The caller branches on the refusal code, not on a capability flag. A capability flag would be a
second source of truth about the same fact, free to drift from the implementation. The refusal keeps
one source of truth and puts the distinction where it belongs.

The distinction the caller needs is between *this agent has no such channel*, which may fall back to
typing into a pane, and *the send failed*, which must not, because falling back after a real failure
can deliver a message twice.

Issue #9 records what this unlocks: every agent already exposes its own session identity, name and
liveness, and two of the three expose a message channel that needs no keystrokes. None of it is used
today, because there is no place for that knowledge to live.

### Hosts, which are two abstractions rather than one

tmux is not interchangeable with Orca and Superset. tmux gives a session whose panes can be split,
waited on, configured and read. Orca and Superset give a tab that cannot be opened or read. The
current code already reflects this: `megabrain_tmux_cleanup_launch` and
`megabrain_host_cleanup_launch` are different functions with different signatures, not two
implementations of one idea.

So the split is:

- a **terminal provider**, which can create a place to run and send text to it: Orca, Superset, and
  tmux when that is all that is needed
- an **observable runtime**, which additionally exposes panes, layout and scrollback: tmux only

This explains the 261 MB of transcripts recorded in #9. megabrain records the screen because under
Orca there is no other way to know what happened. Under tmux there is. A design that treats them as
one interface has to record the screen always, which is how that cost was incurred.

`src/cli/commands/terminal-lifecycle.ts:108` already dispatches by host and returns
`{ command, args }`, with `undefined` for an unknown host. That is the terminal provider in
embryonic form; it should be finished rather than replaced.

## Phases

### Phase 1: the two strategies

`src/agents/*` and the host provider, with the interfaces taken from the tables above. Nothing in
spawn depends on this being done first in the sense of compiling, but everything depends on it in
the sense of not reproducing eight scattered `case` statements inside a new `executeSpawn`.

Deliverable: the existing scattered sites call the strategy instead of switching inline. This is
verifiable on its own, against the current bash spawn, because the behaviour must not change.

### Phase 2: tmux runtime in TypeScript

`src/core/tmux.ts` today covers only the `tune` and `wrapper` config editing. There is no
`new-session` and no `split-window` anywhere in `src/`. The runtime needs: create or reuse a session
for a worktree, split a pane, wait for the session, point the state directory, apply config, find
the first pane, send text with the submit key, and retry the submit without retyping.

This is the phase that unblocks the most unrelated work: `lib/module-tmux-runtime.sh` is 1375 lines,
of which roughly 870 are runtime consumed from outside the module.

### Phase 3: the prompt state machine, alone

Eleven named failure reasons exist today: `prompt-publication-failed`, `command-not-submitted`,
`readiness-timeout`, `readiness-output-invalid`, `prompt-transport-failed`,
`prompt-confirmation-failed`, `transcript-start-failed`, `state-persist-failed`,
`metadata-read-failed`, `model-substitution-record-failed`, `prompt-state-persist-failed`.

This is the most valuable part of the current implementation and the riskiest to reimplement. The
map says why: the transaction spans three identities, the parent terminal, the child host terminal
and the child dispatch process, and it has a deliberate timeout that returns success while leaving
the dispatch open for `reconcile`. A rewrite that launches and then marks running loses the
reconcile path and misclassifies a live but slow child.

Port it as pure core: the states, the legal transitions, the reasons. Testable with no tmux, no host
and no agent. A defect here is expensive and a test here is cheap.

### Phase 4: separate the verbs, still in bash

Extract the dispatch half out of `megabrain_worktree_create`, leaving it with worktree concerns
only. The `--orchestrate` guard disappears. This is work in code that will be deleted, and it is
worth it because it turns phase 5 into a series of verifiable steps instead of one 733-line jump.

### Phase 5: `executeSpawn` in TypeScript

Composes: resolve the worktree, delegating creation when it is missing; select the agent through the
strategy; create the terminal through the provider; write the dispatch record; publish; transport;
confirm.

### Phase 6: delete the bash

The established recipe: rewrite the contract to assert the compiled binary, break the TypeScript and
confirm red, only then delete the shell, break it again and confirm still red.

## What must survive the rewrite

From the map's judgement section, and each of these earned its place:

- **The staged dispatch record.** Metadata is published before the queue directories are complete,
  publication is separate from transport and receipt, and the transition table rejects illegal
  changes. This is what lets `reconcile` distinguish not-published, transported-but-unconfirmed,
  confirmed, failed and terminal-cleanup instead of collapsing them into one exit code.
- **The child identity proof.** A `child/received` message is evidence tied to the dispatch
  identity, and the tmux path matches session plus pane rather than trusting a host terminal id
  shared by several panes.
- **Bounded transport.** Atomic queue writes, a lock around sequence allocation, tmux send locking,
  and retrying the submit key without retyping the prompt. These prevent duplicate prompts and
  interleaved input.
- **Validation before side effects.** Prompt budget, model validity and agent presence are all
  checked before `git worktree add` runs. Cheap refusal before expensive mutation.

## What this unlocks

The capabilities requested for spawn all depend on state that does not exist yet, and the tables for
them are in #42:

- registering every agent and session, with history that survives the dispatch being closed
- a cap on concurrent sessions, which becomes a count query against a configured maximum instead of
  a directory walk
- reading Claude, Codex and agy usage limits efficiently, which is per-agent knowledge and therefore
  belongs to the agent strategy
- richer communication, which is #9 and depends on the agent strategy exposing each agent's own
  channel

Separating spawn also removes the last bash writer of the dispatch store, which is what #42 needs
before `dispatches` can move to SQLite. Two writers on one database is worse than two writers on
JSON files, because the lock fails visibly where JSON interleaves silently.

## Related issues

- #44 — the launch-failure rollback deletes the worktree; fixed in bash ahead of this work
- #42 — SQLite, session history, limits, and facts
- #9 — address agents by their own session, not by their terminal
- #22 — dispatch ownership is lost when the terminal handle changes
- #43 — `executeInstall` reports status and never installs, which blocks the tmux removal
