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
- This repo is also worked on by Codex, GitHub Copilot CLI, and the GitHub
  Copilot cloud agent. Keep anything that isn't Claude-specific in
  `AGENTS.md` so the other agents see it too.
