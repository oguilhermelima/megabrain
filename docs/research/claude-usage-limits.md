# How other apps read Claude usage limits

Question: megabrain polls `GET https://api.anthropic.com/api/oauth/usage` about once a minute with the Claude Code OAuth token and gets HTTP 429. How do Orca, Superset and Conductor get the same numbers without it?

Method: read-only. Orca 's `app.asar` and Superset's `app.asar` were extracted to a scratch dir; Claude Code 2.1.301 (`~/.local/share/claude/versions/2.1.301`) was inspected with `strings`. No request was sent to any endpoint.

## Summary

- Nobody has a better endpoint. Orca and Superset call the same `oauth/usage` URL megabrain calls, with the same Keychain token.
- The apps that survive do two things megabrain does not: they rate-limit themselves hard (Superset: one request per 5 min, shared across callers; Orca: honours `Retry-After` and skips fetches), and the best source of all is not the endpoint. Orca takes live numbers from Claude Code's statusLine `rate_limits` payload, which costs no usage-endpoint budget at all.
- Orca's own source says it plainly: the endpoint "429s under Orca's polling".
- Our 429 is explained by interval, not headers. Our request is a valid shape (see comparison).

## Orca (installed, /Applications/Orca.app)

Evidence: `app.asar` -> `out/main/index.js`, `out/main/chunks/hook-service-yuyCywXx.js`, `out/shared/claude-statusline-rate-limits.js`.

1. Endpoint fetch (fallback source). `index.js` offset ~7598800: `fetch("https://api.anthropic.com/api/oauth/usage", { headers: { Authorization: "Bearer <token>", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" } })`, 10 s timeout. Token is Claude Code's own: Keychain "Claude Code-credentials" or `<configDir>/.credentials.json`. No `anthropic-version` header.
2. Backoff. On 429 it parses `Retry-After` (seconds or HTTP date), caps it at 24 h, stores `retryAtMs`, marks the failure terminal (no CLI fallback, no refresh) and `shouldSkipAutomatedClaudeFetch` skips automated fetches while `retryAtMs` is in the future. 401/403 -> "stale token" (waits for Claude Code to refresh; it does not refresh the token itself).
3. Primary source: statusLine. `out/shared/claude-statusline-rate-limits.js` header comment: "Claude Code (>=2.1.80) pipes `rate_limits` to the statusLine command on every turn - piggybacked on Messages API responses, so reading it costs no usage-endpoint budget (the endpoint 429s under Orca's polling)". Orca installs a managed script `~/.orca/agent-hooks/claude-statusline.sh`, which POSTs the stdin payload to its local hook server `/statusline/claude` (at most once per 15 s per pane; the service dedupes within 30 s). `ingestLiveClaudeRateLimits` stores it as source `live-session`; while a live reading is under 5 min old (`isLiveClaudeUsageFresh`, 3e5 ms) the endpoint is not called.
4. Orca only writes `statusLine` into `~/.claude/settings.json` when the user has none (`qt()` returns `user` for a foreign command and `Yt()` then leaves it alone). On this machine `statusLine` is `ai-statusline`, so Orca's statusLine path is probably inactive here and it falls back to the endpoint.
5. Poll interval: not found as a single constant in the bundle; the 5 min freshness rule and the `Retry-After` skip are what bound it.

## Superset (installed, /Applications/Superset.app)

Evidence: `app.asar` -> `node_modules/@superset/host-service/src/trpc/router/usage/{claude.ts,usage.ts}`.

- Same endpoint, same Keychain item ("Claude Code-credentials") plus `~/.claude/.credentials.json` and `~/.config/claude/credentials.json`, picks the freshest. Headers: `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20` only (no User-Agent, no `anthropic-version`). Also calls `/api/oauth/profile` for the email.
- Never refreshes tokens (comment: a second refresher can trip token-reuse protection and sign the CLI out). Expired access token with a live refresh token -> shows "Refreshes when Claude Code next runs".
- Cache: `usage.ts` `QUOTA_CACHE_TTL_MS = 5 * 60 * 1000`, one in-flight promise shared by all callers, evicted on rejection. Source comment: ">=5 min: Anthropic 429-blacklists faster pollers of the oauth/usage endpoint (ccusage deprecated its live gauge over this; CodexBar #30930)."
- No statusLine hook.

## Conductor (not installed)

Closed source, no `/Applications/Conductor*`, no `~/Library/Application Support/*onductor*`. A web search found no documentation of how it shows Claude usage (only Conductor-as-worktree-orchestrator pages, e.g. https://portkey.ai/blog/conductor-x-portkey-is-now-live/). Treat as unknown; no evidence either way. Not worth more time.

## Claude Code itself (2.1.301)

Evidence: strings of the binary.

- `/usage` backend `Hm()`: `GET /api/oauth/usage` (variants `?at_wall=1&skip_spend=1`, `?cedar_ember=1&skip_spend=1`) through its own axios instance, 5 s timeout, `refreshOAuth: true`, `Content-Type: application/json`. User-Agent is `claude-code/<version>` (`gs()` -> `claude-code/2.1.301`). It serialises concurrent reads (`kL` shares one pending promise) and records 429/403 with `Retry-After` (default 5 min `Zw=300000`, capped 1 h `zm=3600000`) so it will not hammer after a 429.
- It refreshes the OAuth token itself; other apps must not.
- Statusline `rate_limits` is not read from this endpoint per turn. It comes from the `anthropic-ratelimit-unified-*` response headers on normal Messages API responses (`-5h-utilization`, `-5h-reset`, `-7d-utilization`, `-7d-reset`, ...), then handed to the statusLine command on stdin as `rate_limits.five_hour` / `seven_day` (and a `limits[]` array in newer builds).
- No disk cache of usage found: `~/.claude` has only `stats-cache.json` (token counts), no rate-limit file. Nothing for another process to read except by being the statusLine command.

## megabrain today

`src/core/chain-limits.ts:310-312`: `curl` to `https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`, `anthropic-version: 2023-06-01`; default curl User-Agent (`curl/x.y`); Keychain token; refuses an expired token; no cache or backoff in this function (a 429 is returned as a transient reading with `retryAfterSeconds`, honouring it depends on the caller).

## Why we get 429 and they do not

1. Interval. Superset caches 5 min and says faster pollers get 429-blacklisted; Orca skips for `Retry-After` and for 5 min after a live reading; Claude Code itself backs off 5 min on 429. We poll every ~60 s. This is the main cause and is stated in two vendor sources.
2. Concurrency. Superset/Claude Code share one in-flight request. Several megabrain processes or dispatch checks each spawn their own `curl`.
3. Source. Orca avoids the endpoint whenever the statusLine feed is fresh.
4. Headers are not the cause. Our set is a superset of Superset's. The only differences: we send the curl User-Agent while Orca and Claude Code send `claude-code/<ver>`. Unverified whether the server rate-limits per client UA; it is cheap to match, but do not expect it to fix a 60 s interval.

## Recommendation

Do all of these, in order of effect:

1. Poll no faster than 5 min and cache the last good reading on disk (the `limits` table / a state file) so `chain limits` and every reader serve it. Superset's cache is the proven floor.
2. On HTTP 429, record `now + Retry-After` (default 5 min, cap 1 h as Claude Code does, 24 h as Orca does) and make the reader return the cached reading with `stale` until then; never call again before it. Today `retryAfterSeconds` is returned but nothing enforces a cooldown.
3. Single flight: a lock or shared in-flight call so concurrent megabrain processes do not each curl.
4. Send `User-Agent: claude-code/<installed claude --version>` and drop `anthropic-version` (neither Orca nor Superset sends it; harmless but not needed). Low confidence this matters.
5. Optional, best accuracy at zero budget cost: a statusLine feed like Orca's, but only when the user has no statusLine or opts in. The person declined wrapping `~/.claude/settings.json` statusLine, so skip it. Alternative with no settings edit: none found; Claude Code writes no readable cache.

Exact change in `src/core/chain-limits.ts` (`fetchClaudeUsage`, ~line 300): before the `curl`, read the stored Claude reading; if `fetchedAt` is under 300 s old, return it as `live`/cached; if a stored `retryAtMs` is in the future, return it stale; after a 429 write `retryAtMs`. Raise the Claude refresh interval wherever the 60 s poll is scheduled to 300 s.
