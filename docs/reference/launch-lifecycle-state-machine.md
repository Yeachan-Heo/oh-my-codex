# Launch Lifecycle State Machine

This document is the canonical live reference for launch lifecycle behavior in this repository. It is normative for the current source tree and replaces the older split between launch and context-pack handoff references.

## Update contract

Contributors and coding agents who touch lifecycle behavior must read this document before making changes and update it after the change when behavior, state domains, transitions, or invariants change.

Lifecycle behavior means launch, planning approval, handoff, Team or Ralph startup, runtime binding, reassignment, scale-up, mode-state visibility, and runtime context projection behavior.

## 1. Scope and notation

Sources covered by this reference include:

- `src/planning/artifacts.ts`
- `src/planning/context-packs.ts`
- `src/cli/ralph.ts`
- `src/cli/team.ts`
- `src/pipeline/stages/team-exec.ts`
- `src/team/runtime.ts`
- `src/team/runtime-cli.ts`
- `src/team/approved-execution.ts`
- `src/team/scaling.ts`
- `src/modes/base.ts`

Notation:

```text
⊥ = no result / null / rejected lookup
:= = definition
∨ = logical OR
∧ = logical AND
¬ = logical NOT
→ = transition
↔ = logical equivalence
|S| = cardinality of set/sequence S
last(S) = last element of ordered sequence S
Exists(x) = filesystem object exists and is readable
Canonical(x) = object satisfies the repo artifact contract
```

No lifecycle path may rely on an unnamed latent state. If code needs a lifecycle distinction, this document must name it.

## 2. Launch surfaces

OMX has four lifecycle launch surfaces:

```text
LaunchSurface ∈ {
  ralph-cli,
  team-cli,
  pipeline-team-exec,
  team-runtime-cli
}
```

Surface responsibilities:

```text
ralph-cli
  -> resolves Ralph approved handoffs
  -> starts Ralph mode state
  -> writes Ralph session files
  -> projects approved planning context into the Ralph appendix
  -> launches Codex through HUD

team-cli
  -> parses explicit Team launches and short Team follow-ups
  -> resolves bound or unbound approved Team handoffs
  -> starts Team runtime through startTeam
  -> syncs Team mode state after runtime launch or resume

pipeline-team-exec
  -> converts upstream planning artifacts into a structured Team runtime descriptor
  -> emits package-owned runtime-cli launch instructions
  -> carries approvedExecution when the handoff is context-ready
  -> sends approvedExecution = ⊥ for structural or plan-only execution

team-runtime-cli
  -> accepts structured JSON input
  -> preserves task assignments, owners, roles, worker count, provider choice, worktree mode, and approvedExecution
  -> delegates lifecycle to startTeam
```

Required launch-surface invariants:

```text
Every launch surface must preserve structured approvedExecution identity when present.
Every launch surface that intentionally opts out must carry explicit null rather than omission.
No launch surface may reconstruct approved handoff identity from task text when a stronger binding is known.
Pipeline launches must target the package-owned dist/team/runtime-cli.js path, not a target workspace dist path.
```

## 3. Planning and handoff domains

Repository artifact domains:

```text
PRDs(cwd)               ::= ordered canonical discovered .omx/plans/prd-<timestamp>-<slug>.md and legacy .omx/plans/prd-<slug>.md
TestSpecs(cwd)          ::= ordered canonical discovered .omx/plans/test-spec-<timestamp>-<slug>.md and legacy .omx/plans/test-spec-<slug>.md
DeepInterviewSpecs(cwd) ::= ordered canonical discovered .omx/specs/deep-interview-<timestamp>-<slug>.md and legacy .omx/specs/deep-interview-<slug>.md
Packs(cwd)              ::= ordered canonical discovered .omx/context/context-<timestamp>-<slug>.json

LatestPRD(cwd) ::= last(PRDs(cwd)) when |PRDs(cwd)| > 0 else ⊥
```

Timestamped PRD/test-spec names use the same timestamp token shape as context
packs, but their timestamps are artifact identity/order metadata, not update
timestamps. PRD/test-spec matching remains slug-based for compatibility, except
that an exact timestamped `test-spec-<timestamp>-<slug>.md` is preferred when
the selected PRD is `prd-<timestamp>-<slug>.md`.
Deep-interview spec matching is slug-based after stripping an optional leading
timestamp, with timestamped specs naturally ordered after legacy specs.

Accepted PRD inputs preserve canonical membership and persisted identity:

```text
CanonicalPRDInput(cwd, p) ∈ {
  absent,
  noncanonical,
  canonical-existing(canonical_path, persisted_path)
}

CanonicalPRDInput(cwd, p) = canonical-existing(canonical_path, persisted_path)
  iff ∃ p0 ∈ PRDs(cwd) such that realpath(p) = realpath(p0)
  where canonical_path = p0 and persisted_path preserves the caller-supplied absolute alias when present
```

Canonical pack mutation inputs are similarly explicit:

```text
CanonicalPackMutationInput(cwd, k) ∈ {
  noncanonical,
  canonical-existing(path),
  canonical-creatable(path)
}
```

Required properties:

```text
CanonicalPRDInput(cwd, p) = noncanonical
  -> approved hint lookup = ⊥

CanonicalPackMutationInput(cwd, k) = noncanonical
  -> context pack mutation = ⊥

canonical_path is the source of slug and sibling-artifact correlation
persisted_path is the source of returned or persisted approved plan identity
```

Per-PRD readiness:

```text
HandoffState(p) ∈ {
  missing-baseline,
  plan-only,
  ready,
  incomplete,
  invalid
}

BaselinePresent(s)   := s ≠ missing-baseline
ExecutionReusable(s) := s = plan-only ∨ s = ready
AuthoringReady(s)    := s = ready
Broken(s)            := s = incomplete ∨ s = invalid
```

Readiness definitions:

```text
missing-baseline:
  ¬Exists(p) ∨ no matching test spec

plan-only:
  Exists(p) ∧ matching test spec exists ∧ no real Context Pack Outcome section

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

Expanded context-pack handoff state domains:

```text
BaselineState(p) ∈ {
  missing-prd,
  missing-test-spec,
  present
}

OutcomeState(p) ∈ {
  absent,
  malformed,
  ambiguous,
  single(action, canonical_pack_path)
}

For a pack-specific read-only query, normalize `single(action,
canonical_pack_path)` to `single` when `canonical_pack_path = k`, and to
`single-other` when `canonical_pack_path ≠ k`.

PackState(k) ∈ {
  missing,
  unreadable,
  schema-invalid,
  valid
}

RoleCoverage(k) ∈ {
  missing-required-roles(S),
  covered
}

BasisState(k, p) ∈ {
  absent,
  stale-prd,
  stale-test-spec,
  unexpected-test-spec,
  fresh
}

IndexState(k) ∈ {
  missing,
  invalid,
  fresh
}
```

Total readiness mapping is ordered and total. The first matching rule wins, which
keeps malformed or stale declared packs from being reclassified as merely
incomplete because a later generated index or role is also missing.

```text
HandoffState(p, k) =
  missing-baseline  when BaselineState(p) ≠ present
  plan-only         when OutcomeState(p) = absent
  invalid           when OutcomeState(p) ∈ {malformed, ambiguous}
  invalid           when pack-specific OutcomeState(p, k) = single-other
  incomplete        when PackState(k) = missing
  invalid           when PackState(k) ∈ {unreadable, schema-invalid}
  invalid           when BasisState(k, p) ∈ {
                       absent,
                       stale-prd,
                       stale-test-spec,
                       unexpected-test-spec
                     }
  invalid           when IndexState(k) = invalid
  incomplete        when RoleCoverage(k) = missing-required-roles(S)
  incomplete        when IndexState(k) = missing
  ready             otherwise
```

Diagnostic role projection is separate from readiness classification. It reports
what role repair is actually needed without masking stale basis, invalid index,
or malformed manifest causes:

```text
MissingRequiredRoles(p, k) =
  ∅                       when OutcomeState(p) = absent
  ActualMissingRoles(k)   when PackState(k) = valid
  {scope, build, verify}  otherwise

ActualMissingRoles(k) = {r ∈ {scope, build, verify} | r ∉ Roles(k)}
```

Authoring-order invariant:

```text
FinalSyncReady(p, k) :=
  OutcomeState(p) = single(...)
  ∧ Sync(k) occurs after the latest write to p and matching test specs
  ∧ BasisState(k, p) = fresh

SyncBeforeOutcomeThenOutcomeAdded(p, k)
  -> BasisState(k, p) = stale-prd
  -> HandoffState(p, k) = invalid
  -> no Ralph/Team approved-context handoff is allowed

OutcomeState(p) = absent
  -> HandoffState(p, k) = plan-only
  regardless of provisional pack sync artifacts
```

Context-pack write transition invariant:

```text
StoredBasisBefore(k) ∈ {absent, present}
RefreshMode ∈ {disabled, enabled}
ResolvedBasis(p, k) ∈ {unresolved, resolved}

StoredBasisAfterUpsert(k) =
  present              when RefreshMode = enabled ∧ ResolvedBasis(p, k) = resolved
  StoredBasisBefore(k) otherwise

RefreshMode = disabled
  -> StoredBasisAfterUpsert(k) = StoredBasisBefore(k)

BasisState(k, p) ∈ {stale-prd, stale-test-spec, unexpected-test-spec}
  ∧ RefreshMode = disabled
  -> the stored basis remains present so the read-side classifier preserves the
     specific stale basis state instead of collapsing it to absent
```

The read-only context-tool status command is a diagnostic projection of this
same classifier:

```text
context-tool status k
  -> no writes to k, index(k), excerpt cache, or approved artifacts
  -> reports {
       BaselineState,
       OutcomeState,
       PackState,
       RoleCoverage,
       BasisState,
       IndexState,
       HandoffState
     }
```

Required consumer mapping:

```text
Pipeline skip allowed      := ExecutionReusable
Follow-up reuse allowed    := ExecutionReusable
Ralplan consensus allowed  := AuthoringReady

ready      -> approved-context-bearing execution allowed
plan-only  -> pre-context-pack compatibility path only; no approved binding/context projection
others     -> approved-context-bearing execution forbidden
```

Pre-context-pack compatibility means an approved PRD/test-spec pair with no real
`Context Pack Outcome`. This state exists for repos or plans created before
context-pack handoff enforcement, and it also classifies current
PRD/test-spec-only drafts until they are repaired. It may seed repair of a
canonical typed pack, but new implementation handoffs SHOULD NOT intentionally
stop here and it MUST NOT be treated as approved context-bearing execution.

## 4. Launch-hint selection

For a canonical PRD `p` and mode `m ∈ {team, ralph}`:

```text
HintSet(p, m) ::= ordered sequence of parsed same-mode launch hints in p
Task(h)       ::= decoded quoted task text of h
Command(h)    ::= full matched launch command text of h
LaunchId(h)   ::= <sourcePath(p), Command(h)>

Selector ::= bare | task = t | command = c

MatchState(p, m, Selector) ∈ {
  no-match,
  unique(h),
  ambiguous
}
```

Required selector invariants:

```text
ambiguous ≠ no-match
unique(h1) = unique(h2) -> LaunchId(h1) = LaunchId(h2)
ambiguous must never be converted into no-match
```

Exact selector resolution:

```text
TeamLaunchSignature(h) := <Task(h), workerCount, agentType?, linkedRalph>

sel = command = c
  -> exact command identity only

sel = task = t ∧ m = team
  -> same TeamLaunchSignature lineage only

sel = task = t ∧ m = ralph
  -> same Task(h) lineage only

ResolveApprovedHint(cwd, m, sel):
  scan canonical PRDs newest -> oldest

  for each PRD p:
    case MatchState(p, m, sel) of
      ambiguous:
        return ⊥

      unique(h):
        if ExecutionReusable(HandoffState(p)) return h
        if HandoffState(p) = missing-baseline remember newestSurfacedNonReady := h and continue
        if Broken(HandoffState(p)) remember newestBroken := h and continue

      no-match:
        continue

  return newestBroken if present
  else newestSurfacedNonReady if present
  else ⊥
```

Bare selector resolution uses the latest PRD to establish lineage:

```text
m = team  -> lineage key = TeamLaunchSignature(h0)
m = ralph -> lineage key = Task(h0)

ResolveApprovedHint(cwd, m, bare):
  let p0 := LatestPRD(cwd)
  if p0 = ⊥ return ⊥

  case MatchState(p0, m, bare) of
    no-match  -> return ⊥
    ambiguous -> return ⊥
    unique(h0):
      if ExecutionReusable(HandoffState(p0)) return h0
      backscan older PRDs only in the same lineage
      ambiguous same-lineage -> return ⊥
      unique reusable same-lineage -> return h
      otherwise keep the newest surfaced non-ready hint visible
```

Markdown scanners that find headings or launch hints use shared structural state:

```text
MarkdownScanState(line) ∈ {
  normal,
  fenced,
  indented-code
}

ATX heading recognition is allowed only in normal
launch-hint command recognition is allowed only in normal
fenced        -> heading-like lines are ignored
fenced        -> launch-hint-like command lines are ignored
indented-code -> heading-like lines are ignored
indented-code -> launch-hint-like command lines are ignored
```

## 5. Ralph launch

Ralph launch transition:

```text
LaunchRalph(cwd, args):
  help -> render help and stop

  idle
  -> artifacts-ready
      iff the PRD gate passes and canonical Ralph artifacts are ensured
  -> approved-handoff-selected
      via ResolveApprovedHint(cwd, ralph, bare | task = explicitTask)
  -> approved-context-materialized
      iff selected hint is ready and materializeContextRefs = true
  -> mode-started
      via StartMode("ralph", RalphTask(cwd, args), cwd)
  -> session-files-written
      via writeRalphSessionFiles(cwd, task, approvedHint)
  -> mode-updated(starting)
      with approved plan, test specs, deep-interview specs, context pack, context status, context refs, staffing, and deslop metadata
  -> hud-launched
      via launchWithHud(filtered args, possibly with approved task appended)
```

Ralph task derivation:

```text
ExplicitRalphTask(args) := extractRalphTaskDescription(args, fallback = "ralph-cli-launch")

RalphTask(cwd, args) :=
  if ExplicitRalphTask(args) = "ralph-cli-launch" ∧ approved Ralph handoff exists
    then Task(approved hint)
    else ExplicitRalphTask(args)
```

Ralph context-pack refinement:

```text
ready handoff -> materialized context refs are projected into the Ralph appendix and mode state
plan-only -> approved plan/test/deep-interview fallback is projected, but no approved context refs exist
incomplete | invalid | missing-baseline -> diagnostic fallback is projected; approved-context-bearing execution is forbidden
```

Ralph invariants:

```text
Ralph has no persisted approved binding file.
Ralph may use exact task matching for explicit task launches.
Ralph materialized refs must keep sourcePath as the canonical repo source.
StartMode("ralph") always precedes HUD launch.
```

## 6. Team launch

Team CLI state domains:

```text
TeamCommand ∈ {
  api,
  status,
  await,
  resume,
  shutdown,
  launch
}

TeamLaunchState ∈ {
  parsed,
  execution-planned,
  runtime-started,
  mode-state-synced,
  summary-rendered
}
```

Short follow-up tokens:

```text
ShortFollowup(t) =
  short-team        iff trim(t) = "team"
  short-korean-team iff trim(t) ∈ {"team으로 해줘", "team으로 해주세요"}
  other             otherwise
```

Team CLI follow-up projection:

```text
TeamCliFollowupState(cwd, raw_task, parsed_task) ∈ {
  generic(raw_task),
  approved-unbound(h),
  approved-bound(h, b),
  rejected-bound(b),
  blocked(reason)
}

TeamCliFollowupState = approved-bound(h, b)
  -> startTeam input contains approvedExecution = b

TeamCliFollowupState = approved-unbound(h)
  -> startTeam input contains approvedExecution = BuildBinding(h)

TeamCliFollowupState ∈ { generic(raw_task), rejected-bound(b) }
  -> startTeam input contains approvedExecution = ⊥

TeamCliFollowupState = blocked(reason)
  -> Team launch is rejected before generic execution widening
```

Main Team launch:

```text
LaunchTeamCLI(args, cwd):
  parsed
  -> execution-planned
      via buildTeamExecutionPlan(parsed.task, parsed.workerCount, ...)
  -> runtime-started
      via startTeam(parsed.teamName,
                    parsed.task,
                    parsed.agentType,
                    plan.workerCount,
                    plan.tasks,
                    cwd,
                    { worktreeMode, approvedExecution })
  -> mode-state-synced
      via ensureTeamModeState(parsed/task plan, approved hint, runtime.config.team_state_root)
  -> summary-rendered
```

Team resume:

```text
ResumeTeamCLI(name, cwd):
  let runtime := resumeTeam(name, cwd)
  if runtime = ⊥ return ⊥
  else ensureTeamModeState(runtime config)
       -> renderStartSummary(runtime, ...)
```

Pipeline `team-exec` transport:

```text
PlanningArtifactsAuthorityState(artifacts) ∈ {
  none,
  structural,
  approved-authoritative(latest_prd_path)
}

PipelineTeamExecLaunchState(descriptor, authority) ∈ {
  structured-generic,
  structured-approved(b),
  blocked
}

none | structural
  -> structured-generic

approved-authoritative(latest_prd_path)
   ∧ ResolveApprovedHint(cwd, team, prdPath = latest_prd_path) = reusable(h)
   ∧ HandoffState(h.sourcePath) = ready
  -> descriptor.task := h.task
  -> structured-approved(BuildBinding(h))

approved-authoritative(latest_prd_path)
   ∧ ResolveApprovedHint(...) = reusable(h)
   ∧ HandoffState(h.sourcePath) = plan-only
  -> descriptor.task := h.task
  -> structured-generic

approved-authoritative(latest_prd_path)
   ∧ ResolveApprovedHint(...) ∈ { surfaced-nonready(h), blocked(reason), absent }
  -> blocked
```

Pipeline launch invariants:

```text
structured-generic -> runnable launch instruction carries approvedExecution = ⊥ as structured runtime input
structured-approved(b) -> runnable launch instruction carries approvedExecution = b as structured runtime input
approved-authoritative ready or plan-only -> runnable Team task text is derived from h.task
runnable launch instruction preserves task assignments including owner and optional role
blocked -> no runnable Team worker launch is emitted
```

Team runtime-cli launch:

```text
LaunchTeamRuntimeCLI(stdin_json, cwd):
  validate required fields teamName, tasks, cwd
  workerCount := input.workerCount defaulting to provider count or 1
  agentType := input.agentType defaulting to "executor"
  task := input.task if provided else join(tasks.subject, "; ")
  normalizedTasks := tasks preserving subject, description, owner, role
  startTeam(teamName,
            task,
            agentType,
            workerCount,
            normalizedTasks,
            cwd,
            {
              worktreeMode,
              approvedExecution if the input object owns that property
            })
```

Runtime-cli approvedExecution invariants:

```text
input omits approvedExecution -> startTeam may consult persisted bindings
input contains approvedExecution = null -> startTeam receives explicit null and suppresses persisted bindings
input contains approvedExecution = b -> startTeam receives b as authoritative binding
No later runtime step may collapse explicit-null back to absent.
```

## 7. Team binding lifecycle

Persisted binding schema:

```text
Binding ::= {
  prd_path: string,
  task: string,
  command?: string
}

StrongBinding(b) := b.command is present
LegacyBinding(b) := b.command is absent
```

Binding construction:

```text
BuildBinding(h) := {
  prd_path = h.sourcePath,
  task     = h.task,
  command  = h.command
}

SelectedHint(h) before startTeam
  -> startTeam input contains approvedExecution = BuildBinding(h)
  -> runtime must not rediscover h from task text alone
```

StartTeam requested state:

```text
RequestedApprovedExecutionState ∈ {
  absent,
  explicit-null,
  explicit-binding(b)
}

explicit-null    -> persisted binding lookup is suppressed
explicit-binding -> binding is authoritative
absent           -> persisted binding may be consulted
```

Launch-time binding write root:

```text
LaunchBindingWriteRoot(cwd) := resolveCanonicalTeamStateRoot(cwd)

BindingPath(team_name, cwd, root) :=
  root / team / team_name / approved-execution.json
```

During Team startup, `startTeam` writes the binding under the newly initialized runtime config root:

```text
startTeam(..., options)
  -> teamStateRoot := resolveCanonicalTeamStateRoot(cwd)
  -> initTeamState(..., { team_state_root: teamStateRoot })
  -> writePersistedApprovedTeamExecutionBinding(team, cwd, approvedExecution, teamStateRoot)
```

Recovery-time visibility root:

```text
ActiveTeamIdentityState(path) ∈ {
  active-complete(team_name, team_state_root?),
  active-incomplete,
  inactive,
  malformed,
  missing
}

VisibleTeamState(cwd) ∈ {
  session-active(team_name, team_state_root?),
  root-active(team_name, team_state_root?),
  none
}

EffectiveTeamStateRoot(v, cwd) :=
  if v.team_state_root is present and non-empty
    then v.team_state_root
    else LaunchBindingWriteRoot(cwd)
```

Recovery reads must use the active visible Team mode state:

```text
ReadBoundApprovedTeamExecutionState(cwd):
  let v := VisibleTeamState(cwd)
  if v = none return <bindingConfigured = false, approvedHint = ⊥>

  let root := EffectiveTeamStateRoot(v, cwd)
  let b := ReadBinding(v.team_name, root)

  if binding file missing:
    return <bindingConfigured = false, approvedHint = ⊥>

  if binding file malformed:
    return <bindingConfigured = true, bindingState = malformed, approvedExecution = ⊥, approvedHint = ⊥>

  return <bindingConfigured = true, approvedExecution = b, approvedHint = Rehydrate(cwd, b)>
```

Binding rehydration:

```text
Rehydrate(cwd, b) :=
  if StrongBinding(b)
    then ResolveApprovedHint(cwd, team, command = b.command, prdPath = b.prd_path)
    else ResolveApprovedHint(cwd, team, task = b.task, prdPath = b.prd_path)

Rehydrate(cwd, b) = ⊥
  -> no implicit rebind to another PRD or another hint
```

Binding file and hydration states:

```text
BindingFileState(team) ∈ {
  missing,
  malformed,
  valid(b)
}

BindingHydrationState(b) ∈ {
  reusable(h),
  surfaced-nonready(h),
  stale,
  ambiguous
}
```

Fail-closed properties:

```text
missing ≠ malformed
malformed -> fail closed where binding continuity is required
bindingConfigured = true ∧ bindingState = malformed -> no generic Team launch fallback
bindingConfigured = true ∧ approvedHint = ⊥ -> no fallback to latest PRD or task-only rediscovery
BindingHydrationState = reusable(h) -> worker-launch input may carry approvedExecution = b
BindingHydrationState ∈ { surfaced-nonready(h), stale, ambiguous } -> worker-launch input must not carry approvedExecution = b
```

## 8. Reassignment and scale-up continuity

Approved handoff context is a continuity property across every running-Team worker inbox rewrite:

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
unbound
  -> no Approved Handoff Context section

carry(h, b)
  -> bootstrap inbox includes Approved Handoff Context section for h
  -> reassignment inbox includes Approved Handoff Context section for h

blocked(reason)
  -> bootstrap/reassignment worker launch path fails closed
```

Scale-up state:

```text
ScaleUpBindingState(team) ∈ {
  no-binding-file,
  binding-valid(b, h),
  binding-stale(b),
  binding-malformed
}

no-binding-file   -> remain unbound
binding-valid     -> preserve and rehydrate binding
binding-stale     -> fail closed
binding-malformed -> fail closed
```

Continuity invariants:

```text
Only reusable(h) may project into carry(h, b).
carry(h, b) must preserve the same approved brief across bootstrap, scale-up, and reassignment.
blocked(reason) must not silently widen into generic inbox generation.
Scale-up must never create a new approved binding from task text alone.
```

## 9. Runtime context projection

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

Selector-backed refs:

```text
Canonical entry with selector
  -> materialize excerpt body from canonical sourcePath
  -> write to runtime cache path
  -> emit RuntimeProjection { delivery = excerpt, path = cachePath, sourcePath = canonical source }
```

Direct file refs:

```text
Canonical entry without selector or short source
  -> emit RuntimeProjection { delivery = file, path = absolute leader source, sourcePath = absolute leader source }

Worker/worktree rendering:
  -> attempt worktree rebind from sourcePath
  -> use rebound path only if target exists
  -> otherwise preserve original path
```

Projection invariants:

```text
delivery = file    -> sourcePath is the canonical repo source
delivery = excerpt -> path is a runtime cache file, sourcePath remains canonical repo source

ExcerptCachePath(ref) must satisfy:
  outside tracked repo tree
  deterministic from pack identity + entry order
  readable by the launching process

Workers must never be handed nonexistent rebound file paths.
Runtime cache paths must not be stored as canonical planning artifacts.
```

## 10. Mode-state visibility

Generic mode readers preserve fail-closed parse behavior:

```text
GenericModeReadState(paths) ∈ {
  parseable(state),
  malformed,
  missing
}

first existing malformed higher-precedence mode state -> generic read returns ⊥
```

Team active-state visibility is different because stale or malformed session state must not hide a valid root active Team:

```text
session-inactive ∨ session-malformed ∨ session-active-incomplete
  -> Team active-state lookup may continue to root-active
```

Required distinction:

```text
Generic read root = fail closed on malformed higher precedence.
Team binding recovery root = effective root from the active visible Team state.
Ambient env is not a valid substitute once a Team is already running.
```

## 11. Diagnostic confidence

Confidence is diagnostic only. It is derived from categorical resolution state;
it must never be used to upgrade a non-launchable state. Its purpose is to tell
operators how the selected approved identity was found and how much provenance
was preserved.

```text
ConfidenceClass(result) :=
  100 if result = reusable exact strong identity
        (explicit or persisted Binding rehydrates the exact approved PRD/task,
         command identity when present, and ready context)

   85 if result = reusable same-lineage fallback
        (latest same-lineage hint is non-ready, but an older hint in the same
         Task or TeamLaunchSignature lineage is ExecutionReusable)

   40 if result = surfaced non-ready lineage anchor
        (a concrete PRD/task lineage exists, but HandoffState is
         missing-baseline, incomplete, or invalid)

    0 if result = blocked | ambiguous | stale | malformed | noncanonical

ConfidenceClass < 85 -> no execution launch state.
ConfidenceClass >= 85 is necessary but not sufficient: categorical handoff,
binding, selector, and runtime-start gates still decide whether launch proceeds.

Launch projection:
  100 -> launchable; existing strong binding may be carried forward
   85 -> launchable; use the selected older same-lineage hint and build or
         refresh binding from that hint, do not pretend it is the latest PRD
   40 -> diagnostic-only; surface lineage and repair issue, do not launch
    0 -> blocked/fail-closed
```

## 12. Strict invariants

These invariants are part of the lifecycle contract:

```text
No identity degradation:
  if a stronger identity component is known at state N,
  every successor state N+k must preserve it or fail closed.

No ambiguity laundering:
  ambiguous must never be converted into no-match.

No implicit rebinding:
  known command -> never rehydrate by task only
  known canonical prdPath -> never substitute a different PRD
  known team_state_root -> never reread from default root during recovery

No generic widening:
  stale, malformed, ambiguous, or nonready approved bindings must not become generic launches.

No runtime-cache canonicalization:
  runtime cache paths must never be persisted as canonical planning artifacts.

No nonexistent worker paths:
  if worktree rebinding produces a path that does not exist,
  preserve the original readable path.
```

Acceptance checklist:

```text
∀ non-canonical prdPath: approved hint lookup = ⊥
∀ ambiguous same-selector newest PRD: explicit resolution = ⊥
∀ ambiguous newer same-task lineage: bare fallback resolution = ⊥
∀ selected strong hint before startTeam: runtime launch receives binding with command
∀ active Team states: binding reads use EffectiveTeamStateRoot
∀ runtime-cli explicit null: persisted binding lookup is suppressed
∀ selector excerpts: cache path is outside tracked repo tree
∀ direct file ref rebinds: nonexistent target -> preserve original path
∀ plan-only handoffs: ExecutionReusable = true
∀ ready handoffs: AuthoringReady = true
∀ Ralph ready handoffs: materialized context refs are projected into launch context
```
