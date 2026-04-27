# Committed Launch Lifecycle Model

- Baseline commit: `22f1656c87e230646ca9a8410e9566fbdd2d50a0`
- Scope: committed `HEAD` only
- Purpose: define the committed Ralph and Team launch lifecycle in formal logic so later context-pack lifecycle checks can be expressed as explicit refinements, not ad hoc behavior changes

## 1. Scope and notation

This document models the **committed** launch behavior only. It does **not** describe the intended uncommitted context-pack behavior.

The baseline is defined by these committed sources:

- `src/planning/artifacts.ts`
- `src/cli/ralph.ts`
- `src/cli/team.ts`
- `src/team/runtime.ts`
- `src/team/runtime-cli.ts`
- `src/modes/base.ts`

Notation:

- `⊥` = no result / null / no transition
- `:=` = definition
- `∨` = logical OR
- `∧` = logical AND
- `¬` = logical NOT
- `→` = transition
- `↔` = logical equivalence
- `|S|` = cardinality of set/sequence `S`
- `last(S)` = last element of ordered sequence `S`
- `Proj_B(...)` = committed-baseline projection function
- `State_X` = semantic state domain

This document separates:

1. **semantic state**: states that can exist in the environment
2. **committed projection**: states the committed code can actually distinguish

That distinction is mandatory. Several lifecycle bugs come from treating a collapsed committed projection as if it preserved all semantic distinctions.

## 2. Shared semantic domains

### 2.1 Core domains

```text
Mode ::= ralph | team

PlanningBaseline ::= missing-prd
                   | missing-test-spec
                   | complete

HintMultiplicity ::= zero
                   | one
                   | many

SessionTeamVisibility ::= active
                        | inactive
                        | malformed
                        | missing

RootTeamVisibility ::= active
                     | inactive
                     | malformed
                     | missing

VisibleTeamState ::= SessionTeamVisibility × RootTeamVisibility

ShortFollowupToken ::= short-team
                     | short-korean-team
                     | other
```

### 2.2 Artifact and hint objects

```text
PRDs(cwd)               ::= ordered sequence of canonical discovered prd-*.md artifacts
TestSpecs(cwd)          ::= ordered sequence of canonical discovered test-spec-*.md artifacts
DeepInterviewSpecs(cwd) ::= ordered sequence of canonical discovered deep-interview-*.md artifacts

LatestPRD(cwd)          ::= last(PRDs(cwd)) when |PRDs(cwd)| > 0 else ⊥

Slug(path)              ::= raw captured filename slug used by committed code

HintSet(p, mode)        ::= ordered sequence of parsed same-mode launch hints in PRD p
Task(h)                 ::= decoded quoted task text of hint h
Command(h)              ::= full matched command string of hint h
```

### 2.3 Semantic invariants that exist before any patch

```text
PlanningComplete_sem(cwd) := (|PRDs(cwd)| > 0) ∧ (∃ p ∈ PRDs(cwd) : matching test spec exists)

HintMultiplicity_sem(p, mode) :=
  zero  iff |HintSet(p, mode)| = 0
  one   iff |HintSet(p, mode)| = 1
  many  iff |HintSet(p, mode)| > 1
```

The committed baseline does **not** preserve all of these distinctions.

## 3. Shared committed planning projection

Source of truth:

- `src/planning/artifacts.ts#readPlanningArtifacts`
- `src/planning/artifacts.ts#selectLatestPlanningArtifacts`
- `src/planning/artifacts.ts#readApprovedExecutionLaunchHint`

### 3.1 Planning completeness

Committed baseline:

```text
PlanningComplete_B(cwd) := (|PRDs(cwd)| > 0) ∧ (|TestSpecs(cwd)| > 0)
```

Important consequence:

- committed baseline does **not** require PRD/test-spec slug correlation to declare planning complete
- it only requires at least one PRD and at least one test spec anywhere in the discovered set

### 3.2 Latest planning selection

Committed baseline:

```text
LatestPlanningSelection_B(cwd) :=
  let p := LatestPRD(cwd) in
  if p = ⊥ then <prd = ⊥, test_specs = [], deep_interview_specs = []>
  else
    <prd = p,
     test_specs = { t ∈ TestSpecs(cwd) | Slug(t) = Slug(p) },
     deep_interview_specs = { d ∈ DeepInterviewSpecs(cwd) | Slug(d) = Slug(p) }>
```

### 3.3 Launch hint projection

For committed baseline, ambiguity is collapsed by the selector:

```text
Proj_B_Hint(p, mode) :=
  if HintSet(p, mode) = [] then ⊥
  else last(HintSet(p, mode))
```

Equivalent collapse rule:

```text
HintMultiplicity_sem(p, mode) = many  →  committed code still returns one hint
```

This is a **lossy projection**:

- semantic state `many` is collapsed to the last hint
- committed code has no explicit `ambiguous` state

### 3.4 Approved execution hint projection

Committed baseline:

```text
ApprovedExecutionHint_B(cwd, mode) :=
  if ¬PlanningComplete_B(cwd) then ⊥
  else
    let p := LatestPRD(cwd) in
    let h := Proj_B_Hint(p, mode) in
    if h = ⊥ then ⊥
    else <mode = mode,
          command = Command(h),
          task = Task(h),
          sourcePath = p,
          testSpecPaths = LatestPlanningSelection_B(cwd).test_specs,
          deepInterviewSpecPaths = LatestPlanningSelection_B(cwd).deep_interview_specs,
          workerCount / agentType / linkedRalph from h when mode = team>
```

There is no committed notion of:

- exact-task lookup
- exact-command lookup
- explicit `prdPath` override
- reusable vs broken handoff state
- `plan-only | ready | incomplete | invalid`

All of those are patch-era refinements, not baseline behavior.

## 4. Shared mode-state baseline

Source of truth:

- `src/modes/base.ts#startMode`
- `src/modes/base.ts#readModeState`
- `src/modes/base.ts#updateModeState`

### 4.1 Visible mode-state reader

Committed baseline:

```text
ReadModeStatePaths_B(mode, cwd) := getReadScopedStatePaths(mode, cwd)

ReadModeState_B(mode, cwd) :=
  for path in ReadModeStatePaths_B(mode, cwd):
    if path does not exist: continue
    if path exists and JSON parse succeeds: return parsed state
    if path exists and JSON parse fails: return ⊥
  return ⊥
```

Critical committed property:

```text
Malformed higher-precedence scoped state masks lower-precedence fallback
```

because the reader returns `⊥` immediately on the first existing malformed file instead of continuing.

### 4.2 Mode start and update

Committed baseline:

```text
StartMode_B(mode, task, cwd) :=
  create scoped state file with
    active = true
    mode = mode
    iteration = 0
    max_iterations = supplied/default
    current_phase = "starting"
    task_description = task
    started_at = now

UpdateModeState_B(mode, updates, cwd) :=
  let current := ReadModeState_B(mode, cwd)
  if current = ⊥ then error
  else write merged state to the resolved active scope path
```

## 5. Ralph committed launch lifecycle

Source of truth:

- `src/cli/ralph.ts#ralphCommand`

### 5.1 Ralph state domains

```text
RalphInputState ::= help
                  | invalid-prd-gate
                  | runnable

RalphLaunchState ::= idle
                   | artifacts-ready
                   | mode-started
                   | session-files-written
                   | mode-updated(starting)
                   | hud-launched
```

### 5.2 Ralph preconditions

Committed PRD gate:

```text
RalphPrdMode_B(args) := args contains "--prd" or "--prd=<value>"

RalphPrdGate_B(cwd, args) :=
  if ¬RalphPrdMode_B(args) then pass
  else Exists(cwd/.omx/prd.json) ∧ ValidCommittedRalphPrdJson(cwd/.omx/prd.json)
```

Approved hint projection used by Ralph:

```text
ApprovedRalphHint_B(cwd) := ApprovedExecutionHint_B(cwd, ralph)
```

Task derivation:

```text
ExplicitRalphTask_B(args) := extractRalphTaskDescription(args, fallback = "ralph-cli-launch")

RalphTask_B(cwd, args) :=
  let e := ExplicitRalphTask_B(args) in
  if (e = "ralph-cli-launch") ∧ (ApprovedRalphHint_B(cwd) ≠ ⊥)
    then Task(ApprovedRalphHint_B(cwd))
    else e
```

### 5.3 Ralph transition system

Committed transition:

```text
LaunchRalph_B(cwd, args):
  idle
  → artifacts-ready
      iff RalphPrdGate_B(cwd, args) passes
      and canonical Ralph artifacts are ensured
  → mode-started
      via StartMode_B("ralph", RalphTask_B(cwd, args), cwd)
  → session-files-written
      via writeRalphSessionFiles(cwd, RalphTask_B(cwd,args), ...)
  → mode-updated(starting)
      via UpdateModeState_B("ralph", approved-hint metadata + staffing metadata, cwd)
  → hud-launched
      via launchWithHud(filtered args, possibly with approved task appended)
```

### 5.4 Ralph committed invariants

```text
ApprovedRalphHint_B uses latest PRD only
Ralph has no committed persisted approved binding
Ralph has no committed exact-task PRD selector
StartMode_B always precedes HUD launch
```

## 6. Team committed launch lifecycle

Committed Team behavior has three distinct launch surfaces:

1. short follow-up reuse
2. main CLI launch
3. resume
4. runtime-cli launch

These must be modeled separately.

### 6.1 Short follow-up reuse

Source of truth:

- `src/cli/team.ts#readPersistedTeamFollowupState`
- `src/cli/team.ts#resolveApprovedTeamFollowupContext`

#### 6.1.1 Root-only persisted follow-up state

Committed baseline:

```text
PersistedTeamFollowupState_B(cwd) :=
  parse(cwd/.omx/state/team-state.json) if readable else ⊥
```

No session-aware lookup is used here in committed baseline.

#### 6.1.2 Short-followup token classifier

```text
ShortFollowup_B(t) :=
  short-team        iff trim(t) = "team"
  short-korean-team iff trim(t) ∈ {"team으로 해줘", "team으로 해주세요"}
  other             otherwise
```

#### 6.1.3 Team short-followup resolution

Committed baseline:

```text
ApprovedTeamHint_B(cwd) := ApprovedExecutionHint_B(cwd, team)

ResolveShortTeamFollowup_B(cwd, t) :=
  if ShortFollowup_B(t) = other then ⊥
  else if ApprovedTeamHint_B(cwd) = ⊥ then ⊥
  else
    let s := PersistedTeamFollowupState_B(cwd) in
    if s.task_description = Task(ApprovedTeamHint_B(cwd))
       ∧ s.agent_count is present
      then <task = s.task_description,
            worker_count = s.agent_count,
            explicit_worker_count = true,
            agent_type = ApprovedTeamHint_B(cwd).agentType>
      else <task = Task(ApprovedTeamHint_B(cwd)),
            worker_count = ApprovedTeamHint_B(cwd).workerCount defaulting to 3,
            explicit_worker_count = (ApprovedTeamHint_B(cwd).workerCount is present),
            agent_type = ApprovedTeamHint_B(cwd).agentType>
```

Committed short-followup invariants:

```text
ApprovedTeamHint_B uses latest PRD only
No committed binding identity exists
Follow-up persistence reads root .omx/state/team-state.json only
Matching is by task text only
```

### 6.2 Main Team CLI launch

Source of truth:

- `src/cli/team.ts#parseTeamArgs`
- `src/cli/team.ts#teamCommand`
- `src/cli/team.ts#ensureTeamModeState`

#### 6.2.1 Team CLI state domains

```text
TeamCommand_B ::= api | status | await | resume | shutdown | launch

TeamLaunchState ::= parsed
                  | execution-planned
                  | runtime-started
                  | mode-state-synced
                  | summary-rendered
```

#### 6.2.2 Team parse projection

Committed parser:

```text
ParseTeamArgs_B(args, cwd) :=
  either ResolveShortTeamFollowup_B(cwd, raw task text)
  or normal worker-count / role / task parsing
```

#### 6.2.3 Team launch transition

Committed transition:

```text
LaunchTeamCLI_B(args, cwd):
  let parsed := ParseTeamArgs_B(args, cwd)
  let plan := buildTeamExecutionPlan(parsed.task, parsed.workerCount, ...)
  parsed
  → execution-planned
  → runtime-started
      via startTeam(parsed.teamName,
                    parsed.task,
                    parsed.agentType,
                    plan.workerCount,
                    plan.tasks,
                    cwd,
                    { worktreeMode })
  → mode-state-synced
      via ensureTeamModeState(parsed/task plan)
  → summary-rendered
      via renderStartSummary(...)
```

Committed launch invariant:

```text
startTeam receives task text only
No committed approved binding or exact launch identity is threaded into startTeam
```

### 6.3 Team resume

Source of truth:

- `src/cli/team.ts#teamCommand` resume branch

Committed transition:

```text
ResumeTeamCLI_B(name, cwd) :=
  let runtime := resumeTeam(name, cwd) in
  if runtime = ⊥ then ⊥
  else
    ensureTeamModeState(<task = runtime.config.task,
                         workerCount = runtime.config.worker_count,
                         agentType = runtime.config.agent_type,
                         explicit flags = false,
                         teamName = runtime.teamName>)
    → renderStartSummary(runtime, ...)
```

Committed resume invariant:

```text
Resume rehydrates mode state from Team runtime config only
No committed approved binding identity is recovered on resume
```

### 6.4 Team runtime-cli launch

Source of truth:

- `src/team/runtime-cli.ts#main`

Committed transition:

```text
LaunchTeamRuntimeCLI_B(stdin_json, cwd):
  validate required fields teamName, agentTypes, tasks, cwd
  workerCount := input.workerCount defaulting to |agentTypes|
  agentType := "executor"
  synthesizedTask := join(tasks.subject, "; ")
  startTeam(teamName,
            synthesizedTask,
            "executor",
            workerCount,
            tasks,
            cwd)
```

Committed runtime-cli invariants:

```text
runtime-cli synthesizes task text from task subjects
runtime-cli does not carry approved-handoff identity
runtime-cli delegates lifecycle to startTeam
```

## 7. Team runtime as a black-box launch transition

Source of truth:

- `src/team/runtime.ts#startTeam`
- `src/team/runtime.ts#resumeTeam`

For this committed baseline reference, `startTeam` is modeled as a black-box launch operator:

```text
StartTeamRuntime_B(teamName, task, agentType, workerCount, tasks, cwd, options)
  := TeamRuntime | error
```

Committed properties that matter for lifecycle cross-checks:

```text
startTeam is invoked from both team CLI and runtime-cli
resumeTeam returns TeamRuntime | ⊥
the Team CLI layers mode-state synchronization around runtime start/resume
```

This reference intentionally does **not** restate the full internal Team runtime protocol. That belongs to the Team runtime contract, not the launch identity baseline.

## 8. Collapsed-state table

These are the most important semantic states that exist in the environment but are collapsed by committed baseline behavior.

| Semantic state | Committed projection |
|---|---|
| `HintMultiplicity = many` for latest PRD | `Proj_B_Hint = last(HintSet)` |
| latest PRD vs older PRD lineage | latest PRD only |
| exact launch identity (`command`) vs task text | task text only |
| session-active vs root-active Team follow-up state | root `.omx/state/team-state.json` only |
| malformed higher-precedence mode-state with valid lower fallback | `ReadModeState_B = ⊥` |
| Team runtime started from runtime-cli with structured task list | synthesized `"; "`-joined task text |
| approved-handoff identity persisted across Team resume | not represented in committed baseline |

These collapsed states are not bugs in this document. They are the exact baseline that later patch refinements must name explicitly.

## 9. Cross-check rule for later context-pack work

Any later context-pack lifecycle model must define an explicit refinement map:

```text
Refine_patch : PatchState → BaselineCommittedState
```

over at least these surfaces:

- Ralph launch
- Team short follow-up
- Team main CLI launch
- Team resume
- Team runtime-cli launch
- shared mode-state visibility

Required rule:

```text
If the patch distinguishes a state that committed baseline collapses,
that distinction must be named, persisted or propagated where required,
and mapped back to one BaselineCommittedState explicitly.
```

Forbidden pattern:

```text
Patch behavior depends on an unnamed latent state
that is not represented in either the patch state machine
or the refinement map to committed baseline.
```

This is the minimum condition needed to prevent lifecycle ping-pong across context-pack fixes.
