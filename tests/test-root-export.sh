#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# WHY: the Node bundle resolves package assets independently of the caller's current directory.
work="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/megabrain-root-export.XXXXXX")" && pwd -P)"
fixture="$work/repo"
state="$work/state"
unrelated="$work/unrelated"
binary_source="${MEGABRAIN_TEST_BINARY:-$root/.build/megabrain}"
trap 'rm -rf "$work"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ -x "$binary_source" ] || {
  printf 'skip: compiled root-export binary is missing at %s; run bun run build\n' "$binary_source"
  exit 0
}

# The fixture is an installed package copy kept outside the repository.
mkdir -p "$fixture/.build" "$state" "$unrelated" "$work/home" "$work/bin"
cp "$root/.build/megabrain" "$fixture/.build/megabrain"
cp "$root/package.json" "$fixture/package.json"
cp -R "$root/scripts" "$fixture/scripts"
cp -R "$root/skills" "$fixture/skills"
cp -R "$root/.megabrain" "$fixture/.megabrain"
cp "$binary_source" "$fixture/.build/megabrain"
chmod +x "$fixture/.build/megabrain"

# The fixture Node captures the Playwright script invocation while still running the CLI bundle.
real_node="$(command -v node)"
cat >"$work/bin/node" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  */scripts/playwright-web.mjs) printf '%s\n' "$*"; exit 0 ;;
esac
exec "$MEGABRAIN_TEST_REAL_NODE" "$@"
EOF
chmod +x "$work/bin/node"

cat >"$state/chains.json" <<'EOF'
{
  "chains": {
    "fixture": {
      "when": {"parentAgent": "fixture"},
      "steps": [{"agent": "codex", "model": "fixture", "effort": "low"}]
    }
  },
  "defaultSteps": [],
  "usageLimits": {}
}
EOF

run_from_unrelated() {
  local output_file="$1"
  shift
  local exit_code
  if output_file_value="$(cd "$unrelated" && env -i \
    HOME="$work/home" \
    PATH="$work/bin:/usr/bin:/bin" \
    MEGABRAIN_TEST_REAL_NODE="$real_node" \
    MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_PLAYWRIGHT_ROOT="$work/playwright" \
    "$fixture/.build/megabrain" "$@" 2>&1)"; then
    exit_code=0
  else
    exit_code=$?
  fi
  printf '%s' "$output_file_value" >"$output_file"
  printf '%s\n' "$exit_code"
}

# Scenario: web resolves its checkout script from an unrelated directory.
# Falsification: an unexported root sends the unrelated/scripts path to node.
web_output="$work/web.out"
web_status="$(run_from_unrelated "$web_output" web devices)"
[ "$web_status" -eq 0 ] || fail "web devices returned $web_status: $(cat "$web_output")"
grep -F "$fixture/scripts/playwright-web.mjs" "$web_output" >/dev/null ||
  fail "web devices did not resolve the fixture script: $(cat "$web_output")"
if grep -F "$unrelated/scripts/playwright-web.mjs" "$web_output" >/dev/null; then
  fail 'web devices resolved its script against the unrelated directory'
fi
printf 'web resolves checkout script outside the repository\n'

# Scenario: model reads the checkout template from an unrelated directory.
# Falsification: an unexported root reports the unrelated/.megabrain/models.json as missing.
model_output="$work/model.out"
model_status="$(run_from_unrelated "$model_output" model list --json)"
[ "$model_status" -eq 0 ] || fail "model list returned $model_status: $(cat "$model_output")"
jq -e '.version == 1 and (.models | length > 0)' "$model_output" >/dev/null ||
  fail "model list did not read the checkout registry: $(cat "$model_output")"
printf 'model reads checkout registry outside the repository\n'

# Scenario: chain validation reads the checkout model registry outside the repository.
# Falsification: without the exported root, the invalid model is accepted because validation is
# silently skipped when models.json is resolved against the unrelated directory.
chain_output="$work/chain.out"
chain_status="$(run_from_unrelated "$chain_output" chain list)"
[ "$chain_status" -eq 1 ] || fail "chain list accepted an invalid model: $(cat "$chain_output")"
grep -F "unknown model 'fixture'" "$chain_output" >/dev/null ||
  fail "chain list did not validate against the checkout registry: $(cat "$chain_output")"
printf 'chain list validates checkout models outside the repository\n'

printf 'ok: checkout file resolution from an unrelated directory\n'
