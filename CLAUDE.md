# Claude Code Rules

**Always read and follow [CONTRIBUTING.md](CONTRIBUTING.md)** for the full development workflow, branch strategy, PR guidelines, and issue linking rules.

## Repo Layout

This repo hosts multiple self-contained browser apps, one folder per app at the repo root (currently `brand-palette-pantone/` and `product-card-printer/`). A root `index.html` is the hub that links to each app. When adding a new app, create a new top-level folder and add a card to the hub. See [README.md](README.md) for the current app list.

## bakery-erp: new features must update the data schema

Any `bakery-erp/` feature that persists data **must** register its sheet(s) and columns in `SCHEMA` (`bakery-erp/js/db.js`). `SCHEMA` is the single source of truth for the whole data lifecycle:

- **Sync** — `pullAll()` only pulls sheets listed in `SCHEMA`. A sheet missing from `SCHEMA` will never sync from Google Sheets, even after 「重新同步」.
- **Migrate / setup** — `action=migrate` and `action=setup` only create/repair `SCHEMA` sheets, so an unregistered sheet is never auto-created on the backend.
- **Seed / cache / clear** — demo seed data, the `localStorage` cache, and the 「清空」 flows all iterate `SCHEMA` keys.

Sheets loaded ad-hoc outside `SCHEMA` (e.g. `user_account`, `role_permission`, fetched via `db.api('action=list&sheet=…')`) are the exception, not the pattern: they must own their own load/refresh and do **not** ride the main sync. Prefer adding to `SCHEMA` unless a sheet is intentionally kept out (e.g. super_admin-only, backend-managed).

## Git Workflow

- Do NOT include `Co-Authored-By` lines in commit messages.
- **Branch strategy**: `feature/*`, `fix/*`, `chore/*` branches merge into `dev` via PR. Only `dev` merges into `master` for releases.
- **App scope in branch names**: app-specific branches use `<type>/<app>-description` (e.g. `feature/pantone-export-svg`, `feature/cards-csv-mapping`). Repo-wide branches drop the scope (e.g. `chore/multi-app-structure`). See [CONTRIBUTING.md](CONTRIBUTING.md) for the full table.
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
