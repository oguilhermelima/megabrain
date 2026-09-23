# Shell-removal map

This is a source-trace map, not a runtime test result. The line counts below are physical
lines in the shell function body, excluding the function declaration and including its closing
brace. A helper is counted only when it is reachable from the removed body and has no remaining
production caller. Shared helpers are counted once in the proposed lane, not once per row.

The 31 dispatch guards agree with the stated count when the definition of
`megabrain_should_use_typescript_binary` in `lib/common.sh` is excluded. The spawn guard was
retired with the Bash implementation: `orchestrate spawn` now requires and invokes the compiled
binary directly, and an explicit `MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=shell` fails because no
shell implementation remains.

## `lib/module-orchestrate.sh`

| subverb | TypeScript file and function | port complete | lines deletable | helpers that must stay and why |
|---|---|---:|---:|---|
| `orchestrate liveness` (guard at line 600) | `src/cli/commands/orchestrate-read-liveness.ts` — `executeOrchestrateLiveness` | yes* | 14 | `megabrain_dispatch_liveness_read` is also called by shell `stop`; its `megabrain_dispatch_meta_read` path is used by spawn, and `megabrain_dispatch_terminal_status` is used by reconcile, close, stop, and spawn lifecycle checks. |
| `orchestrate reconcile` (guard at line 1042) | `src/cli/commands/orchestrate-stop-reconcile.ts` — `executeOrchestrateReconcile` | yes | 50 | `megabrain_dispatch_reconcile_one`, `megabrain_dispatch_reconcile_update`, metadata normalization, prompt receipt synchronization, terminal identity, and parent-status helpers remain because doctor, spawn, hooks, and lifecycle paths call them directly. |
| `orchestrate read` (guard at line 2190) | `src/cli/commands/orchestrate-read-liveness.ts` — `executeOrchestrateRead` | yes | 65 | The compiled path owns host read-back, tmux capture, and persisted transcript rendering. Shared transcript lifecycle helpers and terminal metadata helpers remain for spawn, close, liveness, and hooks. |
| `orchestrate watch` (guard at line 2266) | `src/cli/commands/orchestrate-parent.ts` — `executeOrchestrateWatch` | no | 0 | The TypeScript parser accepts `--wait-mode nudge` but the loop only sleeps; the shell registers/unregisters a parent waiter and waits for event-driven wake-up. The shared `megabrain_dispatch_mailbox_watch` is also the child reader used by `check` and by the turn-end hook. |
| `orchestrate ack` and child `ack` (guard at line 2412) | `src/cli/commands/orchestrate-parent.ts` — `executeOrchestrateAck`; `src/cli/commands/child-ack.ts` — `executeChildAck` | no | 0 | The parent TypeScript parser always defaults generation to `1` instead of reading `MEGABRAIN_CONSUMER_GENERATION`; child reply detection checks one padded filename while shell scans all messages for the delivery sequences. The shell `ack_for_owner` also reaches queue locks, message append, child lookup, and close. |
| `orchestrate stop` (guard at line 2670) | `src/cli/commands/orchestrate-stop-reconcile.ts` — `executeOrchestrateStop` | yes | 107 | The compiled path proves tmux process identity, applies the agent interrupt affordance, proves Orca terminal identity, and preserves queue-message helpers. The shell terminal-status, native-interrupt, liveness, and metadata helpers remain shared lifecycle code. |
| `ask` (guard at line 2955) | `src/cli/commands/queue-write.ts` — `executeQueueWrite("ask", ...)` | yes | 13 (+ shared 35 once in the queue lane) | `megabrain_dispatch_find_child` is also used by child `check`/`ack`; message append, metadata reads/updates, and prompt-receipt synchronization are used by spawn and queue lifecycle. The shared `megabrain_dispatch_child_message` body is counted once with this three-verb lane. |
| `received` (guard at line 2969) | `src/cli/commands/queue-write.ts` — `executeQueueWrite("received", ...)` | yes | 12 (+ shared 35 once in the queue lane) | Same shared closure as `ask`; in particular, do not delete `megabrain_dispatch_meta_update_*` or `megabrain_dispatch_sync_prompt_receipt`, which spawn reaches directly. |
| `done` (guard at line 2982) | `src/cli/commands/queue-write.ts` — `executeQueueWrite("done", ...)` | yes | 12 (+ shared 35 once in the queue lane) | Same shared closure as `ask`; the shared shell body is also the only shell implementation behind these three wrappers, so remove it only after all three wrappers are retired together. |
| `check` (guard at line 2995) | `src/cli/commands/check.ts` — `executeCheck` | yes | 8 | This row's original claim — that `megabrain_dispatch_child_check` and `megabrain_dispatch_mailbox_watch` must stay because `hooks/megabrain-turn-end.sh:94` called the child function directly, outside the CLI guard — is stale on two counts: the turn-end hook stopped sourcing lib/ before that wrapper script was itself deleted, and `src/cli/commands/hook-turn-end.ts` now calls the compiled `executeCheck` directly (see its own comments), not this shell function. Whether either shell helper still has a production caller elsewhere is unverified here and is a question for whoever ports `check`'s remaining shell lifecycle code, not this hooks migration. |

The liveness row is complete for the managed-parent contract exercised by the command. The shell
also permits an unmanaged caller to read a dispatch without ownership validation, whereas
TypeScript rejects that caller; whether that legacy behavior is supported is listed as unknown
below. It is not a reason to delete the shared liveness reader.

## `lib/module-worktree.sh`

| subverb | TypeScript file and function | port complete | lines deletable | helpers that must stay and why |
|---|---|---:|---:|---|
| `terminal list` (guard at line 1431) | `src/cli/commands/terminal-list.ts` — `executeTerminalList` | yes | 54 | `megabrain_worktree_root_for_selector` is used by spawn/worktree operations; host-record, host-id, and process-status helpers are used by terminal create/restart/close lifecycle. |
| `worktree create` | `src/cli/commands/worktree-write.ts` — `executeWorktreeCreate` | yes | 0 | The compiled command owns create; spawn is routed separately to `executeSpawn`. The Bash create and spawn bodies, including their exclusive helpers, are removed. |
| `worktree finish` (guard at line 1976) | `src/cli/commands/worktree-write.ts` — `executeWorktreeFinish` | yes | 167 | The compiled contract now covers base/source/warning metadata, structured refusals/errors, merge guarding, and Superset/Orca/Git removal. The shell wrapper remains only as a binary boundary; root and selector helpers remain for terminal lifecycle and module doctor. |
| `worktree pr` (guard at line 2523) | `src/cli/commands/worktree-write.ts` — `executeWorktreePr` | yes | 69 | The compiled command owns pull-request resolution; the old shell-only helpers are no longer retained for create or spawn. |
| `worktree list` (guard at line 2611) | `src/cli/commands/worktree-list.ts` — `executeWorktreeList` | yes | 215 (198 body + 17 `megabrain_worktree_list_tree_node`) | The recursive tree formatter is reached only by this shell verb and is removable with it. Root, Orca/Superset discovery, Git parsing, and PR discovery helpers are shared with other worktree operations or host lifecycle. |
| `worktree adopt` (guard at line 2810) | `src/cli/commands/worktree-adopt.ts` — `executeWorktreeAdopt` | yes | 51 | The compiled command owns repository and Superset registration; the retained shell root/selector helpers serve terminal lifecycle and module doctor. |
| `terminal create` (guard at line 2890) | `src/cli/commands/terminal-lifecycle.ts` — `executeTerminalLifecycle("create", ...)` | no | 0 | TypeScript requires `--command`; shell can derive the command from `.superset/config.json`, wraps identity markers/agent permissions, and records host-derived process identity. |
| `terminal restart` (guard at line 2901) | `src/cli/commands/terminal-lifecycle.ts` — `executeTerminalLifecycle("restart", ...)` | no | 0 | TypeScript parses `--wait-port` and `--timeout` but does not implement the shell's port-free/listening waits or process-tree ownership checks. |
| `terminal close` (guard at line 2911) | `src/cli/commands/terminal-lifecycle.ts` — `executeTerminalLifecycle("close", ...)` | no | 0 | The TypeScript route is part of the incomplete lifecycle port; the shell verifies the host terminal, handles stale records, and retains/removes records according to host identity. |

## `lib/module-context.sh`

The rows below refer to the guarded bodies reached through `command_context`,
`command_orchestrate`, and `command_orchestrate_list`. The dispatcher itself is shared and is not a
deletion unit.

| subverb | TypeScript file and function | port complete | lines deletable | helpers that must stay and why |
|---|---|---:|---:|---|
| `context` (guard at line 23) | `src/cli/commands/context.ts` — `executeContext` | yes | **0, do not remove** | `megabrain_context_detect`, `megabrain_session_id`, and `megabrain_resolve_parent_context` are called by spawn and parent/lifecycle setup. The body itself also stays: `tests/test-clean-install.sh` requires `megabrain context --json` to answer in a release that has no compiled binary, because `context` reports which host the session is in and that has to work before anything else does. Port completeness is not the only criterion; availability without the binary is a separate, deliberate decision per verb. A removal attempt on 2026-09-18 was caught by that contract and reverted. |
| `orchestrate prune` (guard at line 54) | `src/cli/commands/orchestrate-prune.ts` — `executeOrchestratePrune` | no | 0 | TypeScript filters and moves/deletes records but does not perform the shell's reconcile-before-prune flow or release/retain terminal identity safely. Keep the full shell body and its release helpers. |
| `orchestrate reply` (guard at line 67) | `src/cli/commands/orchestrate-reply.ts` — `executeOrchestrateReply` | yes | 67 | Parent/session validation, queue locks, append/delivery notification, superseding, and metadata state updates are shared with `change`, child queue operations, or spawn. |
| `orchestrate change` (guard at line 76) | `src/cli/commands/orchestrate-reply.ts` — `executeOrchestrateChange` | no | 0 | TypeScript hard-codes the non-interrupted result after queuing the replacement and does not reproduce the shell's call to the real stop path and its host-specific interrupt behavior. |
| `orchestrate close` (guard at line 84) | `src/cli/commands/orchestrate-close.ts` — `executeOrchestrateClose` | no | 0 | TypeScript closes the dispatch metadata but does not reproduce the shell's process-state transition and all transcript/native-close outcome handling. Retained-terminal and host release helpers must remain. |
| `orchestrate list` (guard at line 362) | `src/cli/commands/orchestrate-list.ts` — `executeOrchestrateList` | no | 0 | Shell derives ownership through `megabrain_session_id`, including tmux/generic `MEGABRAIN_SESSION_*`; TypeScript only derives caller identity from Superset/Orca terminal variables. That changes default owned filtering for tmux and generic managed sessions. |

## What has already been removed

Lanes 1 through 6 below were executed on 2026-09-18, except where noted. `terminal list`,
`worktree adopt`, `worktree pr`, `worktree list` with its private tree formatter, `ask`, `received`,
`done`, `check`, `orchestrate reply`, the liveness wrapper body, `orchestrate reconcile`,
`orchestrate read`, `orchestrate stop`, `worktree create`, and `orchestrate spawn` are gone. `context` was attempted
and reverted, for the reason in its row.

Two things a later reader needs, because both were learned by getting them wrong here:

- `worktree list` was blocked until issue #38 closed. Its row said the port was complete when it was
  not: `--repo` by name was refused by the binary and worked in the shell, and no contract exercised
  `--repo` at all. Check a verb against every form of invocation it accepts, not only the forms the
  existing contracts happen to cover.
- A thin wrapper must call `megabrain_warn_if_typescript_binary_stale` after its missing-binary
  refusal. Eight migrations dropped that notice silently before anyone noticed, which was issue #39.
  `tests/test-binary-freshness.sh` now derives its subject list by scanning `lib/module-*.sh`, so a
  new wrapper without the call turns it red on its own.

## Proposed removal lanes

Only the `yes` rows are candidates. The following order keeps shared helper decisions explicit:

1. Remove `terminal list`, `worktree adopt`, and `worktree pr` bodies. Keep all helpers named in
   their rows. The `context` body was in this lane and must not be: see its row.
2. Remove `worktree list` and then its private recursive `megabrain_worktree_list_tree_node` helper.
3. Remove `ask`, `received`, and `done` together. Remove their three wrappers and the shared
   `megabrain_dispatch_child_message` body once; retain `find_child`, queue writers, metadata
   helpers, and prompt-receipt helpers. Note six test files called
   `megabrain_dispatch_child_message` directly as a fixture; they were migrated to drive the
   compiled CLI instead. The claim below that it had no caller outside the three wrappers was about
   *production* callers and was true as written, which did not help the person deleting it.
4. Remove only the `command_check` dispatch body. The claim that the turn-end hook calls
   `megabrain_dispatch_child_check` and `megabrain_dispatch_mailbox_watch` directly is stale (see
   the `check` row above): the hook is a compiled binary now, with no shell script left at all.
   Re-verify whether either helper still has a caller before removing it.
5. Remove `orchestrate reply` and the liveness wrapper body. Retain reply/queue helpers and
   `megabrain_dispatch_liveness_read`, which remains a shared shell liveness reader.
6. Remove the `orchestrate reconcile`, `orchestrate read`, and `orchestrate stop` bodies together
   only after their compiled contracts prove routing, transcript content, prompt receipts, parent
   identity, and interrupt identity safety. Retain the helpers named in their rows.
7. Remove the `worktree create` and `orchestrate spawn` Bash bodies together after the compiled
   create and spawn contracts prove routing, failure behavior, and the absence of a shell fallback.

The `no` rows are a hold lane, not deletion candidates. In particular, do not group
`worktree create` with ordinary worktree writes: its compiled route owns both worktree creation
and the create phase of spawn.

## Claims based on grep alone

The following are absence claims from token search, not proof by execution:

- `megabrain_worktree_list_tree_node` has no production caller other than the recursive function
  itself and `megabrain_worktree_list`.
- `megabrain_dispatch_child_message` has no production caller other than the `ask`, `received`,
  and `done` wrappers.
- `megabrain_dispatch_host_terminal_read` and `megabrain_dispatch_render_transcript` have no
  shell production caller after `megabrain_dispatch_read` is removed; transcript stream start,
  stop, and metadata helpers remain independently reachable from lifecycle code.
- `megabrain_worktree_parent_branch` is referenced by shell `finish` and `pr`; therefore it was
  not classified as private to `pr`.
- The 31 dispatch-guard count was obtained with `rg`; it excludes the helper definition in
  `lib/common.sh` and includes the six context guards, nineteen listed guards in the two large
  modules, and the remaining guards outside this scope.

All other edges cited above were established by reading the case branches and function bodies,
including variable-selected owner branches, the `source module-chain.sh` edge in spawn, the
nested `megabrain_worktree_removal_reason` definition, and the direct hook call that
`hooks/megabrain-turn-end.sh` made before it stopped sourcing lib/ and was later deleted
entirely; that edge no longer exists (see the `check` row above).

## Unknowns

- It is unknown whether TypeScript's stricter liveness ownership check is an intentional contract
  change or an accidental difference; the shell accepts an unmanaged caller while TypeScript
  requires the parent identity.
- It is unknown whether every host payload shape returned by Orca, Superset, and `gh` is covered
  by the TypeScript list/lifecycle normalizers. No real host, tmux server, browser, or simulator
  was contacted, as required by the brief.
- No runtime parity gate was run: the brief forbids the Bash test/container gate, and this report
  is based on source tracing plus the existing test scenarios' assertions.
