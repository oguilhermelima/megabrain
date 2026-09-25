# Shell implementation removal

The unreachable Bash command implementations and the context shell fallback have been removed.
The `megabrain` entrypoint keeps its `command_*` wrappers for binary checks, freshness warnings,
and compatibility with existing command entrypoints.

Command behavior lives in `src/cli` and `src/core`; context detection is implemented in
`src/cli/commands/context.ts`. `lib/common.sh` retains the usage table and small wrapper helpers.
