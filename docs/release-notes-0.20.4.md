# oh-my-codex 0.20.4 release notes

Release date: 2026-07-28

`0.20.4` is a patch release covering the exact frozen range `v0.20.3..73cb50c125c11aca0654b8841e690f011eb5f43f`. It contains 62 merged product PRs (one additive, backward-compatible feature plus reliability, workflow-safety, native-hook trust, and path-canonicalization fixes).

> **Current fork policy / supersession:** The host-receipt preflight entry below records 0.20.4 behavior. This fork now compiles `authority_policy: "local_owner_lifecycle"`: a fresh, approving, tracker-backed native Architect review followed by a fresh, approving, tracker-backed native Critic review, with distinct completed native thread identities, authorizes Ralplan handoff. This local lifecycle authority is never a `host_consensus_receipt`. Adapted role-intent restrictions remain unchanged.

## Highlights

- **Dead session-pointer lock recovery** — canonical session-pointer locks are now recovered when positively dead, with identity-revalidated, no-clobber reversible claims. Recovery checkpoints are resumable, swapped claims are preserved, failed claims are rolled back, and recovery directories are atomically quarantined (#3261, #3262; issue #3256).
- **Team startup rollback and pane authority** — startup cleanup is bound to exact owned panes with split-proof reconciliation, pinned against ambiguous worker/HUD cleanup and PID reuse. Team also validates worker liveness against exact panes, preserves leader session pointer ownership, invalidates stale queued notices, guards the terminal follow-up boundary, and fails closed on managed Codex bypass rejection (#3265; #3231, #3228, #3229, #3230, #3232; issue #3224).
- **Native hook trust and path canonicalization** — exact absolute package CLI status is trusted (#3333; issues #3320, #3322, #3323, #3325, #3321, #3327). Conductor mutation roots, macOS policy paths, and temporary fixture roots are canonicalized. Planning state transport guards are repaired (#3343, #3344, #3348, #3349, #3350, #3351, #3352, #3353).
- **Ultragoal goal-status and state binding** — native Codex goal blocked status is preserved (#3301, #3305), aggregate goals are bound to canonical state paths (#3294, #3297), aggregate completion is persisted on ordinary final checkpoint (#3295), and finite Codex goal tools are authorized under Main-root Conductor (#3300, #3304).
- **State authoritative root** — the authoritative runtime root establishes session-scoped authority with authenticated fixtures, ownership enforcement, alias binding, HUD read binding, stale-ancestor rejection, plugin authority isolation, and contained root targets (#3160).
- **Herdr lifecycle/status bridge** — opt-in Herdr lifecycle and status bridge (Phase 1) provides an external adaptation surface (#3241, #3242).

## Other fixes

- **Resumed session cancel ownership** — cancel ownership is reconciled for resumed sessions, preserving proven-session scoping (#3280, #3290, #3214).
- **Root session self-reopen prevention** — root sessions are prevented from self-reopening (#3284, #3289).
- **Identity-indeterminate pointer recovery** — bounded exact-match recovery resolves identity-indeterminate session pointers (#3324, #3332).
- **State alias resolution and revalidation** — verified native session aliases are resolved (#3308), and durable state commits are revalidated against exact stale session bindings (#3272, #3298).
- **Deep-interview cancel and self-lock** — the deep-interview omx cancel hook is made hook-owned (#3293, #3299), and the PreToolUse self-lock is fixed (#3240).
- **HUD teardown and resize guards** — detached HUD is torn down on child exit (#3267), and deferred HUD resize sinks are guarded in command-list context (#3292, #3296).
- **Native Stop hook bounds** — sloppy fallback Stop audit is bounded and session-scoped (#3347), native Stop hook pointer loops are bounded (#3238), paused Stop guidance is bounded (#3237), and unmatched native Stop is silenced (#3254).
- **Native sidecar and collaboration authority** — native sidecar session authority is scoped during pointer conflicts (#3244), live session pointers are prevented from native-start replacement (#3235), collaboration tool names are canonicalized (#3264), and collaboration.send_message is scoped out of native-child orchestration deny (#3317).
- **Standalone Conductor activation guard** — standalone Ultragoal Conductor activation with no reachable owner is refused (#3311, #3312).
- **Unauthoritative plan bootstrap rejection** — unauthoritative Ultragoal bootstrap publication is rejected (#3326).
- **Read-only discovery misclassification** — omx/gjc read-only discovery is no longer misclassified as writes (#3313, #3314, #3318).
- **Auth metadata validation** — metadata is validated before credential switch (#3276).
- **Oversized native hook stdin** — oversized native hook stdin is drained (#3273).
- **Nonexistent native assignment guidance** — nonexistent native assignment guidance is removed (#3346).
- **Windows session owner PID** — Windows native hook session owner PID is resolved (#3260).
- **Bun install ownership** — Bun install ownership is preserved during update (#3259).
- **tmux separator argv boundaries** — tmux separator argv boundaries are preserved (#3258).
- **Ralplan preflight guidance** — Ralplan preflight guidance is scoped (#3255).
- **PowerShell psmux pane creation** — Team's PowerShell psmux pane creation is made safe (#3145).
- **Autopilot host-receipt preflight** — fresh default Autopilot now fails before deep-interview and Architect/Critic review work when the official host consensus receipt verifier is deterministically unavailable (#3270).
- **Native cache integrity boundary** — managed cache binaries without their `.sha256` sidecar are rejected; native-assets fail closed on unverified cache authority (#3285).
- **Deterministic test fixes** — PATH candidate-budget smoke test is made deterministic (#3330), portable PTY script(1) argv helper for Darwin/Linux is added (#3328, #3331), and Windows durability sync is made deterministic (#3233).
- **Dependency bumps** — libc 0.2.186→0.2.189 (#3251, #3335), serde 1.0.228→1.0.229 (#3249), serde_json 1.0.150→1.0.151 (#3248), @modelcontextprotocol/sdk 1.29.0→1.30.0 (#3337), @biomejs/biome 2.5.3→2.5.4 (#3252), c8 11.0.0→12.0.0 (#3250), @types/yauzl 2.10.3→3.4.0 (#3339), @types/yazl 2.4.5→3.3.1 (#3340).

## Merged PR inventory

The merged product PR set is #3145, #3160, #3214, #3216, #3219, #3228, #3229, #3230, #3231, #3232, #3233, #3235, #3237, #3238, #3240, #3241, #3242, #3244, #3248, #3249, #3250, #3251, #3252, #3254, #3255, #3258, #3259, #3260, #3262, #3264, #3265, #3267, #3271, #3272, #3273, #3276, #3277, #3280, #3284, #3285, #3289, #3290, #3292, #3293, #3294, #3295, #3296, #3297, #3298, #3299, #3300, #3304, #3305, #3308, #3311, #3312, #3313, #3314, #3317, #3318, #3324, #3326, #3328, #3330, #3331, #3332, #3333, #3335, #3337, #3339, #3340, #3343, #3346, #3347, #3348, #3349, #3350, #3351, #3352, #3353. Associated issues #3301, #3309, #3220, #3320, #3321, #3322, #3323, #3325, #3327, #3293, #3284, #3292, #3294, #3272, #3311, #3313, #3314, #3241, #3256, #3224, #3270, and #3300 are not additional PRs. Reproduce the inventory with:

```sh
git log --reverse --format='%H%x09%s' v0.20.3..73cb50c125c11aca0654b8841e690f011eb5f43f
```

A full commit-level classification is in `artifacts/release-0.20.4/inventory.md`.

## Compatibility

Patch release with no intentional breaking CLI or package-layout changes. The one feature (#3241/#3242 Herdr bridge) is additive and backward-compatible.

## Validation

Local build, lint, typecheck, plugin-bundle, native-agents, and Node test gates for the touched surface are recorded in `docs/qa/release-readiness-0.20.4.md`. External CI, tag, GitHub release, and npm publication evidence is recorded in that same readiness record as the publish sequence completes.

## Contributors

Thanks to Bellman (@Yeachan-Heo) for the majority of commits in this range, with additional contributions from @achieve0410, @bohe76, @chief-impact7, @don9x2E, @huajuan404, @ictechgy, @lux-02, @masterFoad, and @WangErgouaaaa, plus @app/dependabot for dependency updates.

**Full Changelog**: [`v0.20.3...v0.20.4`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.3...v0.20.4)
