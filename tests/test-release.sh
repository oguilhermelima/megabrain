#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/megabrain-release.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

release_script="$root/scripts/release.sh"
version="$(jq -r '.version' "$root/.claude-plugin/plugin.json")"
archive="$work/megabrain-$version.tar.gz"
formula="$work/megabrain.rb"
tracked_formula_hash_before="$(shasum -a 256 "$root/Formula/megabrain.rb" | awk '{print $1}')"

if help_output="$("$release_script" --help 2>&1)"; then
  help_status=0
else
  help_status=$?
fi
[ "$help_status" -eq 0 ] || fail "--help was refused: $help_output"
case "$help_output" in
  *'Build a release archive and render the Homebrew formula.'*) ;;
  *) fail "--help did not describe the release operation: $help_output" ;;
esac
case "$help_output" in
  *'v<version>'*|*'v0.2.0'*) ;;
  *) fail "--help did not describe the tag argument: $help_output" ;;
esac
case "$help_output" in
  *'--output <path>'*) ;;
  *) fail "--help omitted --output: $help_output" ;;
esac
case "$help_output" in
  *'--formula-output <path>'*) ;;
  *) fail "--help omitted --formula-output: $help_output" ;;
esac
case "$help_output" in
  *'prints the commands for the operator to run'*|*'does not tag or push'*) ;;
  *) fail "--help did not explain operator commands: $help_output" ;;
esac
case "$help_output" in
  *'compiled binary'*'install.sh'*'Bun'*) ;;
  *) fail "--help did not explain how the compiled binary is delivered: $help_output" ;;
esac
printf 'scenario 1: release help describes arguments and operator commands\n'

mismatch_tag="v$version-mismatch"
if mismatch_output="$("$release_script" "$mismatch_tag" --output "$archive" --formula-output "$work/mismatch-formula.rb" 2>&1)"; then
  mismatch_status=0
else
  mismatch_status=$?
fi
[ "$mismatch_status" -ne 0 ] || fail 'release script accepted a tag that differs from the manifest'
case "$mismatch_output" in
  *"does not match manifest version $version"*) ;;
  *) fail "mismatch error did not name the manifest version: $mismatch_output" ;;
esac
printf 'scenario 2: mismatched release tag is refused\n'

matching_output="$($release_script "v$version" --output "$archive" --formula-output "$formula" 2>&1)" ||
  fail "matching release tag was refused: $matching_output"
[ -s "$archive" ] || fail 'matching release did not produce a tarball'
[ -s "$formula" ] || fail 'matching release did not render a formula'
case "$matching_output" in
  *"git tag -a v$version"*) ;;
  *) fail "release instructions omitted the tag command: $matching_output" ;;
esac
case "$matching_output" in
  *"gh release create v$version"*) ;;
  *) fail "release instructions omitted the release command: $matching_output" ;;
esac
tar -tzf "$archive" | grep -F "megabrain-$version/megabrain" >/dev/null ||
  fail 'release tarball does not contain the megabrain entrypoint'
if tar -tzf "$archive" | grep -F '/.build/megabrain' >/dev/null; then
  fail 'release tarball unexpectedly contains the compiled binary'
fi
grep -F "releases/download/v$version/megabrain-$version.tar.gz" "$formula" >/dev/null || fail 'rendered formula has the wrong version'
grep -Eq '^  sha256 "[0-9a-f]{64}"$' "$formula" || fail 'rendered formula has no concrete sha256'
grep -F '__VERSION__' "$formula" >/dev/null && fail 'rendered formula retained a version placeholder'
tracked_formula_hash_after="$(shasum -a 256 "$root/Formula/megabrain.rb" | awk '{print $1}')"
[ "$tracked_formula_hash_before" = "$tracked_formula_hash_after" ] ||
  fail 'release test changed the tracked formula'
printf 'scenario 3: matching release tag creates the formula tarball and instructions\n'

jq -e '(.private == true) and (.files == null) and (has("bin") | not)' "$root/package.json" >/dev/null ||
  fail 'package metadata implies an npm binary package even though distribution is private'
printf 'scenario 4: private package metadata does not claim an npm binary\n'

committed_root="$work/formula-change"
git clone -q "$root" "$committed_root" || fail 'could not clone the release tree'
committed_archive="$work/committed.tar.gz"
committed_formula="$work/committed-formula.rb"
matching_output="$($release_script "v$version" --output "$committed_archive" --formula-output "$committed_formula" 2>&1)" ||
  fail "release script refused the committed release tree: $matching_output"
# Match release.sh's capability check: without --mtime, git archive timestamps entries at runtime.
archive_help_output="$(git -C "$root" archive -h 2>&1 || true)"
case "$archive_help_output" in
  *--mtime*)
    formula_release_tag="$(sed -n 's#^  url ".*releases/download/\(v[^/]*\)/megabrain-[^/]*\.tar\.gz"$#\1#p' "$root/Formula/megabrain.rb")"
    [ -n "$formula_release_tag" ] || fail 'committed formula has no release tag in its URL'
    if ! git -C "$root" rev-parse --verify "refs/tags/$formula_release_tag^{commit}" >/dev/null 2>&1; then
      printf 'skip: committed formula hash comparison skipped because tag %s is unavailable\n' \
        "$formula_release_tag"
    else
      formula_archive_version="$(sed -n 's#^  url ".*releases/download/v[^/]*/megabrain-\([^/]*\)\.tar\.gz"$#\1#p' "$root/Formula/megabrain.rb")"
      [ -n "$formula_archive_version" ] || fail 'committed formula has no archive version in its URL'
      formula_archive="$work/formula-release.tar.gz"
      if ! git -C "$root" archive --format=tar --mtime='1970-01-01 00:00:00' \
        --prefix="megabrain-$formula_archive_version/" "$formula_release_tag^{tree}" -- . \
        ':(exclude)Formula' | gzip -n >"$formula_archive"; then
        fail "could not create archive for formula tag $formula_release_tag"
      fi
      formula_hash="$(sed -n 's/^  sha256 "\([0-9a-f]\{64\}\)"$/\1/p' "$root/Formula/megabrain.rb")"
      [ -n "$formula_hash" ] || fail 'committed formula has no sha256'
      committed_hash="$(shasum -a 256 "$formula_archive" | awk '{print $1}')"
      [ "$formula_hash" = "$committed_hash" ] ||
        fail "committed formula hash $formula_hash does not match $formula_release_tag archive $committed_hash"
      printf 'scenario 5: committed formula hash matches its tagged release archive\n'
    fi
    ;;
  *)
    printf 'skip: committed formula hash comparison requires git archive --mtime for reproducible archives\n'
    ;;
esac
printf '\n# Formula-only release invariant test\n' >>"$committed_root/Formula/megabrain.rb"
git -C "$committed_root" -c user.name=megabrain-test -c user.email=megabrain-test@example.com \
  add Formula/megabrain.rb || fail 'could not stage the Formula-only change'
git -C "$committed_root" -c user.name=megabrain-test -c user.email=megabrain-test@example.com \
  commit -m 'test release formula-only change' >/dev/null || fail 'could not commit the Formula-only change'
changed_archive="$work/changed.tar.gz"
changed_formula="$work/changed-formula.rb"
matching_output="$("$committed_root/scripts/release.sh" "v$version" --output "$changed_archive" --formula-output "$changed_formula" 2>&1)" ||
  fail "release script refused the Formula-only commit: $matching_output"
committed_tree="$work/committed-tree"
changed_tree="$work/changed-tree"
mkdir -p "$committed_tree" "$changed_tree"
tar -xzf "$committed_archive" -C "$committed_tree" ||
  fail 'could not extract the committed release archive'
tar -xzf "$changed_archive" -C "$changed_tree" ||
  fail 'could not extract the changed release archive'
diff -r "$committed_tree" "$changed_tree" >/dev/null ||
  fail 'Formula-only commit changed the release archive contents'
changed_entries="$(tar -tzf "$changed_archive")" ||
  fail 'could not list the changed release archive'
[ -n "$changed_entries" ] || fail 'changed release archive contains no entries'
if printf '%s\n' "$changed_entries" | grep -F '/Formula/' >/dev/null; then
  fail 'release archive includes Formula files'
fi
printf 'scenario 6: Formula-only commit preserves the release.sh archive\n'

manifest_mismatch_root="$work/manifest-mismatch"
git clone -q "$root" "$manifest_mismatch_root" || fail 'could not clone the manifest tree'
jq --arg version '9.9.9' \
  '(.plugins[] | select(.name == "megabrain") | .version) = $version' \
  "$manifest_mismatch_root/.claude-plugin/marketplace.json" >"$work/marketplace.json" ||
  fail 'could not create a mismatched marketplace manifest'
mv "$work/marketplace.json" "$manifest_mismatch_root/.claude-plugin/marketplace.json"
if mismatch_output="$("$manifest_mismatch_root/scripts/release.sh" "v$version" \
  --output "$work/mismatch-release.tar.gz" --formula-output "$work/mismatch-release.rb" 2>&1)"; then
  fail 'release script accepted mismatched release versions'
fi
case "$mismatch_output" in
  *'version mismatch'*'.claude-plugin/marketplace.json'*) ;;
  *) fail "version mismatch error was not actionable: $mismatch_output" ;;
esac
printf 'scenario 7: release refuses mismatched JSON release versions\n'

printf 'ok: release guard scenarios\n'
