# oh-my-codex v0.22.18

## Summary

This patch release ships the runtime fix for spark/explore model resolution, completing the fix for issue #4133. The runtime now consistently applies the configured model setting across setup and runtime contexts.

## Fixed

- **MAKE SPARK/EXPLORE RUNTIME RESOLUTION FOLLOW CONFIGURED MODEL (#4138):** Fixed spark and explore model runtime resolution to respect configured model settings, completing the fix for #4133 (started by #4135 setup table changes in v0.22.17).

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.18`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to the development team for contributing to this release.

**Full Changelog**: [`v0.22.17...v0.22.18`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.17...v0.22.18)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
