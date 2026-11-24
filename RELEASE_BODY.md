# oh-my-codex v0.22.24

## Summary

This patch release improves native manifest handling for dev versions by respecting explicit environment overrides, and enhances documentation clarity for workflow runtime prerequisites and template validation checks.

## Fixed

- **NATIVE MANIFEST HYDRATION RESPECTS ENV OVERRIDES FOR DEV VERSIONS (#4179):** Fixes #4166 regression. When OMX runs a dev version, the manifest request is now correctly skipped only when neither `OMX_NATIVE_MANIFEST_URL` nor `OMX_NATIVE_RELEASE_BASE_URL` environment variables are set. If either override is explicitly set, the manifest is loaded as requested, allowing dev builds to work with custom manifest endpoints. Error messages in sparkshell and api were also improved to suggest local builds or binary path overrides for dev versions instead of network reconnection.

## Changed

- **DOCS: CLARIFY WORKFLOW RUNTIME PREREQUISITES (#4176):** Template documentation now clarifies the runtime requirements and expectations for workflow execution, helping users understand setup and execution environment requirements.

- **DOCS: SCOPE TEMPLATE VALIDATION TO APPLICABLE CHECKS (#4178):** Template validation guidance is now scoped to checks that apply in the current context, reducing noise and improving clarity for template maintainers and validators.

## Compatibility

Behavior change for manifest loading in development versions. The `-dev` version suffix now only skips manifest requests when no manifest URL environment variables are set; explicit environment overrides are always respected. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.24`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to Valeriy Pavlovich and the team for improving manifest handling and documentation clarity.

**Full Changelog**: [`v0.22.23...v0.22.24`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.23...v0.22.24)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
