# Claude Code Rules

## Git Workflow

- Do NOT include `Co-Authored-By` lines in commit messages.
- **Branch strategy**: `feature/*`, `fix/*`, `chore/*` branches merge into `dev` via PR. Only `dev` merges into `master` for releases.
- Always create new branches from `dev`, not `master`:
  ```bash
  git checkout dev && git pull origin dev && git checkout -b feature/my-feature
  ```
- PRs for features/fixes target `dev`. PRs from `dev` to `master` are release merges.
- **IMPORTANT: `Fixes #X` / `Closes #X` only goes in the `dev` → `master` release PR**, not in feature/fix → dev PRs. GitHub only auto-closes issues when merged into the **default branch (master)**. Feature PRs into `dev` should reference issues with `Relates to #X` instead.
- Put each `Fixes` on its own line (comma-separated may not auto-close all issues):
  ```
  # feature/fix PR → dev (does NOT close issues):
  Relates to #5 — Bug: Pantone type filter ignored when searching by hex value

  # dev → master release PR (CLOSES issues):
  Fixes #5 — Bug: Pantone type filter ignored when searching by hex value
  Fixes #6 — Bug: Toast messages can stack and interfere
  ```
