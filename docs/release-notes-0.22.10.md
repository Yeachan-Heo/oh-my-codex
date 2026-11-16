# Release Notes: oh-my-codex v0.22.10

## Highlights

### Ralplan Skill: Align Custom-Gate Guidance with Warn-and-Skip Runtime Policy

The ralplan skill guidance now documents that unavailable custom gates are warned about and skipped at runtime, not treated as an error condition. The skill examples and workflow paths no longer reference or require missing custom gates, aligning skill documentation with the actual runtime behavior that gates unavailable to the host environment are simply skipped with a warning message.

This change fixes #4096, which reported inconsistency between the documented requirements and the actual runtime behavior.

- **#4097**: Align unavailable custom-gate guidance with warn-and-skip runtime policy

## Merged PRs

- **#4097**: docs(ralplan): align unavailable custom-gate guidance with warn-and-skip runtime policy by Yeachan-Heo
- **#4100**: back-merge: main into dev after v0.22.9 release + bump to 0.22.10-dev (internal)

## Contributors

- Yeachan-Heo

## Full Changelog

Compare full changes: https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.9...v0.22.10

**v0.22.10** was released on {{ release_date }} (UTC).
