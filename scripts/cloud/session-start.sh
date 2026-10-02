#!/bin/bash
# SessionStart hook (.claude/settings.json): repo dependencies for Claude Code
# cloud sessions. A no-op on a laptop. Runs on every start and resume, so each
# step checks before it works: a resumed session with nothing changed should
# cost a few seconds, not a reinstall.

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

log() { echo "[session-start] $*" >&2; }

# npm ci only when the lockfile changed since the last install.
ci_if_stale() {
  local dir=$1 stamp="$1/node_modules/.lock-sha"
  [ -f "$dir/package-lock.json" ] || return 0
  local want
  want=$(sha256sum "$dir/package-lock.json" | cut -d' ' -f1)
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then return 0; fi
  log "npm ci in $dir"
  if (cd "$dir" && npm ci --no-audit --no-fund >/tmp/session-npm-"${dir//\//-}".log 2>&1); then
    echo "$want" >"$stamp"
  else
    log "npm ci failed in $dir (see /tmp/session-npm-${dir//\//-}.log)"
  fi
}

ci_if_stale pwa &
ci_if_stale scripts &
wait

# validate-db and check-selects replay the seed; it is generated and gitignored.
if [ ! -s supabase/seed/exercises.generated.sql ]; then
  node scripts/build-exercise-seed.mjs >/dev/null 2>&1 || log "exercise seed build failed"
fi

# Warm Deno's cache for each edge function and its tests, so the first
# `deno check` / `deno test` doesn't stall on downloads.
if command -v deno >/dev/null 2>&1; then
  for fn in mcp-server coach push-alerts endurance-sync; do
    (
      cd "supabase/functions/$fn" || exit 0
      shopt -s nullglob globstar
      deno cache index.ts ./**/*.test.ts >/dev/null 2>&1 || log "deno cache failed for $fn"
    ) &
  done
  wait
else
  log "deno missing: add scripts/cloud/environment-setup.sh to the environment"
fi

exit 0
