# Claude Code Rules

**Always read and follow [CONTRIBUTING.md](CONTRIBUTING.md)** for the full development workflow, branch strategy, PR guidelines, and issue linking rules.

## Repo Layout

This repo hosts multiple self-contained browser apps, one folder per app at the repo root (currently `brand-palette-pantone/` and `product-card-printer/`). A root `index.html` is the hub that links to each app. When adding a new app, create a new top-level folder and add a card to the hub. See [README.md](README.md) for the current app list.

## bakery-erp: new features must update the data schema

Any `bakery-erp/` feature that persists data **must** register its sheet(s) and columns in **`bakery-erp/js/schema.js`** (`TABLE_COLUMNS`) — the single source of truth. The frontend `SCHEMA` (`db.js`) and `ACC_HEAD`/`PERM_HEAD` (`app.js`) derive from it directly; the backend `apps-script.js` `TABLES` block is generated from it via **`npm run gen:schema`** (then manually pasted into Apps Script to deploy). `npm run check:schema` fails CI if the backend block is stale. Add a table only to the ad-hoc/auth set (`AUTH_TABLES`) if it must stay out of the main sync. `TABLE_COLUMNS` drives the whole data lifecycle:

- **Sync** — `pullAll()` only pulls sheets listed in `SCHEMA`. A sheet missing from `SCHEMA` will never sync from Google Sheets, even after 「重新同步」.
- **Migrate / setup** — `action=migrate` and `action=setup` only create/repair `SCHEMA` sheets, so an unregistered sheet is never auto-created on the backend.
- **Seed / cache / clear** — demo seed data, the `localStorage` cache, and the 「清空」 flows all iterate `SCHEMA` keys.

Sheets loaded ad-hoc outside `SCHEMA` (e.g. `user_account`, `role_permission`, fetched via `db.api('action=list&sheet=…')`) are the exception, not the pattern: they must own their own load/refresh and do **not** ride the main sync. Prefer adding to `SCHEMA` unless a sheet is intentionally kept out (e.g. super_admin-only, backend-managed).

## bakery-erp: no hand-duplicated constants between frontend and backend (anti-drift rule)

**Never copy a constant into both `bakery-erp/js/*` and `bakery-erp/apps-script.js` by hand.** The backend file cannot `import`, so any value both sides must agree on (table columns, `DEFAULT_PERMS`, future role lists / perm keys / status enums…) follows one pattern:

1. Define it **once** in `bakery-erp/js/schema.js` (frontend imports it directly).
2. Give `apps-script.js` a marker block (`// <<gen:xxx>> … // <</gen:xxx>>`) and teach `bakery-erp/tools/gen-schema.mjs` to generate it (see `gen:tables` / `gen:perms` as the model).
3. Run `npm run gen:schema` after changing the source; `npm run check:schema` must stay green (enforced by the schema-check GitHub workflow) — if it fails, the generated block is stale and the pasted backend would disagree with the frontend.

If you catch yourself writing the same literal in two files, stop and route it through `schema.js` + a gen block instead. (This rule exists because `DEFAULT_PERMS` was once duplicated by hand and drifted-by-construction until unified.)

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
