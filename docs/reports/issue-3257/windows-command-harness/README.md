# Issue 3257 Windows command feasibility harness

This is a **Phase-0, receipt-only** Node harness for the frozen Revision 8 command contract. It does not execute npm, Bun, package installation, product code, lifecycle scripts, or external commands. It makes no package-manager, global, user, or repository mutation.

## Contract

- Command-contract SHA-256: `4cacc4a13de4f6d53c54c9237aa4c1df6b9582cf824aa19d4911e12a57d447df`
- Windows model: only command shadows already present before launch, resolved by PATH order and `.com`, `.exe`, `.bat`, `.cmd` precedence.
- Excluded: post-launch replacement, TOCTOU races, PATH mutation after launch, and product execution.
- Nested dispatcher allowlist: `npm run build`, `npm run verify:native-agents`, `npm run sync:plugin`, `npm run verify:plugin-bundle`, and `npm run clean:native-package-assets`.

`dispatcher.cmd` delegates only to the Node allowlist checker. `dispatcher.mjs` prints an approved edge; it does not invoke npm.

## Receipt shapes

The harness emits a JSON feasibility receipt for one of two sources:

- `stable`: `install --global --ignore-scripts --no-audit --no-progress --prefix <FROZEN_PREFIX> oh-my-codex@latest`
- `dev`: `install --global --ignore-scripts --no-audit --no-progress --prefix <FROZEN_PREFIX> <VALIDATED_ABSOLUTE_CONTAINED_TARBALL>`

`noop` accepts no root. `disposable` requires a direct child of the system temporary directory named `issue-3257-disposable-*`; all other roots fail closed. Both shapes report every empirical or execution field as `NOT_EXECUTED` and require owner review.

## Evidence and limitations

The corpus is deterministic fixture data, not a record of a Windows run. It is limited to pre-launch command resolution and cannot establish package-manager ownership, lifecycle safety, Bun behavior, npm behavior, or protection against post-launch races. Receipt output is advisory and cannot close the owner gate.

Created Phase-0 artifacts: `harness.mjs`, `dispatcher.cmd`, `dispatcher.mjs`, `resolution-corpus.json`, `policy-schema.json`, this README, and `../issue-3257-update-owner-verification-manifest.json`.
