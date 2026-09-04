# Coach eval

A replay eval for the in-app coach (`supabase/functions/coach`). It answers one
question with numbers instead of opinion: **which model and effort setting
should the coach run at, and does a prompt change help or hurt?**

It replays real conversations against the REAL MCP server on a local database,
then grades what the model DID (the rows it wrote, the tools it called), not
just what it said.

Nothing here touches production. The database is PGlite, built from
`supabase/migrations` and the exercise seed on every run.

```
PGlite (migrations + seed + fixture)
  └─ pglite-socket :54329
       └─ PostgREST :54330
            └─ proxy :54321          strips /rest/v1 so supabase-js is none the wiser
                 └─ mcp-server :8000  the real Deno edge function, unmodified
                      └─ run.mjs      drives the tool loop against the Anthropic API
```

The MCP server authenticates through its legacy env path (`MCP_SECRET` +
`OWNER_USER_ID`), so the fixture needs no `mcp_tokens` row and no auth server.

## Why it exists

Valentine's 13-turn session on 2026-08-31 (the transcript the cases are built
from) failed in four ways: the coach cloned her program instead of editing it,
never saved a standing preference she stated five times, listed alternatives
four times before asking what she actually wanted, and made her type "Yes" then
"Confirm". Two of those are structural and two are judgment. Judgment is what
this eval measures; the structural ones are tasks in
`docs/superpowers/plans/2026-09-04-gaps-roadmap.md`.

## Setup

Needs `deno` (already required by this repo), Node 22+, and a PostgREST binary.

```bash
cd scripts/coach-eval && npm install
```

PostgREST is not vendored. Download the macOS arm64 build:

```bash
mkdir -p ../../.bin && cd ../../.bin
curl -sL https://github.com/PostgREST/postgrest/releases/download/v16.2/postgrest-v16.2-macos-aarch64.tar.xz | tar -xJ
```

`run.mjs` looks for `.bin/postgrest` at the repo root, or `$POSTGREST`.

**libpq**: the PostgREST binary dynamically links `libpq.5.dylib` and
`libgssapi_krb5.2.2.dylib`. `brew install libpq krb5` is the normal fix. If you
would rather not install them system-wide, fetch the bottles and point the
loader at them:

```bash
brew fetch libpq krb5                     # downloads only, installs nothing
# extract both tarballs from $(brew --cache libpq) / $(brew --cache krb5), then:
export POSTGREST_DYLD="/path/to/libpq/lib:/path/to/krb5/lib:/opt/homebrew/opt/openssl@3/lib"
```

API key, gitignored, never on a command line:

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env
```

The 13 Valentine cases replay a real person's conversation, so the transcript
is **not in this repository**. Pull it from `coach_usage` with the Supabase CLI
linked (ask them first):

```bash
node fetch-turns.mjs --user <uuid>
```

Without it the harness still runs, with the six synthesized cases only.

## Running

```bash
node run.mjs --smoke                  # boots the stack, no model calls, no spend
node run.mjs --configs sonnet-low,opus-medium --trials 1 --out out/run1
node run.mjs --configs fable-low --cases s01-swap,s02-perhand,v02,v08 --out out/run1
node grade.mjs --out out/run1         # optional Opus judge over the rubric claims
node report.mjs --out out/run1        # writes out/run1/report.md
```

`--smoke` is the one to run after any change to the stack, the fixture or the
checks. It exercises every moving part and costs nothing.

Configs are in `run.mjs`: `sonnet-low` (what production runs today),
`sonnet-medium`, `opus-low`, `opus-medium`, `fable-low`. Cases can be selected
by id (`v01`, `s03-midsession`) or by group (`valentine`, `synth`).

## Cost

Roughly $0.03 per turn on Sonnet, $0.08 on Opus, $0.17 on Fable. 19 cases on
two configs at one trial is about $2. The full 5 x 19 x 3 matrix with a judge
pass is $40 to $80. Every run spends real money: decide the matrix before
starting, and prefer more cases over more trials until a result is close.

## What is graded

**Programmatic checks** (`checks.mjs`) read the database after the turn and the
tool calls the turn made. This is the part that matters: it catches a coach
that says the right thing and writes the wrong rows.

| check                                             | asserts                                             |
| ------------------------------------------------- | --------------------------------------------------- |
| `tools_required` / `tools_forbidden` / `no_tools` | which tools were called                             |
| `memory_matches`                                  | a `coach_memory.fact` matching each regex exists    |
| `programs_live_max`                               | it edited rather than cloned                        |
| `program_has_days`, `day_superset_groups`         | the written plan has the shape asked for            |
| `newest_confirmed`                                | confirmation happened (or did not) in this turn     |
| `rx_load`                                         | the load is stored as a TOTAL with `load_entry` set |
| `rx_absent` / `rx_present`                        | a substitution actually replaced the exercise       |
| `answer_any` / `answer_none` / `max_words`        | cheap text assertions                               |

**Judge claims** (`grade.mjs`) are concrete per-case statements graded by Opus
with structured output, for the things a regex cannot see ("asks what the
lifter is avoiding before offering a fourth alternative"). The judge sees the
exchange and the tool results, never the system prompt under test. Unknown
counts as fail.

Traces land in `out/<run>/traces/*.json`, one per turn, with the full tool
calls and their results. Read those before believing any number in the report.

## Adding a case

Append to `cases.mjs`. A case names a fixture state (`early`, `late`,
`session`), the context block the PWA would have sent, the conversation before
it, the message, its checks and its rubric claims. Draw new cases from real
turns in `coach_usage` or from a bug someone hit; the point is coverage of
failures that actually happened.
