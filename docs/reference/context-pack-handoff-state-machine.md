# Context-Pack Handoff State Machine

- Scope: current uncommitted context-pack patch
- Baseline reference: [launch-lifecycle-model.md](launch-lifecycle-model.md)
- Purpose: define the full context-pack handoff lifecycle as explicit state domains, transition rules, and invariants that refine the committed baseline instead of collapsing back to weaker identities

## 1. Notation

- `⊥` = no result / null / rejected lookup
- `:=` = definition
- `∨` = OR
- `∧` = AND
- `¬` = NOT
- `→` = transition
- `↔` = equivalence
- `|S|` = cardinality of set/sequence `S`
- `last(S)` = last element of ordered sequence `S`
- `Exists(x)` = filesystem object exists and is readable
- `Canonical(x)` = object is a canonical artifact under the current repo contract
- `Refine_patch(s)` = patch state projected back to the committed baseline state described in `launch-lifecycle-model.md`

This file separates:

1. **semantic state**: states that can exist in the world
2. **patch-visible state**: states the current patch must explicitly distinguish
3. **baseline refinement**: how the patch-visible state maps back to the committed lifecycle

No patch branch may rely on an unnamed latent state.

## 2. Shared domains

### 2.1 Repository artifact domains

```text
PRDs(cwd)               ::= ordered canonical discovered .omx/plans/prd-*.md
TestSpecs(cwd)          ::= ordered canonical discovered .omx/plans/test-spec-*.md
DeepInterviewSpecs(cwd) ::= ordered canonical discovered .omx/specs/deep-interview-*.md
Packs(cwd)              ::= ordered canonical discovered .omx/context/context-<timestamp>-<slug>.json

LatestPRD(cwd)          ::= last(PRDs(cwd)) when |PRDs(cwd)| > 0 else ⊥
```

Discovered canonical membership:

```text
DiscoveredCanonicalPRD(cwd, p)  := p ∈ PRDs(cwd)
DiscoveredCanonicalPack(cwd, k) := k ∈ Packs(cwd)
```

Accepted inputs must preserve the distinction between canonical membership and canonical identity:

```text
CanonicalPRDInput(cwd, p) ∈ {
  absent,
  noncanonical,
  canonical-existing(canonical_path, persisted_path)
}

CanonicalPackMutationInput(cwd, k) ∈ {
  noncanonical,
  canonical-existing(path),
  canonical-creatable(path)
}
```

Definitions:

```text
CanonicalPRDInput(cwd, p) = canonical-existing(canonical_path, persisted_path)
  iff ∃ p0 ∈ PRDs(cwd) such that realpath(p) = realpath(p0)
  where canonical_path = p0 and persisted_path preserves the caller-supplied absolute alias when present

CanonicalPackMutationInput(cwd, k) = canonical-existing(path)
  iff k ∈ Packs(cwd)

CanonicalPackMutationInput(cwd, k) = canonical-creatable(path)
  iff k is the flat canonical path .omx/context/context-<timestamp>-<slug>.json
     under the current workspace root and the file does not yet exist
```

Required property:

```text
CanonicalPRDInput(cwd, p) = noncanonical       -> ApprovedHint(cwd, ..., prdPath = p) = ⊥
CanonicalPackMutationInput(cwd, k) = noncanonical -> ContextPackMutation(cwd, k, ...) = ⊥
```

Canonical artifact correlation rule:

```text
canonical_path is the source of slug and sibling-artifact correlation
persisted_path is the source of returned/persisted approved plan identity
```

### 2.2 Launch-hint objects

For a canonical PRD `p` and mode `m ∈ {team, ralph}`:

```text
HintSet(p, m) ::= ordered sequence of parsed same-mode launch hints in p
Task(h)       ::= decoded quoted task text of hint h
Command(h)    ::= full matched launch command text of hint h
LaunchId(h)   ::= <sourcePath(p), Command(h)>
```

Selectors:

```text
Selector ::= bare | task = t | command = c
```

Per-PRD selector match state:

```text
MatchState(p, m, Selector) ∈ { no-match, unique(h), ambiguous }
```

Invariants:

```text
ambiguous ≠ no-match
unique(h1) = unique(h2) -> LaunchId(h1) = LaunchId(h2)
```

### 2.3 Per-PRD handoff readiness

For each canonical PRD `p`:

```text
HandoffState(p) ∈ {
  missing-baseline,
  plan-only,
  ready,
  incomplete,
  invalid
}
```

Derived predicates:

```text
BaselinePresent(s)   := (s ≠ missing-baseline)
ExecutionReusable(s) := (s = plan-only) ∨ (s = ready)
AuthoringReady(s)    := (s = ready)
Broken(s)            := (s = incomplete) ∨ (s = invalid)
```

Required consumer mapping:

```text
PipelineSkipAllowed        := ExecutionReusable
FollowupReuseAllowed       := ExecutionReusable
RalplanConsensusAllowed    := AuthoringReady
```

### 2.4 Persisted Team binding

The patch must model persisted Team handoff identity as:

```text
Binding ::= {
  prd_path: string,
  task: string,
  command?: string
}
```

Interpretation:

```text
StrongBinding(b) := b.command is present
LegacyBinding(b) := b.command is absent
```

Binding rehydration:

```text
Rehydrate(cwd, b) :=
  if StrongBinding(b)
    then ResolveApprovedHint(cwd, team, command = b.command, prdPath = b.prd_path)
    else ResolveApprovedHint(cwd, team, task = b.task, prdPath = b.prd_path)
```

Required property:

```text
Rehydrate(cwd, b) = ⊥ -> no implicit rebind to another PRD or another hint
```

### 2.5 Requested approved-execution state

Team runtime launch must distinguish three caller states:

```text
RequestedApprovedExecutionState ∈ {
  absent,
  explicit-null,
  explicit-binding(b)
}
```

Required properties:

```text
explicit-null     -> persisted binding lookup is suppressed
explicit-binding  -> binding is authoritative
absent            -> persisted binding may be consulted
```

No later runtime step may collapse `explicit-null` back to `absent`.

### 2.6 Persisted binding file state

Binding-file reads must distinguish:

```text
BindingFileState(team) ∈ {
  missing,
  malformed,
  valid(b)
}
```

Required properties:

```text
missing   ≠ malformed
malformed -> fail closed where binding continuity is required
missing   -> compatibility fallback is allowed only where explicitly documented
```

### 2.7 Binding hydration state

Binding rehydration must stay explicit:

```text
BindingHydrationState(b) ∈ {
  reusable(h),
  surfaced-nonready(h),
  stale,
  ambiguous
}
```

Required properties:

```text
reusable(h)         -> binding may be threaded into execution
surfaced-nonready(h)-> diagnostic only, not executable
stale               -> fail closed
ambiguous           -> fail closed
```

### 2.8 Mode-state reader semantics

Generic mode-state readers preserve the committed fail-closed baseline:

```text
GenericModeReadState(paths) ∈ {
  parseable(state),
  malformed,
  missing
}
```

Required property:

```text
first existing malformed higher-precedence mode state -> generic read returns ⊥
```

This rule applies to generic `readModeState*` / `updateModeState` behavior and must not be weakened by Team-specific follow-up needs.

### 2.9 Active Team visibility

Team identity is evaluated per scoped state file as:

```text
ActiveTeamIdentityState(path) ∈ {
  active-complete(team_name, team_state_root?),
  active-incomplete,
  inactive,
  malformed,
  missing
}
```

Visible Team execution state is derived from those per-path identity states:

```text
VisibleTeamState(cwd) ∈ {
  session-active(team_name, team_state_root?),
  root-active(team_name, team_state_root?),
  none
}
```

Malformed, inactive, or semantically incomplete higher-precedence Team state must not mask lower-precedence active state:

```text
session-inactive ∨ session-malformed ∨ session-active-incomplete -> may continue to root-active
```

Effective Team binding root:

```text
EffectiveTeamStateRoot(v, cwd) :=
  if v.team_state_root is present and non-empty
    then v.team_state_root
    else CanonicalDefaultTeamStateRoot(cwd)
```

Required property:

```text
VisibleTeamState(cwd) = active(team, root)
-> all binding reads/writes for team use EffectiveTeamStateRoot(active, cwd)
```

Ambient env is not a valid substitute once a Team is already running.

### 2.10 Markdown structural scan state

Planning-side markdown scanners must explicitly distinguish:

```text
MarkdownScanState(line) ∈ {
  normal,
  fenced,
  indented-code
}
```

Required properties:

```text
ATX heading recognition is allowed only in normal
launch-hint command recognition is allowed only in normal
fenced        -> heading-like lines are ignored
fenced        -> launch-hint-like command lines are ignored
indented-code -> heading-like lines are ignored
indented-code -> launch-hint-like command lines are ignored
```

This state machine must be shared by:
- Context Pack Outcome section detection
- heading-selector section detection
- Team/Ralph launch-hint detection

### 2.11 Runtime ref projection

A context ref has two identities:

```text
CanonicalSourceRef ::= {
  sourcePath,
  label,
  roles,
  tags,
  relationPath
}

RuntimeProjection ::= {
  path,
  sourcePath,
  delivery ∈ { file, excerpt }
}
```

Projection invariants:

```text
delivery = file    -> sourcePath is the canonical repo source
delivery = excerpt -> path is a runtime cache file, sourcePath remains canonical repo source
```

Worker/worktree rule:

```text
RebindFileRef(sourceRepoRoot, targetRepoRoot, ref) :=
  if targetRepoRoot/source-relative-path(ref.sourcePath) exists
    then file path under targetRepoRoot
    else original ref.path
```

Cache rule:

```text
ExcerptCachePath(ref) must satisfy:
  outside tracked repo tree
  deterministic from pack identity + entry order
  readable by the launching process
```

## 3. Selection state machine

### 3.1 Exact selector (`command` preferred, else `task`)

For explicit selectors `sel ∈ { command = c, task = t }`:

```text
TeamLaunchSignature(h) := <Task(h), workerCount, agentType?, linkedRalph>
```

Cross-PRD fallback uses:

```text
sel = command = c
  -> exact command identity only

sel = task = t ∧ m = team
  -> same TeamLaunchSignature lineage only

sel = task = t ∧ m = ralph
  -> same Task(h) lineage only
```

```text
ResolveApprovedHint(cwd, m, sel):
  scan canonical PRDs newest -> oldest

  for each PRD p:
    case MatchState(p, m, sel) of
      ambiguous:
        return ⊥

      unique(h):
        if ExecutionReusable(HandoffState(p))
          return h
        if HandoffState(p) = missing-baseline
          remember newestSurfacedNonReady := h and continue
        if Broken(HandoffState(p))
          remember newestBroken := h and continue

      no-match:
        continue

  return newestBroken if present
  else newestSurfacedNonReady if present
  else ⊥
```

Required properties:

```text
Newest same-selector ambiguous -> result = ⊥
Newest same-selector unique reusable -> result = that hint
No reusable match ∧ newest broken unique exists -> result = newest broken unique
No reusable match ∧ newest unique missing-baseline exists -> result = newest surfaced non-ready hint
```

No older PRD may be revived once the newest same-selector PRD is ambiguous.

### 3.2 Bare/no-task selector

Bare lookup uses the latest PRD to establish lineage:

```text
m = team
  -> lineage key = TeamLaunchSignature(h0)

m = ralph
  -> lineage key = Task(h0)
```

```text
ResolveApprovedHint(cwd, m, bare):
  let p0 := LatestPRD(cwd)
  if p0 = ⊥ return ⊥

  case MatchState(p0, m, bare) of
    no-match:
      return ⊥

    ambiguous:
      return ⊥

    unique(h0):
      if ExecutionReusable(HandoffState(p0))
        return h0

      if HandoffState(p0) = missing-baseline:
        backscan older PRDs only where Task(h) = Task(h0)
        using per-PRD rules:
          ambiguous -> return ⊥
          unique reusable -> return h
          unique missing-baseline -> remember newestSurfacedNonReadySameTask and continue
          unique broken -> remember newestBrokenSameTask and continue
          no-match -> continue

        return newestBrokenSameTask if present
        else newestSurfacedNonReadySameTask if present
        else h0

      if Broken(HandoffState(p0)):
        backscan older PRDs only where Task(h) = Task(h0)
        using per-PRD rules:
          ambiguous -> return ⊥
          unique reusable -> return h
          unique missing-baseline -> remember newestSurfacedNonReadySameTask and continue
          unique broken -> remember newestBrokenSameTask and continue
          no-match -> continue

        return newestBrokenSameTask if present
        else newestSurfacedNonReadySameTask if present
        else h0
```

Required properties:

```text
Bare lookup never revives an older different task
Newer ambiguous same-task lineage -> result = ⊥
Newer uniquely broken same-task lineage -> older reusable same-task may win
Newer unique missing-baseline same-task lineage -> older reusable same-task may win
No reusable same-task fallback -> latest surfaced non-ready hint remains visible
```

## 4. Handoff readiness state machine

For a canonical PRD `p`:

```text
missing-baseline:
  ¬Exists(p) ∨ no matching test spec

plan-only:
  Exists(p) ∧ matching test spec exists ∧ no Context Pack Outcome section

ready:
  plan baseline exists
  exactly one real Context Pack Outcome section exists
  exactly one canonical pack declaration exists
  declared pack exists
  pack basis is fresh and valid
  required roles {scope, build, verify} are covered
  generated index contract is satisfied

incomplete:
  baseline exists
  declaration exists
  pack identity is canonical
  but at least one required readiness property is missing

invalid:
  baseline exists
  but declaration or pack contract is malformed, ambiguous, drifted, or non-canonical
```

Required transitions:

```text
plan-only  -> executionReusable = true
ready      -> executionReusable = true
incomplete -> executionReusable = false
invalid    -> executionReusable = false
ready      -> authoringReady = true
others     -> authoringReady = false

ready      -> approved-context-bearing execution allowed
plan-only  -> generic compatibility only; no approved binding/context projection
others     -> approved-context-bearing execution forbidden
```

## 5. Team binding lifecycle

### 5.1 Binding creation

If a concrete approved hint `h` has already been selected before Team runtime launch:

```text
BuildBinding(h) := {
  prd_path = h.sourcePath,
  task     = h.task,
  command  = h.command
}
```

Required property:

```text
SelectedHint(h) before startTeam
-> startTeam input contains approvedExecution = BuildBinding(h)
-> runtime must not rediscover h from task text alone
```

### 5.2 Binding persistence

Binding write location:

```text
BindingPath(team_name, cwd, team_state_root) :=
  EffectiveTeamStateRoot(VisibleTeamState(cwd), cwd) / team / team_name / approved-execution.json
```

Required property:

```text
post-start reload, resume rehydration, scale-up rehydration
must all use the same effective team_state_root that was used for persistence
```

### 5.3 Binding recovery

```text
ReadBoundApprovedTeamExecutionState(cwd):
  let v := VisibleTeamState(cwd)
  if v = none return <bindingConfigured = false, approvedHint = ⊥>

  let root := EffectiveTeamStateRoot(v, cwd)
  let b := ReadBinding(v.team_name, root)

  if no binding file exists:
    return <bindingConfigured = false, approvedHint = ⊥>

  if binding file exists but normalization fails:
    return <bindingConfigured = true, bindingState = malformed, approvedExecution = ⊥, approvedHint = ⊥>

  let h := Rehydrate(cwd, b)
  return <bindingConfigured = true, approvedExecution = b, approvedHint = h>
```

Fail-closed property:

```text
bindingConfigured = true ∧ bindingState = malformed
-> malformed binding is surfaced as blocked(malformed-binding)
-> no generic Team launch fallback is allowed

bindingConfigured = true ∧ bindingState ≠ malformed ∧ approvedHint = ⊥
-> no fallback to latest PRD or task-only rediscovery unless the caller is explicitly handling legacy task-only binding ambiguity
```

Launch property:

```text
BindingHydrationState(b) = reusable(h)
-> worker-launch input may carry approvedExecution = b

BindingHydrationState(b) ∈ { surfaced-nonready(h), stale, ambiguous }
-> worker-launch input must not carry approvedExecution = b
```

### 5.4 Short Team launch binding projection

For a parsed Team launch request:

```text
TeamCliFollowupState(cwd, raw_task, parsed_task) ∈ {
  generic(raw_task),
  approved-unbound(h),
  approved-bound(h, b),
  rejected-bound(b),
  blocked(reason)
}
```

Projection:

```text
TeamCliFollowupState(cwd, raw_task, parsed_task) :=
  let s := ReadBoundApprovedTeamExecutionState(cwd) in
  if raw_task is not a short Team follow-up token then
    generic(raw_task)
  else if s.bindingConfigured = true
       ∧ s.bindingState = malformed
    then blocked(malformed-binding)
  else if s.bindingConfigured = true
       ∧ s.approvedExecution ≠ ⊥
       ∧ s.approvedHint ≠ ⊥
       ∧ FollowupReadyStatus(s.approvedHint.contextPackStatus)
    then approved-bound(s.approvedHint, s.approvedExecution)
  else if s.bindingConfigured = true
       ∧ s.approvedExecution ≠ ⊥
       ∧ (s.approvedHint = ⊥
          ∨ ¬FollowupReadyStatus(s.approvedHint.contextPackStatus))
    then rejected-bound(s.approvedExecution)
  else if ResolveApprovedHint(cwd, team, parsed_task) = reusable(h)
    then approved-unbound(h)
  else generic(raw_task)
```

Required launch property:

```text
TeamCliFollowupState = approved-bound(h, b)
-> startTeam input contains approvedExecution = b

TeamCliFollowupState = approved-unbound(h)
-> startTeam input contains approvedExecution = BuildBinding(h)

TeamCliFollowupState ∈ { generic(raw_task), rejected-bound(b) }
-> startTeam input contains approvedExecution = ⊥

TeamCliFollowupState = blocked(reason)
-> Team launch is rejected before generic execution widening
```

This prevents a rejected bound handoff from contaminating a generic `team` launch with stale approved metadata.

### 5.4a Pipeline `team-exec` transport

Pipeline Team execution must first classify whether upstream planning artifacts are merely structural or whether they carry authoritative approved handoff identity:

```text
PlanningArtifactsAuthorityState(artifacts) ∈ {
  none,
  structural,
  approved-authoritative(latest_prd_path)
}
```

Definitions:

```text
none
  iff no upstream planning artifacts are present

structural
  iff upstream planning artifacts are present
     ∧ they carry structural planning output only
     ∧ no authoritative approved PRD identity is available for handoff resolution

approved-authoritative(latest_prd_path)
  iff upstream planning artifacts are present
     ∧ latest_prd_path is present
     ∧ latest_prd_path is intended as the authoritative approved handoff anchor
```

Execution transport then refines to:

```text
PipelineTeamExecLaunchState(descriptor, authority) ∈ {
  structured-generic,
  structured-approved(b),
  blocked
}
```

Projection:

```text
PlanningArtifactsAuthorityState = none
  -> structured-generic

PlanningArtifactsAuthorityState = structural
  -> structured-generic

PlanningArtifactsAuthorityState = approved-authoritative(latest_prd_path)
   ∧ ResolveApprovedHint(cwd, team, prdPath = latest_prd_path) = reusable(h)
   ∧ HandoffState(h.sourcePath) = ready
   ∧ descriptor.task := h.task
   ∧ b = BuildBinding(h)
  -> structured-approved(b)

PlanningArtifactsAuthorityState = approved-authoritative(latest_prd_path)
   ∧ ResolveApprovedHint(...) = reusable(h)
   ∧ HandoffState(h.sourcePath) = plan-only
   ∧ descriptor.task := h.task
  -> structured-generic

PlanningArtifactsAuthorityState = approved-authoritative(latest_prd_path)
   ∧ ResolveApprovedHint(...) ∈ { surfaced-nonready(h), blocked(reason), absent }
  -> blocked
```

Required transport property:

```text
PipelineTeamExecLaunchState = structured-generic
-> runnable launch instruction carries approvedExecution = ⊥ as structured runtime input

PipelineTeamExecLaunchState = structured-approved(b)
-> runnable launch instruction carries approvedExecution = b as structured runtime input

PlanningArtifactsAuthorityState = approved-authoritative(latest_prd_path)
   ∧ ResolveApprovedHint(cwd, team, prdPath = latest_prd_path) ∈ { reusable(h), surfaced-nonready(h) }
-> runnable Team task text is derived from h.task, not from the original upstream request text
-> runnable launch instruction must not collapse back to raw task text alone
-> runnable launch instruction targets the package-owned Team runtime entry, not target-workspace dist paths
-> runnable launch instruction preserves full task assignments including owner and optional role

PipelineTeamExecLaunchState = blocked
-> no runnable Team worker launch is emitted
```

### 5.4b Running Team approved-context continuity

For a running Team, approved handoff context is a continuity property across every worker inbox rewrite:

```text
DispatchApprovedContextState(team) ∈ {
  unbound,
  carry(h, b),
  blocked(reason)
}

InboxSurface ∈ {
  bootstrap,
  reassignment
}
```

Projection:

```text
DispatchApprovedContextState(team) = unbound
  -> InboxSurface projects no Approved Handoff Context section

DispatchApprovedContextState(team) = carry(h, b)
  -> bootstrap inbox includes Approved Handoff Context section for h
  -> reassignment inbox includes Approved Handoff Context section for h

DispatchApprovedContextState(team) = blocked(reason)
  -> bootstrap/reassignment worker launch path fails closed
```

Required continuity property:

```text
Only reusable(h) may project into carry(h, b)
carry(h, b) must preserve the same approved brief across bootstrap, scale-up, and reassignment
blocked(reason) must not silently widen into generic inbox generation
```

### 5.5 Team scale-up binding state

Scale-up must treat binding presence as an explicit state machine:

```text
ScaleUpBindingState(team) ∈ {
  no-binding-file,
  binding-valid(b, h),
  binding-stale(b),
  binding-malformed
}
```

Required properties:

```text
no-binding-file   -> remain unbound
binding-valid     -> preserve and rehydrate binding
binding-stale     -> fail closed
binding-malformed -> fail closed
```

Most importantly:

```text
Scale-up must never create a new approved binding from task text alone.
```

## 5.6 Diagnostic confidence classes

Confidence is diagnostic only. It is not an execution threshold.

```text
ConfidenceClass(result) :=
  100 if result = reusable exact strong identity
   85 if result = reusable same-lineage fallback
   40 if result = surfaced non-ready lineage anchor
    0 if result = blocked | ambiguous | stale | malformed | noncanonical
```

Required property:

```text
Execution launch states must never be produced from ConfidenceClass < 85
```

## 6. Runtime projection lifecycle

### 6.1 Selector-backed refs

Selector-backed refs transition:

```text
Canonical entry with selector
  -> materialize excerpt body from canonical sourcePath
  -> write to runtime cache path
  -> emit RuntimeProjection { delivery = excerpt, path = cachePath, sourcePath = canonical source }
```

Required properties:

```text
cachePath outside repo tree
cachePath does not make leader checkout dirty
cachePath remains stable for the life of the launch
```

### 6.2 Direct file refs

Direct refs transition:

```text
Canonical entry without selector or short source
  -> emit RuntimeProjection { delivery = file, path = absolute leader source, sourcePath = absolute leader source }

Worker/worktree rendering:
  -> attempt worktree rebind from sourcePath
  -> use rebound path only if target exists
  -> otherwise preserve original path
```

Required property:

```text
Workers must never be handed nonexistent rebound file paths
```

## 7. Refinement to committed baseline

The patch refines the baseline documented in `launch-lifecycle-model.md` by splitting committed collapsed states.

### 7.1 Approved hint refinement

Committed baseline:

```text
Proj_B_Hint(p, mode) := last(HintSet(p, mode)) when |HintSet| > 0
```

Patch refinement:

```text
Refine_patch(MatchState = no-match)   -> committed no hint
Refine_patch(MatchState = unique(h))  -> committed selected hint h
Refine_patch(MatchState = ambiguous)  -> committed "would have collapsed to last(h)", but patch must reject
```

### 7.2 Team state refinement

Committed baseline treated visible Team state loosely through scoped mode-state reads. Patch refinement must preserve:

```text
active-complete / active-incomplete / malformed / inactive
```

instead of collapsing them to “whatever first readable file says.”

### 7.3 Binding identity refinement

Committed baseline had no persisted approved binding. Patch refinement adds:

```text
<prd_path, command>  as strong in-PRD launch identity
<prd_path, task>     as legacy compatibility identity only
```

No patch path may collapse from the former to the latter unless the former is absent by schema.

## 8. Code obligations

These are the verifiable obligations the code must satisfy.

### 8.1 No identity degradation

```text
If a stronger identity component is known at state N,
then every successor state N+k must preserve it or fail closed.
```

Concretely:

```text
known command -> never rehydrate by task only
known team_state_root -> never reread from default root
known canonical prdPath -> never substitute a different alias path unless canonicalized consistently
```

### 8.2 No ambiguity laundering

```text
ambiguous must never be converted into no-match
```

This applies:

```text
within one PRD
across same-task lineage scans
during binding rehydration
```

### 8.3 No runtime cache in canonical artifacts

```text
Runtime cache paths must not be stored as canonical planning artifacts.
```

### 8.4 No nonexistent worker paths

```text
If worktree rebinding produces a path that does not exist,
the original readable path must be preserved.
```

## 9. Minimal implementation consequences

The state machine above implies only a small set of shared-source fixes are legitimate:

1. Shared planning selector owns:
   - canonical `prdPath` membership
   - `command`/`task`/`bare` matching
   - ambiguity terminality
   - same-task lineage backscan rules

2. Shared Team binding helper owns:
   - additive `{ prd_path, task, command? }` schema
   - exact rehydration by `command` when present
   - legacy task-only compatibility behavior

3. Shared Team visibility/root helper owns:
   - session-first/root-fallback active Team state
   - effective `team_state_root`

4. Shared runtime ref projection owns:
   - cache path outside repo tree
   - file-ref worktree rebinding with existence fallback

Consumer code must only thread already-known strong identity into these helpers. It must not invent new fallback policy.

## 10. Acceptance checklist

The patch is lifecycle-correct only if all of the following hold:

```text
∀ non-canonical prdPath: approved hint lookup = ⊥
∀ ambiguous same-selector newest PRD: explicit resolution = ⊥
∀ ambiguous newer same-task lineage: bare fallback resolution = ⊥
∀ selected strong hint before startTeam: runtime launch receives binding with command
∀ active Team states: binding reads use effective team_state_root
∀ selector excerpts: cache path is outside tracked repo tree
∀ direct file ref rebinds: nonexistent target -> preserve original path
∀ plan-only handoffs: executionReusable = true
∀ ready handoffs: authoringReady = true
```

If any one of these is violated, the patch is still collapsing an explicit lifecycle state back into an implicit surrogate, and another review loop is expected.
