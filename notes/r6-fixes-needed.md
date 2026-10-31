# PR #3900 r6 Fixes Needed

## Problem Summary
- Hook writes live pins to `.omx-live-pin` inside plugin root (e.g., `~/.codex/plugins/cache/oh-my-codex-local/oh-my-codex/0.21.33/.omx-live-pin/`)
- This changes the plugin content, invalidating Codex's content-bound hook approval (issue #3898)
- CLI has already been updated to read pins from external state directory: `$CODEX_HOME/.omx/plugin-cache-live-pins/${rootHash}-${versionHash}/`
- Hook has NOT been updated to write to the same external location

## Tests Failing
1. `plugin-cache-live-pin-3790.test.ts`: Tests seeding pins in old location inside plugin root
2. `setup-install-mode.test.ts`: Tests that check removalSafe field when cache has live pins

## Solution
1. Update hook's `livePinDirectory` function to return external state path instead of `.omx-live-pin`
2. Use same hash-based key as CLI: `omxPluginCacheLivePinDir()` + `rootHash` (from plugin base) + `versionHash`
3. Update tests that manually seed pins to use the new external location
4. Ensure CODEX_HOME is properly canonicalized to handle symlinks

## Key Functions to Update in Hook
- `lexicalLivePinTarget()` - Already computes cacheBase, needs to pass state dir info
- `livePinDirectory()` - Change `pinDir = join(operationRoot, '.omx-live-pin')` to external path
- Hook needs to compute rootHash and versionHash like the CLI does
- Must canonicalize paths for consistent symlink handling
