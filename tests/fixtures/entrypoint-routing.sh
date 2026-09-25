#!/usr/bin/env bash

make_entrypoint_routing_fixture() {
  local source_root="$1" fixture_root="$2" marker_status="$3"
  mkdir -p "$fixture_root/.build"
  printf '#!/usr/bin/env bash\nexit %s\n' "$marker_status" >"$fixture_root/.build/megabrain"
  chmod +x "$fixture_root/.build/megabrain"
}

make_binary_isolation_fixture() {
  local source_root="$1" fixture_root="$2" marker_status="$3"
  mkdir -p "$fixture_root/.build"
  printf '#!/usr/bin/env bash\nexit %s\n' "$marker_status" >"$fixture_root/.build/megabrain"
  chmod +x "$fixture_root/.build/megabrain"
}
