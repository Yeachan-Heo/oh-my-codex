# Codex 0.164.0 hook approval fingerprint

[Upstream PR #54619](https://github.com/openai/codex/pull/54619), commit `2bf2bdf82c33f4c66ba3f0767b8e4b6a933aac40`, binds approval to plugin contents. Before execution, Codex recomputes SHA-256; a mismatch against approved contents or the hook declaration rejects execution. Legacy approvals use a persisted baseline.

[Fingerprint implementation](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/hooks/src/engine/plugin_fingerprint.rs) recursively traverses the **entire installed plugin version root**, not just `hooks/`. It hashes relative paths, directory/file type markers (including empty directories), and file lengths/bytes. There is no extension allowlist. Basenames `__pycache__`, `.venv`, `*.pyc`, and `*.egg-info` are skipped; matching directories exclude their subtrees. Timestamps and permissions are not hashed.

Thus `hooks/`, manifests, scripts, hidden files, and `.omx-live-pin/pin-*.json` under the version root are included. External state such as `~/.omx/plugin-cache-live-pins/`, sibling versions, and cache-parent locks are outside that traversal. Creating, changing, or deleting pins **outside the cache cannot change this hash**, provided no in-bundle entries change.

Caveats: removing existing in-bundle pins changes the hash once, potentially requiring reapproval. Leaving even an empty pin directory changes the fingerprint versus its absence. Other bundle writes/upgrades still invalidate approval. Nonexcluded symlinks/special files and unreadable or concurrently resized files cause fingerprinting errors. [Trust verification](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/hooks/src/engine/plugin_trust.rs) also rejects declaration changes.
