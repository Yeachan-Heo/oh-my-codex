# PR #3900 Lane r6 - Bug Fix

## Issue Found
Path canonicalization order mismatch between hook and CLI:

**CLI (omxPluginCacheLivePinStatePath)**:
1. `canonicalPluginRoot = realpath(pluginRoot)`
2. `canonicalPluginBase = dirname(canonicalPluginRoot)`

**Hook (original)**:
1. `canonicalPluginBase = dirname(absoluteRoot)`
2. `canonicalPluginBase = realpathSync(canonicalPluginBase)` (after dirname)

This mismatch caused different hashes to be computed for the same plugin, resulting in live pins being written to a different state directory than what the CLI reads from.

## Fix Applied
Updated hook to match CLI order:
1. `canonicalPluginRoot = realpathSync(absoluteRoot)`
2. `canonicalPluginBase = dirname(canonicalPluginRoot)` (after canonicalization)

This ensures both hook and CLI compute the same hash and use the same external state directory path.

## Commit
- **4e21842e**: "fix(#3898): correct path canonicalization order in hook to match CLI"

This should resolve the test failures where live pins weren't being detected after repair.
