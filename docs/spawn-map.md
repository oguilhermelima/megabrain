# Spawn implementation map

This is a source-trace map, not a runtime test result. No spawn, worktree creation,
agent launch, Orca call, Superset call, or tmux call was executed. The only command
invoked was orchestrate spawn --help with MEGABRAIN_STATE_DIR pointed at a temporary
directory.

The measured routing is correct: orchestrate spawn enters the Bash worktree-create
body even when the compiled binary exists. The guard scans for the internal
--orchestrate argument before considering the TypeScript route.

## End-to-end flow

The normal path below describes a new worktree. The existing-worktree path skips the
Git add and host registration steps called out as conditional. The final confirmation
is the child writing a child/received message after it runs megabrain received.

1. The executable loads common.sh and every module-*.sh, then megabrain_main routes
   the top-level orchestrate command to command_orchestrate. Sources: megabrain:20-25,
   megabrain:80-91.

2. command_orchestrate removes the spawn subverb and calls command_worktree create
   with the private --orchestrate marker. Source: lib/module-context.sh:46-51.

3. megabrain_worktree_create scans for --orchestrate. Because the marker is present,
   it does not call the TypeScript worktree binary. It parses the public options and
   validates combinations, including managed-session identity, required repo and
   branch unless --worktree is used, chain versus agent, model, effort, and prompt.
   Sources: lib/module-worktree.sh:1531-1543, 1552-1624, 1626-1645.

4. It detects the current host. Without an exported managed session this may call
   orca worktree current --json. The spawn path then requires MEGABRAIN_SESSION_ID.
   Sources: lib/module-context.sh:3-18, lib/module-worktree.sh:1642-1649.

5. If --agent is absent, it loads and validates the chain configuration, resolves
   the explicit --chain or the best selector match, and calls megabrain_chain_walk.
   Chain selection can write chains.json while seeding a missing file or reconciling
   missing usage-limit defaults. The walk evaluates usage limits, skips unavailable
   steps when policy says skip, records the selected chain in environment variables,
   and retries later chain steps after a launch failure. Sources:
   lib/module-worktree.sh:1647-1675, lib/module-chain.sh:111-136,
   lib/module-chain.sh:796-871, lib/module-chain.sh:926-1067.

6. A chain step calls megabrain_chain_run_spawn, which converts the selected step
   back into an orchestrate spawn invocation. It forwards --worktree when reusing a
   worktree, otherwise --repo, --branch, optional --base and --name, then --agent,
   --model, optional --effort, --prompt, --json, optional --label, --tmux,
   --browser, and repeated --agent-arg. The resulting call re-enters step 3 with an
   explicit agent. Sources: lib/module-chain.sh:873-897,
   lib/module-chain.sh:1020-1055.

7. For --worktree, it resolves and validates the existing Git root, rejects a
   detached branch, and, on Superset, resolves the already registered workspace.
   For a new worktree, it resolves the repository, discovers or validates the base,
   derives a safe name from the branch when needed, checks branch existence, and runs
   Git worktree add. Sources: lib/module-worktree.sh:1706-1747,
   lib/module-worktree.sh:1748-1775.

   External commands on this branch are git rev-parse, git symbolic-ref, git config,
   git remote get-url, git ls-remote, git fetch, git show-ref, git worktree list, and
   git worktree add. A non-path repository selector can additionally call orca repo
   list --json. Worktree-root lookup can call superset settings get worktreeBaseDir.
   Sources: lib/module-worktree.sh:28-71, 114-224.

8. For a new worktree it copies .env and other non-example .env.* files, then, on
   Superset, ensures a project and creates or finds a local workspace. Parent and PR
   information is applied to workspace creation. A requested parent also writes Git
   branch.$branch.megabrain-parent metadata. Sources: lib/module-worktree.sh:1512-1529,
   lib/module-worktree.sh:1775-1831, lib/module-worktree.sh:1833-1851.

   The registration helpers call superset projects list/create, superset workspaces
   list/create/update, and, during rollback, superset workspaces delete and superset
   projects delete. They may call orca repo list to choose a project name. Sources:
   lib/module-worktree.sh:270-323, 325-343, 439-490.

9. Requested parent lineage, issue, or Linear issue links are sent to Orca with
   orca worktree set --worktree path:<worktree> and the relevant relationship flags.
   Registration failures deliberately retain the Git worktree and branch so the
   operator can run worktree adopt later. Source: lib/module-worktree.sh:1853-1887,
   lib/module-worktree.sh:1489-1492.

10. megabrain_launch_agent resolves runtime. auto selects tmux when the runtime is
    enabled, otherwise host; true selects tmux and false selects host. It requires a
    managed Orca, Superset, or tmux parent and records the parent identity. It reads
    the current branch, constructs a dispatch preamble, adds the browser availability
    notice, builds the final prompt, and validates the prompt size for argv or tmux.
    Sources: lib/module-worktree.sh:807-860, lib/module-worktree.sh:577-615.

11. The tmux runtime creates a dispatch id, validates that the selected host CLI is
    available, and reuses an existing session when one belongs to the worktree. If
    none exists, it asks Orca with orca terminal create or Superset with superset
    terminals create to run tmux new-session -A -s <session>. It then checks the
    session with tmux has-session, sets MEGABRAIN_STATE_DIR with tmux
    set-environment, discovers panes with tmux list-panes, and may create one with
    tmux split-window. Sources: lib/module-worktree.sh:861-919,
    lib/module-tmux-runtime.sh:45-68, 174-270.

12. The tmux path applies options with tmux set-option, builds the agent CLI command,
    prefixes it with cd, MEGABRAIN_DISPATCH_ID, MEGABRAIN_TMUX_SESSION, and
    MEGABRAIN_TMUX_PANE, then writes dispatch metadata in spawning state and starts a
    transcript with tmux pipe-pane. Sources: lib/module-worktree.sh:920-947,
    lib/module-tmux-runtime.sh:598-605.

13. The host runtime instead creates an Orca terminal with orca terminal create or a
    Superset terminal with superset terminals create. It reads the terminal back
    immediately, writes spawning metadata, and prepares the command with cd, a
    cleared TMUX environment, MEGABRAIN_STATE_DIR, the host terminal identity, and
    MEGABRAIN_DISPATCH_ID. Sources: lib/module-worktree.sh:1007-1054,
    lib/module-worktree.sh:672-697.

14. Both runtimes publish the full prompt as a parent/prompt message before sending
    the agent command or prompt. The message append creates a numbered JSON message,
    a parent-to-child delivery, and best-effort notification state. Sources:
    lib/module-worktree.sh:721-732, lib/module-orchestrate.sh:1307-1382.

15. The tmux runtime submits the agent command with tmux send-keys and checks pane
    output for model substitution and terminal-identity escape leakage. The host
    runtime submits the command through superset terminals send or orca terminal send,
    waits for readiness with superset terminal reads or orca terminal wait --for
    tui-idle, and then sends the prompt through the same native channel. Sources:
    lib/module-worktree.sh:948-974, lib/module-worktree.sh:1061-1092,
    lib/module-orchestrate.sh:1744-1781.

16. Prompt transport is recorded, then the sender polls for a child/received message
    for the configured timeout. It retries up to MEGABRAIN_PROMPT_RECEIPT_ATTEMPTS;
    tmux retries only Enter so it does not type the prompt twice. A receipt marks the
    prompt delivered and transitions spawning to running. If the timeout expires,
    spawn returns successfully with the dispatch still awaiting receipt so reconcile
    can finish it later. Sources: lib/module-worktree.sh:734-805,
    lib/module-tmux-runtime.sh:583-596, lib/module-orchestrate.sh:912-919,
    lib/module-orchestrate.sh:955-983.

17. The launched agent CLI is codex, claude, or agy, with agent-specific model,
    effort, browser, and permission arguments plus all repeated --agent-arg values.
    The final prompt tells the agent to run megabrain received. The TypeScript
    received command finds the child dispatch, appends child/received, and updates
    promptReceipt and promptState. Sources: lib/module-worktree.sh:497-552,
    lib/module-orchestrate.sh:52-67, lib/module-orchestrate.sh:2238-2247,
    src/cli/commands/queue-write.ts:235-247.

18. On a confirmed receipt, metadata is running and the parent receives the dispatch
    id and runtime in the JSON result or human output. Sources:
    lib/module-worktree.sh:991-1005, lib/module-worktree.sh:1109-1122,
    lib/module-worktree.sh:1911-1947.

### External command inventory

The reachable spawn path uses these external command families, including calls made by
helpers rather than directly by the top-level function:

- Git: rev-parse, symbolic-ref, config, remote get-url, ls-remote, fetch, show-ref,
  worktree list, worktree add, worktree remove --force, and branch -D.
- Orca: worktree current, repo list, worktree show, worktree set, terminal create,
  terminal read, terminal send, terminal wait, and terminal close.
- Superset: settings get/set, projects list/create/delete, workspaces
  list/create/update/delete, and terminals create/read/send/close.
- tmux: has-session, set-environment, list-panes, split-window, display-message,
  resize-pane, send-keys, capture-pane, pipe-pane, set-option, kill-pane, and
  kill-session.
- Agent CLIs: codex, claude, or agy, selected by the agent configuration and invoked
  inside the target worktree.
- Local utilities used while constructing and persisting the flow include jq, awk,
  sed, find, cp, mkdir, mktemp, mv, rm, cat, cmp, date, sleep, hostname, id, wc,
  tr, cut, grep, head, sort, ps, od, sh, and env.

## State written

The persistent dispatch store is rooted at MEGABRAIN_STATE_DIR, whose default-derived
subpaths are defined in lib/common.sh:4-14. The groups below describe writes by
semantic purpose, not every call site.

### Chain and worktree state

- MEGABRAIN_STATE_DIR/chains.json is created or reconciled by chain initialization
  when a chain is selected. This is incidental configuration maintenance, before the
  worktree exists. Source: lib/module-chain.sh:111-131.
- Git administrative state is changed by git worktree add. The new branch, worktree
  directory, and copied .env files are created before agent launch. Parent metadata is
  written with git config when requested. Sources: lib/module-worktree.sh:1754-1779,
  lib/module-worktree.sh:1833-1838.
- The shared host integrations are changed during registration: Superset project and
  workspace records, workspace tags, and optional PR association; Orca worktree
  parent and issue links. Sources: lib/module-worktree.sh:1781-1831,
  lib/module-worktree.sh:1840-1876.

### Dispatch metadata

- MEGABRAIN_STATE_DIR/dispatches/<dispatch-id>/meta.json is first published by
  megabrain_dispatch_meta_write after the child terminal or pane is known and before
  prompt publication. It includes parent and child host identities, workspace and
  terminal ids, worktree and branch, agent/model/effort, runtime, tmux location,
  label, chain context, state spawning, processState starting, terminalState owned,
  and all prompt state fields. Sources: lib/module-orchestrate.sh:316-368,
  lib/module-worktree.sh:937-947 and 1050-1054.
- The same file is atomically rewritten for promptPublication, promptTransport,
  promptReceipt, promptState, promptDelivered, and promptDeliveryReason as the prompt
  moves from publication to transport to receipt. Sources:
  lib/module-worktree.sh:721-752, lib/module-orchestrate.sh:370-418.
- It is rewritten to record model substitution, then to transition processState and
  dispatch state from spawning to running. Failure paths use the same fields for
  failed state, stage, reason, reconcileOutcome, failureCount, and terminal state.
  Sources: lib/module-worktree.sh:959-1004, lib/module-orchestrate.sh:689-707,
  lib/module-orchestrate.sh:783-837.
- A child received command also rewrites meta.json to set promptReceipt received,
  promptState confirmed, and, if still spawning, running state. Source:
  src/cli/commands/queue-write.ts:220-233.

### Queue state

- dispatches/<dispatch-id>/messages/<sequence>-<from>-<type>.json is appended first
  for the parent prompt. It is later appended by the child for received. Each message
  carries sequence, sender, type, text, timestamp, and session id. Source:
  lib/module-orchestrate.sh:1307-1371.
- dispatches/<dispatch-id>/deliveries/<delivery-id>.json is created for the prompt's
  child recipient and for subsequent protocol messages. It records recipient,
  message sequences, status, and consumer fields. Source:
  lib/module-orchestrate.sh:221-245, 300-314, 1343-1368.
- dispatches/<dispatch-id>/cursor.json is initialized to sequence zero with the
  metadata store and is part of the later queue-reader contract. Source:
  lib/module-orchestrate.sh:365-367.
- messages/.lock and temporary .message and .delivery files are transient concurrency
  state. They are removed after append or on the error path. Sources:
  lib/module-orchestrate.sh:1273-1298, 1325-1340, 1373-1382.

### Runtime state

- For tmux, dispatches/<dispatch-id>/transcript is created and tmux pipe-pane writes
  captured pane output into it. The pipe is stopped and the file may be truncated on
  terminal release. Sources: lib/module-orchestrate.sh:433-434, 647-671.
- The tmux server receives the session, pane, options, and MEGABRAIN_STATE_DIR as
  runtime state. Existing session-registry JSON files under
  MEGABRAIN_STATE_DIR/sessions are read and pruned by this flow but are not written
  by spawn itself. Sources: lib/module-tmux-runtime.sh:50-79, 108-200.
- tmux-send-locks under MEGABRAIN_STATE_DIR can exist briefly while text and Enter are
  sent. The lock is removed after the transaction. Source:
  lib/module-tmux-runtime.sh:478-495, 556-580.
- Temporary chain-run error files under MEGABRAIN_STATE_DIR are created during a chain
  walk and cleaned when the walk ends. Source: lib/module-chain.sh:963-965,
  lib/module-chain.sh:1053-1064.
- Process-local variables such as MEGABRAIN_LAST_DISPATCH, MEGABRAIN_LAST_SPAWN_RUNTIME,
  and chain selection variables are not persistent state. They carry the result from
  nested Bash functions to the final formatter. Sources: lib/module-worktree.sh:821,
  lib/module-worktree.sh:835-840, lib/module-chain.sh:912-920.

## Failure and rollback paths

### Worktree creation or registration fails

- A failed git worktree add may remove only a branch that did not exist before the
  invocation. Source: lib/module-worktree.sh:1748-1773.
- An environment-copy failure calls rollback. Rollback deletes the created Superset
  workspace and project only when ownership was proven, then runs git worktree remove
  --force and git branch -D. Source: lib/module-worktree.sh:1775-1779,
  lib/module-worktree.sh:1420-1486.
- Superset project or workspace registration failure does not call that rollback. It
  deliberately keeps the Git worktree and branch and tells the operator to adopt it
  later. Unknown ownership is also retained. Sources: lib/module-worktree.sh:1781-1823,
  lib/module-worktree.sh:1489-1492.

### The worktree exists but the agent fails to launch

- The outer create function treats every nonzero launch result as a worktree-create
  failure and calls megabrain_worktree_create_rollback. For a newly created worktree,
  this forcibly removes the worktree and deletes its branch, in addition to removing
  newly created Superset workspace/project records when they are marked owned.
  Sources: lib/module-worktree.sh:1891-1913, lib/module-worktree.sh:1420-1479.
- The launch function separately attempts to close the host terminal or kill the tmux
  pane/session on failures after a terminal was created. Metadata is retained and
  marked failed when it already exists; the dispatch outcome is intentionally durable
  even when terminal cleanup fails. Sources: lib/module-worktree.sh:632-655,
  lib/module-worktree.sh:948-1001, lib/module-worktree.sh:1050-1118.
- Registration failure is different: it happens before launch and retains the
  worktree, so the data-loss rollback is specifically tied to later launch failure,
  not to all host failures.

### The prompt is published but no receipt arrives

- Publication is durable before transport: parent/prompt exists in messages and a
  child delivery exists. The metadata says published, then transported or
  not-transported. Sources: lib/module-worktree.sh:725-740,
  lib/module-orchestrate.sh:1307-1368.
- The sender waits for a child/received message up to the configured timeout and
  retries up to the configured attempts. A timeout returns status 2, marks the
  prompt awaiting receipt, retains the terminal, and returns success to the caller;
  the operator is told to run reconcile. Sources: lib/module-worktree.sh:755-792,
  lib/module-worktree.sh:974-985 and 1091-1102.
- A transport error, delivery-state persistence error, or explicit confirmation
  failure closes or kills the child terminal where possible, marks prompt delivery
  failed, marks the dispatch failed, and then the outer layer may remove the new
  worktree. Sources: lib/module-worktree.sh:986-1001, lib/module-worktree.sh:1103-1118.

### The host terminal cannot be created or does not become usable

- If Orca or Superset terminal creation itself returns failure, the function returns
  before metadata is written. There is no known terminal to close, and the outer
  worktree rollback runs if the worktree had just been created. Sources:
  lib/module-worktree.sh:1018-1044, lib/module-worktree.sh:1891-1913.
- If creation returns no identity, the tmux path attempts host and tmux cleanup before
  returning. The host path rejects the missing identity but does not have an identity
  with which to clean up. Sources: lib/module-worktree.sh:898-907,
  lib/module-worktree.sh:1029-1047.
- If host read-back fails, the host terminal is closed before returning. If readiness
  fails after command submission, the host terminal is closed and metadata is marked
  failed. Sources: lib/module-worktree.sh:1045-1048, 1072-1089.
- If a terminal was created remotely but the create command failed without returning
  an identity, ownership is unknown. The code cannot prove it and deliberately has no
  safe cleanup target; this is retained as an unknown rather than guessed away.

### Receipt and child behavior

- The child does not confirm receipt merely because a terminal became ready. It must
  execute the injected agent prompt, resolve its dispatch identity, append child/
  received, and update metadata. Sources: src/cli/commands/queue-write.ts:39-62,
  src/cli/commands/queue-write.ts:235-247.
- A child identity proof can later make reconciliation trust the dispatch even when
  host terminal inspection is inconclusive. Source: lib/module-orchestrate.sh:985-1004.

## Coupling analysis

### Genuine worktree concerns

Repository selection, base discovery and fetch, branch/name validation, Git worktree
creation, environment copying, parent Git metadata, Superset project/workspace
registration, workspace tags and PR association, Orca lineage/issue links, and the
worktree result JSON are worktree concerns. They are implemented in
megabrain_worktree_create and its helpers at lib/module-worktree.sh:98-490 and
1531-1889.

### Genuine dispatch concerns

Parent/child identity, runtime selection, agent command construction, browser notice,
prompt budget, dispatch metadata, message/delivery files, transcript capture, terminal
creation and readiness, native or tmux transport, receipt polling/retry, state
transitions, failure classification, and child protocol are dispatch concerns. They
are implemented primarily in megabrain_launch_agent at lib/module-worktree.sh:807-1123
and the dispatch store in lib/module-orchestrate.sh:316-418, 647-707, 955-983, and
1307-1781.

### Honestly both

The following have a real boundary between the two domains:

- A dispatch needs a valid worktree path and branch to set its child working directory
  and metadata, while worktree creation needs a dispatch result only when an agent is
  requested. The current function couples them through local variables, not through a
  shared invariant.
- Superset workspace identity belongs to worktree registration, but it is also needed
  to create and send to a Superset child terminal. The redesign must pass a resolved
  workspace capability or an equivalent host target, rather than make dispatch query
  worktree state again.
- A requested parent or issue link is worktree metadata, while the parent terminal
  identity is dispatch metadata. Both currently use the current host context.
- The chain chooses a dispatch step but also supplies the worktree creation inputs.
  Chain selection and fallback belong to dispatch policy; repository and worktree
  mutation belong to the worktree operation.

### Separation cost

Separating spawn means introducing a worktree result contract that can be consumed by
dispatch, or making spawn accept an existing worktree and compose two commands. The
contract must preserve path, branch, workspace id, base provenance, parent/link
outcomes, and whether the worktree was created by this invocation. The last field is
needed to prevent dispatch failure from deleting a pre-existing worktree and to make
rollback ownership explicit. It also needs a host-terminal target containing host,
workspace, and terminal capability without making the dispatch layer rediscover it.

The current code does not require the worktree and dispatch halves to share a function;
it requires them to share ownership and cleanup information. That is the real redesign
cost.

## Shell capabilities without a TypeScript equivalent

The TypeScript side has queue readers/writers, lifecycle commands, and portions of
terminal handling, but no spawn implementation. The following shell capabilities need
new TypeScript ownership or an explicit retained shell boundary:

- The spawn entry and its separate routing from worktree create:
  command_orchestrate and the --orchestrate guard in megabrain_worktree_create.
  TypeScript needs an executeOrchestrateSpawn command and a direct dispatcher route.
- Agent command construction in megabrain_agent_command and permission wrapping in
  megabrain_terminal_command_with_agent_permissions. TypeScript needs the per-agent
  model, effort, browser-MCP, dangerous-permission, and passthrough-argument mapping,
  including agy model-id conversion.
- Runtime selection and managed-session validation in megabrain_resolve_spawn_runtime.
  TypeScript needs the Orca, Superset, and tmux identity contract and the auto/true/
  false runtime decision.
- Tmux child-session reuse and pane layout in megabrain_tmux_existing_session_for_worktree,
  megabrain_tmux_split_pane, megabrain_tmux_apply_config, and the tmux setup branch of
  megabrain_launch_agent. Existing TypeScript tmux send/read code does not create this
  child launch topology.
- Tmux command submission and prompt retry in megabrain_tmux_send_agent,
  megabrain_tmux_send_text, megabrain_tmux_retry_prompt, and the pane-output checks in
  megabrain_tmux_model_substitution_report and megabrain_tmux_agent_output_clean.
  TypeScript needs the send transaction, Enter retry, model substitution evidence, and
  escape-leak safety check.
- Host launch orchestration in megabrain_launch_agent: terminal creation, identity
  extraction, immediate read-back, command wrapping, readiness wait, native send, and
  host cleanup. TypeScript terminal-lifecycle can create a terminal, but its contract
  is not dispatch creation and does not provide this spawn transaction.
- Prompt publication and the four-layer prompt state machine in
  megabrain_spawn_publish_prompt, megabrain_spawn_mark_prompt_transported,
  megabrain_spawn_mark_prompt_awaiting_receipt, megabrain_spawn_mark_prompt_delivered,
  megabrain_spawn_mark_prompt_failed, and megabrain_dispatch_send_prompt_with_receipt.
  TypeScript needs atomic publication, transport evidence, receipt polling, bounded
  retry, and the awaiting-receipt success outcome.
- Dispatch metadata creation in megabrain_dispatch_meta_write, including parent and
  child host identity, chain context, runtime, process state, terminal state, and
  prompt fields. TypeScript lifecycle commands can update existing metadata but do not
  establish this spawn record.
- Spawn-specific rollback in megabrain_worktree_create_rollback and the distinction
  between proven ownership, unknown ownership, retained registration failure, and
  launch failure. A rewrite needs an ownership-aware rollback policy before porting
  the mechanics.
- Chain fallback integration in megabrain_chain_walk and megabrain_chain_run_spawn.
  The TypeScript chain command manages chain configuration, but this Bash walk owns
  usage-limit skip/take decisions, launch retry, chain metadata injection, and
  continuation after a refusal.

## Flags and ownership

The observed help output is:

Usage: megabrain orchestrate spawn --repo <name|path> --branch <branch> [--agent <id>] [--chain <name>] [--model <id>] [--base <ref>] [--name <slug>] [--effort <level>] [--prompt <text>] [--label <text>] [--worktree <path>] [--tmux true|false] [--browser] [--agent-arg <flag>] [--json]

The public spawn flags split as follows:

- Dispatch: --agent, --chain, --model, --effort, --prompt, --label, --tmux,
  --browser, and --agent-arg. These select and configure the child agent, transport,
  prompt, and protocol.
- Worktree: --repo, --branch, --base, --name, and --worktree. The first four create
  a new target; --worktree selects an existing target.
- Result boundary: --json affects both operation output and nested chain forwarding,
  but is not persisted as dispatch state.

The parser also accepts worktree-create flags that spawn help does not advertise:
--from, --parent, --no-parent, --issue, --linear-issue, and --pr. These belong to
worktree creation or registration and should be made explicit in the new worktree
command rather than silently retained as spawn flags. Sources:
lib/module-worktree.sh:1555-1609 and lib/common.sh:309, 318.

The private --orchestrate flag is not an operator flag. It is the coupling mechanism
that suppresses the TypeScript worktree route. It should disappear when spawn has its
own command path. Source: lib/module-worktree.sh:1531-1543.

## Judgements

### Opinion: good and should survive

The durable, staged dispatch record is the strongest part of the design. Metadata is
published before queue directories are completed, prompt publication is separate from
transport and receipt, and the transition table rejects illegal state changes. This
lets reconcile distinguish not-published, transported-but-unconfirmed, confirmed,
failed, and terminal-cleanup outcomes instead of collapsing them into one exit code.
Sources: lib/module-orchestrate.sh:78-115, 316-368, 394-418.

The child identity proof is also good. A child/received message is evidence tied to
the dispatch identity, and the tmux path matches session plus pane rather than trusting
the host terminal id shared by multiple panes. That is the kind of invariant that has
kept recovery possible across sessions. Sources: lib/module-orchestrate.sh:1667-1703,
lib/module-orchestrate.sh:902-919.

The bounded transport behavior should survive: atomic queue writes, a lock around
sequence allocation, tmux send locking, and retrying Enter without retyping the prompt
avoid duplicate prompts and corrupted concurrent input. Sources:
lib/module-orchestrate.sh:1273-1382, lib/module-tmux-runtime.sh:556-596.

### Opinion: accidental complexity

The biggest accidental complexity is that worktree provisioning, host registration,
chain policy, terminal creation, agent command construction, queue publication, and
rollback all live in one function-shaped path. The private --orchestrate marker then
changes the meaning of worktree create and disables the otherwise available binary.
The chain front door also reconstructs another spawn command to re-enter that path.
Sources: lib/module-context.sh:46-51, lib/module-worktree.sh:1531-1544,
lib/module-chain.sh:873-897.

The duplicated tmux and host branches in megabrain_launch_agent are another growth
artifact. They share metadata, prompt, receipt, and failure semantics but duplicate
terminal creation, command submission, cleanup, and result handling. A future design
can keep runtime-specific adapters while sharing a single dispatch transaction.
Sources: lib/module-worktree.sh:861-1005 and 1007-1122.

The public surface is also historically merged: spawn help omits worktree flags that
the parser accepts, while worktree create help lists agent and dispatch flags that are
meaningful only through the private marker. Sources: lib/common.sh:309, 318,
lib/module-worktree.sh:1552-1619.

### Opinion: riskiest part to reimplement

The riskiest part is the prompt-delivery transaction across three identities: parent
terminal, child host terminal, and child dispatch process. The implementation must
preserve ordering between metadata, parent prompt message, terminal transport, child
receipt, and running-state transition. It also has separate host and tmux transport
semantics and a deliberate timeout that returns success while retaining an open
dispatch. A rewrite that only launches the agent and then marks running will lose the
reconcile path and misclassify a live but slow child. Sources:
lib/module-worktree.sh:937-1005, 1050-1122, lib/module-orchestrate.sh:955-983.

### Opinion: outright defects

1. Launch failure is treated as worktree failure and can destroy user work. After
   worktree_created is set, any nonzero megabrain_launch_agent result calls rollback;
   rollback runs git worktree remove --force and git branch -D. If the agent started
   enough to write files before a readiness, transport, or receipt failure, those
   changes are deleted. This is a data-loss path caused by mixing dispatch rollback
   with worktree ownership. Sources: lib/module-worktree.sh:1774-1775,
   lib/module-worktree.sh:968-1001, lib/module-worktree.sh:1911-1913,
   lib/module-worktree.sh:1458-1479.

2. The host branch has a cleanup hole after metadata creation. At
   lib/module-worktree.sh:1091, a failed meta read returns directly without closing
   the already-created host terminal or marking metadata failed. The outer caller then
   rolls back the Git worktree, but its rollback helper does not know the host terminal
   id. This can leave a live terminal and a spawning dispatch pointing at a worktree
   that has just been deleted. The analogous earlier failures do call host cleanup,
   so this is an inconsistent branch-specific omission. Sources:
   lib/module-worktree.sh:1050-1076, 1091-1092, 1911-1913,
   lib/module-worktree.sh:1420-1486.

## Call-edge evidence

The flow edges in the ordered list were established by reading the dispatcher case
branches and the called function bodies: megabrain_main to command_orchestrate,
command_orchestrate to command_worktree, the --orchestrate guard to the Bash body,
the chain selection to megabrain_chain_walk, the walk to megabrain_chain_run_spawn,
the worktree body to megabrain_launch_agent, each launch branch to its terminal and
transport helpers, and the prompt sender to the receipt predicate. The child receipt
edge was established by reading the injected preamble, command_received wrapper, and
TypeScript queue writer.

The external-command inventory was established by reading those reachable helper
bodies. The state grouping was established by reading the atomic write helpers and
their callers. Grep was used to find candidate definitions, call sites, and absence
patterns, but a grep match alone was not used as proof of a positive call edge.

## Validation evidence

Before this file was committed, git status --porcelain produced:

 docs/spawn-map.md

No test suite was run. No real host, browser, tmux server, agent, or worktree was
contacted.

## Claims based on grep alone

- The statement that no TypeScript command named executeOrchestrateSpawn or spawn
  parser exists is a token-search result over src. The positive conclusion that the
  current TypeScript command set contains queue, terminal, and lifecycle pieces comes
  from reading those files.
- The statement that TypeScript has no direct spawn-specific implementation is an
  absence claim from searching src/cli/commands and src/core. The detailed list of
  missing capabilities is based on reading the Bash implementation and the relevant
  TypeScript command files.
- The statement that existing session-registry JSON files are not written by spawn
  itself is based on searching calls to the registry write helper; the read and prune
  behavior was established by reading the tmux helper bodies.
- The inventory claim that the 40 dispatch-store call sites are grouped here rather
  than listed individually is based on repository search; the grouping and semantics
  were established by reading each reachable writer family.

## Unknowns

- Runtime host payloads from Orca and Superset were not contacted, so all response
  shapes outside the fallback jq selectors are unknown.
- It is unknown whether a failed terminal-create command can create a remote terminal
  while returning no usable identity. The code treats that ownership as unprovable and
  cannot safely clean it up.
- It is unknown whether an agent can modify the new worktree before each specific
  launch failure. The force-removal path demonstrably permits data loss if it does.
- It is unknown whether the intended redesign will preserve chain fallback and usage
  limit policy or move that policy elsewhere.
- It is unknown whether the omitted spawn help flags are intentionally hidden legacy
  compatibility or an accidental documentation defect.
- No runtime parity result is known. The report is source tracing plus the isolated
  help output only; the requested test suites were not run.
