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

| Type | Pattern | Example |
|------|---------|---------|
| New feature | `feature/short-description` | `feature/color-export-svg` |
| Bug fix | `fix/short-description` | `fix/toast-stacking` |
| Maintenance | `chore/short-description` | `chore/update-dependencies` |

## Pull Requests

- PR title: short, under 70 characters
- PR body must include:
  - Summary of changes
  - `Fixes #X` or `Closes #X` on separate lines for each related issue
  - Test plan if applicable
- Feature/fix PRs target `dev`
- Release PRs (`dev` → `master`) summarize all included changes

## Issues

- Use issue labels: `bug`, `enhancement`, `security`, `performance`, `accessibility`
- Reference issues in PR descriptions to auto-close them on merge
