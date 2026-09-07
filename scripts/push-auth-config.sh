#!/usr/bin/env bash
# Applies the auth config (code-only sign-in email + AgentMail SMTP) to the
# linked Supabase project. Needs SMTP_USER and SMTP_PASS in .env.local:
#   SMTP_USER=<inbox>@agentmail.to   # a DEDICATED inbox for this app
#   SMTP_PASS=<an AgentMail API key, Dashboard -> API Keys>
#
# SMTP_USER is also the From address: AgentMail requires the sender to match the
# inbox it authenticates as. Use an inbox created for this app rather than an
# existing one, so a login code never arrives from a research alias and this
# app's deliverability is its own.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env.local ]]; then
  echo "missing .env.local (see comment at the top of this script)" >&2
  exit 1
fi
set -a
source .env.local
set +a
: "${SMTP_USER:?add SMTP_USER to .env.local}"
: "${SMTP_PASS:?add SMTP_PASS to .env.local}"
exec supabase config push --yes
