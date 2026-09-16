# GitHub Copilot instructions

@AGENTS.md

The file above is the shared source of truth for this repo — project
structure, invariants, commands, conventions, and delegation rules. Read it
before making changes. This file only adds Copilot-specific context.

## Copilot-specific notes

- This is a public, multi-user repo where a GitHub Copilot cloud agent may
  pick up issues labeled `copilot-ready` (see `AGENTS.md` → "Delegating
  incidental work" for what that label means and its limits). Only work
  issues that meet that bar autonomously; anything security-sensitive,
  schema-changing, or product-ambiguous needs a human in the loop.
- No `copilot-setup-steps.yml` exists yet for the cloud agent environment.
  The local dev commands in `AGENTS.md` ("Development commands" /
  "Tests, by area") are the source of truth for what to run; there is no
  separate Copilot-only build step.
- CI (`.github/workflows/ci.yml`) is the ground truth for what "passing"
  means in this repo — run the same commands it runs for whatever area you
  touched before treating a change as done.
