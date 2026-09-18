#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-root-export.XXXXXX")"
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

# The fixture is the installed wrapper's checkout. Keeping it outside the repository makes the
# red and green runs prove the child process contract without writing the checkout build.
mkdir -p "$fixture/.build" "$state" "$unrelated" "$work/home" "$work/bin"
cp "$root/megabrain" "$fixture/megabrain"
cp -R "$root/lib" "$fixture/lib"
cp -R "$root/src" "$fixture/src"
cp -R "$root/scripts" "$fixture/scripts"
cp -R "$root/skills" "$fixture/skills"
cp -R "$root/.megabrain" "$fixture/.megabrain"
cp "$binary_source" "$fixture/.build/megabrain"
chmod +x "$fixture/megabrain" "$fixture/.build/megabrain"

# web devices must resolve the script but must not launch a browser in this contract.
cat >"$work/bin/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*"
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
    MEGABRAIN_STATE_DIR="$state" \
    MEGABRAIN_PLAYWRIGHT_ROOT="$work/playwright" \
    "$fixture/megabrain" "$@" 2>&1)"; then
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

# Scenario: fact list returns the checkout fact instead of a plausible empty table.
# Falsification: an unexported root returns [] with exit code 0.
fact_output="$work/fact.out"
fact_status="$(run_from_unrelated "$fact_output" fact list --json)"
[ "$fact_status" -eq 0 ] || fail "fact list returned $fact_status: $(cat "$fact_output")"
jq -e 'any(.[]; .id == "bash-version")' "$fact_output" >/dev/null ||
  fail "fact list silently returned no checkout facts: $(cat "$fact_output")"
printf 'fact list reads checkout facts outside the repository\n'

# Scenario: doctor assesses the compiled artifact at the checkout root.
# Falsification: an unexported root reports an absent artifact and still exits 0.
doctor_output="$work/doctor.out"
doctor_status="$(run_from_unrelated "$doctor_output" doctor compiled-binary --json)"
[ "$doctor_status" -eq 0 ] || [ "$doctor_status" -eq 1 ] ||
  fail "doctor returned unexpected status $doctor_status: $(cat "$doctor_output")"
jq -e '.module == "compiled-binary" and (.reason | test("compiled binary is (current|stale)"))' "$doctor_output" >/dev/null ||
  fail "doctor did not assess the checkout binary: $(cat "$doctor_output")"
if grep -F 'compiled binary is not present' "$doctor_output" >/dev/null; then
  fail 'doctor skipped freshness by resolving the binary against the unrelated directory'
fi
printf 'doctor assesses checkout binary outside the repository\n'

# Scenario: chain state remains isolated in the test fixture while running outside the repository.
# Falsification: an ambient home or cwd state source changes the fixture result.
chain_output="$work/chain.out"
chain_status="$(run_from_unrelated "$chain_output" chain list)"
[ "$chain_status" -eq 0 ] || fail "chain list returned $chain_status: $(cat "$chain_output")"
grep -F 'fixture' "$chain_output" >/dev/null ||
  fail "chain list did not read the fixture state: $(cat "$chain_output")"
printf 'chain list remains isolated outside the repository\n'

printf 'ok: checkout file resolution from an unrelated directory\n'
