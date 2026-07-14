# Codex native hook mapping

This page is the canonical answer to:

> Which OMC/OMX hooks run on native Codex hooks already, which stay on runtime fallbacks, and which are not supported yet?

## Install surface

For plugin installs on Codex versions that report official plugin-scoped hook
support, the packaged plugin is the hook registration surface:

- `plugins/oh-my-codex/.codex-plugin/plugin.json` → points Codex at `./hooks/hooks.json`
- `plugins/oh-my-codex/hooks/hooks.json` → registers the OMX lifecycle hook commands with `${PLUGIN_ROOT}`
- `.codex/config.toml` → enables `[features].plugin_hooks = true` and `[features].goals = true`

`omx setup` still owns the legacy/fallback native Codex artifacts for legacy
installs and older Codex versions that do not report `plugin_hooks`:

- `.codex/config.toml` → enables the installed-Codex hook flag (`[features].hooks = true`, or legacy `[features].codex_hooks = true` when that is the only reported feature) and `[features].goals = true`
- `.codex/hooks.json` → registers the OMX-managed native hook command while preserving non-OMX hook entries already in the file
- `.codex/config.toml` → also records `hooks.state."<hooks.json>:<event>:<group>:<handler>".trusted_hash` for the OMX-owned wrappers so recent Codex releases do not require a manual `/hooks` review for setup-managed hooks

Compatibility note: Codex CLI 0.129/0.130 treats `hooks` as the canonical stable feature key and keeps `codex_hooks` only as a legacy alias. Some public hook examples may still show `[features].codex_hooks = true`; OMX-generated fallback config intentionally emits `[features].hooks = true` while setup/uninstall migration paths still accept and normalize older `codex_hooks` entries so existing user configs do not lose hook enablement.

For project scope, `.gitignore` keeps generated `.codex/hooks.json` out of source control.
`omx uninstall` removes only the OMX-managed wrapper entries from `.codex/hooks.json`; if user hooks remain, the file stays in place.
Project launches use a session-scoped `.omx/runtime/codex-home/<session>/` mirror for Codex runtime writes; hook review/discovery tools should treat that directory as runtime mirror state and ignore its `hooks.json` surfaces rather than loading them alongside the canonical `.codex/hooks.json`.
Project-scoped resume and search discovery include generated runtime homes under `.omx/runtime/codex-home/omx-*/sessions`: plain `omx resume` and `omx session search` in a project-scoped repo include those session sources automatically, `omx resume --project` restricts resume to generated project runtime homes, and `--codex-home <path>` is the one-shot escape hatch for both `omx resume` and `omx session search`.

`omx doctor` can confirm that these files exist and are shaped correctly. It does not prove that the same shell/profile can complete an authenticated Codex request; use `codex login status` plus a real `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"` smoke test for that boundary.

## Ownership split

- **Plugin-scoped Codex hooks**: `plugins/oh-my-codex/hooks/hooks.json` for plugin installs on Codex versions with `[features].plugin_hooks`
- **Legacy/fallback native Codex hooks**: `.codex/hooks.json`
- **OMX plugin hooks**: `.omx/hooks/*.mjs`
- **tmux/runtime fallbacks**: `omx tmux-hook`, notify-hook, derived watcher, idle/session-end reporters

OMX only owns the wrapper entries that invoke `dist/scripts/codex-native-hook.js`. User-managed hook entries in the same `.codex/hooks.json` file are preserved across `omx setup` refreshes and `omx uninstall`.
Setup-owned trust state is limited to those generated wrapper identities; user hooks and user-owned `hooks.state` entries are preserved and remain subject to Codex's normal review flow.

## Mapping matrix

| OMC / OMX surface | Native Codex source | OMX runtime target | Status | Notes |
| --- | --- | --- | --- | --- |
| `session-start` | `SessionStart` | `session-start` | native | Native adapter refreshes leader session bookkeeping, preserves the canonical leader scope when a native subagent `SessionStart` is detected from rollout `session_meta`, restores startup developer context, and ensures `.omx/` is gitignored at the repo root |
| wiki startup context | `SessionStart` | `session-start` | native | Wiki session-start context can append a compact `omx_wiki/` summary when wiki pages exist; startup writes stay config-gated |
| `keyword-detector` | `UserPromptSubmit` | `keyword-detector` | native | Persists skill activation state and can add prompt-side developer context for top-level prompts; native subagent prompt text is treated as delegated task text, so literal workflow keywords inside a child prompt do not activate nested workflow state; `$ralph` prompt routing seeds workflow state only and does not launch `omx ralph --prd ...` |
| ultragoal bounded steering | `UserPromptSubmit` | `ultragoal` artifacts | native | Only explicit structured directives such as `OMX_ULTRAGOAL_STEER: { ... }`, `omx.ultragoal.steer: { ... }`, or `omx ultragoal steer: { ... }` are parsed; accepted/rejected/deduped attempts route through `steerUltragoal`, append `.omx/ultragoal/ledger.jsonl`, and add advisory context without changing keyword precedence |
| `pre-tool-use` | `PreToolUse` | `pre-tool-use` | native-partial | Native behavior cautions on Bash `rm -rf dist`, blocks inspectable inline `git commit` commands until Lore-format structure + the required `Co-authored-by: OmX <omx@oh-my-codex.dev>` trailer are present only when explicitly opted in with `OMX_LORE_COMMIT_GUARD=1`, emits non-blocking document-refresh warnings for mapped staged commit changes that lack rule-scoped docs/spec refresh evidence, and blocks `close_agent` / parallel close cleanup before it starts when a fresh native subagent capacity blocker was recorded |
| native `PreToolUse` stdout schema | `PreToolUse` | CLI stdout | native | Codex CLI 0.141.0 accepts only `systemMessage` for `PreToolUse`; the native CLI writer strips internal `decision`, `reason`, `stopReason`, `continue`, and `hookSpecificOutput` fields before stdout while preserving richer internal dispatch results for tests and non-stdout callers. |
| `post-tool-use` | `PostToolUse` | `post-tool-use` | native-partial | Built-in Bash behavior covers command-not-found / permission-denied / missing-path guidance only from stderr or non-zero Bash results, ignores failure-looking strings from successful source/log reads, keeps MCP transport-death guidance scoped to MCP-like tool calls, and records a short-lived `.omx/state/native-subagent-capacity-blocker.json` when native subagent spawn/collab output reports `agent thread limit reached`; document-refresh commit warnings use PreToolUse advisory output, with PostToolUse reserved as a future fallback if Codex advisory semantics change |
| Ralph/persistence stop handling | `Stop` | `stop` | native-partial | Native adapter uses the documented native Stop continuation contract (`decision: "block"` + `reason`) for active Ralph runs, emits a single JSON object on Stop stdout even for no-op Stop decisions, and emits deterministic JSON continuation output if Stop dispatch fails before normal handling |
| imagegen continuation helper | `Stop` | `stop` | native-partial | `omx imagegen continuation <session-id> --artifact <name>` records `.omx/state/sessions/<session>/imagegen-pending.json` and queues an audited exec follow-up so built-in `image_gen` turns that must end immediately can resume Ralph visual QA/recovery at the next Stop checkpoint |
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
| non-Bash tool interception | `PreToolUse` / `PostToolUse` when provided by Codex | native hook | native-partial | OMX stays no-op for unrelated non-Bash tools, but native subagent capacity failures and close-agent cleanup requests are handled when Codex provides those tool events |
| code simplifier stop follow-up | none | runtime-only | runtime-fallback | Cleanup follow-up stays on runtime/fallback surfaces, not native Stop |
| `SubagentStop` | none | runtime-only | not-supported-yet | OMC-specific lifecycle extension |
| `session-end` | none | `session-end` | runtime-fallback | Still emitted from runtime/notify path, not native Codex hooks |
| wiki session capture | none | `session-end` | runtime-fallback | Wiki session-log capture runs from the existing runtime session-end cleanup path, not from a native Codex hook |
| `session-idle` | none | `session-idle` | runtime-fallback | Still emitted from runtime/notify path, not native Codex hooks |


## PreToolUse: conductor typed-lane recognition

The Main-root Conductor write guard blocks source, package, git, and substantive
plan/spec/review edits from the leader while allowing workflow metadata writes.
Trust for delegated performer lanes is scoped by guard:

- Planning boundary guards (`ralplan`, `deep-interview`) exempt a delegated lane
  only when the event is a known typed role (catalog-bounded or an installed
  `*.toml` role) **and** trusted lane provenance exists. This keeps untyped
  `collaboration.spawn_agent` children from writing source before an execution
  handoff/approval.
- The Main-root Conductor / Ralph executing guard additionally trusts a delegated
  lane on trusted provenance alone, regardless of role label, so native
  `collaboration.spawn_agent` children and descendants can perform bounded writes
  during execution (#3116).

Native Codex events may provide that provenance either through
`source.subagent.thread_spawn.parent_thread_id` or through an existing
`.omx/state/subagent-tracking.json` entry whose `thread_id` is recorded as
`kind:"subagent"`. The session leader thread is never trusted through either
path, so a bare typed role on the leader event — or provenance attached to the
leader thread — is not enough to bypass the guard.

## Document-refresh warning MVP

The native hook adapter includes an agent-only document-refresh warning MVP for
spec-driven development hygiene. It does **not** install a generic CI gate, does
**not** add a repo-wide pre-commit framework, and must not hard-block `git
commit` for document-refresh reasons. Existing Lore commit blocking remains
separate and still wins when the Lore commit guard is explicitly enabled and an
inline commit message is not Lore-compliant.

## Lore commit guard opt-in

Lore commit enforcement is disabled by default. To require Lore-format inline
commit messages and the OmX co-author trailer while keeping OMX-managed native
hooks installed, set `OMX_LORE_COMMIT_GUARD` to `1`, `true`, `yes`, or `on`.

For persistent Codex CLI usage, place the opt-in in `config.toml`:

```toml
[shell_environment_policy.set]
OMX_LORE_COMMIT_GUARD = "1"
```

The opt-in controls only the Lore-style `git commit` blocking guard. Other
native `PreToolUse` checks, including document-refresh warnings and command
safety checks, still run. Native hook enforcement reads the same persistent
Codex config fallback when the hook process does not already have
`OMX_LORE_COMMIT_GUARD` in its environment. Inline command environment still
wins for that command, so `OMX_LORE_COMMIT_GUARD=0 git commit ...` disables a
persistent opt-in and `env -u OMX_LORE_COMMIT_GUARD git commit ...` removes the
persistent fallback for that invocation. `omx doctor` reports whether the guard
is enabled by explicit opt-in, disabled by default/config/environment, or
disabled because an explicit value is invalid.

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

- **Storage** lives under repository `omx_wiki/`, not ignored `.omx/wiki/` runtime state and not `.omc/wiki/`.
- **SessionStart** may surface bounded wiki context from `omx_wiki/` when the wiki already exists, but it should stay read-mostly and must not block the native hook path on expensive writes or index rebuilds.
- **SessionEnd** remains a runtime/notify-path responsibility for best-effort, non-blocking session capture into `omx_wiki/`.
- **PreCompact** and **PostCompact** are native and no-stdout by default: they record the lifecycle seams without emitting advisory `additionalContext` that Codex rejects for compact hook events.
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

For `ralplan`, native `PreToolUse` allows only a standalone terminal
`omx state write` transport for the current session's complete closeout
(`active:false`, `current_phase:"complete"`). The state backend remains the
authority for consensus validation and root/session terminalization, so compound
Bash commands that add any suffix after the closeout command stay blocked.

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

## UserPromptSubmit: session provenance

`UserPromptSubmit` resolves session authority from the explicit native payload before consulting the workspace pointer. A valid `payload.session_id` selects that Codex logical owner directly; the singleton `.omx/state/session.json` pointer may supply a canonical storage alias only when its recorded native/owner aliases prove the same logical session. When the payload identity is absent, pointer fallback uses the selected pointer's validated owner/native aliases and canonical session. Cwd, directory existence, and last-writer pointer state are not ownership proof.

Native and notify leader turns classify provenance once and pass an immutable authorization context to activation, continuation, HUD, auto-nudge, pane injection, and Ralph helpers. Notify's compatibility fork keeps Codex owner P separate from an already-existing OMX storage scope F; only the notify resolver may authorize that relation. Trusted child provenance is compared to the Codex owner, never the storage directory: a proven child of the current owner is silently suppressed, while foreign or ambiguous child evidence rejects the turn before workflow reads or writes.

Rejected turns perform no activation, continuation, steering, plugin, HUD, pane, timestamp, or neighboring-session mutation. They may append one redacted `prompt_session_provenance_rejected` diagnostic under the already-selected state root; the record contains the reason and producer but no raw session/thread identifiers, prompt text, environment value, or foreign path. `PreToolUse`, `Stop`, SessionStart reconciliation, and authoritative-root selection retain their existing contracts.

## UserPromptSubmit: triage advisory context

`UserPromptSubmit` can now emit triage advisory context alongside keyword context. When no keyword matches, the triage layer classifies the prompt and may inject an advisory prompt-routing context string — this is advisory prompt-routing context that does not activate a skill or workflow by itself; it adds a developer-context hint the model may follow. Light advisory destinations include repo-local `explore`, narrow-edit `executor`, visual `designer`, and external documentation/reference `researcher`; researcher routing is for official-doc, version-compatibility, source-backed, or external lookup requests, does not override local anchors or implementation-shaped prompts, and still writes only prompt-routing state. Keywords remain the deterministic control surface: a matched keyword always takes precedence over triage output, and users can suppress triage injection per prompt with phrases such as `no workflow`, `just chat`, or `plain answer`.

Tracked native subagent `UserPromptSubmit` events are intentionally isolated from keyword activation and triage injection. The parent may delegate a child prompt that starts with text such as `$ralplan Architect review step...`; once the child native session is known in `.omx/state/subagent-tracking.json`, that prompt is handled as literal task text rather than as a fresh workflow invocation. Top-level prompt submits are unchanged and still activate workflows normally.


## UserPromptSubmit: bounded ultragoal steering

When `.omx/ultragoal/goals.json` exists, native `UserPromptSubmit` can apply bounded ultragoal steering only from explicit structured directives. The parser recognizes JSON objects after labels such as `OMX_ULTRAGOAL_STEER:`, `omx.ultragoal.steer:`, or `omx ultragoal steer:`. It does not infer mutations from ordinary prose.

Accepted and rejected proposals are delegated to `src/ultragoal/artifacts.ts` via `steerUltragoal`, so hook code does not own mutation semantics. The hook returns additional context that names `.omx/ultragoal/goals.json`, `.omx/ultragoal/ledger.jsonl`, the accepted/rejected/deduped status, and the invariant result. Steering context is additive with keyword, goal-warning, and triage context; keyword routing still takes precedence.

The steering invariants are the same as the CLI: no aggregate objective edits, no constraint edits, no hard delete, no auto-complete, no silent mutation, and no broad natural-language magic. Repeated prompt-submit directives dedupe by prompt signature or idempotency key so structural mutations are not duplicated.

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
