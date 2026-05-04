# Codex native hook mapping

This page is the canonical answer to:

> Which OMC/OMX hooks run on native Codex hooks already, which stay on runtime fallbacks, and which are not supported yet?

## Install surface

`omx setup` now owns both of these native Codex artifacts:

- `.codex/config.toml` → enables setup-owned runtime feature flags including `[features].codex_hooks = true` and `[features].goals = true`
- `.codex/hooks.json` → registers the OMX-managed native hook command while preserving non-OMX hook entries already in the file

For project scope, `.gitignore` keeps generated `.codex/hooks.json` out of source control.
`omx uninstall` removes only the OMX-managed wrapper entries from `.codex/hooks.json`; if user hooks remain, the file stays in place.

`omx doctor` can confirm that these files exist and are shaped correctly. It does not prove that the same shell/profile can complete an authenticated Codex request; use `codex login status` plus a real `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"` smoke test for that boundary.

## Ownership split

- **Native Codex hooks**: `.codex/hooks.json`
- **OMX plugin hooks**: `.omx/hooks/*.mjs`
- **tmux/runtime fallbacks**: `omx tmux-hook`, notify-hook, derived watcher, idle/session-end reporters

OMX only owns the wrapper entries that invoke `dist/scripts/codex-native-hook.js`. User-managed hook entries in the same `.codex/hooks.json` file are preserved across `omx setup` refreshes and `omx uninstall`.

## Mapping matrix

| OMC / OMX surface | Native Codex source | OMX runtime target | Status | Notes |
| --- | --- | --- | --- | --- |
| `session-start` | `SessionStart` | `session-start` | native | Native adapter refreshes leader session bookkeeping, preserves the canonical leader scope when a native subagent `SessionStart` is detected from rollout `session_meta`, restores startup developer context, and ensures `.omx/` is gitignored at the repo root |
| wiki startup context | `SessionStart` | `session-start` | native | Wiki session-start context can append a compact `.omx/wiki/` summary when wiki pages exist; startup writes stay config-gated |
| `keyword-detector` | `UserPromptSubmit` | `keyword-detector` | native | Persists skill activation state and can add prompt-side developer context for top-level prompts; native subagent prompt text is treated as delegated task text, so literal workflow keywords inside a child prompt do not activate nested workflow state; `$ralph` prompt routing seeds workflow state only and does not launch `omx ralph --prd ...` |
| `pre-tool-use` | `PreToolUse` (`Bash`) | `pre-tool-use` | native-partial | Current native scope is Bash-only; built-in native behavior cautions on `rm -rf dist`, blocks inspectable inline `git commit` commands until Lore-format structure + the required `Co-authored-by: OmX <omx@oh-my-codex.dev>` trailer are present unless explicitly opted out with `OMX_LORE_COMMIT_GUARD=0`, and emits non-blocking document-refresh warnings for mapped staged commit changes that lack rule-scoped docs/spec refresh evidence |
| `post-tool-use` | `PostToolUse` (`Bash`) | `post-tool-use` | native-partial | Current native scope is Bash-only; built-in native behavior covers command-not-found / permission-denied / missing-path guidance only from stderr or non-zero Bash results, ignores failure-looking strings from successful source/log reads, and keeps MCP transport-death guidance scoped to MCP-like tool calls; document-refresh commit warnings use PreToolUse advisory output, with PostToolUse reserved as a future fallback if Codex advisory semantics change |
| Ralph/persistence stop handling | `Stop` | `stop` | native-partial | Native adapter uses the documented native Stop continuation contract (`decision: "block"` + `reason`) for active Ralph runs, emits a single JSON object on Stop stdout even for no-op Stop decisions, and emits deterministic JSON continuation output if Stop dispatch fails before normal handling |
| Autopilot continuation | `Stop` | `stop` | native-partial | Native adapter continues non-terminal autopilot sessions from active session/root mode state |
| Ultrawork continuation | `Stop` | `stop` | native-partial | Native adapter continues non-terminal ultrawork sessions from active session/root mode state |
| UltraQA continuation | `Stop` | `stop` | native-partial | Native adapter continues non-terminal ultraqa sessions from active session/root mode state |
| Team-phase continuation | `Stop` | `stop` | native-partial | Native adapter treats per-team `phase.json` as canonical when deciding whether a current-session team run is still non-terminal and can re-block on later fresh Stop replies while keeping leader guidance explicit about rewriting system-generated worker auto-checkpoint commits into Lore-format final history |
| `ralplan` skill-state continuation | `Stop` | `stop` | native-partial | Native adapter can block on active `skill-active-state.json` for `ralplan`, unless active subagents are already the real in-flight owners |
| `deep-interview` skill-state continuation | `Stop` | `stop` | native-partial | Native adapter can block on active `skill-active-state.json` for `deep-interview`, unless active subagents are already the real in-flight owners |
| auto-nudge continuation | `Stop` | `stop` | native-partial | Native adapter continues turns that end in a permission/stall prompt, can re-fire for later fresh replies, and suppresses auto-nudge while interview / deep-interview state is active; explicit terminal lifecycle metadata should be authoritative when present, legacy `blocked_on_user` remains a suppress-continuation compatibility signal, and `cancelled` stays internal legacy-only for user-facing lifecycle summaries |
| team worker Stop nudge | `Stop` | `stop` | native-partial | Team worker leader nudges are lifecycle-driven: a resolved allowed native worker Stop may notify the leader through guarded delivery after the non-terminal task guard passes. Deprecated worker stall/progress environment knobs such as `OMX_TEAM_PROGRESS_STALL_MS` and `OMX_TEAM_WORKER_TURN_STALL_MS` are compatibility/test-only surfaces and must not be documented as active team-nudge tuning knobs. |
| `ask-user-question` | none | runtime-only | runtime-fallback | No distinct Codex native hook today |
| `PostToolUseFailure` | none | runtime-only | runtime-fallback | Fold into runtime/fallback handling until native support exists |
| non-Bash tool interception | none | runtime-only | runtime-fallback | Current Codex native tool hooks expose Bash only |
| code simplifier stop follow-up | none | runtime-only | runtime-fallback | Cleanup follow-up stays on runtime/fallback surfaces, not native Stop |
| `SubagentStop` | none | runtime-only | not-supported-yet | OMC-specific lifecycle extension |
| `session-end` | none | `session-end` | runtime-fallback | Still emitted from runtime/notify path, not native Codex hooks |
| wiki session capture | none | `session-end` | runtime-fallback | Wiki session-log capture runs from the existing runtime session-end cleanup path, not from a native Codex hook |
| `session-idle` | none | `session-idle` | runtime-fallback | Still emitted from runtime/notify path, not native Codex hooks |


## Document-refresh warning MVP

The native hook adapter includes an agent-only document-refresh warning MVP for
spec-driven development hygiene. It does **not** install a generic CI gate, does
**not** add a repo-wide pre-commit framework, and must not hard-block `git
commit` for document-refresh reasons. Existing Lore commit blocking remains
separate and still wins when an inline commit message is not Lore-compliant,
unless the Lore commit guard is explicitly disabled.

## Lore commit guard opt-out

Lore commit enforcement is enabled by default. To use conventional commits or
another local commit policy while keeping OMX-managed native hooks installed,
set `OMX_LORE_COMMIT_GUARD` to `0`, `false`, `no`, or `off`.

For persistent Codex CLI usage, place the opt-out in `config.toml`:

```toml
[shell_environment_policy.set]
OMX_LORE_COMMIT_GUARD = "0"
```

The opt-out disables only the Lore-style `git commit` blocking guard. Other
native `PreToolUse` checks, including document-refresh warnings and command
safety checks, still run. `omx doctor` reports when the guard is explicitly
disabled by environment or config.

Warning scope is intentionally narrow and rule-scoped:

- **Commit path:** `PreToolUse` is Bash-only in this MVP and evaluates only
  inspectable `git commit` commands. It reads `git diff --cached --name-status`,
  so only staged changes count. Staged product docs such as
  `docs/codex-native-hooks.md` can suppress a native-hook rule warning.
  Rule-owned `.omx/plans/**` and `.omx/specs/**` targets suppress commit-path
  warnings only when they are tracked or force-staged despite `.omx/` being
  gitignored. Local-only ignored planning files do not suppress commit warnings.
- **Final handoff path:** `Stop` evaluates only terminal-looking final handoff
  attempts, after active-mode blockers and auto-nudge recovery. It reads staged
  plus unstaged diffs and can count fresh local rule-owned `.omx/plans/**` or
  `.omx/specs/**` files when their mtimes are newer than the mapped source
  change. This is an agent-local heuristic freshness check for final handoff,
  not commit evidence or proof of semantic refresh.
- **Mappings:** rules live in `src/document-refresh/config.ts`; unrelated doc
  or `.omx` edits do not suppress warnings for another rule. Initial rules cover
  native hook behavior, document-refresh enforcer behavior, CLI/operator
  behavior, and prompt-guidance behavior only.
- **Exclusions:** tooling-only changes, release collateral, rename-only changes,
  and explicitly ignored non-user-facing internal tests are ignored
  conservatively. Ambiguous refactors should use the explicit exemption if no
  product/spec refresh is needed.

To acknowledge a legitimate no-refresh case, include this exact line in the
commit message or final handoff text with a concrete reason:

```text
Document-refresh: not-needed | <reason>
```

The warning output names the mapped triggering path(s) and expected refresh
target group(s), so agents can refresh the right product docs or planning specs
instead of using an unrelated docs edit as a blanket suppression.

## Project wiki addendum (approved v1 backport)

The approved OMX-native wiki backport keeps lifecycle ownership intentionally narrow:

- **Storage** lives under `.omx/wiki/`, not `.omc/wiki/`.
- **SessionStart** may surface bounded wiki context from `.omx/wiki/` when the wiki already exists, but it should stay read-mostly and must not block the native hook path on expensive writes or index rebuilds.
- **SessionEnd** remains a runtime/notify-path responsibility for best-effort, non-blocking session capture into `.omx/wiki/`.
- **PreCompact parity is intentionally deferred** in v1 unless a clearly OMX-native compaction seam exists.
- **Routing should stay explicit**: prefer `$wiki` or task verbs like `wiki query` / `wiki add`, and avoid implicit bare `wiki` noun activation.

## Explicit terminal stop model note

The approved explicit terminal stop model adds a canonical lifecycle layer for active workflow handoffs:

- `finished`
- `blocked`
- `failed`
- `userinterlude`
- `askuserQuestion`

Hook readers should prefer explicit lifecycle metadata over assistant-text heuristics when those signals are available.
During migration, legacy `blocked_on_user` still suppresses continuation, but `cancelled` should be treated as internal legacy/admin compatibility rather than a canonical user-facing outcome.

There is still no distinct native Codex `ask-user-question` hook today. That means `askuserQuestion` classification remains a runtime/fallback responsibility unless a future native hook surface exposes first-class question-stop metadata.

## Combined workflow note

Stop/continuation readers must interpret approved combined workflow state from
the shared active-set contract rather than from a single legacy `skill` owner.
For the first-pass multi-state rollout, the approved overlaps are:

- `team + ralph`
- `team + ultrawork`

Unsupported overlaps should preserve the current state unchanged and direct the
operator to clear incompatible state explicitly via `omx state ...` or the
`omx_state.*` MCP tools before retrying. See
`docs/contracts/multi-state-transition-contract.md`.

## UserPromptSubmit: triage advisory context

`UserPromptSubmit` can now emit triage advisory context alongside keyword context. When no keyword matches, the triage layer classifies the prompt and may inject an advisory prompt-routing context string — this is advisory prompt-routing context that does not activate a skill or workflow by itself; it adds a developer-context hint the model may follow. Light advisory destinations include repo-local `explore`, narrow-edit `executor`, visual `designer`, and external documentation/reference `researcher`; researcher routing is for official-doc, version-compatibility, source-backed, or external lookup requests, does not override local anchors or implementation-shaped prompts, and still writes only prompt-routing state. Keywords remain the deterministic control surface: a matched keyword always takes precedence over triage output, and users can suppress triage injection per prompt with phrases such as `no workflow`, `just chat`, or `plain answer`.

Tracked native subagent `UserPromptSubmit` events are intentionally isolated from keyword activation and triage injection. The parent may delegate a child prompt that starts with text such as `$ralplan Architect review step...`; once the child native session is known in `.omx/state/subagent-tracking.json`, that prompt is handled as literal task text rather than as a fresh workflow invocation. Top-level prompt submits are unchanged and still activate workflows normally.

## Verification guidance

When validating hooks, keep the proof boundary explicit:

1. **Native Codex hook proof**
   - `omx setup` wrote `.codex/hooks.json`
   - native Codex event invoked `dist/scripts/codex-native-hook.js`
2. **OMX plugin proof**
   - plugin dispatch/log evidence exists under `.omx/logs/hooks-*.jsonl`
3. **Fallback proof**
   - behavior came from notify-hook / derived watcher / tmux runtime, not native Codex hooks

Do not claim “native hooks work” when only tmux or synthetic notify fallback paths were exercised.
Likewise, do not claim real execution readiness from hook/install evidence alone; validate an actual Codex execution in the active runtime profile when diagnosing auth or provider issues.
