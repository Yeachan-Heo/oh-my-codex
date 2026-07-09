# PR #3001 planning-gate regression handoff

## Scope

PR #3001 addresses model/tool-originated transport bypasses that could deactivate protected planning state before an explicit execution handoff.

Protected planning state means active `deep-interview` or `ralplan` state, either session-scoped or standalone/global.

This PR keeps the fix at the native-hook transport boundary:

- Bash `omx state write` / `omx state clear` deactivation vectors.
- Bash `--input` and `--input-file` payloads where planning `--mode` may be supplied outside JSON.
- Multiple `omx state write` invocations in one Bash command.
- Decoy arguments before the actual `omx state write` invocation.
- MCP structured state tools surfaced to PreToolUse as `mcp__omx_state__state_write` and `mcp__omx_state__state_clear`.

This PR intentionally does not introduce new trusted-wrapper/private-helper state APIs and does not make `src/state/operations.ts` the default enforcement layer for this blocker.

## Incident vs defect vs hotfix vs follow-up

| Category | Finding | Handling |
| --- | --- | --- |
| Defect | A model-originated Bash command could pass deactivation intent through `omx state write` when `mode` came from CLI `--mode` rather than JSON. | Hotfix in native hook parser: merge `--mode` into parsed `--input` / `--input-file` payload before deactivation classification. |
| Defect | A Bash command containing multiple `omx state write` invocations could expose only the first payload to the guard. | Hotfix in native hook parser: fail closed when more than one state-write invocation is detected during active protected planning. |
| Defect | Arguments before the actual `omx state write` invocation could act as parser decoys. | Hotfix in native hook parser: parse the state-write invocation segment, not the whole Bash command. |
| Defect | MCP structured state tools could bypass the Bash-specific transport guard. | Hotfix in native hook PreToolUse boundaries: block protected planning deactivation through `mcp__omx_state__state_write` and block `mcp__omx_state__state_clear` while protected planning is active. |
| Incident classification | A reported `planning-gate` tmux behavior involved runtime/build provenance uncertainty. | Treat as observation-only unless exact-pane evidence proves latest PR #3001 code failed. |
| Architectural follow-up | Backend state-operation authority/provenance is broader than this PR's transport blocker. | Defer. Optional backend refusal belongs only in a maintainer-requested follow-up or explicit Option D branch. |

## Observed evidence

- The previously observed active runtime path `/Users/vp/.omx-runs/run-20260629070147-62db/.omx/runtime/bin/omx` reported `0.18.16-dev-eae4b3988732`, which predates PR #3001 changes.
- The source worktree referenced by the incident handoff was observed at local `e100206c`, not the later PR head `30dd6520`.
- The current PR worktree and PR #3001 head were observed at `30dd6520` during planning.

## Inference / incident classification

- Therefore the runtime incident is not, by itself, proof that latest #3001 code failed. Exact-pane evidence is required before making that claim.

## Regression matrix

Required hook regressions:

- Deep-interview and ralplan implementation writes remain blocked while planning is active.
- `omx state write --input '{..."active":false...}'` is blocked for protected planning modes.
- `omx state write --input-file <file>` is blocked when the file payload deactivates protected planning.
- `--mode deep-interview|ralplan` supplied outside JSON is honored for inline and file payloads.
- CLI `--mode` overrides conflicting JSON mode for deactivation classification.
- Multiple detected `omx state write` invocations in one Bash command are blocked.
- A decoy `--input` before the sole actual `omx state write` invocation does not drive classification.
- `exec` / `command` dispatch builtins do not bypass dynamic payload classification when options like `--`, `-c`, or `-p` precede the executable payload.
- Safe non-deactivating `omx state write` remains allowed.
- `mcp__omx_state__state_write` is blocked for protected planning deactivation or terminal lifecycle payloads.
- Nested MCP `state` payloads are classified with the same effective fields as backend state writes, with the target `mode` preserved.
- `mcp__omx_state__state_clear` is blocked while session-scoped or standalone protected planning is active.
- Non-deactivating MCP `state_write` remains allowed.
- Explicit handoff/completion paths that do not use backend state operations remain green.

## Runtime diagnostics boundary

Diagnostics may report:

- active `omx` executable path/version/build commit;
- hook/dist path from config when available;
- inherited `OMX_ROOT`, `OMX_STATE_ROOT`, `OMXBOX_ACTIVE`;
- root/session pointer owner;
- exact tmux pane cwd/pid/title/current path;
- operator recommendation to manually restart/relaunch affected panes after update.

Diagnostics must not:

- kill panes;
- mutate state;
- auto-relaunch sessions;
- claim stale build caused the incident without exact-pane evidence.

## PR wording

Suggested PR update wording:

> This PR addresses the currently known model/tool-originated transport/path bypasses for planning-phase deactivation and keyword/state parity, including Bash `omx state write/clear`, `--input`/`--input-file`, and MCP structured state tools at the native-hook transport boundary. The observed `planning-gate` tmux incident also showed a stale-runtime/provenance dimension: an active runtime reporting `0.18.16-dev-eae4b3988732` predates #3001, so it cannot prove latest #3001 failure without exact-pane evidence. Diagnostics remain observation-only. Broader state-operation provenance beyond the narrow protected planning deactivation blocker remains a follow-up design item.
