# CLAUDE.md

@AGENTS.md

The file above is the shared source of truth for this repo — project
structure, invariants, commands, conventions, and delegation rules. Read it
before making changes. This file only adds Claude Code-specific notes.

## Claude Code-specific notes

- Spec/plan artifacts for larger changes live under `docs/superpowers/plans/`
  and `docs/superpowers/specs/` (the "superpowers" spec-driven-development
  workflow). If you're running a planned, multi-step change, follow that
  existing convention rather than starting a new ad hoc format.
- `.claude/launch.json` defines debug launch configs for the PWA dev/demo
  servers (`npm --prefix pwa run dev|demo`) — use it if you need a running
  dev server rather than guessing at ports.
- Session start: before planning, run the inventory in AGENTS.md ("Before
  you start"). Cloud sessions clone shallow, so deepen history first. When
  you fan work out to subagents in separate worktrees, give each its own
  real `node_modules` (or `npm ci` in that worktree) rather than a symlink
  into another checkout, and remove the worktrees and merged sub-branches
  when the integration branch has them.
- This repo is also worked on by Codex, GitHub Copilot CLI, and the GitHub
  Copilot cloud agent. Keep anything that isn't Claude-specific in
  `AGENTS.md` so the other agents see it too.
