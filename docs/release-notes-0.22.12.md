# Release Notes: oh-my-codex v0.22.12

## Highlights

### Team State: Recover Quarantined Live-Pin Lock Links

Fixed deserialization of live-pin tracking data from JSONL record streams. Quarantined lock links in team state were not being properly recovered due to incomplete deserialization logic. This patch improves reliability of team lock recovery when processing stored JSONL records, fixing #4111.

- **#4112**: Recover quarantined live-pin lock links

## Merged PRs

- **#4112**: fix: recover quarantined live-pin lock links by Yeachan-Heo (Fixes #4111)

## Contributors

- Yeachan-Heo

## Full Changelog

Compare full changes: https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.11...v0.22.12

**v0.22.12** was released on {{ release_date }} (UTC).
