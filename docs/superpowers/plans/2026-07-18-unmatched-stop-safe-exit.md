# Unmatched Codex Stop Safe Exit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let rejected secondary Codex roots exit without touching the live owner and prevent Cursor from launching duplicate Codex roots in one checkout.

**Architecture:** OMX keeps pointer ownership fail-closed, but treats an unmatched Stop with no session-scoped state directory as a no-write safe exit. A separate host-local Python guard checks the live pointer before the Cursor shell wrapper creates a new tmux/Codex root.

**Tech Stack:** TypeScript, Node's built-in test runner, Python 3 standard library, Bash, npm.

---

### Task 1: Lock the unmatched Stop behavior with a failing test

**Files:**
- Modify: `src/scripts/__tests__/codex-native-hook.test.ts:4177`

- [ ] **Step 1: Change the existing issue #3138 assertion to the desired safe exit**

Replace the `unmatchedStop` assertions with:

```ts
      const conflictingPointerPath = join(conflictingCwd, ".omx", "state", "session.json");
      const conflictingPointerBeforeStop = await readFile(conflictingPointerPath, "utf-8");
      const unmatchedStop = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd: conflictingCwd,
        session_id: "native-unmatched-stop-3138",
      }, { cwd: conflictingCwd });
      assert.equal(unmatchedStop.outputJson, null);
      assert.equal(await readFile(conflictingPointerPath, "utf-8"), conflictingPointerBeforeStop);
      assert.equal(
        existsSync(join(conflictingCwd, ".omx", "state", "sessions", "native-unmatched-stop-3138")),
        false,
      );
      assert.equal(existsSync(join(conflictingCwd, ".omx", "state", "native-stop-state.json")), false);
```

- [ ] **Step 2: Build and run only the issue #3138 test**

Run:

```bash
npm run build
node --test \
  --test-name-pattern='issue #3138 converges' \
  dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: FAIL because `unmatchedStop.outputJson` is still the existing
`session_scope_unmatched` block.

### Task 2: Implement the no-write safe-exit branch

**Files:**
- Modify: `src/scripts/codex-native-hook.ts:10189`
- Modify: `src/scripts/codex-native-hook.ts:10305`
- Modify: `src/scripts/codex-native-hook.ts:10649`
- Test: `src/scripts/__tests__/codex-native-hook.test.ts`

- [ ] **Step 1: Track the narrow safe-exit condition**

Immediately after `stopAuthorizationFailure`, add:

```ts
  let allowUnmatchedStopExit = false;
```

Inside the unmatched Stop branch, after disabling implicit side effects, add:

```ts
      allowUnmatchedStopExit = !existsSync(
        join(stateDir, "sessions", stopPayloadSessionId),
      );
```

Do not set `allowImplicitSessionSideEffects` back to `true`.

- [ ] **Step 2: Return no Stop output only for the safe-exit condition**

Change the final Stop dispatch branch to:

```ts
  } else if (hookEventName === "Stop") {
    if (allowImplicitSessionSideEffects) {
      outputJson = await buildStopHookOutput(payload, cwd, stateDir, {
        canonicalSessionId: canonicalSessionId || undefined,
        skipRalphStopBlock: isSubagentStop,
        skipAutoNudge: isSubagentStop,
      }) ?? await buildCompletedGoalCleanupStopOutput(payload, cwd);
    } else if (allowUnmatchedStopExit) {
      outputJson = null;
    } else {
      const failure = stopAuthorizationFailure ?? {
        stopReason: "session_pointer_unusable",
        reason: "OMX cannot authorize Stop without a writable session authority.",
      };
      outputJson = {
        decision: "block",
        stopReason: failure.stopReason,
        reason: failure.reason,
        systemMessage: failure.reason,
      };
    }
  }
```

- [ ] **Step 3: Verify the issue #3138 test is green**

Run the Task 1 command again.

Expected: PASS.

- [ ] **Step 4: Verify existing scoped Team and Ralph mismatch tests remain green**

Run:

```bash
node --test \
  --test-name-pattern='fails closed on Stop when a session-scoped (team|Ralph) id is not bound' \
  dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: both tests PASS because each fixture creates the unmatched session's
scoped state directory.

- [ ] **Step 5: Run the complete native-hook test file**

Run:

```bash
node dist/scripts/run-test-files.js dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: 555 tests PASS, 0 failures.

- [ ] **Step 6: Commit the portable OMX repair**

```bash
git add src/scripts/codex-native-hook.ts src/scripts/__tests__/codex-native-hook.test.ts
git commit
```

Use a Lore commit whose intent is that rejected roots must exit without owner
mutation. Record the focused tests and the full native-hook test file.

### Task 3: Add a failing host-guard self-test

**Files:**
- Create: `/data/agent/profile/bin/test_codex_live_pointer_guard.py`
- Test target: `/home/ergou-aa/.local/bin/codex-live-pointer-guard`

- [ ] **Step 1: Create the unittest harness**

```python
#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

GUARD = Path("/home/ergou-aa/.local/bin/codex-live-pointer-guard")


def process_start_ticks(pid: int) -> int:
    stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    command_end = stat.rfind(")")
    return int(stat[command_end + 2:].split()[19])


class GuardTest(unittest.TestCase):
    def run_guard(self, root: Path, *, override: bool = False) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        if override:
            env["CODEX_ALLOW_SHARED_CHECKOUT"] = "1"
        else:
            env.pop("CODEX_ALLOW_SHARED_CHECKOUT", None)
        return subprocess.run(
            [str(GUARD), "--check", str(root)],
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )

    def write_pointer(self, root: Path, value: object) -> None:
        path = root / ".omx" / "state" / "session.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def test_classifications(self) -> None:
        self.assertTrue(GUARD.exists(), "guard script is missing")
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve()
            self.assertEqual(self.run_guard(root).returncode, 0)

            self.write_pointer(root, {"broken": True})
            self.assertEqual(self.run_guard(root).returncode, 78)

            live = {
                "session_id": "live-owner",
                "cwd": str(root),
                "pid": os.getpid(),
                "pid_start_ticks": process_start_ticks(os.getpid()),
            }
            self.write_pointer(root, live)
            blocked = self.run_guard(root)
            self.assertEqual(blocked.returncode, 75)
            self.assertIn("live-owner", blocked.stderr)
            self.assertEqual(self.run_guard(root, override=True).returncode, 0)

            nested = root / "nested"
            nested.mkdir()
            subprocess.run(
                ["git", "-C", str(root), "init", "-q"],
                check=True,
            )
            self.assertEqual(self.run_guard(nested).returncode, 75)

            self.write_pointer(root, {**live, "pid_start_ticks": live["pid_start_ticks"] + 1})
            self.assertEqual(self.run_guard(root).returncode, 0)

            self.write_pointer(root, {**live, "cwd": str(root / "other")})
            self.assertEqual(self.run_guard(root).returncode, 78)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
python3 /data/agent/profile/bin/test_codex_live_pointer_guard.py
```

Expected: FAIL with `guard script is missing`.

### Task 4: Implement the host live-pointer guard

**Files:**
- Create: `/home/ergou-aa/.local/bin/codex-live-pointer-guard`
- Test: `/data/agent/profile/bin/test_codex_live_pointer_guard.py`

- [ ] **Step 1: Implement the smallest standard-library checker**

```python
#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path

ALLOW = 0
USAGE = 64
LIVE_OWNER = 75
UNUSABLE_POINTER = 78


def process_start_ticks(pid: int) -> int | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError:
        return None
    command_end = stat.rfind(")")
    if command_end < 0:
        return None
    fields = stat[command_end + 2:].split()
    try:
        return int(fields[19])
    except (IndexError, ValueError):
        return None


def resolve_root(candidate: Path) -> Path:
    candidate = candidate.resolve()
    result = subprocess.run(
        ["git", "-C", str(candidate), "rev-parse", "--show-toplevel"],
        text=True,
        capture_output=True,
        check=False,
    )
    return Path(result.stdout.strip()).resolve() if result.returncode == 0 else candidate


def classify(root: Path) -> tuple[str, dict[str, object] | None]:
    pointer = root / ".omx" / "state" / "session.json"
    if not pointer.exists():
        return "absent", None
    try:
        state = json.loads(pointer.read_text(encoding="utf-8"))
        pid = int(state["pid"])
        expected_ticks = state.get("pid_start_ticks")
        if expected_ticks is not None:
            expected_ticks = int(expected_ticks)
        pointer_cwd = Path(str(state["cwd"])).resolve()
        session_id = str(state["session_id"]).strip()
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return "unusable", None
    if pid <= 0 or not session_id or pointer_cwd != root.resolve():
        return "unusable", state
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return "stale", state
    except PermissionError:
        return "unusable", state
    if expected_ticks is not None:
        live_ticks = process_start_ticks(pid)
        if live_ticks is None:
            return "unusable", state
        if live_ticks != expected_ticks:
            return "stale", state
    return "live", state


def main() -> int:
    if os.environ.get("CODEX_ALLOW_SHARED_CHECKOUT") == "1":
        return ALLOW
    if len(sys.argv) != 3 or sys.argv[1] != "--check":
        print("usage: codex-live-pointer-guard --check <path>", file=sys.stderr)
        return USAGE
    root = resolve_root(Path(sys.argv[2]))
    status, state = classify(root)
    if status in {"absent", "stale"}:
        return ALLOW
    if status == "live":
        print(
            f"Codex launch blocked: checkout already owned by session {state['session_id']} "
            f"(pid {state['pid']}). Use that session or a task worktree. "
            "Set CODEX_ALLOW_SHARED_CHECKOUT=1 only for explicit recovery.",
            file=sys.stderr,
        )
        return LIVE_OWNER
    print(
        "Codex launch blocked: .omx/state/session.json is unusable; repair pointer "
        "evidence or use a task worktree. Set CODEX_ALLOW_SHARED_CHECKOUT=1 only "
        "for explicit recovery.",
        file=sys.stderr,
    )
    return UNUSABLE_POINTER


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Verify GREEN**

Run:

```bash
python3 /data/agent/profile/bin/test_codex_live_pointer_guard.py
```

Expected: 1 test PASS.

- [ ] **Step 3: Check Python syntax**

Run:

```bash
python3 -m py_compile \
  /home/ergou-aa/.local/bin/codex-live-pointer-guard \
  /data/agent/profile/bin/test_codex_live_pointer_guard.py
```

Expected: exit 0.

### Task 5: Wire the guard into Cursor's Codex launcher

**Files:**
- Modify: `/home/ergou-aa/.bashrc:369`

- [ ] **Step 1: Call the guard before creating the tmux root**

Change the branch to:

```bash
    if [ "$use_cursor_mux" = 1 ]; then
        /home/ergou-aa/.local/bin/codex-live-pointer-guard --check "$PWD" || return $?
        __cursor_tui_tmux_run codex codex "$@"
    else
        command codex "$@"
    fi
```

- [ ] **Step 2: Verify shell syntax and installed function text**

Run:

```bash
bash -n /home/ergou-aa/.bashrc
bash --noprofile --norc -ic \
  'source /home/ergou-aa/.bashrc; declare -f codex' \
  | rg 'codex-live-pointer-guard|__cursor_tui_tmux_run'
```

Expected: syntax exit 0 and both guard and tmux calls are present.

- [ ] **Step 3: Verify the current shared checkout is blocked read-only**

Run:

```bash
/home/ergou-aa/.local/bin/codex-live-pointer-guard --check \
  /data/sync/projects/visible-agent-orchestrator
```

Expected: exit 75 and the live owner session ID is printed. The pointer file is
unchanged.

### Task 6: Full verification, install, and isolated black-box acceptance

**Files:**
- Verify: `src/scripts/codex-native-hook.ts`
- Verify: `src/scripts/__tests__/codex-native-hook.test.ts`
- Install target: `/home/ergou-aa/.local/lib/node_modules/oh-my-codex`

- [ ] **Step 1: Run repository verification**

Run:

```bash
npm test
git diff --check
git status --short --branch
```

Expected: all tests and generated checks PASS; only intended committed history
is ahead of `origin/main`.

- [ ] **Step 2: Pack the exact tested worktree**

Run:

```bash
rm -rf /tmp/omx-unmatched-stop-install
mkdir -p /tmp/omx-unmatched-stop-install
npm pack --pack-destination /tmp/omx-unmatched-stop-install
```

Expected: one `oh-my-codex-0.20.2.tgz`.

- [ ] **Step 3: Install through the user-level prefix used by hooks**

Run:

```bash
npm install -g --prefix /home/ergou-aa/.local \
  /tmp/omx-unmatched-stop-install/oh-my-codex-0.20.2.tgz
```

Expected: exit 0. Do not run `omx setup`; the existing hooks already point to
this stable install path.

- [ ] **Step 4: Verify installed source contains the safe-exit branch**

Run:

```bash
rg -n 'allowUnmatchedStopExit' \
  /home/ergou-aa/.local/lib/node_modules/oh-my-codex/src/scripts/codex-native-hook.ts \
  /home/ergou-aa/.local/lib/node_modules/oh-my-codex/dist/scripts/codex-native-hook.js
```

Expected: both source and dist match.

- [ ] **Step 5: Run isolated black-box Stop acceptance**

Use a temporary repository and a Python harness to:

1. write a usable live owner pointer using the harness PID and start ticks;
2. invoke the installed `codex-native-hook.js` with an unmatched Stop payload;
3. assert the returned JSON has no `decision: "block"`;
4. assert the owner pointer SHA-256 is byte-identical;
5. create `sessions/<unmatched-id>/`;
6. invoke Stop again and assert `stopReason == "session_scope_unmatched"`.

The harness must run under `/tmp` and must not read or write the live shared
checkout pointer.

- [ ] **Step 6: Verify live state was not mutated**

Compare the live pointer's SHA-256, owner session ID, PID, and start ticks with
the snapshot taken before installation.

Expected: all values unchanged and owner PID still live.

- [ ] **Step 7: Commit the plan and any remaining repository-only changes**

Use Lore commits. Do not commit host-local `.bashrc` or profile files into the
upstream OMX repository.
