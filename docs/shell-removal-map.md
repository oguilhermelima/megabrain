# Shell-removal map

This is a source-trace map, not a runtime test result. The line counts below are physical
lines in the shell function body, excluding the function declaration and including its closing
brace. A helper is counted only when it is reachable from the removed body and has no remaining
production caller. Shared helpers are counted once in the proposed lane, not once per row.

The 31 dispatch guards agree with the stated count when the definition of
`megabrain_should_use_typescript_binary` in `lib/common.sh` is excluded. The spawn guard is
different from the other guards: `megabrain_worktree_create` scans all arguments for the exact
`--orchestrate` flag first, and the binary condition is evaluated only when that scan remains
false. Therefore `orchestrate spawn` always enters the shell implementation, even with a binary
present and even if `MEGABRAIN_WORKTREE_WRITE_IMPLEMENTATION=binary` is set.

## `lib/module-orchestrate.sh`

| subverb | TypeScript file and function | port complete | lines deletable | helpers that must stay and why |
|---|---|---:|---:|---|
| `orchestrate liveness` (guard at line 600) | `src/cli/commands/orchestrate-read-liveness.ts` — `executeOrchestrateLiveness` | yes* | 14 | `megabrain_dispatch_liveness_read` is also called by shell `stop`; its `megabrain_dispatch_meta_read` path is used by spawn, and `megabrain_dispatch_terminal_status` is used by reconcile, close, stop, and spawn lifecycle checks. |
| `orchestrate reconcile` (guard at line 1042) | `src/cli/commands/orchestrate-stop-reconcile.ts` — `executeOrchestrateReconcile` | no | 0 | The shell body must remain. Its transitive graph includes prompt normalization/receipt synchronization, host-terminal identity checks, parent-status checks, and `megabrain_dispatch_reconcile_update`; those are not all represented by the TypeScript command. |
| `orchestrate read` (guard at line 2190) | `src/cli/commands/orchestrate-read-liveness.ts` — `executeOrchestrateRead` | no | 0 | The TypeScript source references `resolved` in the tmux transcript fallback although no such variable is in scope (line 64); it also cannot be treated as a complete port until that path is fixed. Shell transcript helpers are shared with spawn/close. |
| `orchestrate watch` (guard at line 2266) | `src/cli/commands/orchestrate-parent.ts` — `executeOrchestrateWatch` | no | 0 | The TypeScript parser accepts `--wait-mode nudge` but the loop only sleeps; the shell registers/unregisters a parent waiter and waits for event-driven wake-up. The shared `megabrain_dispatch_mailbox_watch` is also the child reader used by `check` and by the turn-end hook. |
| `orchestrate ack` and child `ack` (guard at line 2412) | `src/cli/commands/orchestrate-parent.ts` — `executeOrchestrateAck`; `src/cli/commands/child-ack.ts` — `executeChildAck` | no | 0 | The parent TypeScript parser always defaults generation to `1` instead of reading `MEGABRAIN_CONSUMER_GENERATION`; child reply detection checks one padded filename while shell scans all messages for the delivery sequences. The shell `ack_for_owner` also reaches queue locks, message append, child lookup, and close. |
| `orchestrate stop` (guard at line 2670) | `src/cli/commands/orchestrate-stop-reconcile.ts` — `executeOrchestrateStop` | no | 0 | TypeScript does not prove the tmux process identity before interrupting, does not use the shell interrupt-affordance lookup, and treats Orca as working without the shell terminal identity check. The shell body reaches liveness, terminal identity, native interrupt, and queue-message helpers. |
| `ask` (guard at line 2955) | `src/cli/commands/queue-write.ts` — `executeQueueWrite("ask", ...)` | yes | 13 (+ shared 35 once in the queue lane) | `megabrain_dispatch_find_child` is also used by child `check`/`ack`; message append, metadata reads/updates, and prompt-receipt synchronization are used by spawn and queue lifecycle. The shared `megabrain_dispatch_child_message` body is counted once with this three-verb lane. |
| `received` (guard at line 2969) | `src/cli/commands/queue-write.ts` — `executeQueueWrite("received", ...)` | yes | 12 (+ shared 35 once in the queue lane) | Same shared closure as `ask`; in particular, do not delete `megabrain_dispatch_meta_update_*` or `megabrain_dispatch_sync_prompt_receipt`, which spawn reaches directly. |
| `done` (guard at line 2982) | `src/cli/commands/queue-write.ts` — `executeQueueWrite("done", ...)` | yes | 12 (+ shared 35 once in the queue lane) | Same shared closure as `ask`; the shared shell body is also the only shell implementation behind these three wrappers, so remove it only after all three wrappers are retired together. |
| `check` (guard at line 2995) | `src/cli/commands/check.ts` — `executeCheck` | yes | 8 | `megabrain_dispatch_child_check` and `megabrain_dispatch_mailbox_watch` must stay: `hooks/megabrain-turn-end.sh:94` calls the child function directly, outside the CLI guard. Delivery matching, claiming, fencing, and reporting therefore remain shell lifecycle code. |

The liveness row is complete for the managed-parent contract exercised by the command. The shell
also permits an unmanaged caller to read a dispatch without ownership validation, whereas
TypeScript rejects that caller; whether that legacy behavior is supported is listed as unknown
below. It is not a reason to delete the shared liveness reader.

## `lib/module-worktree.sh`

| subverb | TypeScript file and function | port complete | lines deletable | helpers that must stay and why |
|---|---|---:|---:|---|
| `terminal list` (guard at line 1431) | `src/cli/commands/terminal-list.ts` — `executeTerminalList` | yes | 54 | `megabrain_worktree_root_for_selector` is used by spawn/worktree operations; host-record, host-id, and process-status helpers are used by terminal create/restart/close lifecycle. |
| `worktree create` (guard at line 1908) | `src/cli/commands/worktree-write.ts` — `executeWorktreeCreate` | no | 0 | The TypeScript parser lacks the spawn-only flags (`--orchestrate`, `--agent`, `--model`, `--effort`, `--chain`, `--prompt`, `--label`, `--tmux`, `--browser`, and `--agent-arg`). More importantly, the guarded shell body is the spawn implementation and reaches launch, prompt publication/transport/receipt, dispatch metadata, rollback, and chain helpers. |
| `worktree finish` (guard at line 2355) | `src/cli/commands/worktree-write.ts` — `executeWorktreeFinish` | no | 0 | The shell JSON contract includes `baseSource`, `baseWarning`, structured refusal/error fields, and host-specific removal handling; TypeScript emits null/default metadata in paths where shell computes it. Its target, parent-base, root, and repository helpers are also shared with `pr` and worktree operations. |
| `worktree pr` (guard at line 2523) | `src/cli/commands/worktree-write.ts` — `executeWorktreePr` | yes | 69 | `megabrain_worktree_target_path`, `megabrain_worktree_parent_branch`, `megabrain_repo_default_base`, and root/selector helpers are shared with `finish`, create, or spawn. No helper below this body is independently removable. |
| `worktree list` (guard at line 2611) | `src/cli/commands/worktree-list.ts` — `executeWorktreeList` | yes | 215 (198 body + 17 `megabrain_worktree_list_tree_node`) | The recursive tree formatter is reached only by this shell verb and is removable with it. Root, Orca/Superset discovery, Git parsing, and PR discovery helpers are shared with other worktree operations or host lifecycle. |
| `worktree adopt` (guard at line 2810) | `src/cli/commands/worktree-adopt.ts` — `executeWorktreeAdopt` | yes | 51 | Root/selector resolution, repository resolution, Superset project registration, and workspace creation are shared with worktree create/spawn and other lifecycle paths. |
| `terminal create` (guard at line 2890) | `src/cli/commands/terminal-lifecycle.ts` — `executeTerminalLifecycle("create", ...)` | no | 0 | TypeScript requires `--command`; shell can derive the command from `.superset/config.json`, wraps identity markers/agent permissions, and records host-derived process identity. |
| `terminal restart` (guard at line 2901) | `src/cli/commands/terminal-lifecycle.ts` — `executeTerminalLifecycle("restart", ...)` | no | 0 | TypeScript parses `--wait-port` and `--timeout` but does not implement the shell's port-free/listening waits or process-tree ownership checks. |
| `terminal close` (guard at line 2911) | `src/cli/commands/terminal-lifecycle.ts` — `executeTerminalLifecycle("close", ...)` | no | 0 | The TypeScript route is part of the incomplete lifecycle port; the shell verifies the host terminal, handles stale records, and retains/removes records according to host identity. |

## `lib/module-context.sh`

The rows below refer to the guarded bodies reached through `command_context`,
`command_orchestrate`, and `command_orchestrate_list`. The dispatcher itself is shared and is not a
deletion unit.

| subverb | TypeScript file and function | port complete | lines deletable | helpers that must stay and why |
|---|---|---:|---:|---|
| `context` (guard at line 23) | `src/cli/commands/context.ts` — `executeContext` | yes | 25 | `megabrain_context_detect`, `megabrain_session_id`, and `megabrain_resolve_parent_context` are called by spawn and parent/lifecycle setup. |
| `orchestrate prune` (guard at line 54) | `src/cli/commands/orchestrate-prune.ts` — `executeOrchestratePrune` | no | 0 | TypeScript filters and moves/deletes records but does not perform the shell's reconcile-before-prune flow or release/retain terminal identity safely. Keep the full shell body and its release helpers. |
| `orchestrate reply` (guard at line 67) | `src/cli/commands/orchestrate-reply.ts` — `executeOrchestrateReply` | yes | 67 | Parent/session validation, queue locks, append/delivery notification, superseding, and metadata state updates are shared with `change`, child queue operations, or spawn. |
| `orchestrate change` (guard at line 76) | `src/cli/commands/orchestrate-reply.ts` — `executeOrchestrateChange` | no | 0 | TypeScript hard-codes the non-interrupted result after queuing the replacement and does not reproduce the shell's call to the real stop path and its host-specific interrupt behavior. |
| `orchestrate close` (guard at line 84) | `src/cli/commands/orchestrate-close.ts` — `executeOrchestrateClose` | no | 0 | TypeScript closes the dispatch metadata but does not reproduce the shell's process-state transition and all transcript/native-close outcome handling. Retained-terminal and host release helpers must remain. |
| `orchestrate list` (guard at line 362) | `src/cli/commands/orchestrate-list.ts` — `executeOrchestrateList` | no | 0 | Shell derives ownership through `megabrain_session_id`, including tmux/generic `MEGABRAIN_SESSION_*`; TypeScript only derives caller identity from Superset/Orca terminal variables. That changes default owned filtering for tmux and generic managed sessions. |

## Proposed removal lanes

Only the `yes` rows are candidates. The following order keeps shared helper decisions explicit:

1. Remove the isolated `context` dispatcher body, `terminal list`, `worktree adopt`, and
   `worktree pr` bodies. Keep all helpers named in their rows.
2. Remove `worktree list` and then its private recursive `megabrain_worktree_list_tree_node` helper.
3. Remove `ask`, `received`, and `done` together. Remove their three wrappers and the shared
   `megabrain_dispatch_child_message` body once; retain `find_child`, queue writers, metadata
   helpers, and prompt-receipt helpers.
4. Remove only the `command_check` dispatch body. Leave `megabrain_dispatch_child_check` and
   `megabrain_dispatch_mailbox_watch` because the turn-end hook calls them directly.
5. Remove `orchestrate reply` and the liveness wrapper body. Retain reply/queue helpers and
   `megabrain_dispatch_liveness_read`, which the still-shell `stop` path reaches.

The `no` rows are a hold lane, not deletion candidates. In particular, do not group
`worktree create` with ordinary worktree writes: the `--orchestrate` guard makes it the spawn
implementation. Revisit those rows only after the missing TypeScript behavior is implemented and
the spawn design is explicitly replanned.

## Claims based on grep alone

The following are absence claims from token search, not proof by execution:

- `megabrain_worktree_list_tree_node` has no production caller other than the recursive function
  itself and `megabrain_worktree_list`.
- `megabrain_dispatch_child_message` has no production caller other than the `ask`, `received`,
  and `done` wrappers.
- `megabrain_dispatch_host_terminal_read` and `megabrain_dispatch_render_transcript` have no
  shell production caller other than `megabrain_dispatch_read`.
- `megabrain_worktree_parent_branch` is referenced by shell `finish` and `pr`; therefore it was
  not classified as private to `pr`.
- The 31 dispatch-guard count was obtained with `rg`; it excludes the helper definition in
  `lib/common.sh` and includes the six context guards, nineteen listed guards in the two large
  modules, and the remaining guards outside this scope.

All other edges cited above were established by reading the case branches and function bodies,
including variable-selected owner branches, the `source module-chain.sh` edge in spawn, the
nested `megabrain_worktree_removal_reason` definition, and the direct hook call in
`hooks/megabrain-turn-end.sh`.

## Unknowns

- It is unknown whether TypeScript's stricter liveness ownership check is an intentional contract
  change or an accidental difference; the shell accepts an unmanaged caller while TypeScript
  requires the parent identity.
- It is unknown whether every host payload shape returned by Orca, Superset, and `gh` is covered
  by the TypeScript list/lifecycle normalizers. No real host, tmux server, browser, or simulator
  was contacted, as required by the brief.
- No runtime parity gate was run: the brief forbids the Bash test/container gate, and this report
  is based on source tracing plus the existing test scenarios' assertions.
