# PR #3900 Lane r6 Summary

## Changes Made

### Hook Changes (codex-native-hook.mjs)
- Modified `livePinDirectory()` function to:
  - Compute external state directory path instead of using `.omx-live-pin` inside plugin root
  - Uses `$CODEX_HOME/.omx/plugin-cache-live-pins/${rootHash}-${versionHash}/`
  - Canonicalizes paths with `realpathSync()` to handle symlinks (macOS /var vs /private/var)
  - Creates directory with `{ recursive: true }` instead of just checking it exists

### Test Changes (plugin-cache-live-pin-3790.test.ts)
- Added helper function `omxPluginCacheLivePinStateDirectory(codexHomeDir, pluginRoot, version)`
  to compute the external state directory path matching the CLI's logic
- Updated 15+ test cases that manually seed pins to use the new external location:
  - Line 519: "pins a running hook wrapper"
  - Line 815: "serializes startup pin publication with quarantine deletion"
  - Line 1098: "preserves live snapshot across snapshot cleaning"
  - Line 1121: "reclaims an abandoned empty live-pin directory"
  - Line 1232: "reclaims expired pending markers"
  - Line 1302: "sweeps expired sidecar intents"
  - Line 1364: "does not steal an aged mutation lock"
  - Line 1456: "rejects a stale session pin"
  - Line 1504: "re-registers an aged same-session pin"
  - Line 1830: "keeps an active delegate when retirement must preserve unknown-identity pin"
  - Line 2176: "deserializes wrapper dead lock"
  - Line 2314: "repairs manifest version drift" (also removes pins from new location)
  - Line 2325: "refreshes a fresh same-session pin with stale process identity"
  - Line 2379: "retries pin registration on later hooks"
  - Line 2459: "refreshes a resumed SessionStart pin"

### Logic Verification
- Hook and CLI both use same hashing logic:
  - Compute rootHash from canonical plugin base (dirname of plugin root)
  - Compute versionHash from version
  - Create state directory at: `${codexHome}/.omx/plugin-cache-live-pins/${rootHash}-${versionHash}`
- Canonicalization ensures macOS symlinks (/var → /private/var) are handled consistently
- Tests compute same path as product code for consistency

## Why These Changes Fix #3898
- Live pins were being written inside the plugin cache directory (`.omx-live-pin/`)
- Codex 0.164.0 content-binds hooks to plugin contents using SHA-256
- Any runtime file writes inside the plugin root invalidate the content-bound approval
- Moving pins to external state directory prevents approval invalidation
- The hook still tracks live sessions, but outside the plugin root

## Commits
1. `2483d063`: "fix(#3898): move plugin cache live pin state to external directory"
   - Hook code changes
   - Initial test updates for specific failing tests
   
2. `90d4fe37`: "refactor: update all test seeding locations to use external pin state directory"
   - Comprehensive test updates for all manually seeded pins
