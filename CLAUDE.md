# Claude Code Rules

**Always read and follow [CONTRIBUTING.md](CONTRIBUTING.md)** for the full development workflow, branch strategy, PR guidelines, and issue linking rules.

## Repo Layout

This repo hosts multiple self-contained browser apps, one folder per app at the repo root (currently `brand-palette-pantone/` and `product-card-printer/`). A root `index.html` is the hub that links to each app. When adding a new app, create a new top-level folder and add a card to the hub. See [README.md](README.md) for the current app list.

## bakery-erp: execute work as an agent team

When a request involves **building, changing, debugging, or reviewing `bakery-erp/`**, don't do it solo — plan and run it as an **agent team**. The feature is enabled locally and a 6-agent bench already exists; see the master guide **`.claude/docs/agent-teams.md`** and the definitions in **`.claude/agents/`** (`bakery-flow-expert`, `bakery-backend`, `bakery-frontend`, `schema-guard`, `qa-pm`, `ux-researcher`).

Before spawning, restate the work in this exact shape:

```
Goal:        <what the user actually wants — 1–2 sentences, derived from their request>
Teammates:   <N agents from the bench + why each; name the ONE dev-lead who integrates>
Deliverable: <the concrete, verifiable "done" state>
```

Rules:
- The **main session is the team lead / orchestrator** (leadership can't be handed off). Among the spawned teammates, designate **one dev-lead** — usually `bakery-backend` or `bakery-frontend`, whichever owns the primary change — who integrates the others' output; teammates message each other directly to resolve file overlaps.
- Draw from the bench but **spawn 3–5, not all 6** (Windows = in-process; token cost is real). Typical full-feature flow: `bakery-flow-expert` specs → `bakery-backend` + `bakery-frontend` build (distinct files) → `schema-guard` + `qa-pm` gate. Per-task compositions live in §5 of the guide.
- Give each teammate full context in its spawn prompt (they don't inherit the lead's history), and require plan approval for risky implementation. Every teammate must honor the schema single-source-of-truth + anti-drift + Git guardrails in the sections below.
- **Stay solo / use a subagent** for a trivial one-line edit or a pure read-only question — a full team is overkill there.
- **Fallbacks:** if agent teams are disabled or the local `.claude/agents/` are absent (e.g. a fresh clone — `.claude/` is gitignored), proceed with a single session or subagents and say so. If *you are already a teammate*, just execute your assigned task — teammates can't spawn teammates (no nested teams).

Example:
```
Goal:        Add a 庫存盤點 (stocktake) variance report per 門市.
Teammates:   flow-expert (spec + acceptance criteria), bakery-backend (DEV-LEAD: stocktake vs
             stock_ledger query + gen:schema), bakery-frontend (report screen), qa-pm (per-role
             verification). 4 total.
Deliverable: Report screen gated by screen.reports, backed by stocktake vs stock_ledger,
             `npm run check:schema` green, verified for store_admin and super_admin.
```

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
