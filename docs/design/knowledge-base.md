# Knowledge base and artifacts — design

Status: approved 2026-10-17, updated 2026-10-17 with the decisions made while building it. Replaces the branch-first summaries view.

## Why

Per-chat summaries describe what happened in one chat ("the person asked…, the agent dispatched…").
They pile up by the hundred on main, nobody rereads them, and they answer "what happened in that chat"
instead of "how does X work, what was decided and why". The unit worth keeping is the topic.

## Model

All state is JSON/JSONL under $MEGABRAIN_STATE_DIR/knowledge/<project-id>/ (no DB migration).

**Topic** — topics/<topic-id>/topic.json + revisions.jsonl

- id, project (repo path), title (names the subject: "Chat summaries", not "Work on summaries"),
  kind: feat | fix | refactor | decision | investigation, status: active | shipped | dropped,
  createdAt, updatedAt, aliases (old titles, for search and merges).
- sections (markdown each, fixed order): overview (what it is), state (where it stands now),
  decisions (list, each { id, text, why, at, chatId, supersededBy? } — never deleted, only superseded),
  pitfalls (known traps), open (pending items).
- refs: issues, PRs, commits, branches, files — each { kind, id, url?, title?, state? }. Rendered as
  links; issue/PR state read from megabrain github issue|pr when the page opens (cached).
- chats: ids of chats that built the topic.
- keyMessages: { chatId, eventCursor, at, role, text, why } — mostly the person's directions and
  decisions, plus agent turns that settled something. Not the whole history.
- Every curator write appends the previous topic.json to revisions.jsonl (cheap undo, audit).

**Chat record** — chats/<chat-id>.json

- title, summary (subject-first, see prompt rules), agent, model, branch, worktree,
  startedAt, endedAt, topics (ids), refs (issues/PRs/commits it touched).
- transcript.jsonl: the distilled conversation, kept forever — person messages and agent text in full,
  each tool call as one line (edited src/chat/daemon.ts, ran bun test: 2511 pass 0 fail), images as
  references only. Measured: a 70 MB Claude session log holds ~650 KB of conversation text, so this is
  roughly 1% of the raw log; the raw logs (5.6 GB Claude, 5.3 GB Codex here) are not durable anyway.
- Written when a chat is curated, refreshed as it continues.

**Artifact** — artifacts/<artifact-id>/ with artifact.json (title, kind: diagram | plan | doc,
topics, chatId, createdAt, updatedAt) and the content file (index.html or doc.md) plus
revisions. Any agent can create one through the CLI; diagrams come from the diagram-design skill.

## Sources

Every agent session whose cwd is inside a registered project, whoever opened it: the app's chats,
Orca, Superset, plain terminals and dispatch workers all write the same session logs
(~/.claude/projects, ~/.codex/sessions, grok and agy logs that sessions history already reads),
so the knowledge base reads those logs, read-only. One session id is processed once, whichever host
ran it. A dispatch worker's session is linked to its parent session (dispatch records know both) and
shown under the parent's chat card, not as a separate chat.

Sessions of grok and agy are listed by sessions history but their logs have no turn reader yet, so the
scanner reads Claude and Codex sessions only.

**Switches.** Settings key knowledge = { defaults, projects }: five toggles, each with a default and an
optional per-project override (`projects[repoPath]`):

- summaries: summarise the project's chats and sessions (the master switch; with it off nothing else applies);
- retitle: rename chats from their summaries (a title a person set is kept);
- topics: file summaries into topics (needs summaries);
- sessions: also read sessions opened outside the app (needs summaries and topics);
- context: give agents the topics for their branch (needs summaries).

chat-summaries keeps the model and the cadence (agent, model, effort, everyMessages, everyMinutes); its
enabled and retitle fields are read once, to migrate (below), and ignored afterwards. A project whose
summaries, topics and sessions toggles are not all on is never scanned, and its sessions are never sent
to the summary model.

**Fresh install: everything off.** With neither a knowledge file nor a chat-summaries file nothing has
been chosen, so every toggle is off and nothing is written. The first read with an old chat-summaries
file and no knowledge file migrates once: enabled becomes the summaries default (a file that never set
it means off), retitle becomes the retitle default, the others default to on, and knowledge-settings.json
is written. A knowledge file the person saved applies as saved; toggles it leaves out default to on.

A scanner (inside chatd, which already runs the summarizer: a backfill once, then a scan every 10
minutes starting 60 seconds after boot) finds new or grown sessions in enabled projects and feeds them
to the same summarizer trigger (every N messages or M minutes of new content).

**Bounds.** Turning summaries on must not send a machine's whole history to a model:

- Horizon: the first time the scanner sees a project with the switches on it stores, in
  knowledge/scan.json, a horizon of now minus 7 days. Only sessions whose last activity is after it are
  taken, so later scans pick up new or grown sessions only.
- Older history is opt-in: `megabrain knowledge scan --repo <path> --since <ISO date|Nd>` takes sessions
  active since then, once, without moving the stored horizon. `--dry-run` prints, per project, the sessions
  in range, the older ones and the estimated model calls (two per session, none for dispatch workers) and
  calls no model, writes no knowledge and stores no horizon.
- Cap: a scan sends at most 20 sessions to the model across all projects, newest first (`--limit <n>`
  changes it for one run); the rest wait for the next scan. Dispatch workers are linked, not summarised,
  and do not count.
- Size: the summariser clips every event to 1,500 characters and a prompt's conversation to its last
  14,000, whoever sent the session, so a huge session costs the same as a long one.

## Pipeline

1. **Summarizer** (existing trigger: every N messages or M minutes, model from Settings > Summaries).
   New prompt rules:
   - write about the work, never about the actors: no "the person"/"the agent"; "In this session…",
     "This feature…";
   - concrete: what changed, where, what was decided and why; name issues, PRs, commits and files
     with their numbers and subjects, never a bare number list;
   - title names the subject and outcome ("QA defects become 12 issues and 5 fix lanes");
   - output adds REFS: (issues/PRs/commits/branches seen in the transcript, also extracted
     mechanically from tool output by regex — the model is not trusted alone for numbers) and
     KEY: (event cursors of messages that set direction or decided something, with a one-line why);
   - writes in the chat's language.
2. **Curator** (same configurable model, runs after each summary):
   - input: the new summary + refs + key messages, the project's topic list (id, title, kind, aliases,
     one-line overview), and the full text of the 1–2 candidate topics (picked by branch name, refs and
     text match);
   - output: one JSON object: topic ({ assign: id } or { new: { kind, title } }), sections (the ones to
     replace), decisions ({ add, supersede }), refs and an optional status; key messages come from the
     summary's KEY lines;
   - megabrain validates the patch (sections known, decisions never removed, refs well formed) before
     writing; a bad answer is logged and retried at the next summary, never written half.
   - the branch name is a strong hint, not the rule: feat/summaries-wiki and feat/summaries-by-branch
     land in one topic.
3. **Hand edits**, as verbs: `knowledge rename <topic-id> <title>` (the old title becomes an alias),
   `kind <topic-id> <kind>`, `status <topic-id> <status>`, `merge <topic-id> <into-topic-id>` (the target keeps
   its title, sections and status and gains the other's aliases, refs, chats, decisions renumbered after its
   own, and key messages; the source topic is removed and its chats point at the target) and
   `move-chat <chat-id> <topic-id>` (the chat leaves its other topics). Each writes a revision of every topic
   it changes; the curator sees the result as current text and keeps it. Editing a section by hand and the
   app UI for these verbs are not built yet.

## Agents

- megabrain knowledge list|show|search|transcript|topic-for|context (replaces summaries list|search|show|context;
  old verbs kept as aliases for one release). list gives { projects: [{ repo, project, enabled, topics }] },
  show a topic with its chatRecords (cards, each dispatch worker under its parent), transcript a chat
  record and its distilled events.
- Context injection (native chats now, hook module for terminals as today): the topic(s) for the cwd's
  branch and recent work — overview, state, live decisions, pitfalls, open — capped at ~3 KB, instead of
  the latest raw summaries.
- megabrain artifact create|update|list|show for agents to file plans, docs and diagrams.

## App

- Sidebar: one "Knowledge" entry (replaces Summaries).
- Page, wiki layout (current shell kept):
  - left nav: search, then kind groups (Features, Fixes, Refactors, Decisions, Investigations), each
    listing topics with status dot and last update; per project, project switcher on top;
  - topic page: title, kind/status chips, refs row (issue/PR chips with live state, click opens on
    GitHub or the app's PR view), sections, decisions as a list with superseded ones folded, key
    messages as a timeline, "Chats" as cards (summary + last messages; click opens the distilled
    transcript read-only inside the knowledge page, never the live chat), artifacts strip.
- **Map** button: graph view (Obsidian-like) of the project's topics as nodes, sized by activity,
  coloured by kind; edges from shared chats, shared files and shared refs; click opens the topic.
  Force layout, no new heavy dependency if a small one does it.
- Raw summaries hidden for now.
- Artifacts: rendered in a sandboxed iframe (no same-origin, no network: Google Fonts link stripped on
  save, system fonts fallback); markdown docs through the app's renderer. Listed on their topic and in an
  Artifacts list.

## diagram-design

MIT (keep the copyright notice), no server or telemetry; only network use is Google Fonts in generated
files, which we strip. Installed as a megabrain module (artifacts-diagram) for every agent, pinned to a
tested commit; the module's skill note tells agents to save output with megabrain artifact create.

## Migration

Existing summaries.jsonl entries are fed once through the curator in order, oldest first, so the
first topics come from real history (`knowledge backfill`, recorded in knowledge/backfill.json so a rerun
skips what is done). Summaries stay on disk. Sessions older than the scan horizon are not part of it;
`knowledge scan --since` brings them in on request.

## Lanes (after approval)

1. CLI: knowledge store, summarizer prompt + refs/key extraction, curator with validation, distilled
   transcripts, knowledge/artifact verbs, context injection, one-time backfill. (Sonnet)
2. App: Knowledge page, topic page, transcript reader, map view. (Opus) — starts on fixtures from lane 1's
   schema, merges after it.
3. Artifacts: store + verbs (may fold into lane 1), iframe renderer, diagram-design module. (Sonnet + Opus)

## Models

Summarizer and curator both use the model chosen in Settings > Summaries (now gemini-3.8-flash low).
