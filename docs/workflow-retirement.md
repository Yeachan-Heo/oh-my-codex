# Workflow retirement boundary

## Canonical policy

`src/catalog/manifest.json` owns installability/lifecycle status; `src/hooks/sunset-stub.ts`
owns the implemented removed-token diagnostics and supported replacements; on-disk
sunset cards also carry migration messages. The diagnostic map is not an exhaustive
lifecycle inventory. `templates/AGENTS.md` owns
ordinary-mode selection. Skill cards own only their task-specific process; plugin copies
are generated with `npm run sync:plugin`.

Ordinary scoped coding is direct execution. Explicit Autopilot retains its full
Deep Interview → Ralplan → Ultragoal contract. New execution handoffs use supported
skills, not `$ralph`, `$ultrawork`, `$pipeline`, or `$autoresearch-goal`.

## Compatibility is not a second recommended workflow

Retiring a prompt token does not retire its similarly named CLI, existing on-disk
state, HUD projection, cancellation cleanup, or previously produced artifacts.
In particular, the `omx ralph` CLI and persistence runtime remain supported by the
current sunset contract. Do not delete their identity, ownership, stop, or cancel
checks as part of prompt cleanup.

Active cards may mention retired tokens only as explicitly labeled migration or
historical-artifact input, not as an executable fallback. HUD examples must label
legacy compatibility rather than encourage starting retired skills.

## Removal conditions

- **Prompt stubs:** remove only in a release that explicitly ends their advertised
  grace period, after catalog/install cleanup, replacement diagnostics, generated
  mirrors, and active-card handoff tests agree. Do not infer removal from a name alone.
- **Runtime compatibility:** requires a separate reviewed migration with tests for
  supported saved-state resume, exact-session cancellation, and stale/foreign-owner
  rejection. Prompt retirement alone is insufficient evidence to remove it.
- **Historical artifacts:** remain readable without granting activation or write
  authority. Any future removal must document a migration path and affected format.

Check active handoffs with the sunset-routing contract tests; regenerate mirrors,
then run `npm run verify:generated` and the affected skill contracts.
