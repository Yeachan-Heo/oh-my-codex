# Heavy / Manual Stress Lane: `omx-explore` and `omx-sparkshell`

Date: **2026-03-11**
Scope: opt-in/manual stress scenarios that complement the deterministic CI lane in:
- `npm run test:explore`
- `npm run test:sparkshell`

This document covers the heavy/manual scenarios intentionally excluded from default CI because they depend on noisy operator environments, repeated invocation, or judgment-based evidence review.

## Preconditions

From the repository root:

```bash
npm run build
npm run build:explore
npm run build:sparkshell
```

Use a clean throwaway workspace when possible. If you need tmux-pane coverage, run inside tmux and confirm the target pane id first.

## Verified command baseline

The following command forms were verified during this doc pass:

| Command | Result |
|---|---|
| `node bin/omx.js explore --help` | PASS |
| `node bin/omx.js sparkshell --help` | PASS |
| `node bin/omx.js sparkshell git --version` | PASS |
| `node bin/omx.js version` | PASS |
| `for i in $(seq 1 20); do node bin/omx.js sparkshell git --version; done` | PASS (bounded sample verified locally) |
| `seq 1 5 | xargs -I{} -P5 node bin/omx.js sparkshell git --version` | PASS (bounded sample verified locally) |

Environment limitation during this doc pass:
- `tmux -V` worked, but detached tmux socket access failed with `error connecting to /tmp/tmux-1000/default (Operation not permitted)`, so the `--tmux-pane` examples below are **documented but not end-to-end verified in this session**.

## Evidence capture template

For every heavy/manual scenario record:
- scenario id
- command(s) run
- captured stdout/stderr or screenshot/snippet
- observed summary/guidance/fallback behavior
- pass/fail result
- residual notes

## Exit criteria for the heavy/manual lane

A manual scenario passes only when all of the following are true:
1. the required setup was followed,
2. the expected evidence was captured,
3. the failure signal did **not** appear,
4. the deterministic lane still passes afterward.

Final deterministic recheck (required for the later Ralph verification sweep; not re-run in this doc-only pass):

```bash
npm run test:explore
npm run test:sparkshell
```

## Scenario 1: large noisy tmux-pane captures

**Why excluded from default CI**
- Depends on a live tmux server and realistic pane noise.
- Evidence quality is partly operator-judged: the summary must preserve the facts that matter, not exact wording.

**Goal**
- Confirm `omx-sparkshell --tmux-pane` preserves operator-critical facts when pane tails are large and noisy.
- Confirm the summary/fallback path still points the operator to the right next action.

**Setup**
1. Start a tmux session with a pane that emits mixed signal + distractor output.
2. Predeclare the must-preserve facts before running the scenario.
3. Capture the pane id.

Suggested must-preserve facts:
- the failing command name,
- the final non-zero exit or failure state,
- the actionable recovery or inspection hint,
- any file/path identifier needed for next action.

**Command shape**

```bash
omx sparkshell --tmux-pane <pane-id> --tail-lines 400
```

**Evidence to capture**
- raw pane tail sample,
- summarized output,
- must-preserve fact checklist,
- whether the next-step command in the output is actually sufficient.

**Failure signal**
- any must-preserve fact is missing,
- the output suggests the wrong next command,
- the output hides the actual failure source under noise.

## Scenario 2: repeated / concurrent invocation stress

**Why excluded from default CI**
- Repetition and concurrency are more expensive and can be environment-sensitive.
- Useful signal comes from aggregate stability, not one isolated run.

**Goal**
- Confirm repeated runs do not degrade fallback reliability or guidance quality.
- Confirm concurrent direct-command use does not produce confusing or unusable operator output.

**Setup**
1. Choose a stable direct command and one fallback-oriented command.
2. Run the direct command repeatedly.
3. Run a bounded burst of concurrent invocations.

Verified direct-command example:

```bash
node bin/omx.js sparkshell git --version
```

Suggested repeated-run shape:

```bash
for i in $(seq 1 20); do node bin/omx.js sparkshell git --version; done
```

Suggested concurrent-run shape:

```bash
seq 1 5 | xargs -I{} -P5 node bin/omx.js sparkshell git --version
```

**Evidence to capture**
- run count,
- any non-zero exits,
- stderr snapshots,
- whether output format/guidance drifted across runs.

**Failure signal**
- intermittent launch failures,
- inconsistent or truncated guidance text,
- different recovery messaging for the same failure mode without reason.

## Scenario 3: pseudo-fuzz summary corpora

**Why excluded from default CI**
- Corpus design is intentionally adversarial and may evolve faster than stable fixtures.
- Review requires semantic inspection against predeclared must-preserve facts.

**Goal**
- Stress `omx-explore` and `omx-sparkshell` summarization with outputs that bury signal under distractors.

**Setup**
1. Build 3-10 text fixtures with:
   - one clear critical failure/success fact,
   - many distractor lines,
   - at least one actionable next-step hint,
   - optional conflicting near-miss distractors.
2. For each fixture, write the must-preserve facts before running the tool.

Suggested corpus dimensions:
- duplicated near-match file paths,
- multiple warnings with one real blocker,
- success text followed by later failure text,
- long tails where the important line appears early, middle, and late.

**Evidence to capture**
- fixture id,
- must-preserve fact list,
- observed summarized output,
- missing/preserved fact checklist.

**Failure signal**
- summary keeps decorative noise but drops the real blocker,
- summary collapses distinct paths/errors into one misleading statement,
- summary omits the only actionable next step.

## Scenario 4: operator walkthrough validation

**Why excluded from default CI**
- Validates whether the tool output is actually usable by a human operator.
- Requires judgment beyond strict string matching.

**Goal**
- Confirm the recovery/inspection command shown by the tool is sufficient when followed literally.

**Setup**
1. Pick one direct-command scenario and one tmux-pane scenario.
2. Record the exact next-step command suggested by the tool.
3. Follow that command without editing it first.

Useful direct-command baseline:

```bash
node bin/omx.js sparkshell --help
node bin/omx.js explore --help
```

**Evidence to capture**
- original tool output,
- copied next-step command,
- result of running that command,
- whether additional hidden knowledge was needed.

**Failure signal**
- the suggested command is syntactically wrong,
- the command is directionally wrong for the scenario,
- the operator must guess undocumented extra context to recover.

## Verification glue checklist

Use this checklist after both deterministic and heavy/manual work are present.

### Deterministic lane
- [ ] `npm run test:explore`
- [ ] `npm run test:sparkshell`
- [ ] deterministic tests assert semantic fact preservation with predeclared must-preserve facts
- [ ] deterministic tests assert fallback path selection or actionable failure output
- [ ] deterministic tests assert sparkshell guidance/help remains actionable

### Heavy/manual lane
- [ ] at least one scenario run for large noisy `--tmux-pane` capture
- [ ] at least one repeated-run stress sample captured
- [ ] at least one pseudo-fuzz corpus reviewed with must-preserve facts
- [ ] at least one operator walkthrough executed from tool output to follow-up command
- [ ] each manual scenario recorded setup, command, evidence, and failure signal

### Final evidence package
- [ ] changed deterministic tests listed
- [ ] this heavy/manual doc updated
- [ ] residual risks called out explicitly
- [ ] any environment-limited scenarios marked as not verified rather than implied

## Residual-risk prompts for the final Ralph sweep

Use these prompts during the final sequential verification pass:
- Did any summary preserve wording but still lose the decisive fact?
- Did any fallback path technically succeed but leave the operator without a usable next action?
- Did any guidance string pass exact matching while still being practically misleading?
- Are tmux-only scenarios clearly separated from direct-command scenarios in the evidence?
