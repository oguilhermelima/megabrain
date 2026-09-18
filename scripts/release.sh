#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
manifest="$root/.claude-plugin/plugin.json"
template="$root/Formula/megabrain.rb.in"
output=""
formula_output=""
tag="${1:-}"
release_version=""
release_version_file=""
release_version_path=""

fail() {
  printf 'release: %s\n' "$*" >&2
  exit 1
}

record_release_version() {
  local file="$1" path="$2" value="$3"
  [ -n "$value" ] || fail "release version is empty in $file$path"
  if [ -z "$release_version_file" ]; then
    release_version="$value"
    release_version_file="$file"
    release_version_path="$path"
  elif [ "$value" != "$release_version" ]; then
    fail "version mismatch: $release_version_file$release_version_path=$release_version versus $file$path=$value"
  fi
}

validate_release_versions() {
  local file='' declarations='' declaration_path='' declaration_value=''
  while IFS= read -r file; do
    case "$file" in
      .megabrain/facts.json) continue ;; # facts.json version 1 is the facts schema, not a release version.
      .megabrain/models.json) continue ;; # models.json version 1 is the models schema, not a release version.
      .megabrain/native.json) continue ;; # native.json version 1 is the native schema, not a release version.
    esac
    declarations="$(jq -r '
      if type == "object" and has("version") then
        [".version", (.version | tostring)] | @tsv
      else empty end,
      if type == "object" then
        .plugins[]?
        | select(type == "object" and .name == "megabrain" and has("version"))
        | [".plugins[].version", (.version | tostring)] | @tsv
      else empty end
    ' "$root/$file")" || fail "could not read version declarations from $file"
    while IFS="$(printf '\t')" read -r declaration_path declaration_value; do
      [ -n "$declaration_path" ] || continue
      record_release_version "$file" "$declaration_path" "$declaration_value"
    done <<EOF
$declarations
EOF
  done <<EOF
$(git -C "$root" ls-files '*.json')
EOF
  [ -n "$release_version_file" ] || fail 'no release version declarations found'
}

print_help() {
  cat <<EOF
Usage: scripts/release.sh v<version> [--output <path>] [--formula-output <path>]

Build a release archive and render the Homebrew formula.
  v<version>                 release tag; must match the manifest version
  --output <path>            archive destination
  --formula-output <path>    rendered formula destination
  -h, --help                 show this help

The script prints the commands for the operator to run. It does not tag,
push, or create a GitHub release itself.
The rendered formula commit must be the last commit before tagging.
The archive intentionally excludes the compiled binary; install.sh builds it with Bun after extraction.
EOF
}

sha256_file() {
  local path="$1" output=''
  if command -v shasum >/dev/null 2>&1; then
    output="$(shasum -a 256 "$path")" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then
    output="$(sha256sum "$path")" || return 1
  else
    return 1
  fi
  printf '%s\n' "${output%% *}"
}

archive_release_tree() {
  local help_output=''
  help_output="$(git -C "$root" archive -h 2>&1 || true)"
  case "$help_output" in
    *--mtime*)
    git -C "$root" archive --format=tar --mtime='1970-01-01 00:00:00' \
      --prefix="megabrain-$version/" HEAD^{tree} -- . ':(exclude)Formula'
    ;;
    *)
    git -C "$root" archive --format=tar --prefix="megabrain-$version/" \
      HEAD^{tree} -- . ':(exclude)Formula'
    ;;
  esac
}

[ -f "$manifest" ] || fail "manifest is missing: $manifest"
[ -f "$template" ] || fail "formula template is missing: $template"
validate_release_versions
version="$(jq -er '.version | strings | select(length > 0)' "$manifest")" ||
  fail "could not read a version from $manifest"
case "$tag" in
  -h|--help)
    print_help
    exit 0
    ;;
esac
[ -n "$tag" ] || fail "usage: scripts/release.sh v$version [--output <path>]"
expected_tag="v$version"
[ "$tag" = "$expected_tag" ] ||
  fail "tag $tag does not match manifest version $version (expected $expected_tag)"
shift

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      [ "$#" -gt 1 ] || fail '--output requires a path'
      output="$2"
      shift 2
      ;;
    --formula-output)
      [ "$#" -gt 1 ] || fail '--formula-output requires a path'
      formula_output="$2"
      shift 2
      ;;
    -h|--help)
      printf 'Usage: scripts/release.sh v%s [--output <path>] [--formula-output <path>]\n' "$version"
      exit 0
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ -n "$output" ] || output="$root/dist/megabrain-$version.tar.gz"
[ -n "$formula_output" ] || formula_output="$root/Formula/megabrain.rb"
output_dir="$(dirname "$output")"
formula_dir="$(dirname "$formula_output")"
mkdir -p "$output_dir" || fail "could not create output directory: $output_dir"
temp="$(mktemp "$output.XXXXXX")" || fail "could not create temporary archive: $output"
if ! archive_release_tree | gzip -n >"$temp"; then
  rm -f "$temp"
  fail 'could not create release archive from HEAD'
fi

archive_hash="$(sha256_file "$temp")" || {
  rm -f "$temp"
  fail 'could not hash release archive'
}
if ! mv -f "$temp" "$output"; then
  rm -f "$temp"
  fail "could not install release archive: $output"
fi
mkdir -p "$formula_dir" || fail "could not create formula directory: $formula_dir"
formula_temp="$(mktemp "$formula_output.XXXXXX")" || fail "could not create temporary formula: $formula_output"
if ! sed -e "s/__VERSION__/$version/g" -e "s/__SHA256__/$archive_hash/g" "$template" >"$formula_temp"; then
  rm -f "$formula_temp"
  fail 'could not render Homebrew formula'
fi
if ! mv -f "$formula_temp" "$formula_output"; then
  rm -f "$formula_temp"
  fail "could not install rendered formula: $formula_output"
fi

printf 'release archive: %s\n' "$output"
printf 'rendered formula: %s\n' "$formula_output"
printf 'compiled binary: install.sh builds it with Bun after extraction (not included in the archive)\n'
printf 'git tag -a %s -m "Release %s"\n' "$tag" "$version"
printf 'git push origin %s\n' "$tag"
printf 'gh release create %s %s --title "Release %s" --generate-notes\n' "$tag" "$output" "$version"
