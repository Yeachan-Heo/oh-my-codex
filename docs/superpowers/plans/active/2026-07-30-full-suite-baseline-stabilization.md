# Full-Suite Baseline Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development when tasks are independent; otherwise execute in the current approved lane task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 최신 `origin/main`의 지정된 13개 Node 20 테스트를 재현·분류하고, 결정적 baseline 결함으로 입증된 항목만 TDD로 최소 수정한다.

**Architecture:** repo의 기존 TypeScript 빌드와 `run-test-files` runner를 그대로 사용한다. 먼저 per-file process isolation과 env scrub이 적용된 targeted run으로 환경-only, deterministic baseline defect, suite-interaction/flaky를 분리한다. production code는 결정적 결함이 두 번 이상 동일하게 재현되고 shared root cause가 확인된 뒤에만 이 계획에 exact RED/GREEN task를 추가해 수정한다.

**Tech Stack:** Node.js 20, npm, TypeScript, Node test runner, repo-local `dist/scripts/run-test-files.js`

---

## 범위와 중단 조건

- Base/HEAD: `origin/main@57f8e682af899b5d0e28d05b238c903c2fdeb913`
- Lane: `imyuntae/full-suite-baseline-stabilization`
- 수정 금지: graph execution provenance branch/code, ignored local `AGENTS.md`, global model environment, global OMX installation, user custom settings.
- 설치 금지: tmux, global packages, 새 dependency.
- production code 중단 조건: 동일 test file의 isolated repeat가 안정적으로 실패하지 않거나, host prerequisite/ambient fixture로 설명되거나, shared root cause가 확인되지 않으면 수정하지 않는다.
- 전체 작업 중단 조건: 환경-only blocker와 남은 failure는 lane handoff에 기록하고 정직하게 보고한다.

## 대상 테스트

- `src/cli/__tests__/team.test.ts`
- `src/notifications/__tests__/tmux.test.ts`
- `src/team/__tests__/tmux-test-fixture.test.ts`
- `src/hooks/__tests__/deep-interview-contract.test.ts`
- `src/hooks/__tests__/team-runtime-gating-docs-contract.test.ts`
- `src/team/__tests__/worker-runtime-identity.test.ts`
- `src/utils/__tests__/agents-model-table.test.ts`
- `src/hooks/__tests__/analyze-routing-contract.test.ts`
- `src/scripts/__tests__/codex-native-hook.test.ts`
- `src/scripts/__tests__/smoke-packed-install.test.ts`
- `src/team/__tests__/api-interop.test.ts`
- `src/cli/__tests__/setup-gh-star.test.ts`
- `src/team/__tests__/runtime.test.ts`

### Task 1: Clean Node 20 baseline 재현

**Files:**

- Read: 위 13개 `src/**/*.test.ts`
- Run: 대응하는 `dist/**/*.test.js`
- Modify: 없음

- [x] **Step 1: lane identity와 runtime을 재확인한다**

Run:

```bash
pwd
git branch --show-current
git status -sb --untracked-files=all
git rev-list --left-right --count origin/main...HEAD
node --version
npm --version
/Users/yuntae/.codex/skills/s-01-open/scripts/worktree-guard.sh check
```

Expected: 지정 worktree/branch, clean status, `0 0`, Node `v20.x`, guard `ok`.

- [x] **Step 2: clean source에서 dist를 다시 빌드한다**

Run:

```bash
npm run build
```

Expected: TypeScript build PASS, tracked file 변화 없음.

- [x] **Step 3: host prerequisite와 금지 대상의 현재 상태를 읽기만 한다**

Run:

```bash
command -v tmux || true
git check-ignore -v AGENTS.md || true
git status --ignored -s AGENTS.md
```

Expected: `tmux` 부재는 environment evidence로만 기록한다. ignored `AGENTS.md`는 존재 여부와 관계없이 수정하지 않는다.

- [x] **Step 4: repo runner로 13개를 한 번에 serial/per-file isolation으로 실행한다**

Run:

```bash
node dist/scripts/run-test-files.js \
  dist/cli/__tests__/team.test.js \
  dist/notifications/__tests__/tmux.test.js \
  dist/team/__tests__/tmux-test-fixture.test.js \
  dist/hooks/__tests__/deep-interview-contract.test.js \
  dist/hooks/__tests__/team-runtime-gating-docs-contract.test.js \
  dist/team/__tests__/worker-runtime-identity.test.js \
  dist/utils/__tests__/agents-model-table.test.js \
  dist/hooks/__tests__/analyze-routing-contract.test.js \
  dist/scripts/__tests__/codex-native-hook.test.js \
  dist/scripts/__tests__/smoke-packed-install.test.js \
  dist/team/__tests__/api-interop.test.js \
  dist/cli/__tests__/setup-gh-star.test.js \
  dist/team/__tests__/runtime.test.js
```

Expected: runner가 13 files, test concurrency 1, per-file process isolation을 보고한다. PASS/FAIL file 목록과 첫 root-cause assertion을 보존한다.

### Task 2: 결정성·환경·suite interaction 분류

**Files:**

- Read: Task 1에서 실패한 test와 direct implementation/helper
- Modify: 없음

- [x] **Step 1: tmux와 model-contract failure의 input boundary를 확인한다**

Run:

```bash
command -v tmux || true
rg -n "tmux is not available|withTempTmuxSession" \
  src/cli/__tests__/team.test.ts \
  src/team/__tests__/tmux-test-fixture.test.ts \
  src/team/__tests__/tmux-test-fixture.ts
node dist/scripts/run-test-files.js dist/team/__tests__/worker-runtime-identity.test.js
node dist/scripts/run-test-files.js dist/utils/__tests__/agents-model-table.test.js
```

Expected: missing `tmux`는 environment-only로 고정한다. model failure가 repo runner의 env scrub 뒤에도 실제 global/ignored configuration을 읽어서 발생하면 environment-only로 분류하고 global files를 수정하지 않는다.

- [x] **Step 2: timeout·ambient 후보를 한 번씩 isolated 반복한다**

Run:

```bash
node dist/scripts/run-test-files.js dist/scripts/__tests__/smoke-packed-install.test.js
node dist/scripts/run-test-files.js dist/cli/__tests__/setup-gh-star.test.js
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  node --test \
  --test-name-pattern="startTeam launches executor workers with authoritative config policy, positional backslashes, and no bypass" \
  dist/team/__tests__/runtime.test.js
```

Expected: Task 1의 assertion이 반복되지 않거나 PASS/timeout이 섞이면 suite-interaction/flaky 또는 environment-only로 분류한다.

- [x] **Step 3: repo-owned deterministic 후보를 같은 assertion으로 반복한다**

Run:

```bash
node dist/scripts/run-test-files.js dist/team/__tests__/api-interop.test.js
node dist/scripts/run-test-files.js dist/team/__tests__/api-interop.test.js
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  node --test \
  --test-name-pattern="allows canonical leader deep-interview artifact and state writes while blocking implementation Bash writes" \
  dist/scripts/__tests__/codex-native-hook.test.js
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  node --test \
  --test-name-pattern="allows canonical leader deep-interview artifact and state writes while blocking implementation Bash writes" \
  dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: 동일 assertion이 세 번 일치하고 direct callers가 repo-owned shared root를 가리킬 때만 deterministic baseline defect로 분류한다.

- [x] **Step 4: 각 test를 세 범주 중 하나로 기록한다**

분류 규칙:

- `environment-only`: repo code 변경 없이 missing host prerequisite, ambient user/global state, platform 차이로 설명된다.
- `deterministic baseline defect`: clean `origin/main`, isolated runner, 동일 Node 20에서 동일 root-cause failure가 반복되며 repo-owned shared behavior가 기대를 위반한다.
- `suite-interaction/flaky`: isolated repeat는 통과하지만 grouped/full-suite 또는 timing 조건에서만 실패한다.

### Task 3: Deterministic defect TDD gate

**Files:**

- Modify: 아직 없음

- [x] **Step 1: deterministic defect 유무에 따라 production edit branch를 선택한다**

Result: 두 deterministic baseline defect가 확인되어 exact TDD task를 아래에 추가한다. 나머지 failure는 수정하지 않는다.

- [x] **Step 2: deterministic defect가 있으면 production edit 전에 이 계획을 exact task로 갱신한다**

각 defect마다 다음을 모두 확정한 뒤에만 executor를 dispatch한다:

- exact failing test path와 추가할 최소 regression assertion,
- expected RED message,
- 모든 caller가 경유하는 exact shared implementation path,
- minimal GREEN change,
- targeted GREEN command,
- spec review, quality review, Lore commit checkpoint.

Expected: placeholder 없이 exact file/code/command가 추가되기 전에는 production code를 수정하지 않는다.

### Task 3A: Canonical deep-interview state write 허용

**Files:**

- Modify: `src/scripts/codex-native-hook.ts:9039`, `src/scripts/codex-native-hook.ts:9062`, `src/scripts/codex-native-hook.ts:10007`
- Test: `src/scripts/__tests__/codex-native-hook.test.ts:14310`
- Test guard: existing RED assertions must not be changed, removed, skipped, or weakened. Add only the exact lookalike CLI negative assertion below.

- [ ] **Step 1: existing regression assertion이 RED인지 다시 확인한다**

Run:

```bash
npm run build
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  node --test \
  --test-name-pattern="allows canonical leader deep-interview artifact and state writes while blocking implementation Bash writes" \
  dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: safe CLI wrapper state write loop의 `should defer to backend validation` assertion이 expected `null`, actual `decision: block`으로 FAIL.

- [ ] **Step 2: basename fallback을 막는 lookalike assertion을 먼저 고정한다**

Immediately before the existing `safeCliWrapperStateWriteCommands` loop, add:

```ts
const blockedLookalikeNodeCliStateWrite = await preToolUse(
  {
    hook_event_name: "PreToolUse",
    cwd,
    session_id: "sess-di-artifact",
    tool_name: "Bash",
    tool_use_id: "tool-di-state-cli-lookalike-node-wrapper",
    tool_input: {
      command: `node ./attacker/omx.js state write --input ${safeStateWriteInput} --json`,
    },
  },
  { cwd },
);
assert.equal(
  (blockedLookalikeNodeCliStateWrite.outputJson as { decision?: string } | null)?.decision,
  "block",
);
```

Expected: 기존 source에서는 lookalike assertion은 PASS하고, 바로 뒤의 기존 safe wrapper assertion은 계속 RED다.

- [ ] **Step 3: shared helper의 기본 증명은 보존하고 deep-interview exact workspace wrapper만 opt-in한다**

Extend the existing helper signature:

```ts
function isStandaloneParsedOmxStateWriteTransport(
  cwd: string,
  command: string,
  authoritativeSessionId: string,
  options: { allowDeepInterviewWorkspaceNodeCliWrapper?: boolean } = {},
): boolean {
```

Replace only the helper's final raw-mutation return:

```ts
const mutations = extractConductorBashMutations(command, cwd);
if (
  options.allowDeepInterviewWorkspaceNodeCliWrapper === true
) {
  const words = tokenizeShellWords(command);
  const wrapperContext = resolveWrappedCommandExecutionContext(words, cwd);
  if (wrapperContext !== null) {
    const wrapperRuntime = shellWordLiteral(words[wrapperContext.index] ?? "");
    if (isOmxCliWrapperRuntime(wrapperRuntime)) {
      return wrapperRuntime === "node"
        && isSingleLiteralShellInvocation(command)
        && sameFilePath(
          resolve(wrapperContext.cwd, shellWordLiteral(words[wrapperContext.index + 1] ?? "")),
          resolve(cwd, "dist/cli/omx.js"),
        );
    }
  }
}
return mutations.length === 1 && mutations[0]?.mainRootStructuredStateWrite === true;
```

Inside the existing deep-interview `if (stateWriteOperations.length > 0)` block, after mode/session/workingDirectory validation:

```ts
if (isStandaloneParsedOmxStateWriteTransport(cwd, command, sessionId, {
  allowDeepInterviewWorkspaceNodeCliWrapper: true,
})) return true;
```

Expected: Ralplan과 Conductor의 3-argument callers는 기존 raw Main-root mutation proof를 그대로 요구한다. deep-interview opt-in의 Node/Bun/tsx wrapper는 raw proof보다 먼저 판정하고, single literal `node` invocation에서 wrapper effective cwd의 CLI entry가 정확히 workspace `dist/cli/omx.js`와 같을 때만 허용한다. direct trusted `omx state write`는 기존 raw proof를 유지한다. basename allow, blanket allow, 새 helper, 새 dependency는 추가하지 않는다.

- [ ] **Step 4: targeted GREEN과 인접 contract를 확인한다**

Run:

```bash
npm run build
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  node --test \
  --test-name-pattern="allows canonical leader deep-interview artifact and state writes while blocking implementation Bash writes" \
  dist/scripts/__tests__/codex-native-hook.test.js
node dist/scripts/run-test-files.js dist/hooks/__tests__/deep-interview-contract.test.js
git diff --check
```

Expected: targeted hook subtest PASS, deep-interview contract 27/27 PASS, diff check PASS.

- [ ] **Step 5: verified slice를 Lore commit한다**

Stage only `src/scripts/codex-native-hook.ts` and `src/scripts/__tests__/codex-native-hook.test.ts`.

```text
Allow safe deep-interview state writes to reach backend validation

Constraint: Preserve protected-state validation and allow only the exact workspace Node CLI wrapper after existing transport checks
Rejected: Basename-based omx.js fallback | would authorize attacker-controlled lookalike paths
Confidence: high
Scope-risk: narrow
Directive: Keep the deep-interview wrapper opt-in exact-path scoped; Ralplan and Conductor must retain the default raw mutation proof
Tested: targeted codex-native-hook deep-interview subtest including lookalike rejection; deep-interview contract suite; git diff --check
Not-tested: full suite deferred to the final verification ladder
```

### Task 3B: Leader mailbox duplicate send idempotency

**Files:**

- Modify: `src/team/runtime.ts:6801`
- Test: `src/team/__tests__/api-interop.test.ts:421`
- Verify unchanged behavior: `src/team/__tests__/mcp-comm.test.ts:297`
- Test guard: existing RED assertions must not be changed, removed, skipped, or weakened; production-only fix.

- [ ] **Step 1: existing API regression assertion이 RED인지 다시 확인한다**

Run:

```bash
npm run build
node dist/scripts/run-test-files.js dist/team/__tests__/api-interop.test.js
```

Expected: duplicate leader `send-message` call에서 `second.ok` expected `true`, actual `false`; 128/129 pass.

- [ ] **Step 2: leader route에서만 pending-dispatch duplicate를 idempotent success로 반환한다**

Immediately after `queueDirectMailboxMessage(...)` in `sendLeaderMailboxMessage`:

```ts
if (queuedOutcome.reason === 'duplicate_pending_dispatch_request') {
  return {
    ...queuedOutcome,
    ok: true,
    transport: 'mailbox',
    reason: 'existing_message_pending_dispatch',
  };
}
```

Expected: persisted mailbox message의 duplicate API call만 성공으로 정규화한다. `queueDirectMailboxMessage`와 broadcast coalescing semantics는 수정하지 않는다.

- [ ] **Step 3: targeted GREEN과 generic queue contract를 확인한다**

Run:

```bash
npm run build
node dist/scripts/run-test-files.js \
  dist/team/__tests__/api-interop.test.js \
  dist/team/__tests__/mcp-comm.test.js
git diff --check
```

Expected: API interop 129/129 PASS, generic mailbox coalescing PASS, diff check PASS.

- [ ] **Step 4: verified slice를 Lore commit한다**

Stage only `src/team/runtime.ts`.

```text
Preserve idempotent leader mailbox sends across pending dispatch dedupe

Constraint: Keep generic queue and broadcast duplicate semantics unchanged
Rejected: Make queueDirectMailboxMessage return success for every duplicate | would broaden behavior outside the leader API route
Confidence: high
Scope-risk: narrow
Directive: Normalize persisted leader-message duplicates at the leader runtime boundary
Tested: API interop suite; MCP communication suite; git diff --check
Not-tested: full suite deferred to the final verification ladder
```

### Task 4: 검증·handoff·local checkpoint

**Files:**

- Modify: `docs/in-flight/full-suite-baseline-stabilization.md`
- Modify: 이 계획의 checkbox와, Task 3이 요구한 경우 exact TDD task

- [ ] **Step 1: 가장 작은 관련 검증을 실행한다**

Run: 입증된 defect의 targeted test 또는, defect가 없으면 13-file command.

Expected: 수정 범위의 주장과 일치하는 fresh evidence.

- [ ] **Step 2: code가 바뀐 경우에만 repo verification ladder를 확장한다**

Run as justified:

```bash
npm run build
npm run lint
npm run check:no-unused
npm test
/Users/yuntae/.codex/skills/s-01-open/scripts/test-worktree-guard.sh
git diff --check
```

Expected: 실행한 check의 pass/fail을 그대로 기록한다. 환경-only failure는 green으로 표현하지 않는다.

- [ ] **Step 3: handoff를 갱신하고 coherent verified slice만 Lore commit한다**

Stage exact intended files only. Commit message must contain the Lore decision trailers required by `/Users/yuntae/AGENTS.md`.

Expected: push/PR/merge/deploy/release/OMX update 없이 local branch에만 checkpoint가 남는다.
