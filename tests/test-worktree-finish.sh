#!/usr/bin/env bash

set -euo pipefail

# The finish implementation is compiled TypeScript. Keep this historical test
# name as a compatibility entrypoint for targeted callers.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec "$root/tests/test-worktree-finish-cli.sh" "$@"
