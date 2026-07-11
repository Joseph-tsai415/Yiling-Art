# Contributing

## Branch Strategy

```
master          (production — deployed to GitHub Pages)
  └── dev       (integration — all features merge here first)
       └── feature/*   (new features)
       └── fix/*       (bug fixes)
       └── chore/*     (maintenance, docs, config)
```

### Rules

1. **Never push directly to `master` or `dev`** — always use pull requests.
2. **All new work** branches off `dev`:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/my-new-feature
   ```
3. **Feature/fix branches** merge into `dev` via PR.
4. **`dev` merges into `master`** only when stable and tested — this triggers a GitHub Pages deploy.

### Branch naming

Branches that touch a single app should include the app scope so PRs are easy to triage. Repo-wide changes (workflows, hub page, docs) use the bare form.

| Type | Pattern | Example |
|------|---------|---------|
| App feature | `feature/<app>-short-description` | `feature/pantone-export-svg`, `feature/cards-csv-mapping` |
| App bug fix | `fix/<app>-short-description` | `fix/pantone-toast-stacking`, `fix/cards-a3-layout` |
| App maintenance | `chore/<app>-short-description` | `chore/pantone-update-dataset` |
| Repo-wide change | `<type>/short-description` (no app scope) | `chore/multi-app-structure`, `chore/update-deploy-workflow` |

Current app scopes: `pantone` (brand-palette-pantone), `cards` (product-card-printer), `bakery` (bakery-erp). When you add a new app, pick a short scope (lowercase, no spaces) and add it to this list.

## Pull Requests

- PR title: short, under 70 characters
- Feature/fix PRs target `dev`
- Release PRs (`dev` → `master`) summarize all included changes

### Issue linking (important!)

GitHub only auto-closes issues when a PR merges into the **default branch (`master`)**. Follow this rule:

| PR type | Target | Issue keyword | Effect |
|---------|--------|---------------|--------|
| `feature/*` / `fix/*` → `dev` | `dev` | `Relates to #X` | References issue, does NOT close it |
| `dev` → `master` (release) | `master` | `Fixes #X` or `Closes #X` | Auto-closes the issue on merge |

Put each issue reference on its own line:
```
# In a feature PR → dev:
Relates to #5 — Bug: Pantone type filter ignored when searching by hex value

# In a release PR dev → master:
Fixes #5 — Bug: Pantone type filter ignored when searching by hex value
Fixes #6 — Bug: Toast messages can stack and interfere
```

### PR body must include
- Summary of changes
- Issue references (see above)
- Test plan if applicable

## Issues

- Use issue labels: `bug`, `enhancement`, `security`, `performance`, `accessibility`
- Only use `Fixes` / `Closes` in `dev` → `master` release PRs to auto-close issues
