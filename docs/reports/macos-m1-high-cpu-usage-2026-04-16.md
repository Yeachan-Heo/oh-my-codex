## macOS M1 High CPU Usage Investigation

Date: 2026-04-16

### Symptom

Launching `omx --madmax --xhigh` on an Apple Silicon Mac caused `syspolicyd`
to spike, often alongside visible CPU churn in `sysmond`.

### Root Cause

The dominant trigger was not `syspolicyd` itself. OMX startup entered the
fallback watcher path in a repository with stale runtime state, which caused
`leader_nudge` polling to run roughly every 250 to 350 ms.

That polling path called `isLeaderRuntimeStale()`, which read leader git
activity by shelling out to multiple short-lived `git` processes:

- `git rev-parse --git-dir`
- `git symbolic-ref --quiet --short HEAD`
- `git rev-parse --git-path logs/HEAD`
- `git rev-parse --git-path logs/refs/heads/<branch>`
- `git show -s --format=%ct HEAD`

On macOS, each of those short-lived `git` execs triggered code-signing and
policy checks in `syspolicyd`. The repeated exec bursts were sufficient to
drive `syspolicyd` CPU well above normal idle levels during startup.

### Patch

File changed:

- `src/team/leader-activity.ts`

Implementation:

- Added a process-local cache for leader git activity lookups.
- Cache key is the repository root derived from `stateDir`.
- Cache TTL is bounded between `1000 ms` and `5000 ms`.
- TTL is computed as `thresholdMs / 4`, clamped to that range.
- `readLeaderRuntimeSignalStatuses()` now uses the cached git activity lookup
  instead of invoking the git-reading path on every poll cycle.

### Why This Shape

- The fix targets the verified hotspot directly.
- It preserves stale-detection semantics.
- It avoids broader changes to watcher cadence or team lifecycle behavior.
- It keeps the diff small and reversible.

### Validation

Controlled reproduction before the patch:

- `omx --madmax --xhigh` in `GhostVMPriv`
- `notify-fallback-watcher` active with `poll_ms = 250`
- `leader_nudge` firing repeatedly
- `syspolicyd` observed around `66% CPU`
- `fs_usage -f exec` showed repeated `git` exec bursts

Controlled reproduction after the patch:

- Same repository and startup command
- Same `leader_nudge` loop still active
- 4-second post-start sampling window observed `0` `git` execs
- `syspolicyd` dropped to low single-digit CPU usage

### Remaining Risks

- Stale `.omx/state` can still keep `leader_nudge` polling active; this patch
  removes the dominant git-exec hotspot but does not stop the poll loop.
- Other synchronous git metadata reads still exist in separate paths such as
  operational event enrichment and HUD rendering, but they were no longer the
  dominant startup hotspot in the reproduced window.
- Git activity freshness is now cached briefly, so stale detection can lag by
  at most the configured cache TTL.
