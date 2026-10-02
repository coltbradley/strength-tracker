#!/bin/bash
# SessionStart hook (.claude/settings.json): repo dependencies for Claude Code
# cloud sessions. A no-op on a laptop. Runs on every start and resume, so each
# step checks before it works: a resumed session with nothing changed should
# cost a few seconds, not a reinstall.

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

log() { echo "[session-start] $*" >&2; }

# Docker is preinstalled but its daemon is not running, so `supabase start`
# fails until something starts it. Launch it first, detached so it outlives
# this hook, and let it boot while the installs below run.
dockerd_started=
if command -v dockerd >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  sudo_=
  [ "$(id -u)" = 0 ] || sudo_="sudo -n"
  log "starting dockerd (log: /tmp/dockerd.log)"
  # In a subshell, so the `wait`s below do not wait on the daemon.
  ( $sudo_ setsid nohup dockerd >/tmp/dockerd.log 2>&1 </dev/null & )
  dockerd_started=1
fi

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

if [ -n "$dockerd_started" ]; then
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || log "dockerd did not come up (see /tmp/dockerd.log)"
fi

exit 0
