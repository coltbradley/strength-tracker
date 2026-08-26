# CLAUDE.md

Strength log + Claude programming layer. Single-user system, public repo.

A coached lifter logs sets on their phone (PWA). Claude reads the log via MCP to
analyze progress and writes programming parsed from coach screenshots. The coach
programs. Claude parses, analyzes, and proposes. The app captures.

## Layout

- `supabase/migrations/`: schema, RLS, views. Numbered SQL, never edit an
  applied migration, add a new one.
- `supabase/functions/mcp-server/`: MCP server as a Supabase Edge Function
  (Deno, streamable HTTP). Tools in `tools/`, shared code in `lib/`.
- `pwa/`: React + Vite PWA. Offline-first, IndexedDB write queue.
- `scripts/`: seed generation and dev utilities (Node).
- `docs/`: plan, architecture, decisions, setup, deploy. `docs/decisions.md`
  is the log of every deviation from the original spec and why.
  `docs/deploy.md` is the per-release runbook — follow it instead of
  rediscovering the deploy steps.

## Hard rules

- `sets`, `sessions`, and `set_voids` are written ONLY by the PWA. MCP tools
  never write them.
- `sets` is append-only. No update/delete paths anywhere (RLS enforces this).
  Corrections are voids: an insert into `set_voids` (itself append-only)
  hides a set from every view. Never add an update or delete policy.
- `sessions` are soft-deleted only (`discarded_at`); no delete policy exists.
  A discarded session leaves every view but stays in Postgres.
- Planned tables (`programs`/`planned_workouts`/`prescriptions`) are written
  by BOTH the MCP server (service role, program parsing) and the PWA (RLS
  owner policies, plan editor). `planned_workouts.notes` is coach notes from
  the parse; `plan_note` is the user's own and the parse must not touch it.
- Programs written by Claude land unconfirmed (`confirmed_at IS NULL`) and
  require a separate `confirm_program` call after user approval in chat.
- Derived metrics (e1RM, volume, adherence, rest) live in SQL views only,
  never stored. Views are `security_invoker` so RLS applies, and every
  set-derived view reads `v_live_sets` (voids and discards excluded) — never
  `sets` directly.
- Exercise library sources: 'free-exercise-db' (generated seed), 'curated'
  (hand-maintained seed), 'custom' (MCP add_exercise / PWA). Each seed only
  updates its own source's rows; update_exercise re-tags edited library rows
  as 'custom' so re-seeds can't revert them. Exercises are never deleted
  (history references them).
- All client writes carry client-generated UUIDs; replay is idempotent
  (`on conflict do nothing`). Do not break this.
- Units are kg in the database everywhere. Display conversion is client-side.
- App updates must never lose device data: the IndexedDB database
  ("strength-log") holds unsynced sets in the outbox. Version bumps must be
  strictly additive (see the comment in `pwa/src/lib/db.ts`); never rename
  the database, delete stores, or clear storage in an update path. Postgres
  migrations are equally append-only once deployed.

## Commands

```bash
# db: start local stack, apply migrations + seed
supabase start && supabase db reset

# mcp server: serve locally
supabase functions serve mcp-server --env-file supabase/functions/.env

# pwa
cd pwa && npm install && npm run dev
cd pwa && npm test          # vitest
cd pwa && npm run build     # tsc + vite build

# regenerate exercise seed from free-exercise-db
node scripts/build-exercise-seed.mjs
```

## Conventions

- TypeScript strict everywhere. Edge function code is Deno (npm: specifiers);
  PWA and scripts are Node.
- Errors: never swallow. PWA reports through `pwa/src/lib/errors.ts`
  (console + optional Sentry via env). Edge function logs structured JSON.
- Keep modules small and swappable; the spec expects the set-entry UX to be
  rebuilt at least once.
