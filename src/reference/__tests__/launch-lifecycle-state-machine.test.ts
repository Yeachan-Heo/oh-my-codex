import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readApprovedExecutionLaunchHint, resolveContextPackHandoffState } from '../../planning/artifacts.js';
import {
  contextPackExcerptPath,
  readContextPackDocument,
  rebindContextRefsForRepoRoot,
  writeContextPackDocument,
  type ContextPackExecutionRef,
} from '../../planning/context-packs.js';
import { readApprovedTeamExecutionHintFromBinding } from '../../team/approved-execution.js';

type HandoffState = 'missing-baseline' | 'plan-only' | 'ready' | 'incomplete' | 'invalid';
type MatchState = 'no-match' | 'unique' | 'ambiguous';
type BoundLaunchState = 'unconfigured' | 'reusable' | 'rejected';
type CanonicalPrdInputState = 'absent' | 'noncanonical' | 'canonical-existing';
type CanonicalPackMutationInputState = 'noncanonical' | 'canonical-existing' | 'canonical-creatable';
type GenericPathState = 'missing' | 'parseable' | 'malformed';
type ActiveTeamIdentityState = 'missing' | 'active-complete' | 'active-incomplete' | 'inactive' | 'malformed';
type ScaleUpBindingState = 'no-binding-file' | 'binding-valid' | 'binding-stale' | 'binding-malformed';
type RequestedApprovedExecutionState = 'absent' | 'explicit-null' | 'explicit-binding';
type BindingFileState = 'missing' | 'malformed' | 'valid';
type BindingHydrationState = 'reusable' | 'surfaced-nonready' | 'stale' | 'ambiguous';
type DiagnosticConfidenceState =
  | 'reusable-exact-strong-identity'
  | 'reusable-same-lineage-fallback'
  | 'surfaced-nonready-lineage-anchor'
  | 'blocked'
  | 'ambiguous'
  | 'stale'
  | 'malformed'
  | 'noncanonical';
type MarkdownScanState = 'normal' | 'fenced' | 'indented-code';
type PlanningArtifactsAuthorityState = 'none' | 'structural' | 'approved-authoritative';
type PipelineTeamExecLaunchState = 'structured-generic' | 'structured-approved' | 'blocked';
type PipelineTeamExecTaskSource = 'upstream-request' | 'approved-hint' | 'unreachable';
type DispatchApprovedContextState = 'unbound' | 'carry' | 'blocked';
type InboxSurface = 'bootstrap' | 'reassignment';
type TeamCliFollowupState = 'generic' | 'approved-unbound' | 'approved-bound' | 'rejected-bound' | 'blocked';
type BaselineState = 'missing-prd' | 'missing-test-spec' | 'present';
type OutcomeState = 'absent' | 'malformed' | 'ambiguous' | 'single' | 'single-other';
type PackState = 'missing' | 'unreadable' | 'schema-invalid' | 'valid';
type RoleCoverageState = 'missing-required-roles' | 'covered';
type BasisState = 'absent' | 'stale-prd' | 'stale-test-spec' | 'unexpected-test-spec' | 'fresh';
type IndexState = 'missing' | 'invalid' | 'fresh';
type StoredBasisState = 'absent' | 'present';
type BasisRefreshMode = 'disabled' | 'enabled';
type ResolvedBasisState = 'unresolved' | 'resolved';

interface Candidate {
  id: string;
  task: string;
  command: string;
  handoffState: HandoffState;
  matchState: MatchState;
  workerCount?: number;
  agentType?: string;
  linkedRalph?: boolean;
}

type ReferenceHint = { id: string; task: string; command: string };
type TeamFollowupState = {
  task_description?: string;
  agent_count?: number;
};

const MODEL_DOC = readFileSync(
  new URL('../../../docs/reference/launch-lifecycle-state-machine.md', import.meta.url),
  'utf8',
);

let tempDir: string;

function executionReusable(state: HandoffState): boolean {
  return state === 'plan-only' || state === 'ready';
}

function contextReady(state: HandoffState): boolean {
  return state === 'ready';
}

function broken(state: HandoffState): boolean {
  return state === 'incomplete' || state === 'invalid';
}

function surfacedNonReady(state: HandoffState): boolean {
  return state === 'missing-baseline' || broken(state);
}

function oldLifecycleReferenceNames(): string[] {
  return [
    `${'launch-lifecycle'}-model.md`,
    `${'context-pack-handoff'}-state-machine.md`,
  ];
}

function planningCompleteModel(prdCount: number, testSpecCount: number): boolean {
  return prdCount > 0 && testSpecCount > 0;
}

function handoffStateModel(input: {
  baseline: BaselineState;
  outcome: OutcomeState;
  pack: PackState;
  roles: RoleCoverageState;
  basis: BasisState;
  index: IndexState;
}): HandoffState {
  if (input.baseline !== 'present') {
    return 'missing-baseline';
  }
  if (input.outcome === 'absent') {
    return 'plan-only';
  }
  if (input.outcome === 'malformed' || input.outcome === 'ambiguous' || input.outcome === 'single-other') {
    return 'invalid';
  }
  if (input.pack === 'missing') {
    return 'incomplete';
  }
  if (input.pack === 'unreadable' || input.pack === 'schema-invalid') {
    return 'invalid';
  }
  if (input.basis !== 'fresh') {
    return 'invalid';
  }
  if (input.index === 'invalid') {
    return 'invalid';
  }
  if (input.roles === 'missing-required-roles') {
    return 'incomplete';
  }
  if (input.index === 'missing') {
    return 'incomplete';
  }
  return 'ready';
}

function storedBasisAfterUpsertModel(input: {
  stored: StoredBasisState;
  refresh: BasisRefreshMode;
  resolved: ResolvedBasisState;
}): StoredBasisState {
  if (input.refresh === 'enabled' && input.resolved === 'resolved') {
    return 'present';
  }
  return input.stored;
}

function artifactName(path: string): { kind: 'prd' | 'test-spec'; slug: string; timestamp?: string } | null {
  const file = path.split('/').pop() ?? path;
  const match = file.match(/^(?<kind>prd|test-?spec)-(?<rawSlug>.+)\.md$/i);
  if (!match?.groups?.kind || !match.groups.rawSlug) return null;
  const separatorIndex = match.groups.rawSlug.indexOf('-');
  const timestamp = separatorIndex === -1 ? null : match.groups.rawSlug.slice(0, separatorIndex);
  const slug = timestamp && /^\d{8}T\d{6}Z$/.test(timestamp)
    ? match.groups.rawSlug.slice(separatorIndex + 1)
    : match.groups.rawSlug;
  return {
    kind: match.groups.kind.toLowerCase().replace('testspec', 'test-spec') as 'prd' | 'test-spec',
    slug,
    ...(timestamp && /^\d{8}T\d{6}Z$/.test(timestamp) ? { timestamp } : {}),
  };
}

function comparePlanningArtifactPathModel(left: string, right: string): number {
  const leftArtifact = artifactName(left);
  const rightArtifact = artifactName(right);
  if (leftArtifact?.timestamp && rightArtifact?.timestamp && leftArtifact.timestamp !== rightArtifact.timestamp) {
    return leftArtifact.timestamp.localeCompare(rightArtifact.timestamp);
  }
  if (leftArtifact?.timestamp && !rightArtifact?.timestamp) return 1;
  if (!leftArtifact?.timestamp && rightArtifact?.timestamp) return -1;
  return left.localeCompare(right);
}

function latestPlanningSelectionModel(
  prds: readonly string[],
  testSpecs: readonly string[],
): { prd: string | null; testSpecs: string[] } {
  const prd = [...prds].sort(comparePlanningArtifactPathModel).at(-1) ?? null;
  const prdArtifact = prd ? artifactName(prd) : null;
  const slug = prdArtifact?.kind === 'prd' ? prdArtifact.slug : null;
  const exactTestSpec = slug && prdArtifact?.timestamp
    ? testSpecs.find((path) => (path.split('/').pop() ?? path) === `test-spec-${prdArtifact.timestamp}-${slug}.md`)
    : null;
  return {
    prd,
    testSpecs: exactTestSpec
      ? [exactTestSpec]
      : slug
        ? testSpecs.filter((path) => {
          const artifact = artifactName(path);
          return artifact?.kind === 'test-spec' && artifact.slug === slug;
        })
      : [],
  };
}

function projectLastHintModel<T>(hints: readonly T[]): T | null {
  return hints.length > 0 ? hints[hints.length - 1]! : null;
}

function readModeStateCompatibilityModel(paths: readonly GenericPathState[]): 'state' | null {
  for (const path of paths) {
    if (path === 'missing') {
      continue;
    }
    if (path === 'parseable') {
      return 'state';
    }
    if (path === 'malformed') {
      return null;
    }
  }
  return null;
}

function resolveShortTeamFollowupModel(
  shortFollowup: boolean,
  approvedHint: ReferenceHint | null,
  rootState: TeamFollowupState | null,
): { task: string; workerCount: number } | null {
  if (!shortFollowup || !approvedHint) {
    return null;
  }
  if (
    rootState
    && rootState.task_description === approvedHint.task
    && typeof rootState.agent_count === 'number'
  ) {
    return {
      task: rootState.task_description,
      workerCount: rootState.agent_count,
    };
  }
  return {
    task: approvedHint.task,
    workerCount: 3,
  };
}

function launchRalphModel(input: 'help' | 'invalid-prd-gate' | 'runnable'): string[] {
  if (input === 'help') {
    return ['help'];
  }
  if (input === 'invalid-prd-gate') {
    return ['idle', 'invalid-prd-gate'];
  }
  return [
    'idle',
    'artifacts-ready',
    'approved-handoff-selected',
    'approved-context-materialized',
    'mode-started',
    'session-files-written',
    'mode-updated(starting)',
    'hud-launched',
  ];
}

function launchTeamModel(command: 'api' | 'status' | 'await' | 'resume' | 'shutdown' | 'launch'): string[] {
  switch (command) {
    case 'launch':
      return ['parsed', 'execution-planned', 'runtime-started', 'mode-state-synced', 'summary-rendered'];
    case 'resume':
      return ['runtime-resumed', 'mode-state-synced', 'summary-rendered'];
    default:
      return [command];
  }
}

function classifyCanonicalPrdInputModel(
  provided: boolean,
  directMember: boolean,
  realpathMatchesMember: boolean,
): CanonicalPrdInputState {
  if (!provided) {
    return 'absent';
  }
  return directMember || realpathMatchesMember ? 'canonical-existing' : 'noncanonical';
}

function classifyCanonicalPackMutationInputModel(
  canonicalShape: boolean,
  alreadyExists: boolean,
): CanonicalPackMutationInputState {
  if (!canonicalShape) {
    return 'noncanonical';
  }
  return alreadyExists ? 'canonical-existing' : 'canonical-creatable';
}

function resolveExplicitModel(candidates: readonly Candidate[]): Candidate | null {
  let newestBroken: Candidate | null = null;
  let newestSurfacedNonReady: Candidate | null = null;
  for (const candidate of candidates) {
    if (candidate.matchState === 'ambiguous') {
      return null;
    }
    if (candidate.matchState === 'no-match') {
      continue;
    }
    if (executionReusable(candidate.handoffState)) {
      return candidate;
    }
    if (broken(candidate.handoffState) && !newestBroken) {
      newestBroken = candidate;
    }
    if (candidate.handoffState === 'missing-baseline' && !newestSurfacedNonReady) {
      newestSurfacedNonReady = candidate;
    }
  }
  return newestBroken ?? newestSurfacedNonReady;
}

function resolveExplicitTeamModel(candidates: readonly Candidate[]): Candidate | null {
  let newestBrokenSameSignature: Candidate | null = null;
  let newestSurfacedNonReadySameSignature: Candidate | null = null;
  let lineageAnchor: Candidate | null = null;

  for (const candidate of candidates) {
    if (candidate.matchState === 'no-match') {
      continue;
    }
    if (!lineageAnchor) {
      if (candidate.matchState === 'ambiguous') {
        return null;
      }
      lineageAnchor = candidate;
    }
    if (candidate.matchState === 'ambiguous') {
      if (sameTeamLaunchSignatureModel(lineageAnchor, candidate)) {
        return null;
      }
      continue;
    }
    if (!sameTeamLaunchSignatureModel(lineageAnchor, candidate)) {
      continue;
    }
    if (executionReusable(candidate.handoffState)) {
      return candidate;
    }
    if (broken(candidate.handoffState) && !newestBrokenSameSignature) {
      newestBrokenSameSignature = candidate;
    }
    if (candidate.handoffState === 'missing-baseline' && !newestSurfacedNonReadySameSignature) {
      newestSurfacedNonReadySameSignature = candidate;
    }
  }

  return newestBrokenSameSignature ?? newestSurfacedNonReadySameSignature;
}

function resolveBareModel(candidates: readonly Candidate[]): Candidate | null {
  const latest = candidates[0];
  if (!latest || latest.matchState !== 'unique') {
    return null;
  }
  if (executionReusable(latest.handoffState)) {
    return latest;
  }
  if (!surfacedNonReady(latest.handoffState)) {
    return latest;
  }

  let newestBrokenSameTask: Candidate | null = broken(latest.handoffState) ? latest : null;
  let newestSurfacedNonReadySameTask: Candidate | null = latest.handoffState === 'missing-baseline' ? latest : null;
  for (const candidate of candidates.slice(1)) {
    if (candidate.task !== latest.task) {
      continue;
    }
    if (candidate.matchState === 'ambiguous') {
      return null;
    }
    if (candidate.matchState === 'no-match') {
      continue;
    }
    if (executionReusable(candidate.handoffState)) {
      return candidate;
    }
    if (broken(candidate.handoffState) && !newestBrokenSameTask) {
      newestBrokenSameTask = candidate;
    }
    if (candidate.handoffState === 'missing-baseline' && !newestSurfacedNonReadySameTask) {
      newestSurfacedNonReadySameTask = candidate;
    }
  }
  return newestBrokenSameTask ?? newestSurfacedNonReadySameTask;
}

function sameTeamLaunchSignatureModel(anchor: Candidate, candidate: Candidate): boolean {
  return anchor.task === candidate.task
    && anchor.workerCount === candidate.workerCount
    && (anchor.agentType ?? null) === (candidate.agentType ?? null)
    && Boolean(anchor.linkedRalph) === Boolean(candidate.linkedRalph);
}

function resolveBareTeamModel(candidates: readonly Candidate[]): Candidate | null {
  const latest = candidates[0];
  if (!latest || latest.matchState !== 'unique') {
    return null;
  }
  if (executionReusable(latest.handoffState)) {
    return latest;
  }
  if (!surfacedNonReady(latest.handoffState)) {
    return latest;
  }

  let newestBrokenSameSignature: Candidate | null = broken(latest.handoffState) ? latest : null;
  let newestSurfacedNonReadySameSignature: Candidate | null = latest.handoffState === 'missing-baseline' ? latest : null;
  for (const candidate of candidates.slice(1)) {
    if (candidate.matchState === 'ambiguous') {
      return null;
    }
    if (candidate.matchState === 'no-match') {
      continue;
    }
    if (!sameTeamLaunchSignatureModel(latest, candidate)) {
      continue;
    }
    if (executionReusable(candidate.handoffState)) {
      return candidate;
    }
    if (broken(candidate.handoffState) && !newestBrokenSameSignature) {
      newestBrokenSameSignature = candidate;
    }
    if (candidate.handoffState === 'missing-baseline' && !newestSurfacedNonReadySameSignature) {
      newestSurfacedNonReadySameSignature = candidate;
    }
  }
  return newestBrokenSameSignature ?? newestSurfacedNonReadySameSignature;
}

function effectiveTeamStateRootModel(
  visibleState: { kind: 'session-active' | 'root-active' | 'none'; team_state_root?: string },
  cwd: string,
): string | null {
  if (visibleState.kind === 'none') {
    return null;
  }
  return visibleState.team_state_root && visibleState.team_state_root.trim() !== ''
    ? visibleState.team_state_root.trim()
    : join(cwd, '.omx', 'state');
}

function readGenericModeStateModel(paths: readonly GenericPathState[]): 'state' | null {
  for (const path of paths) {
    if (path === 'missing') {
      continue;
    }
    if (path === 'parseable') {
      return 'state';
    }
    if (path === 'malformed') {
      return null;
    }
  }
  return null;
}

function readActiveTeamStateModel(
  session: ActiveTeamIdentityState,
  root: ActiveTeamIdentityState,
): 'session' | 'root' | null {
  if (session === 'active-complete') {
    return 'session';
  }
  if (root === 'active-complete') {
    return 'root';
  }
  return null;
}

function requestedApprovedExecutionProjectionModel(
  requested: RequestedApprovedExecutionState,
  persisted: BindingFileState,
): 'suppress-persisted' | 'use-persisted-if-valid' | 'use-explicit-binding' {
  if (requested === 'explicit-null') {
    return 'suppress-persisted';
  }
  if (requested === 'explicit-binding') {
    return 'use-explicit-binding';
  }
  if (persisted === 'valid') {
    return 'use-persisted-if-valid';
  }
  return 'use-persisted-if-valid';
}

function scaleUpBindingProjectionModel(state: ScaleUpBindingState): 'remain-unbound' | 'carry-binding' | 'fail-closed' {
  switch (state) {
    case 'no-binding-file':
      return 'remain-unbound';
    case 'binding-valid':
      return 'carry-binding';
    case 'binding-stale':
    case 'binding-malformed':
      return 'fail-closed';
  }
}

function bindingHydrationProjectionModel(state: BindingHydrationState): 'launchable' | 'diagnostic-only' | 'blocked' {
  switch (state) {
    case 'reusable':
      return 'launchable';
    case 'surfaced-nonready':
      return 'diagnostic-only';
    case 'stale':
    case 'ambiguous':
      return 'blocked';
  }
}

function boundWorkerLaunchProjectionModel(state: BindingHydrationState): 'carry-binding' | 'drop-binding' {
  return state === 'reusable' ? 'carry-binding' : 'drop-binding';
}

function pipelineTeamExecLaunchProjectionModel(
  authorityState: PlanningArtifactsAuthorityState,
  state: HandoffState | null,
): PipelineTeamExecLaunchState {
  if (authorityState === 'none' || authorityState === 'structural') {
    return 'structured-generic';
  }
  if (state === 'plan-only') {
    return 'structured-generic';
  }
  if (state != null && contextReady(state)) {
    return 'structured-approved';
  }
  return 'blocked';
}

function pipelineTeamExecTaskSourceModel(
  authorityState: PlanningArtifactsAuthorityState,
  state: HandoffState | null,
): PipelineTeamExecTaskSource {
  if (authorityState === 'none' || authorityState === 'structural') {
    return 'upstream-request';
  }
  if (state === 'ready' || state === 'plan-only') {
    return 'approved-hint';
  }
  return 'unreachable';
}

function dispatchApprovedContextProjectionModel(
  state: DispatchApprovedContextState,
  surface: InboxSurface,
): 'include-approved-context' | 'omit-approved-context' | 'fail-closed' {
  if (state === 'carry') {
    return surface === 'bootstrap' || surface === 'reassignment'
      ? 'include-approved-context'
      : 'fail-closed';
  }
  if (state === 'unbound') {
    return 'omit-approved-context';
  }
  return 'fail-closed';
}

function markdownScanStateModel(line: string, activeFence: boolean): MarkdownScanState {
  if (activeFence) {
    return 'fenced';
  }
  if (/^( {4,}|\t)/.test(line)) {
    return 'indented-code';
  }
  return 'normal';
}

function launchHintVisibleInMarkdownModel(line: string, activeFence: boolean): boolean {
  return markdownScanStateModel(line, activeFence) === 'normal';
}

function confidenceClassModel(state: DiagnosticConfidenceState): 100 | 85 | 40 | 0 {
  switch (state) {
    case 'reusable-exact-strong-identity':
      return 100;
    case 'reusable-same-lineage-fallback':
      return 85;
    case 'surfaced-nonready-lineage-anchor':
      return 40;
    case 'blocked':
    case 'stale':
    case 'ambiguous':
    case 'malformed':
    case 'noncanonical':
      return 0;
  }
}

function diagnosticConfidenceProjectionModel(state: DiagnosticConfidenceState): 'launchable' | 'diagnostic-only' | 'blocked' {
  switch (state) {
    case 'reusable-exact-strong-identity':
    case 'reusable-same-lineage-fallback':
      return 'launchable';
    case 'surfaced-nonready-lineage-anchor':
      return 'diagnostic-only';
    case 'blocked':
    case 'stale':
    case 'ambiguous':
    case 'malformed':
    case 'noncanonical':
      return 'blocked';
  }
}

function rebindFileProjectionModel(
  sourceRepoRoot: string,
  targetRepoRoot: string,
  ref: ContextPackExecutionRef,
): string {
  if (ref.delivery !== 'file') {
    return ref.path;
  }
  const repoRelativeSourcePath = relative(sourceRepoRoot, ref.sourcePath).replaceAll('\\', '/');
  if (
    repoRelativeSourcePath === ''
    || repoRelativeSourcePath === '.'
    || repoRelativeSourcePath.startsWith('..')
    || repoRelativeSourcePath.startsWith('../')
  ) {
    return ref.path;
  }
  const reboundPath = join(targetRepoRoot, repoRelativeSourcePath);
  return existsSync(reboundPath) ? reboundPath : ref.path;
}

function shortTeamLaunchBindingModel(boundState: BoundLaunchState): 'carry-binding' | 'drop-binding' {
  return boundState === 'reusable' ? 'carry-binding' : 'drop-binding';
}

function teamCliFollowupProjectionModel(
  state: TeamCliFollowupState,
): 'carry-existing-binding' | 'build-binding' | 'drop-binding' | 'fail-closed' {
  switch (state) {
    case 'approved-bound':
      return 'carry-existing-binding';
    case 'approved-unbound':
      return 'build-binding';
    case 'blocked':
      return 'fail-closed';
    case 'generic':
    case 'rejected-bound':
      return 'drop-binding';
  }
}

function* lcg(seed: number): Generator<number> {
  let state = seed >>> 0;
  while (true) {
    state = (1664525 * state + 1013904223) >>> 0;
    yield state;
  }
}

async function writeRepoFile(relativePath: string, content: string): Promise<string> {
  const absolutePath = join(tempDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
  return absolutePath;
}

async function writeReadyContextPack(slug: string): Promise<{ prdPath: string; packPath: string }> {
  const plansDir = join(tempDir, '.omx', 'plans');
  const packPath = join(tempDir, '.omx', 'context', `context-20260420T000000Z-${slug}.json`);
  await mkdir(plansDir, { recursive: true });
  await writeRepoFile(`docs/${slug}-scope.md`, '# Scope\n\nScope.\n');
  await writeRepoFile(`docs/${slug}-build.md`, '# Build\n\nBuild.\n');
  await writeRepoFile(`docs/${slug}-verify.md`, '# Verify\n\nVerify.\n');
  writeContextPackDocument(packPath, {
    schema: 'omx-context-pack-v1',
    slug,
    entries: [
      {
        label: 'scope',
        path: `docs/${slug}-scope.md`,
        roles: ['scope'],
        tags: [],
        relationPath: [
          { tag: 'plan', target: slug },
          { tag: 'bounds', target: `docs/${slug}-scope.md` },
        ],
      },
      {
        label: 'build',
        path: `docs/${slug}-build.md`,
        roles: ['build'],
        tags: [],
        relationPath: [
          { tag: 'plan', target: slug },
          { tag: 'implements', target: `docs/${slug}-build.md` },
        ],
      },
      {
        label: 'verify',
        path: `docs/${slug}-verify.md`,
        roles: ['verify'],
        tags: [],
        relationPath: [
          { tag: 'plan', target: slug },
          { tag: 'verifies', target: `docs/${slug}-verify.md` },
        ],
      },
    ],
  }, { refreshBasis: true });
  const document = readContextPackDocument(packPath);
  assert.ok(document);
  writeContextPackDocument(packPath, document, { refreshBasis: true });

  const prdPath = join(plansDir, `prd-${slug}.md`);
  await writeFile(
    prdPath,
    [
      '# Approved plan',
      '',
      '## Context Pack Outcome',
      `- pack: created \`.omx/context/context-20260420T000000Z-${slug}.json\``,
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(plansDir, `test-spec-${slug}.md`), '# Test Spec\n', 'utf8');
  return { prdPath, packPath };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-context-pack-model-'));
});

afterEach(async () => {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe('launch-lifecycle-state-machine reference', () => {
  it('exists as the canonical reference and removes superseded reference filenames from public docs and scripts', () => {
    assert.equal(existsSync(new URL('../../../docs/reference/launch-lifecycle-state-machine.md', import.meta.url)), true);
    for (const oldName of oldLifecycleReferenceNames()) {
      assert.equal(existsSync(new URL(`../../../docs/reference/${oldName}`, import.meta.url)), false);
    }

    const scannedFiles = [
      '../../../package.json',
      '../../../CONTRIBUTING.md',
      '../../../docs/STATE_MODEL.md',
      '../../../docs/reference/launch-lifecycle-state-machine.md',
    ];
    for (const file of scannedFiles) {
      const content = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const oldName of oldLifecycleReferenceNames()) {
        assert.equal(content.includes(oldName), false, `${file} still references ${oldName}`);
      }
    }
  });

  it('documents the update contract, launch surfaces, and core state domains exercised by this executable model', () => {
    assert.match(MODEL_DOC, /Contributors and coding agents who touch lifecycle behavior must read this document before making changes/);
    assert.match(MODEL_DOC, /update it after the change when behavior, state domains, transitions, or invariants change/);
    assert.match(
      readFileSync(new URL('../../../CONTRIBUTING.md', import.meta.url), 'utf8'),
      /Update that reference in the same change when lifecycle behavior, state domains, transitions, or invariants change/,
    );
    assert.match(
      readFileSync(new URL('../../../docs/STATE_MODEL.md', import.meta.url), 'utf8'),
      /canonical lifecycle reference: \[`docs\/reference\/launch-lifecycle-state-machine\.md`\]/,
    );
    assert.match(
      readFileSync(new URL('../../../docs/STATE_MODEL.md', import.meta.url), 'utf8'),
      /Team active-state lookup may continue past malformed, inactive, or active-but-incomplete session state/,
    );
    assert.match(
      readFileSync(new URL('../../../docs/STATE_MODEL.md', import.meta.url), 'utf8'),
      /approved-execution\.json` from the active Team state's effective `team_state_root`/,
    );
    assert.match(MODEL_DOC, /LaunchSurface ∈ \{/);
    assert.match(MODEL_DOC, /ralph-cli/);
    assert.match(MODEL_DOC, /team-cli/);
    assert.match(MODEL_DOC, /pipeline-team-exec/);
    assert.match(MODEL_DOC, /team-runtime-cli/);
    assert.match(MODEL_DOC, /CanonicalPRDInput\(cwd, p\) ∈ \{/);
    assert.match(MODEL_DOC, /canonical-existing\(canonical_path, persisted_path\)/);
    assert.match(MODEL_DOC, /CanonicalPackMutationInput\(cwd, k\) ∈ \{/);
    assert.match(MODEL_DOC, /canonical-creatable\(path\)/);
    assert.match(MODEL_DOC, /HandoffState\(p\)/);
    assert.match(MODEL_DOC, /MatchState\(p, m, Selector\)/);
    assert.match(MODEL_DOC, /GenericModeReadState\(paths\)/);
    assert.match(MODEL_DOC, /ActiveTeamIdentityState\(path\) ∈ \{/);
    assert.match(MODEL_DOC, /VisibleTeamState\(cwd\)/);
    assert.match(MODEL_DOC, /Binding ::= \{/);
    assert.match(MODEL_DOC, /RequestedApprovedExecutionState ∈ \{/);
    assert.match(MODEL_DOC, /BindingFileState\(team\) ∈ \{/);
    assert.match(MODEL_DOC, /BindingHydrationState\(b\) ∈ \{/);
    assert.match(MODEL_DOC, /MarkdownScanState\(line\) ∈ \{/);
    assert.match(MODEL_DOC, /ConfidenceClass\(result\) :=/);
    assert.match(MODEL_DOC, /100 if result = reusable exact strong identity/);
    assert.match(MODEL_DOC, /85 if result = reusable same-lineage fallback/);
    assert.match(MODEL_DOC, /40 if result = surfaced non-ready lineage anchor/);
    assert.match(MODEL_DOC, /ConfidenceClass < 85 -> no execution launch state/);
    assert.match(MODEL_DOC, /ResolveApprovedHint\(cwd, m, sel\)/);
    assert.match(MODEL_DOC, /TeamCliFollowupState\(cwd, raw_task, parsed_task\) ∈ \{/);
    assert.match(MODEL_DOC, /blocked\(reason\)/);
    assert.match(MODEL_DOC, /ScaleUpBindingState\(team\)/);
    assert.match(MODEL_DOC, /PlanningArtifactsAuthorityState\(artifacts\) ∈ \{/);
    assert.match(MODEL_DOC, /PipelineTeamExecLaunchState\(descriptor, authority\) ∈ \{/);
    assert.match(MODEL_DOC, /descriptor\.task := h\.task/);
    assert.match(MODEL_DOC, /DispatchApprovedContextState\(team\) ∈ \{/);
    assert.match(MODEL_DOC, /InboxSurface ∈ \{/);
    assert.match(MODEL_DOC, /RuntimeProjection/);
    assert.match(MODEL_DOC, /No identity degradation/);
    assert.match(MODEL_DOC, /No ambiguity laundering/);
    assert.match(MODEL_DOC, /TeamLaunchSignature\(h\) := <Task\(h\), workerCount, agentType\?, linkedRalph>/);
    assert.match(MODEL_DOC, /plan-only  -> pre-context-pack compatibility path only; no approved binding\/context projection/);
    assert.match(MODEL_DOC, /Pre-context-pack compatibility means an approved PRD\/test-spec pair with no real/);
    assert.match(MODEL_DOC, /canonical_path is the source of slug and sibling-artifact correlation/);
    assert.match(MODEL_DOC, /launch-hint-like command lines are ignored/);
    assert.match(MODEL_DOC, /LaunchBindingWriteRoot\(cwd\) := resolveCanonicalTeamStateRoot\(cwd\)/);
    assert.match(MODEL_DOC, /Recovery-time visibility root/);
    assert.match(MODEL_DOC, /input contains approvedExecution = null -> startTeam receives explicit null and suppresses persisted bindings/);
    assert.match(MODEL_DOC, /Ralph context-pack refinement/);
    assert.match(MODEL_DOC, /approved-context-materialized/);
    assert.match(MODEL_DOC, /BaselineState\(p\) ∈ \{/);
    assert.match(MODEL_DOC, /OutcomeState\(p\) ∈ \{/);
    assert.match(MODEL_DOC, /PackState\(k\) ∈ \{/);
    assert.match(MODEL_DOC, /BasisState\(k, p\) ∈ \{/);
    assert.match(MODEL_DOC, /SyncBeforeOutcomeThenOutcomeAdded\(p, k\)/);
  });

  it('exhaustively model-checks planning completeness, latest artifact selection, and compatibility hint projection', () => {
    for (let prdCount = 0; prdCount <= 3; prdCount += 1) {
      for (let testSpecCount = 0; testSpecCount <= 3; testSpecCount += 1) {
        assert.equal(
          planningCompleteModel(prdCount, testSpecCount),
          prdCount > 0 && testSpecCount > 0,
          `unexpected planning completeness for prdCount=${prdCount}, testSpecCount=${testSpecCount}`,
        );
      }
    }

    const hints: ReferenceHint[] = [
      { id: 'a', task: 'task-a', command: 'omx ralph "task-a"' },
      { id: 'b', task: 'task-b', command: 'omx ralph "task-b"' },
      { id: 'c', task: 'task-c', command: 'omx ralph "task-c"' },
    ];
    const prdPaths = [
      '/repo/.omx/plans/prd-alpha.md',
      '/repo/.omx/plans/prd-beta.md',
      '/repo/.omx/plans/prd-gamma.md',
    ];
    const testSpecPaths = [
      '/repo/.omx/plans/test-spec-alpha.md',
      '/repo/.omx/plans/test-spec-beta.md',
      '/repo/.omx/plans/test-spec-delta.md',
    ];

    for (let prdCount = 0; prdCount <= prdPaths.length; prdCount += 1) {
      const prds = prdPaths.slice(0, prdCount);
      const selection = latestPlanningSelectionModel(prds, testSpecPaths);
      assert.equal(selection.prd, prdCount === 0 ? null : prds[prdCount - 1]);
      const expectedSlug = selection.prd ? artifactName(selection.prd)?.slug : null;
      const expectedSpecs = expectedSlug
        ? testSpecPaths.filter((path) => artifactName(path)?.slug === expectedSlug)
        : [];
      assert.deepEqual(selection.testSpecs, expectedSpecs);
    }

    assert.deepEqual(
      latestPlanningSelectionModel(
        [
          '/repo/.omx/plans/prd-zeta.md',
          '/repo/.omx/plans/prd-20260427T153000Z-alpha.md',
          '/repo/.omx/plans/prd-20260427T153100Z-alpha.md',
        ],
        [
          '/repo/.omx/plans/test-spec-alpha.md',
          '/repo/.omx/plans/test-spec-20260427T153100Z-alpha.md',
        ],
      ),
      {
        prd: '/repo/.omx/plans/prd-20260427T153100Z-alpha.md',
        testSpecs: ['/repo/.omx/plans/test-spec-20260427T153100Z-alpha.md'],
      },
    );

    for (let hintCount = 0; hintCount <= hints.length; hintCount += 1) {
      const selected = projectLastHintModel(hints.slice(0, hintCount));
      assert.equal(selected, hintCount === 0 ? null : hints[hintCount - 1]);
    }
  });

  it('exhaustively model-checks context-pack handoff readiness over the finite state product', () => {
    const baselines: BaselineState[] = ['missing-prd', 'missing-test-spec', 'present'];
    const outcomes: OutcomeState[] = ['absent', 'malformed', 'ambiguous', 'single-other', 'single'];
    const packs: PackState[] = ['missing', 'unreadable', 'schema-invalid', 'valid'];
    const roleCoverageStates: RoleCoverageState[] = ['missing-required-roles', 'covered'];
    const basisStates: BasisState[] = ['absent', 'stale-prd', 'stale-test-spec', 'unexpected-test-spec', 'fresh'];
    const indexStates: IndexState[] = ['missing', 'invalid', 'fresh'];
    const seen = new Set<HandoffState>();

    for (const baseline of baselines) {
      for (const outcome of outcomes) {
        for (const pack of packs) {
          for (const roles of roleCoverageStates) {
            for (const basis of basisStates) {
              for (const index of indexStates) {
                const state = handoffStateModel({ baseline, outcome, pack, roles, basis, index });
                assert.equal(
                  resolveContextPackHandoffState({
                    baselineState: baseline,
                    outcomeState: outcome,
                    packState: pack,
                    roleCoverage: roles,
                    basisState: basis,
                    indexState: index,
                  }),
                  state,
                );
                seen.add(state);
                if (baseline !== 'present') {
                  assert.equal(state, 'missing-baseline');
                  continue;
                }
                if (outcome === 'absent') {
                  assert.equal(state, 'plan-only');
                  continue;
                }
                if (outcome === 'malformed' || outcome === 'ambiguous' || outcome === 'single-other') {
                  assert.equal(state, 'invalid');
                  continue;
                }
                if (pack === 'missing') {
                  assert.equal(state, 'incomplete');
                  continue;
                }
                if (
                  pack === 'unreadable'
                  || pack === 'schema-invalid'
                  || basis !== 'fresh'
                  || index === 'invalid'
                ) {
                  assert.equal(state, 'invalid');
                  continue;
                }
                if (roles === 'missing-required-roles' || index === 'missing') {
                  assert.equal(state, 'incomplete');
                  continue;
                }
                assert.equal(state, 'ready');
              }
            }
          }
        }
      }
    }

    assert.deepEqual([...seen].sort(), ['incomplete', 'invalid', 'missing-baseline', 'plan-only', 'ready']);
    assert.equal(
      handoffStateModel({
        baseline: 'present',
        outcome: 'single',
        pack: 'valid',
        roles: 'covered',
        basis: 'stale-prd',
        index: 'fresh',
      }),
      'invalid',
    );
    assert.equal(
      handoffStateModel({
        baseline: 'present',
        outcome: 'absent',
        pack: 'valid',
        roles: 'covered',
        basis: 'fresh',
        index: 'fresh',
      }),
      'plan-only',
    );
  });

  it('exhaustively model-checks context-pack upsert basis preservation', () => {
    const storedStates: StoredBasisState[] = ['absent', 'present'];
    const refreshModes: BasisRefreshMode[] = ['disabled', 'enabled'];
    const resolvedStates: ResolvedBasisState[] = ['unresolved', 'resolved'];

    for (const stored of storedStates) {
      for (const refresh of refreshModes) {
        for (const resolved of resolvedStates) {
          const after = storedBasisAfterUpsertModel({ stored, refresh, resolved });
          if (refresh === 'enabled' && resolved === 'resolved') {
            assert.equal(after, 'present');
            continue;
          }
          assert.equal(after, stored);
        }
      }
    }
  });

  it('exhaustively model-checks generic mode reads fail closed on malformed higher-precedence state', () => {
    const states: GenericPathState[] = ['missing', 'parseable', 'malformed'];
    for (const first of states) {
      for (const second of states) {
        const actual = readModeStateCompatibilityModel([first, second]);
        if (first === 'parseable') {
          assert.equal(actual, 'state');
          continue;
        }
        if (first === 'malformed') {
          assert.equal(actual, null);
          continue;
        }
        if (second === 'parseable') {
          assert.equal(actual, 'state');
        } else {
          assert.equal(actual, null);
        }
      }
    }
  });

  it('property-checks short Team follow-up resolution uses root follow-up state only before approved binding recovery takes over', () => {
    const approvedHint: ReferenceHint = {
      id: 'approved',
      task: 'ship feature',
      command: 'omx team 3:executor "ship feature"',
    };
    const sessionStates = ['active', 'inactive', 'malformed', 'missing'] as const;
    const rootStates = ['active', 'inactive', 'malformed', 'missing'] as const;
    const rootPayloads: Record<(typeof rootStates)[number], TeamFollowupState | null> = {
      active: { task_description: 'ship feature', agent_count: 5 },
      inactive: { task_description: 'other task', agent_count: 2 },
      malformed: null,
      missing: null,
    };

    for (const session of sessionStates) {
      for (const root of rootStates) {
        const resolved = resolveShortTeamFollowupModel(true, approvedHint, rootPayloads[root]);
        if (root === 'active') {
          assert.deepEqual(resolved, { task: 'ship feature', workerCount: 5 });
        } else {
          assert.deepEqual(resolved, { task: 'ship feature', workerCount: 3 }, `session=${session} root=${root}`);
        }
      }
    }
  });

  it('model-checks the Ralph and Team transition graphs for totality and order', () => {
    assert.deepEqual(launchRalphModel('help'), ['help']);
    assert.deepEqual(launchRalphModel('invalid-prd-gate'), ['idle', 'invalid-prd-gate']);
    assert.deepEqual(
      launchRalphModel('runnable'),
      [
        'idle',
        'artifacts-ready',
        'approved-handoff-selected',
        'approved-context-materialized',
        'mode-started',
        'session-files-written',
        'mode-updated(starting)',
        'hud-launched',
      ],
    );

    assert.deepEqual(launchTeamModel('launch'), ['parsed', 'execution-planned', 'runtime-started', 'mode-state-synced', 'summary-rendered']);
    assert.deepEqual(launchTeamModel('resume'), ['runtime-resumed', 'mode-state-synced', 'summary-rendered']);
    assert.deepEqual(launchTeamModel('status'), ['status']);
  });

  it('property-checks last-hint compatibility projection over generated hint sequences', () => {
    const random = lcg(0x22f1656c);
    for (let caseIndex = 0; caseIndex < 64; caseIndex += 1) {
      const hintCount = (random.next().value as number) % 6;
      const generatedHints: ReferenceHint[] = Array.from({ length: hintCount }, (_, index) => ({
        id: `hint-${caseIndex}-${index}`,
        task: `task-${(random.next().value as number) % 7}`,
        command: `omx ralph ${JSON.stringify(`task-${index}`)}`,
      }));
      const selected = projectLastHintModel(generatedHints);
      assert.equal(selected, hintCount === 0 ? null : generatedHints[hintCount - 1]);
    }
  });

  it('exhaustively model-checks explicit selector resolution over the finite newest/older state space', () => {
    const handoffStates: HandoffState[] = ['missing-baseline', 'plan-only', 'ready', 'incomplete', 'invalid'];
    const matchStates: MatchState[] = ['no-match', 'unique', 'ambiguous'];

    for (const newestMatch of matchStates) {
      for (const newestHandoff of handoffStates) {
        for (const olderMatch of matchStates) {
          for (const olderHandoff of handoffStates) {
            const candidates: Candidate[] = [
              {
                id: 'newest',
                task: 'task',
                command: 'omx team 2:executor "task"',
                handoffState: newestHandoff,
                matchState: newestMatch,
                workerCount: 2,
                agentType: 'executor',
              },
              {
                id: 'older',
                task: 'task',
                command: 'omx team 2:executor "task"',
                handoffState: olderHandoff,
                matchState: olderMatch,
                workerCount: 2,
                agentType: 'executor',
              },
            ];
            const resolved = resolveExplicitModel(candidates);
            const rerun = resolveExplicitModel(candidates);
            assert.deepEqual(resolved, rerun, 'explicit selector resolution must be deterministic');
            if (newestMatch === 'ambiguous') {
              assert.equal(resolved, null);
            }
            if (newestMatch === 'unique' && executionReusable(newestHandoff)) {
              assert.equal(resolved?.id, 'newest');
            }
            if (
              newestMatch === 'unique'
              && surfacedNonReady(newestHandoff)
              && olderMatch === 'unique'
              && executionReusable(olderHandoff)
            ) {
              assert.equal(resolved?.id, 'older');
            } else if (
              newestMatch === 'unique'
              && newestHandoff === 'missing-baseline'
              && olderMatch !== 'ambiguous'
              && !(olderMatch === 'unique' && broken(olderHandoff))
              && !(olderMatch === 'unique' && executionReusable(olderHandoff))
            ) {
              assert.equal(resolved?.id, 'newest');
            }
          }
        }
      }
    }
  });

  it('exhaustively model-checks canonical PRD and pack mutation input classification', () => {
    for (const provided of [false, true]) {
      for (const directMember of [false, true]) {
        for (const realpathMatchesMember of [false, true]) {
          const state = classifyCanonicalPrdInputModel(provided, directMember, realpathMatchesMember);
          if (!provided) {
            assert.equal(state, 'absent');
          } else if (directMember || realpathMatchesMember) {
            assert.equal(state, 'canonical-existing');
          } else {
            assert.equal(state, 'noncanonical');
          }
        }
      }
    }

    for (const canonicalShape of [false, true]) {
      for (const alreadyExists of [false, true]) {
        const state = classifyCanonicalPackMutationInputModel(canonicalShape, alreadyExists);
        if (!canonicalShape) {
          assert.equal(state, 'noncanonical');
        } else if (alreadyExists) {
          assert.equal(state, 'canonical-existing');
        } else {
          assert.equal(state, 'canonical-creatable');
        }
      }
    }
  });

  it('exhaustively model-checks bare same-task lineage fallback and ambiguity terminality', () => {
    const handoffStates: HandoffState[] = ['missing-baseline', 'plan-only', 'ready', 'incomplete', 'invalid'];
    const matchStates: MatchState[] = ['no-match', 'unique', 'ambiguous'];

    for (const latestMatch of matchStates) {
      for (const latestHandoff of handoffStates) {
        for (const olderSameTaskMatch of matchStates) {
          for (const olderSameTaskHandoff of handoffStates) {
            const latest: Candidate = {
              id: 'latest',
              task: 'shared',
              command: 'omx ralph "shared"',
              handoffState: latestHandoff,
              matchState: latestMatch,
            };
            const olderSameTask: Candidate = {
              id: 'older-same-task',
              task: 'shared',
              command: 'omx ralph "shared"',
              handoffState: olderSameTaskHandoff,
              matchState: olderSameTaskMatch,
            };
            const olderDifferentTask: Candidate = {
              id: 'older-different-task',
              task: 'different',
              command: 'omx ralph "different"',
              handoffState: 'ready',
              matchState: 'unique',
            };

            const resolved = resolveBareModel([latest, olderSameTask, olderDifferentTask]);
            assert.deepEqual(resolved, resolveBareModel([latest, olderSameTask, olderDifferentTask]));

            if (latestMatch !== 'unique') {
              assert.equal(resolved, null);
              continue;
            }
            if (executionReusable(latestHandoff)) {
              assert.equal(resolved?.id, 'latest');
              continue;
            }
            if (olderSameTaskMatch === 'ambiguous') {
              assert.equal(resolved, null);
              continue;
            }
            if (olderSameTaskMatch === 'unique' && executionReusable(olderSameTaskHandoff)) {
              assert.equal(resolved?.id, 'older-same-task');
              continue;
            }
            assert.notEqual(resolved?.id, 'older-different-task');
            if (
              latestHandoff === 'missing-baseline'
              && !(olderSameTaskMatch === 'unique' && broken(olderSameTaskHandoff))
              && !(olderSameTaskMatch === 'unique' && executionReusable(olderSameTaskHandoff))
            ) {
              assert.equal(resolved?.id, 'latest');
            }
          }
        }
      }
    }
  });

  it('model-checks Team same-task fallback stays on the same launch signature', () => {
    const latest: Candidate = {
      id: 'latest',
      task: 'shared',
      command: 'omx team 5:debugger "shared"',
      handoffState: 'incomplete',
      matchState: 'unique',
      workerCount: 5,
      agentType: 'debugger',
    };
    const olderDifferentSignature: Candidate = {
      id: 'older-different-signature',
      task: 'shared',
      command: 'omx team 2:executor "shared"',
      handoffState: 'ready',
      matchState: 'unique',
      workerCount: 2,
      agentType: 'executor',
    };
    const olderSameSignature: Candidate = {
      id: 'older-same-signature',
      task: 'shared',
      command: 'omx team 5:debugger "shared"',
      handoffState: 'ready',
      matchState: 'unique',
      workerCount: 5,
      agentType: 'debugger',
    };

    assert.equal(resolveBareTeamModel([latest, olderDifferentSignature])?.id, 'latest');
    assert.equal(resolveBareTeamModel([latest, olderSameSignature])?.id, 'older-same-signature');
  });

  it('model-checks Team explicit task fallback stays on the same launch signature', () => {
    const latest: Candidate = {
      id: 'latest',
      task: 'shared',
      command: 'omx team 5:debugger "shared"',
      handoffState: 'incomplete',
      matchState: 'unique',
      workerCount: 5,
      agentType: 'debugger',
    };
    const olderDifferentSignature: Candidate = {
      id: 'older-different-signature',
      task: 'shared',
      command: 'omx team 2:executor "shared"',
      handoffState: 'ready',
      matchState: 'unique',
      workerCount: 2,
      agentType: 'executor',
    };
    const olderSameSignature: Candidate = {
      id: 'older-same-signature',
      task: 'shared',
      command: 'omx team 5:debugger "shared"',
      handoffState: 'ready',
      matchState: 'unique',
      workerCount: 5,
      agentType: 'debugger',
    };

    assert.equal(resolveExplicitTeamModel([latest, olderDifferentSignature])?.id, 'latest');
    assert.equal(resolveExplicitTeamModel([latest, olderSameSignature])?.id, 'older-same-signature');
    assert.equal(
      resolveExplicitTeamModel([latest, olderSameSignature, olderDifferentSignature])?.id,
      'older-same-signature',
    );
  });

  it('exhaustively model-checks effective Team state-root selection', () => {
    const cwd = '/repo';
    const visibleStates = [
      { kind: 'session-active' as const, team_state_root: '/custom/session-root' },
      { kind: 'session-active' as const, team_state_root: '' },
      { kind: 'root-active' as const, team_state_root: '/custom/root-state' },
      { kind: 'root-active' as const },
      { kind: 'none' as const },
    ];

    for (const visibleState of visibleStates) {
      const root = effectiveTeamStateRootModel(visibleState, cwd);
      if (visibleState.kind === 'none') {
        assert.equal(root, null);
      } else if (visibleState.team_state_root && visibleState.team_state_root.trim() !== '') {
        assert.equal(root, visibleState.team_state_root);
      } else {
        assert.equal(root, join(cwd, '.omx', 'state'));
      }
    }
  });

  it('exhaustively model-checks generic mode reads fail closed while Team active-state fallback remains permissive', () => {
    const genericStates: GenericPathState[] = ['missing', 'parseable', 'malformed'];
    for (const session of genericStates) {
      for (const root of genericStates) {
        const generic = readGenericModeStateModel([session, root]);
        if (session === 'parseable') {
          assert.equal(generic, 'state');
        } else if (session === 'malformed') {
          assert.equal(generic, null);
        } else if (root === 'parseable') {
          assert.equal(generic, 'state');
        } else {
          assert.equal(generic, null);
        }
      }
    }

    const teamStates: ActiveTeamIdentityState[] = ['missing', 'active-complete', 'active-incomplete', 'inactive', 'malformed'];
    for (const session of teamStates) {
      for (const root of teamStates) {
        const activeTeam = readActiveTeamStateModel(session, root);
        if (session === 'active-complete') {
          assert.equal(activeTeam, 'session');
        } else if (root === 'active-complete') {
          assert.equal(activeTeam, 'root');
        } else {
          assert.equal(activeTeam, null);
        }
      }
    }
  });

  it('exhaustively model-checks that rejected bound handoffs cannot contaminate generic short Team launches', () => {
    const boundStates: BoundLaunchState[] = ['unconfigured', 'reusable', 'rejected'];
    for (const boundState of boundStates) {
      const result = shortTeamLaunchBindingModel(boundState);
      if (boundState === 'reusable') {
        assert.equal(result, 'carry-binding');
      } else {
        assert.equal(result, 'drop-binding');
      }
    }
  });

  it('exhaustively model-checks that scaleUp may only rehydrate an existing binding', () => {
    const states: ScaleUpBindingState[] = ['no-binding-file', 'binding-valid', 'binding-stale', 'binding-malformed'];
    for (const state of states) {
      const result = scaleUpBindingProjectionModel(state);
      if (state === 'no-binding-file') {
        assert.equal(result, 'remain-unbound');
      } else if (state === 'binding-valid') {
        assert.equal(result, 'carry-binding');
      } else {
        assert.equal(result, 'fail-closed');
      }
    }
  });

  it('exhaustively model-checks requested approved-execution opt-out and binding hydration states', () => {
    const requestedStates: RequestedApprovedExecutionState[] = ['absent', 'explicit-null', 'explicit-binding'];
    const bindingFileStates: BindingFileState[] = ['missing', 'malformed', 'valid'];
    const hydrationStates: BindingHydrationState[] = ['reusable', 'surfaced-nonready', 'stale', 'ambiguous'];
    const confidenceStates: DiagnosticConfidenceState[] = [
      'reusable-exact-strong-identity',
      'reusable-same-lineage-fallback',
      'surfaced-nonready-lineage-anchor',
      'blocked',
      'ambiguous',
      'stale',
      'malformed',
      'noncanonical',
    ];

    for (const requested of requestedStates) {
      for (const persisted of bindingFileStates) {
        const projection = requestedApprovedExecutionProjectionModel(requested, persisted);
        if (requested === 'explicit-null') {
          assert.equal(projection, 'suppress-persisted');
        } else if (requested === 'explicit-binding') {
          assert.equal(projection, 'use-explicit-binding');
        } else {
          assert.equal(projection, 'use-persisted-if-valid');
        }
      }
    }

    for (const state of hydrationStates) {
      const projection = bindingHydrationProjectionModel(state);
      if (state === 'reusable') {
        assert.equal(projection, 'launchable');
        assert.equal(boundWorkerLaunchProjectionModel(state), 'carry-binding');
      } else if (state === 'surfaced-nonready') {
        assert.equal(projection, 'diagnostic-only');
        assert.equal(boundWorkerLaunchProjectionModel(state), 'drop-binding');
      } else {
        assert.equal(projection, 'blocked');
        assert.equal(boundWorkerLaunchProjectionModel(state), 'drop-binding');
      }
    }

    for (const state of confidenceStates) {
      const confidence = confidenceClassModel(state);
      const projection = diagnosticConfidenceProjectionModel(state);
      if (state === 'reusable-exact-strong-identity') {
        assert.equal(confidence, 100);
        assert.equal(projection, 'launchable');
      } else if (state === 'reusable-same-lineage-fallback') {
        assert.equal(confidence, 85);
        assert.equal(projection, 'launchable');
      } else if (state === 'surfaced-nonready-lineage-anchor') {
        assert.equal(confidence, 40);
        assert.equal(projection, 'diagnostic-only');
      } else {
        assert.equal(confidence, 0);
        assert.equal(projection, 'blocked');
      }
      if (confidence < 85) {
        assert.notEqual(projection, 'launchable');
      }
    }
  });

  it('exhaustively model-checks Team CLI follow-up launch projection preserves bound identity through staffing overrides', () => {
    const states: TeamCliFollowupState[] = ['generic', 'approved-unbound', 'approved-bound', 'rejected-bound', 'blocked'];
    for (const state of states) {
      const projection = teamCliFollowupProjectionModel(state);
      if (state === 'approved-bound') {
        assert.equal(projection, 'carry-existing-binding');
      } else if (state === 'approved-unbound') {
        assert.equal(projection, 'build-binding');
      } else if (state === 'blocked') {
        assert.equal(projection, 'fail-closed');
      } else {
        assert.equal(projection, 'drop-binding');
      }
    }
  });

  it('exhaustively model-checks that pipeline team-exec keeps structural ralplan outputs on the generic path and only carries approved bindings for reusable authoritative handoffs', () => {
    const authorityStates: PlanningArtifactsAuthorityState[] = ['none', 'structural', 'approved-authoritative'];
    const handoffStates: Array<HandoffState | null> = [null, 'missing-baseline', 'plan-only', 'ready', 'incomplete', 'invalid'];

    for (const authorityState of authorityStates) {
      for (const handoffState of handoffStates) {
        const projection = pipelineTeamExecLaunchProjectionModel(authorityState, handoffState);
        if (authorityState === 'none' || authorityState === 'structural') {
          assert.equal(projection, 'structured-generic');
        } else if (handoffState === 'ready') {
          assert.equal(projection, 'structured-approved');
        } else if (handoffState === 'plan-only') {
          assert.equal(projection, 'structured-generic');
        } else {
          assert.equal(projection, 'blocked');
        }
      }
    }
  });

  it('exhaustively model-checks that authoritative team-exec uses the approved PRD task text for ready and plan-only handoffs', () => {
    const authorityStates: PlanningArtifactsAuthorityState[] = ['none', 'structural', 'approved-authoritative'];
    const handoffStates: Array<HandoffState | null> = [null, 'missing-baseline', 'plan-only', 'ready', 'incomplete', 'invalid'];

    for (const authorityState of authorityStates) {
      for (const handoffState of handoffStates) {
        const taskSource = pipelineTeamExecTaskSourceModel(authorityState, handoffState);
        if (authorityState === 'none' || authorityState === 'structural') {
          assert.equal(taskSource, 'upstream-request');
        } else if (handoffState === 'ready' || handoffState === 'plan-only') {
          assert.equal(taskSource, 'approved-hint');
        } else {
          assert.equal(taskSource, 'unreachable');
        }
      }
    }
  });

  it('exhaustively model-checks approved handoff continuity across bootstrap and reassignment inboxes', () => {
    const states: DispatchApprovedContextState[] = ['unbound', 'carry', 'blocked'];
    const surfaces: InboxSurface[] = ['bootstrap', 'reassignment'];

    for (const state of states) {
      for (const surface of surfaces) {
        const projection = dispatchApprovedContextProjectionModel(state, surface);
        if (state === 'carry') {
          assert.equal(projection, 'include-approved-context');
        } else if (state === 'unbound') {
          assert.equal(projection, 'omit-approved-context');
        } else {
          assert.equal(projection, 'fail-closed');
        }
      }
    }
  });

  it('exhaustively model-checks markdown scan states distinguish indented code from real headings', () => {
    assert.equal(markdownScanStateModel('## Context Pack Outcome', false), 'normal');
    assert.equal(markdownScanStateModel('    ## Context Pack Outcome', false), 'indented-code');
    assert.equal(markdownScanStateModel('\t## Build', false), 'indented-code');
    assert.equal(markdownScanStateModel('## Build', true), 'fenced');
    assert.equal(launchHintVisibleInMarkdownModel('omx team 2:executor "Ship feature"', false), true);
    assert.equal(launchHintVisibleInMarkdownModel('    omx team 2:executor "Ship feature"', false), false);
    assert.equal(launchHintVisibleInMarkdownModel('omx ralph "Ship feature"', true), false);
  });

  it('property-checks excerpt cache paths are deterministic and outside the repo tree', () => {
    const random = lcg(0xc0ffee);
    const repoRoot = join(tempDir, 'repo');
    for (let caseIndex = 0; caseIndex < 64; caseIndex += 1) {
      const slug = `issue-${(random.next().value as number) % 1000}`;
      const label = `label-${(random.next().value as number) % 1000}`;
      const index = (random.next().value as number) % 9;
      const packPath = join(repoRoot, '.omx', 'context', `context-20260420T000000Z-${slug}.json`);
      const excerptA = contextPackExcerptPath(packPath, index, label);
      const excerptB = contextPackExcerptPath(packPath, index, label);
      assert.equal(excerptA, excerptB);
      assert.ok(isAbsolute(excerptA));
      const rel = relative(repoRoot, excerptA).replaceAll('\\', '/');
      assert.ok(rel.startsWith('..'), `excerpt cache should be outside repo tree: ${excerptA}`);
    }
  });

  it('property-checks file ref rebinding only changes paths when the target exists', async () => {
    const random = lcg(0x5eed1234);
    const sourceRepoRoot = join(tempDir, 'leader');
    const targetRepoRoot = join(tempDir, 'worker');
    await mkdir(sourceRepoRoot, { recursive: true });
    await mkdir(targetRepoRoot, { recursive: true });

    for (let caseIndex = 0; caseIndex < 48; caseIndex += 1) {
      const relativePath = `docs/path-${caseIndex}-${(random.next().value as number) % 1000}.md`;
      const sourcePath = join(sourceRepoRoot, relativePath);
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, '# Source\n', 'utf8');
      const shouldCreateTarget = ((random.next().value as number) & 1) === 0;
      if (shouldCreateTarget) {
        await mkdir(dirname(join(targetRepoRoot, relativePath)), { recursive: true });
        await writeFile(join(targetRepoRoot, relativePath), '# Target\n', 'utf8');
      } else {
        await rm(join(targetRepoRoot, relativePath), { force: true });
      }
      const ref: ContextPackExecutionRef = {
        roles: ['build'],
        label: `label-${caseIndex}`,
        path: sourcePath,
        sourcePath,
        delivery: 'file',
        relationPath: [
          { tag: 'plan', target: 'issue-model' },
          { tag: 'implements', target: relativePath.replaceAll('\\', '/') },
        ],
        tags: [],
      };

      const rebound = rebindContextRefsForRepoRoot([ref], sourceRepoRoot, targetRepoRoot)[0]!;
      assert.equal(rebound.path, rebindFileProjectionModel(sourceRepoRoot, targetRepoRoot, ref));
    }
  });

  it('rehydrates strong team bindings by exact command and lets legacy ambiguous bindings fail closed', async () => {
    const slug = 'issue-strong-binding';
    const { prdPath } = await writeReadyContextPack(slug);
    const task = 'Ship feature';
    const primaryCommand = `omx team 2:executor ${JSON.stringify(task)}`;
    const secondaryCommand = `$team ralph 5:debugger ${JSON.stringify(task)}`;

    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        '## Context Pack Outcome',
        `- pack: created \`.omx/context/context-20260420T000000Z-${slug}.json\``,
        '',
        `Launch via ${primaryCommand}`,
        `Launch via ${secondaryCommand}`,
      ].join('\n'),
      'utf8',
    );

    const exactHint = readApprovedTeamExecutionHintFromBinding(tempDir, {
      prd_path: prdPath,
      task,
      command: primaryCommand,
    });
    assert.ok(exactHint);
    assert.equal(exactHint?.command, primaryCommand);
    assert.equal(exactHint?.workerCount, 2);
    assert.equal(exactHint?.agentType, 'executor');

    const legacyHint = readApprovedTeamExecutionHintFromBinding(tempDir, {
      prd_path: prdPath,
      task,
    });
    assert.equal(legacyHint, null);
  });

  it('preserves the caller absolute PRD alias when canonical membership is established by realpath', async () => {
    const slug = 'issue-aliased-binding';
    const { prdPath } = await writeReadyContextPack(slug);
    const aliasRoot = `${tempDir}-alias`;
    try {
      await rm(aliasRoot, { recursive: true, force: true });
      await symlink(tempDir, aliasRoot);
      const aliasedPrdPath = join(aliasRoot, '.omx', 'plans', `prd-${slug}.md`);
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          'Launch via omx ralph "Execute aliased lifecycle plan"',
        ].join('\n'),
        'utf8',
      );

      const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph', {
        prdPath: aliasedPrdPath,
        task: 'Execute aliased lifecycle plan',
      });
      assert.equal(hint?.sourcePath, aliasedPrdPath);
    } finally {
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });
});
