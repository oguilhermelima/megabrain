#!/usr/bin/env bash
# Runs the whole suite inside a container, so a destructive mistake cannot reach the host.
# The local run stays the authority for macOS bash 3.2; this is the safety net for
# everything that starts a tmux server, writes an agent config or installs a module.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
source_git_dir="$(git -C "$root" rev-parse --git-common-dir)"
image=megabrain-suite
output_root="${MEGABRAIN_TEST_OUTPUT_DIR:-${TMPDIR:-/tmp}/megabrain-suite-results}"

mkdir -p "$output_root"
output_dir="$(mktemp -d "$output_root/run.XXXXXX")"
# The container runs as its unprivileged runner user, so its bind mount needs to
# be writable by that user. The directory is unique and contains only this run's
# captured test output.
chmod 0777 "$output_dir"
printf 'test output: %s\n' "$output_dir" >&2

docker build -t "$image" -f "$root/tests/container/Dockerfile" "$root/tests/container" >/dev/null

# The checkout is mounted read-only and copied inside before anything runs. Read-only is
# what stops a test writing to the host tree; the copy is what lets the tests work at all.
exec docker run --rm \
  -e "MEGABRAIN_TEST_JOBS=${MEGABRAIN_TEST_JOBS:-}" \
  -e "MEGABRAIN_TEST_TIMING=${MEGABRAIN_TEST_TIMING:-}" \
  -e "TEST_SCENARIO=${TEST_SCENARIO:-}" \
  -e "SCENARIO=${SCENARIO:-}" \
  -e "FINISH_SCENARIO=${FINISH_SCENARIO:-}" \
  -e MEGABRAIN_IN_CONTAINER=true \
  -e MEGABRAIN_TEST_OUTPUT_DIR=/results \
  -v "$root:/src:ro" \
  -v "$source_git_dir:/source-git:ro" \
  -v "$output_dir:/results" \
  "$image" -c '
    set -uo pipefail
    [ "${1:-}" = -- ] && shift
    mkdir -p "$HOME/work"
    tar -C /src --exclude=.git -cf - . | tar -C "$HOME/work" -xf -
    git -C "$HOME/work" init -q
    origin_url="$(git -C /src config --get remote.origin.url 2>/dev/null || true)"
    if [ -n "$origin_url" ]; then
      git -C "$HOME/work" remote add origin "$origin_url"
    fi
    git -C "$HOME/work" fetch -q /source-git "refs/tags/*:refs/tags/*" || true
    git -C "$HOME/work" symbolic-ref HEAD refs/heads/main
    git -C "$HOME/work" add -A
    git -C "$HOME/work" -c user.name=megabrain-test -c user.email=test@example.invalid \
      commit -qm "fixture container source"
    cd "$HOME/work"
    bun run build
    shared_binary="$HOME/work/.build/megabrain"
    shared_binary_inode_before="$(ls -di "$shared_binary")"
    shared_binary_inode_before="${shared_binary_inode_before%% *}"
    printf "shared artifact inode before tests: %s\n" "$shared_binary_inode_before"
    printf "bash %s on %s\n\n" "$BASH_VERSION" "$(uname -sm)"
    selected_tests=""
    if [ "$#" -eq 0 ]; then
      selected_tests="tests/*.sh"
    else
      for requested in "$@"; do
        case "$requested" in
          *.sh) pattern="tests/$requested" ;;
          *) pattern="tests/$requested.sh" ;;
        esac
        case "$requested" in
          tests/*) pattern="$requested" ;;
        esac
        found=false
        for test_path in $pattern; do
          [ -f "$test_path" ] || continue
          if [ -n "$selected_tests" ]; then
            selected_tests="$selected_tests $test_path"
          else
            selected_tests="$test_path"
          fi
          found=true
        done
        if [ "$found" != true ]; then
          printf "no tests matched: %s\n" "$requested" >&2
          exit 2
        fi
      done
    fi
    source tests/container/worker-count.sh
    test_jobs="$(megabrain_test_jobs_resolve)"
    if [ -z "$test_jobs" ]; then
      printf "MEGABRAIN_TEST_JOBS must be a positive integer: %s\n" "$test_jobs" >&2
      exit 2
    fi
    case "$test_jobs" in
      *[!0-9]*)
        printf "MEGABRAIN_TEST_JOBS must be a positive integer: %s\n" "$test_jobs" >&2
        exit 2
        ;;
    esac
    [ "$test_jobs" -gt 0 ] || {
      printf "MEGABRAIN_TEST_JOBS must be greater than zero\n" >&2
      exit 2
    }

    result_dir="${MEGABRAIN_TEST_OUTPUT_DIR:-${TMPDIR:-/tmp}}"
    mkdir -p "$result_dir"
    failure_report="$result_dir/failures.log"
    : >"$failure_report"
    run_test() {
      local t="$1" name out meta started test_status elapsed skipped
      name="$(basename "$t" .sh)"
      out="$result_dir/$name.out"
      meta="$result_dir/$name.meta"
      started=$(date +%s)
      if timeout 60 bash "$t" >"$out" 2>&1; then
        test_status=0
      else
        test_status=$?
      fi
      elapsed=$(( $(date +%s) - started ))
      # Tests declare skipped scenarios with one `skip: reason` line each.
      # Count the captured declarations here so a new scenario needs no runner registry.
      skipped="$(awk "/^skip:[[:space:]]/ { count += 1 } END { print count + 0 }" "$out")"
      printf "%s %s %s\n" "$test_status" "$elapsed" "$skipped" >"$meta"
    }
    export result_dir
    export -f run_test
    printf "%s\n" "${test_jobs} test workers"
    printf "%s\\n" $selected_tests | xargs -P "$test_jobs" -n 1 bash -c "run_test \"\$1\"" _

    failed=0 passed=0 skipped=0 slowest_test="" slowest_seconds=0
    for selection in TEST_SCENARIO SCENARIO FINISH_SCENARIO; do
      case "$selection" in
        TEST_SCENARIO) value="${TEST_SCENARIO:-}" ;;
        SCENARIO) value="${SCENARIO:-}" ;;
        FINISH_SCENARIO) value="${FINISH_SCENARIO:-}" ;;
      esac
      if [ -n "$value" ]; then
        printf "scenario selection: %s=%s\n" "$selection" "$value"
      fi
    done
    for t in $selected_tests; do
      name="$(basename "$t" .sh)"
      out="$result_dir/$name.out"
      meta="$result_dir/$name.meta"
      if [ -f "$meta" ]; then
        IFS=" " read -r test_status elapsed test_skipped <"$meta"
      else
        test_status=124
        elapsed=60
        test_skipped=0
      fi
      if [ -z "$slowest_test" ] || [ "$elapsed" -gt "$slowest_seconds" ]; then
        slowest_seconds="$elapsed"
        slowest_test="$t"
      fi
      if [ "$test_status" -eq 0 ]; then
        printf "%-46s PASS (%ss)\n" "$t" "$elapsed"
        passed=$((passed + 1))
      else
        printf "%-46s FAIL (%ss)\n" "$t" "$elapsed"
        tail -6 "$out" | sed "s/^/    /"
        {
          printf "FAIL %s\n" "$t"
          cat "$out"
          printf "\n"
        } >>"$failure_report"
        failed=$((failed + 1))
      fi
      if [ "$test_skipped" -gt 0 ]; then
        while IFS= read -r skip_line; do
          [ -n "$skip_line" ] || continue
          printf "    SKIP %s: %s\n" "$t" "$skip_line"
        done <<EOF
$(awk "/^skip:[[:space:]]/ { print }" "$out")
EOF
        skipped=$((skipped + test_skipped))
      fi
    done
    printf "\n%s passed, %s failed, %s skipped\n" "$passed" "$failed" "$skipped"
    printf "slowest: %s (%ss); timeout ceiling: 60s; workers: %s\n" "$slowest_test" "$slowest_seconds" "$test_jobs"
    shared_binary_inode_after="$(ls -di "$shared_binary")"
    shared_binary_inode_after="${shared_binary_inode_after%% *}"
    printf "shared artifact inode after tests: %s\n" "$shared_binary_inode_after"
    if [ "$shared_binary_inode_after" != "$shared_binary_inode_before" ]; then
      printf "shared artifact inode changed during the container run\n" >&2
      failed=$((failed + 1))
    fi
    if [ "$failed" -eq 0 ]; then
      printf "No failing tests.\n" >"$failure_report"
    fi
    [ "$failed" -eq 0 ]
  ' -- "$@"
