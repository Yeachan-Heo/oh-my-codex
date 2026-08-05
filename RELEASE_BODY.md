# oh-my-codex 0.20.4

`0.20.4` is a patch release for the reliability, workflow-safety, and native-hook trust work in the exact range `v0.20.3..73cb50c125c11aca0654b8841e690f011eb5f43f`, plus one additive, backward-compatible feature.

## Highlights

- Dead session-pointer lock recovery with identity-revalidated, no-clobber reversible claims, resumable checkpoints, and atomic quarantine (#3261, #3262; issue #3256).
- Team startup rollback bound to exact owned panes with split-proof reconciliation, worker liveness pinning, leader session pointer ownership, stale notice invalidation, terminal follow-up boundary guards, and fail-closed managed Codex bypass rejection (#3265; #3231, #3228, #3229, #3230, #3232; issue #3224).
- Native hook trust and path canonicalization: exact absolute package CLI status trusted (#3333; issues #3320, #3322, #3323, #3325, #3321, #3327), conductor mutation roots and macOS policy/fixture paths canonicalized, planning state transport guards repaired (#3343, #3344, #3348, #3349, #3350, #3351, #3352, #3353).
- Ultragoal goal-status preservation, canonical state path binding, aggregate completion persistence, and finite Codex goal tool authorization under Main-root Conductor (#3301, #3305, #3294, #3297, #3295, #3300, #3304).
- State authoritative runtime root with session-scoped authority, authenticated fixtures, and plugin authority isolation (#3160).
- Opt-in Herdr lifecycle/status bridge Phase 1 (#3241, #3242).
- Ralplan review authority remains fail-closed without an official host consensus receipt, and autopilot preflight fails before deep-interview and Architect/Critic review work when the receipt verifier is unavailable (#3270).

> **Current status / supersession:** The 0.20.4 host-receipt preflight bullet records historical release behavior. This fork now compiles `authority_policy: "local_owner_lifecycle"`: a fresh, approving, tracker-backed native Architect review followed by a fresh, approving, tracker-backed native Critic review, with distinct completed native thread identities, authorizes Ralplan handoff. This local lifecycle authority is never a `host_consensus_receipt`. The former receipt-only policy reported `documented_host_consensus_receipt_unavailable`; that blocker is historical and does not describe the current compiled policy. Adapted role-intent still does not authorize, and `role_routing_unavailable` adapted authority attempts still fail with `unsupported_documented_leader_proof`.

## Additional fixes

- Resumed session cancel ownership reconciliation (#3280, #3290, #3214).
- Root session self-reopen prevention (#3284, #3289).
- Identity-indeterminate pointer recovery (#3324, #3332).
- State alias resolution and stale binding revalidation (#3308, #3272, #3298).
- Deep-interview cancel hook ownership and PreToolUse self-lock fix (#3293, #3299, #3240).
- HUD teardown on child exit and deferred resize guards (#3267, #3292, #3296).
- Native Stop hook bounds: session-scoped sloppy fallback audit, pointer loop bounds, paused guidance bounds, unmatched Stop silence (#3347, #3238, #3237, #3254).
- Native sidecar and collaboration authority scoping (#3244, #3235, #3264, #3317).
- Standalone Conductor activation guard and unauthoritative plan bootstrap rejection (#3311, #3312, #3326).
- Read-only discovery misclassification fix (#3313, #3314, #3318).
- Auth metadata validation, oversized hook stdin drain, nonexistent assignment guidance removal (#3276, #3273, #3346).
- Windows session owner PID, Bun install ownership, tmux separator argv boundaries (#3260, #3259, #3258).
- Ralplan preflight guidance scoping and PowerShell psmux pane safety (#3255, #3145).
- Autopilot host-receipt preflight and native cache integrity fail-closed (#3270, #3285).
- Dependency updates: libc, serde, serde_json, @modelcontextprotocol/sdk, @biomejs/biome, c8, @types/yauzl, @types/yazl.

## Contributors

Thanks to Bellman (@Yeachan-Heo) for the majority of commits in this range, with additional contributions from @achieve0410, @bohe76, @chief-impact7, @don9x2E, @huajuan404, @ictechgy, @lux-02, @masterFoad, and @WangErgouaaaa, plus @app/dependabot for dependency updates.

**Full Changelog**: [`v0.20.3...v0.20.4`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.3...v0.20.4)
