# State database access inventory

This inventory covers runtime access to `$MEGABRAIN_STATE_DIR/megabrain.db` in `src`. Line
references are from this revision. Knowledge's project databases and its filesystem scan horizon
are separate stores and are not part of this database.

## Connection ownership

| Site | Access | Transaction or work |
| --- | --- | --- |
| `src/db/db.ts:66` | Connection factory | Opens a SQLite handle. It does not migrate by itself. |
| `src/db/db.ts:237` | Integrity inspection | Opens read-only and runs integrity/schema queries; no write transaction. |
| `src/db/db.ts:295` | Migration | `BEGIN IMMEDIATE`; applies unapplied schema SQL and metadata, validates foreign keys, then commits or rolls back. SQL only. |
| `src/db/db.ts:349` | Writable connection setup | Applies SQLite pragmas, enables WAL, and validates versions. WAL setup/retry is outside transactions. |
| `src/db/db.ts:389` | Writable open | Configures, migrates, secures files, and imports native-session JSON. Called by the state owner at startup and by isolated migration/test fixtures only. |
| `src/db/db.ts:429` | Read-only open | Opens an existing WAL database read-only; no migration, WAL mode change, security write, or import. |
| `src/db/state-owner.ts:695,698` | Owner startup | The sole production writable open, followed by creation/cleanup of the request-result ledger in one short transaction. No schema migration was added for that ledger. |
| `src/adapters/state/shared.ts:22,28` | Legacy writable adapter | Still exported for isolated fixtures and migration tooling; production command code has no call to it. `write` uses synchronous `withWrite`. |
| `src/adapters/state/shared.ts:33,39` | Read adapter | Opens a read-only WAL handle and uses deferred read snapshots. |

## Direct read call sites

Each call below opens an existing database read-only. Query callbacks are synchronous; no write lock,
migration, filesystem import, process call, or wait runs in a read transaction.

| Site | Access |
| --- | --- |
| `src/adapters/usage-logs.ts:136` | Read dispatch dates for usage aggregation. |
| `src/cli/commands/check.ts:17,24,51,101` | Read messages, deliveries, and caller metadata; delivery creation/acknowledgement goes through the owner. |
| `src/cli/commands/chain-run.ts:183,414` | Read usage-notice and refused-chain state; chain metadata writes go through the owner. |
| `src/cli/commands/db.ts:40,123` | Read backup/show/check data; import and migration writes go through the owner. |
| `src/cli/commands/delivery-worker.ts:87` | Read delivery proof state; all delivery mutations run in owner execution or use owner requests. |
| `src/cli/commands/install-doctor/diagnostics.ts:16,222` | Read install and dispatch diagnostics. |
| `src/cli/commands/install-doctor/install-state.ts:11` | Read prior install state before sending replacement state to the owner. |
| `src/cli/commands/install-machine/state-plan.ts:6` | Read install planning state. |
| `src/cli/commands/orchestrate-adopt.ts:108` | Read dispatches and adoption metadata; leases and adoption updates go through the owner. |
| `src/cli/commands/orchestrate-close.ts:85` | Read close preconditions; lifecycle and delivery writes go through the owner. |
| `src/cli/commands/orchestrate-graph.ts:140` | Read graph records. |
| `src/cli/commands/orchestrate-list.ts:48` | Read dispatch list. |
| `src/cli/commands/orchestrate-parent.ts:20,64,79,131` | Read dispatch, message, and delivery state; waiters and delivery claims/acks go through the owner. |
| `src/cli/commands/orchestrate-policy.ts:70` | Read the dispatch before owner patch. |
| `src/cli/commands/orchestrate-prune.ts:161` | Read prune candidates and messages; lifecycle writes go through the owner. |
| `src/cli/commands/orchestrate-queue.ts:115,170` | Read queue contents; cancellation goes through the owner. |
| `src/cli/commands/orchestrate-read-liveness.ts:27,76` | Read liveness and message proof; implicit acknowledgement goes through the owner. |
| `src/cli/commands/orchestrate-reply.ts:97,132` | Read ownership and reply state; reply and dispatch writes go through the owner. |
| `src/cli/commands/orchestrate-spawn-options.ts:212` | Read install state. |
| `src/cli/commands/orchestrate-spawn-readiness.ts:66` | Read readiness data. Frame recording goes through the owner. |
| `src/cli/commands/orchestrate-spawn-run.ts:112,165,259,333` | Read admission, registry, and dispatch state; lease and lifecycle writes go through the owner. |
| `src/cli/commands/orchestrate-spawn-state.ts:47,60,77,91,193` | Read dispatch and terminal metadata; mutations go through the owner. |
| `src/cli/commands/orchestrate-spawn-worktree.ts:182` | Read prior session state; lease/session writes go through the owner. |
| `src/cli/commands/orchestrate-stop-reconcile.ts:124,169` | Read dispatches/messages; reconciliation writes go through the owner. |
| `src/cli/commands/orchestrate-transcript.ts:115` | Read dispatch transcript rows. |
| `src/cli/commands/projects.ts:729,839,877` | Read project/repository metadata; cache and backfill writes go through the owner. |
| `src/cli/commands/repo-run.ts:20` | Read repository run configuration. |
| `src/cli/commands/repository-selector.ts:85` | Read repository registry. |
| `src/cli/commands/repository.ts:29` | Read repository state; registration, removal, and visibility go through the owner. |
| `src/cli/commands/resources.ts:18` | Read admission/resource policy; sample and policy writes go through the owner. |
| `src/cli/commands/send.ts:125` | Read dispatch target metadata; channel results go through the owner. |
| `src/cli/commands/settings.ts:281` | Read settings; changes go through the owner. |
| `src/cli/commands/stack.ts:176` | Read worktree and stack state. |
| `src/cli/commands/status.ts:43` | Read status snapshot. |
| `src/cli/commands/supervise.ts:424,447,515` | Read supervisor findings and outbox state; findings, retries, and leases go through the owner. |
| `src/cli/commands/terminal-lifecycle.ts:96` | Read terminal state; lifecycle updates go through the owner. |
| `src/cli/commands/terminal-list.ts:100` | Read terminal listing. |
| `src/cli/commands/worktree-list.ts:209` | Read worktree/repository listing. Pull-request cache writes go through the owner. |
| `src/cli/commands/worktree-prune.ts:138,159` | Read prune candidates and refresh state; completion goes through the owner. |
| `src/cli/commands/worktree-write-base.ts:218` | Read repository and worktree base metadata. |
| `src/core/code-server.ts:201` | Read server ownership metadata. |
| `src/core/model.ts:334` | Read model registry; refresh writes go through the owner. |
| `src/core/native-sim-owner.ts:17` | Read simulator ownership metadata. |
| `src/knowledge/scanner.ts:83,91` | Read registered repositories and dispatch/session links. |
| `src/adapters/native-session-store.ts:45` | Read native-session store; updates go through the owner. |
| `src/cli/commands/github/client.ts:25` | Read cached GitHub data. |

## Owner write call sites

`callStateOwner` starts or reconnects to the owner for the resolved state directory. The socket name
contains a SHA-256 digest of that resolved directory, and a state-directory lock permits one owner.
Calls fail with an explicit owner error; they never fall back to a writable client connection.
Request IDs make retries idempotent. The owner serializes each request in a short `BEGIN IMMEDIATE`
transaction. The transaction contains SQL and synchronous state transformations only; filesystem,
git, terminal, agent, provider, sleeps, and other waits happen before or after it.

| Site | Write coverage and transaction contents |
| --- | --- |
| `src/cli/commands/admission-notify.ts:15`; `orchestrate-spawn-entry.ts:55,65`; `orchestrate-spawn-worktree.ts:221,223`; `orchestrate-adopt.ts:128,162,166` | Acquire/release leases and persist adoption fields. Each request changes only lease or dispatch rows. |
| `src/cli/commands/check.ts:62,118,124,126`; `child-ack.ts:83`; `orchestrate-parent.ts:85,96,102,107,121,146,151`; `orchestrate-read-liveness.ts:80` | Create, claim, fence, acknowledge, and clean up deliveries/waiters in short mailbox transactions. |
| `src/cli/commands/queue-write.ts:338,368,400`; `orchestrate-reply.ts:33,113,122,148,155,164,167`; `orchestrate-queue.ts:125,152` | Write child reports, parent replies, queue cancellation, message and delivery records, and outbox rows. Child ask/done reports and their message, delivery, and outbox rows commit in one owner request; parent reply messages, delivery changes, and outbox rows are atomic. |
| `src/cli/commands/orchestrate-spawn-run.ts:181,190,204,279,338,340`; `orchestrate-spawn-state.ts:63,173`; `orchestrate-stop-reconcile.ts:86,96,112`; `orchestrate-prune.ts:69,151,177,187,195`; `chain-run.ts:176` | Create/patch dispatches, store terminal sessions, reconcile state, and archive/delete pruned dispatches. No terminal action or delay runs inside the transaction. |
| `src/cli/commands/orchestrate-close.ts:168,191,201`; `supervise.ts:250,308,328,341,346,353,373,378,407,418,432,437,451,467,479` | Close dispatches, append supervisor findings, resume outbox work, and record recovery changes. Outbox delivery and process checks run outside transactions. |
| `src/cli/commands/delivery-worker.ts:63,160,163,166,211,233,374,385,387,388,401,412,435,439,454,462,463,465,469`; `router.ts:159,165` | Owner-hosted outbox delivery, leases, transport results, peer verification and acknowledgements. Provider I/O happens outside transactions; delivery workers reject execution without the owner handle. |
| `src/cli/commands/hook-turn-end.ts:158,188,284,376,452,456,461,625,644` | Persist turn-end reports, hook observations, findings, and channel outcomes through owner requests. Hook/process work stays outside transactions. |
| `src/cli/commands/resources.ts:60,87`; `install-doctor/hook-config.ts:149`; `install-doctor/install-state.ts:19,20`; `install-machine/run.ts:104,127`; `install-machine/state-plan.ts:46` | Update resource policy and installation records with SQL-only owner transactions. Desktop settings stored in files do not write this database. |
| `src/cli/commands/projects.ts:739,853`; `repository.ts:40,131,148`; `worktree-list.ts:240`; `src/core/project-registry.ts:33`; `src/core/model.ts:357` | Save repository cache/registry, project history marker, visibility, and model registry rows. Network/GitHub fetch and model discovery happen outside transactions. |
| `src/cli/commands/worktree-adopt.ts:98`; `worktree-archive.ts:114,157`; `worktree-hide.ts:12`; `worktree-write-create.ts:227`; `worktree-write-finish.ts:221` | Insert/upsert, finish/reopen, or hide worktree records. Git, filesystem, and host work happens outside the transaction. |
| `src/cli/commands/terminal-lifecycle.ts:184,193`; `src/adapters/native-session-store.ts:52,57` | Update terminal and native-session records. Host/session discovery happens outside the transaction. |
| `src/cli/commands/db.ts:77`; `src/cli/commands/projects.ts:853`; `src/core/model.ts:357`; `src/adapters/native-session-store.ts:52,57` | Import parsed state, project backfill, model data, and native sessions; only the final SQL changes run inside the transaction. Files and parsing are handled beforehand. |

The exact writable-open audit is `rg -n 'stateDatabase\\(|openDatabase\\(' src/cli`; it returns no
production CLI call sites. The only `openDatabase` runtime call in production is the owner startup.
The only migration path is that startup (or the owner's explicit migration request). Temporary
cutover databases and test fixtures are isolated and are not live state writers.

## Transaction primitives

| Site | Kind | Contents |
| --- | --- | --- |
| `src/db/db.ts:295` | `BEGIN IMMEDIATE` | Schema migration SQL and schema metadata. Owner startup only. |
| `src/db/db.ts:465` | `withWrite`, default `BEGIN IMMEDIATE` | Synchronous callback; production use is inside `src/db/state-owner.ts`. |
| `src/db/db.ts:511` | Deferred `BEGIN` | Synchronous read snapshot. |
| `src/db/queries/native-sessions.ts:38` | `BEGIN IMMEDIATE` | Parsed session record import and marker update. Owner startup only; file parsing precedes it. |
| `src/db/cutover.ts:56,257,316` | `withWrite` | Cutover marker/import state. Backup and source filesystem operations happen outside. |
| `src/db/state-owner.ts:165-280,400-452,527,698` | `withWrite` | One typed owner operation plus its idempotency result where applicable; SQL/state transformation only. |

## Outbox delivery

The owner subscribes immediately after an outbox insert or resume request, chains work by target,
and keeps the owner alive while deliveries or pending rows remain. The receiver's acknowledgement
or verified transport is persisted as proof. Provider/terminal I/O stays outside transactions.
Supervisor retries are the last-resort recovery path. There is no detached per-message delivery
worker; peer verification and fallback scheduling also run under the owner process.
