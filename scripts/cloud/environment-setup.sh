#!/bin/bash
# Claude Code cloud environment setup for strength-tracker.
#
# This file is the source of truth, but it does not run from here: paste it
# into the environment's "Setup script" field at claude.ai/code. It runs as
# root on Ubuntu 24.04 x86_64 BEFORE the session starts, and the filesystem it
# leaves behind is cached for about seven days when it finishes in under about
# five minutes. Keep it to machine-level tools; repo dependencies (npm ci, Deno
# caches, the exercise seed) belong to scripts/cloud/session-start.sh, which
# runs from the repo on every session.
#
# Every step is best-effort: a non-zero exit fails the session, and a missing
# optional tool is better than no session.
#
# Network: Trusted covers npm, jsr.io, raw.githubusercontent.com, Ubuntu
# archives, the Go module proxy and public.ecr.aws (Supabase's local images).
# Playwright's browser CDN is NOT in Trusted; add these under Custom:
#   cdn.playwright.dev
#   playwright.download.prss.microsoft.com

log() { echo "[env-setup] $*"; }

# Deno (edge functions and their tests). Installed from npm, not deno.land:
# deno.land is not on the Trusted list, registry.npmjs.org is. CI uses v2.x.
install_deno() {
  npm install -g deno@2 >/tmp/env-deno.log 2>&1 \
    && log "deno $(deno --version | head -1)" \
    || log "deno install failed (see /tmp/env-deno.log)"
}

# Supabase CLI, for `supabase start` (the Phase 2 browser gate needs the local
# stack; Docker is preinstalled) and `supabase functions serve`. Installed from
# npm like Deno: the `supabase` package's Linux binary is an npm optional
# dependency (@supabase/cli-linux-x64), so nothing is fetched from GitHub. It
# used to be built with `go install github.com/supabase/cli@latest`, which
# stopped working: `@latest` resolves to the last v1 (v2 is +incompatible),
# that needs Go >= 1.25 against the image's 1.24, and from v2 the Go module no
# longer contains `start` at all. Without it, PGlite (scripts/validate-db.mjs)
# still covers the schema.
install_supabase() {
  npm install -g supabase@2 >/tmp/env-supabase.log 2>&1 \
    && log "supabase $(supabase --version 2>/dev/null)" \
    || log "supabase CLI not installed (see /tmp/env-supabase.log); PGlite paths still work"
}

# Chromium and its OS libraries for the Playwright suites in pwa/e2e. The
# version matches pwa/package.json's @playwright/test pin.
install_chromium() {
  npx -y playwright@1.56.1 install --with-deps chromium >/tmp/env-playwright.log 2>&1 \
    && log "playwright chromium installed" \
    || log "playwright chromium failed (allowlist cdn.playwright.dev?) see /tmp/env-playwright.log"
}

install_deno &
install_supabase &
install_chromium &
wait

exit 0
