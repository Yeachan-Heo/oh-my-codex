# Release Notes: oh-my-codex v0.22.15

- **Tag**: `v0.22.15`
- **Candidate**: `dbc99d4f4` (cherry-picked #4123 onto main)
- **Compare range**: `v0.22.14..dbc99d4f4`

## PR Inventory

### Merged PRs (1)

- **#4123**: docs(vision): require reliable viewport evidence for CSS advice
  - Author: ev78394
  - Merged: Sat Nov 21 2026
  - Co-authored-by: lisrel-claw
  - Affects: Vision model prompts and capability tracking

## Commits in Release Range

```
dbc99d4f4 docs(vision): require reliable viewport evidence for CSS advice (#4123)
```

## User-Visible Changes

### Improved

- **Vision model CSS advice guidance**: The vision model's CSS advice now requires reliable viewport evidence to be present in the component context. This prevents false-positive style recommendations when viewport information cannot be verified, ensuring all CSS suggestions reflect the actual rendering environment and are more accurate for responsive design patterns.

This change enhances the quality and reliability of vision-driven styling recommendations by filtering out advice that lacks proper environmental context.

## Validation

- Dev CI run 44987440579 on candidate 5c204931d passed all checks
- Candidate commit dbc99d4f4 is cherry-picked from verified dev branch
- Release-coupled versions verified synchronized across package.json, Cargo.toml, Cargo.lock, and plugin.json

## Compatibility

No breaking changes. Vision model behavior improvements are backward compatible with existing code.
