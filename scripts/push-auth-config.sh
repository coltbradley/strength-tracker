#!/usr/bin/env bash
# Applies the auth config (code-only sign-in email + Gmail SMTP) to the
# linked Supabase project. Needs SMTP_USER and SMTP_PASS in .env.local:
#   SMTP_USER=you@gmail.com
#   SMTP_PASS=<a Google app password, myaccount.google.com/apppasswords>
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
