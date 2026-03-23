# Claude Code Rules

## Git Workflow

- Do NOT include `Co-Authored-By` lines in commit messages.
- When creating a pull request that fixes issues, always include `Fixes #X` (or `Closes #X`) in the **PR description body** (not just in commit messages), so GitHub auto-closes the issues on merge.
- Put each `Fixes` on its own line (comma-separated may not auto-close all issues):
  ```
  Fixes #5 — Bug: Pantone type filter ignored when searching by hex value
  Fixes #6 — Bug: Toast messages can stack and interfere
  ```
