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
# public.ecr.aws serves image manifests, but the layers redirect to a
# CloudFront host that Trusted refuses (403), so `supabase start` cannot pull
# its images without this one too:
#   d2glxqk2uabbnd.cloudfront.net

log() { echo "[env-setup] $*"; }

# Deno (edge functions and their tests). Installed from npm, not deno.land:
# deno.land is not on the Trusted list, registry.npmjs.org is. CI uses v2.x.
install_deno() {
  npm install -g deno@2 >/tmp/env-deno.log 2>&1 \
    && log "deno $(deno --version | head -1)" \
    || log "deno install failed (see /tmp/env-deno.log)"
}

# Supabase CLI, for `supabase start` (the Phase 2 browser gate needs the local
# stack; Docker is preinstalled) and `supabase functions serve`. The usual
# installs download a GitHub release asset, and the cloud GitHub proxy refuses
# release assets from repositories not attached to the session, so build it
# from the Go module proxy instead. Bounded so a slow build cannot push the
# script past the cache window; without it, PGlite (scripts/validate-db.mjs)
# still covers the schema.
install_supabase() {
  if timeout 210 env GOBIN=/usr/local/bin GOFLAGS=-trimpath \
      go install github.com/supabase/cli@latest >/tmp/env-supabase.log 2>&1; then
    [ -x /usr/local/bin/cli ] && mv /usr/local/bin/cli /usr/local/bin/supabase
    log "supabase $(supabase --version 2>/dev/null)"
  else
    log "supabase CLI not installed (see /tmp/env-supabase.log); PGlite paths still work"
  fi
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
