# Chat artifact sources

This note records the read-only investigation for the chat artifacts CLI. Agent logs and state
directories were inspected in place and were not modified.

## Existing megabrain artifacts

`src/knowledge/artifacts.ts` stores `chatId` on each artifact's `artifact.json` record. `listArtifacts`
already sorts by `updatedAt`, and `showArtifact` reads the content. HTML is normalized with
`stripGoogleFonts`. During the investigation, `src/cli/commands/artifact.ts` accepted an explicit
`--chat` but otherwise stored `chatId: null`.

Chats keep their agent session id in `chats/<chat-id>/chat.json` as `agentSessionId`. During the
investigation, the chat daemon injected `MEGABRAIN_CHATD_STATE_DIR` for its own process but did not
pass a chat id to an agent child. The implementation now passes `MEGABRAIN_CHAT_ID` to that child;
`megabrain artifact create` uses it when `--chat` is absent, while an explicit `--chat` remains
authoritative.

## Claude Code and Claude Design

Claude session JSONL stores tool calls as assistant message content blocks. The real calls found
have this shape (paths and private URLs are redacted):

```json
{"type":"tool_use","id":"toolu_…","name":"Artifact","input":{"action":"publish","type_url":"https://claude.ai/artifact/…","title":"…"}}
```

Other real publish calls included a local `file_path` and `label`; a Design publication on this
machine was not found. The corresponding `tool_result` carries the `tool_use_id` and text. One
real result had this shape:

```text
Created a new Artifact at https://claude.ai/artifact/… (version …) from the Artifact type https://claude.ai/artifact/… (release …).
```

The transcripts contained Artifact definitions and calls, but no executed `DesignSync` call. An
Artifact type may be Design even though its publish input only has `type_url`; therefore classify a
publish as `claude-design` only when its `type_url` or matching tool result identifies a type whose
title contains “Design”, or when a `DesignSync` call itself is present. Otherwise it is
`claude-artifact`. Because no real Design publication exists in the inspected logs, its test
fixture should preserve the real Artifact call/result structure while substituting a Design type
result and clearly remain a synthetic classification case.

Session identity is the Claude JSONL filename UUID; the chat record's `agentSessionId` maps to that
filename using the existing `claudeLogPath` convention.

## Codex

Codex sessions are JSONL rollouts under `~/.codex/sessions`. The inspected rollouts contain
conversation and tool activity, but no persisted `update_plan` artifact or other dedicated plan
document that can be read as a stable artifact. Ordinary files mentioned as deliverables are not
owned by the rollout and have no stable artifact identity. Do not expose a `codex-plan` source
until a durable plan format is available.

## Antigravity (agy)

Antigravity keeps conversations in `~/.gemini/antigravity-cli/conversations/<uuid>.db` and
conversation working material in `~/.gemini/antigravity-cli/brain/<uuid>/`. For example, an
inspected conversation had a matching brain directory containing `walkthrough.md`; generated task
logs and step content also live under `.system_generated/`. The conversation UUID ties those
Antigravity records together. Megabrain app chats currently support Claude and Codex only, and
there is no mapping from an Antigravity UUID to a chat `agentSessionId`, so `agy` is intentionally
unused until an explicit association exists. No Antigravity files were changed.

## Grok

Grok keeps session history under `~/.grok/sessions/<encoded-workspace>/<session-id>/`, including
`chat_history.jsonl`, event and update logs, and summaries. Inspection did not identify a durable
artifact format or a chat-to-session mapping suitable for this contract. Leave `grok` unused.

## CLI contract

The desktop lane consumes `megabrain chat artifacts <chat-id> --json` and
`megabrain chat artifact <chat-id> <artifact-id> --json`. Local megabrain artifacts are linked by
their stored `chatId`; Claude sources are discovered from the chat's own Claude session JSONL.
Megabrain artifact ids remain their original `art-...` store ids; Claude ids derive from source and
local path or remote URL. Local content is capped at 1 MiB. The live-only `artifacts` event uses an
empty cursor and is sent only to followers when the list or a listed local file's update time
changes.
