import { posix } from 'node:path';
import type {
  AcceptedEquivalent,
  AcceptedEquivalentRequest,
  EvidenceStatus,
  FrozenCapabilityConfig,
  ReviewRecommendation,
  ScopeManifest,
  ScopeFile,
} from './contract.js';

export type Capability = 'LSP' | 'AST' | 'COMPILER' | 'LINT' | 'RG_FALLBACK';
export type FileKind =
  | 'TYPESCRIPT_JAVASCRIPT'
  | 'RUST'
  | 'SHELL'
  | 'STRUCTURED_DATA'
  | 'DOCUMENTATION'
  | 'ASSET'
  | 'UNKNOWN_TEXT'
  | 'UNKNOWN_BINARY'
  | 'SYMLINK'
  | 'GITLINK';

export interface CapabilityPlanEntry {
  capability: Capability;
  applicability: 'APPLICABLE' | 'NOT_APPLICABLE';
  file_kinds: FileKind[];
  required_for: FileKind[];
  fallback_for: Array<'LSP' | 'AST'>;
}

export interface CapabilityPlan {
  file_kinds: Array<{ path: string; kind: FileKind }>;
  capabilities: CapabilityPlanEntry[];
  inherently_degraded: boolean;
}

export interface CapabilityObservation {
  capability: Capability;
  execution: 'NATIVE' | 'ACCEPTED_EQUIVALENT' | 'FALLBACK' | 'UNAVAILABLE' | 'SKIPPED';
  outcome: 'PASS' | 'FAIL' | 'TIMED_OUT' | 'MALFORMED' | 'NOT_RUN';
  source_ref?: string;
  program?: string;
  args?: string[];
}

export interface CapabilityEvaluation {
  evidence_status: EvidenceStatus;
  maximum_recommendation: ReviewRecommendation;
  reasons: string[];
}

export interface BuildCapabilityPlanOptions {
  trustedFrozenConfig?: FrozenCapabilityConfig;
}

export interface HookOwnedApprovalLedgerEntry {
  approval: Record<string, unknown>;
  provenance: {
    event_ref: string;
    nonce: string;
  };
}

export interface PreparedEquivalentConsumption {
  schema_version: 1;
  state: 'PREPARED';
  nonce: string;
  review_id: string;
  capability: 'LSP' | 'AST';
  source_ref: string;
  prepared_at: string;
}

export interface CommittedEquivalentConsumption
  extends Omit<PreparedEquivalentConsumption, 'state'> {
  state: 'COMMITTED';
  committed_at: string;
}

export interface TrustedEquivalentResolution {
  accepted_equivalents: AcceptedEquivalent[];
  reasons: string[];
  prepared_consumptions: PreparedEquivalentConsumption[];
}

export interface EquivalentResolutionContext {
  workingDirectory: string;
  session_id: string;
  root_thread_id: string;
  turn_id: string;
  review_id: string;
  base_sha?: string;
}

export interface ResolveTrustedEquivalentsOptions {
  requests: unknown;
  context: EquivalentResolutionContext;
}

export interface HookApprovalLedgerIdentity {
  session_id: string;
  root_thread_id: string;
  turn_id: string;
}

export interface TrustedEquivalentDependencies {
  loadHookOwnedApprovalLedger?: (
    identity: HookApprovalLedgerIdentity,
  ) => Promise<readonly unknown[]>;
  existingConsumptions?: readonly unknown[];
  readBaseContract?: (workingDirectory: string, args: readonly string[]) => Promise<string>;
  now?: Date;
  approvalTtlMs?: number;
}

export type CapabilitiesErrorCode =
  | 'INVALID_CAPABILITY_CONFIG'
  | 'INVALID_EQUIVALENT_REQUEST'
  | 'INVALID_EQUIVALENT_CONTEXT'
  | 'EQUIVALENT_CONSUMPTION_CONFLICT';

export class CapabilitiesError extends Error {
  readonly code: CapabilitiesErrorCode;

  constructor(code: CapabilitiesErrorCode, message: string) {
    super(message);
    this.name = 'CapabilitiesError';
    this.code = code;
  }
}

const CAPABILITY_ORDER: readonly Capability[] = ['LSP', 'AST', 'COMPILER', 'LINT', 'RG_FALLBACK'];
const FILE_KIND_ORDER: readonly FileKind[] = [
  'TYPESCRIPT_JAVASCRIPT',
  'RUST',
  'SHELL',
  'STRUCTURED_DATA',
  'DOCUMENTATION',
  'ASSET',
  'UNKNOWN_TEXT',
  'UNKNOWN_BINARY',
  'SYMLINK',
  'GITLINK',
];
const TYPE_SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const SHELL_EXTENSIONS = new Set(['.sh', '.bash', '.zsh']);
const STRUCTURED_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml']);
const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt']);
const ASSET_EXTENSIONS = new Set([
  '.avif', '.bmp', '.eot', '.gif', '.ico', '.jpeg', '.jpg', '.otf', '.pdf', '.png', '.svg',
  '.tif', '.tiff', '.ttf', '.webm', '.webp', '.woff', '.woff2', '.mp3', '.mp4', '.mov', '.wav',
]);
const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const EMPTY_FROZEN_CAPABILITY_CONFIG: FrozenCapabilityConfig = {
  schema_version: 1,
  typescript_javascript: { compiler_or_typecheck: false, lint: false },
  rust: { ast_backend: false, clippy: false },
  shell: { parser: false, lint: false, rg: false },
  structured_data: { parser: false, schema: false, lint: false },
};

export interface FrozenBaseConfigFile {
  path: string;
  content?: string;
}

function byteCompare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function isExactBooleanRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, boolean> {
  return isPlainObject(value)
    && hasExactKeys(value, keys)
    && keys.every((key) => typeof value[key] === 'boolean');
}

export function emptyFrozenCapabilityConfig(): FrozenCapabilityConfig {
  return {
    schema_version: 1,
    typescript_javascript: { ...EMPTY_FROZEN_CAPABILITY_CONFIG.typescript_javascript },
    rust: { ...EMPTY_FROZEN_CAPABILITY_CONFIG.rust },
    shell: { ...EMPTY_FROZEN_CAPABILITY_CONFIG.shell },
    structured_data: { ...EMPTY_FROZEN_CAPABILITY_CONFIG.structured_data },
  };
}

function packageScripts(content: string | undefined): Record<string, string> {
  if (content === undefined) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed) || !isPlainObject(parsed.scripts)) return {};
    return Object.fromEntries(Object.entries(parsed.scripts)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

/** Pure derivation over files read from one immutable Git tree. */
export function deriveFrozenCapabilityConfigFromBaseFiles(
  files: readonly FrozenBaseConfigFile[],
): FrozenCapabilityConfig {
  const config = emptyFrozenCapabilityConfig();
  const paths = files.map((file) => file.path.replaceAll('\\', '/'));
  const scripts = files
    .filter((file) => posix.basename(file.path) === 'package.json')
    .flatMap((file) => Object.entries(packageScripts(file.content)));
  const scriptCommands = scripts.map(([, command]) => command);

  config.typescript_javascript.compiler_or_typecheck = paths.some((path) =>
    /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/iu.test(path))
    || scripts.some(([name, command]) =>
      /(?:^|:)(?:typecheck|type-check|check-types|types)(?:$|:)/iu.test(name)
      || /(?:^|[\s;&|])(?:npx\s+)?(?:tsc|vue-tsc)(?:\s|$)/iu.test(command));
  config.typescript_javascript.lint = paths.some((path) =>
    /(?:^|\/)(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.[^/]+)?|biome\.jsonc?|oxlint\.json)$/iu.test(path))
    || scripts.some(([name, command]) =>
      /(?:^|:)lint(?:$|:)/iu.test(name)
      && /(?:^|[\s;&|])(?:npx\s+)?(?:eslint|biome|oxlint|next\s+lint)(?:\s|$)/iu.test(command));
  config.rust.clippy = paths.some((path) => /(?:^|\/)\.?clippy\.toml$/iu.test(path))
    || scriptCommands.some((command) => /(?:^|[\s;&|])cargo\s+clippy(?:\s|$)/iu.test(command));
  const ownsShell = paths.some((path) => /\.(?:sh|bash|zsh)$/iu.test(path));
  const ownsShellcheck = paths.some((path) => /(?:^|\/)\.shellcheckrc$/iu.test(path))
    || scriptCommands.some((command) => /(?:^|[\s;&|])shellcheck(?:\s|$)/iu.test(command));
  config.shell.parser = ownsShell;
  config.shell.rg = ownsShell;
  config.shell.lint = ownsShellcheck;
  config.structured_data.lint = paths.some((path) => /(?:^|\/)biome\.jsonc?$/iu.test(path));
  return config;
}

export function parseFrozenCapabilityConfig(value: unknown): FrozenCapabilityConfig {
  if (value === undefined) return emptyFrozenCapabilityConfig();
  if (!isPlainObject(value)
    || !hasExactKeys(value, [
      'schema_version', 'typescript_javascript', 'rust', 'shell', 'structured_data',
    ])
    || value.schema_version !== 1
    || !isExactBooleanRecord(
      value.typescript_javascript,
      ['compiler_or_typecheck', 'lint'],
    )
    || !isExactBooleanRecord(value.rust, ['ast_backend', 'clippy'])
    || !isExactBooleanRecord(value.shell, ['parser', 'lint', 'rg'])
    || !isExactBooleanRecord(value.structured_data, ['parser', 'schema', 'lint'])) {
    throw new CapabilitiesError(
      'INVALID_CAPABILITY_CONFIG',
      'frozen capability applicability configuration is malformed',
    );
  }
  return {
    schema_version: 1,
    typescript_javascript: {
      compiler_or_typecheck: value.typescript_javascript.compiler_or_typecheck,
      lint: value.typescript_javascript.lint,
    },
    rust: {
      ast_backend: value.rust.ast_backend,
      clippy: value.rust.clippy,
    },
    shell: {
      parser: value.shell.parser,
      lint: value.shell.lint,
      rg: value.shell.rg,
    },
    structured_data: {
      parser: value.structured_data.parser,
      schema: value.structured_data.schema,
      lint: value.structured_data.lint,
    },
  };
}

function boundedString(value: unknown, maximum = 1_024): string | null {
  return typeof value === 'string'
    && value.length > 0
    && [...value].length <= maximum
    && !value.includes('\0')
    && !/[\r\n]/u.test(value)
    ? value
    : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isCapability(value: unknown): value is 'LSP' | 'AST' {
  return value === 'LSP' || value === 'AST';
}

function safeProgram(value: unknown): string | null {
  const program = boundedString(value, 512);
  if (program === null || !/^[a-zA-Z0-9_./:+@-]+$/u.test(program)) return null;
  const executable = program.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  if (executable === undefined || [
    'sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe',
    'pwsh', 'pwsh.exe',
  ].includes(executable)) return null;
  return program;
}

function safeArgs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const args: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || [...entry].length > 1_024 || entry.includes('\0') || /[\r\n]/u.test(entry)) {
      return null;
    }
    args.push(entry);
  }
  return args;
}

export function classifyReviewFile(file: ScopeFile): FileKind {
  if (file.change === 'SYMLINK') return 'SYMLINK';
  if (file.change === 'SUBMODULE') return 'GITLINK';
  const extension = posix.extname(file.path).toLowerCase();
  if (ASSET_EXTENSIONS.has(extension)) return 'ASSET';
  if (file.binary) return 'UNKNOWN_BINARY';
  if (TYPE_SCRIPT_EXTENSIONS.has(extension)) return 'TYPESCRIPT_JAVASCRIPT';
  if (extension === '.rs') return 'RUST';
  if (SHELL_EXTENSIONS.has(extension)) return 'SHELL';
  if (STRUCTURED_EXTENSIONS.has(extension)) return 'STRUCTURED_DATA';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'DOCUMENTATION';
  return 'UNKNOWN_TEXT';
}

function requiredCapabilities(
  kind: FileKind,
  config: FrozenCapabilityConfig,
): Capability[] {
  switch (kind) {
    case 'TYPESCRIPT_JAVASCRIPT': {
      const required: Capability[] = ['LSP', 'AST'];
      if (config.typescript_javascript.compiler_or_typecheck) required.push('COMPILER');
      if (config.typescript_javascript.lint) required.push('LINT');
      return required;
    }
    case 'RUST': {
      const required: Capability[] = ['LSP', 'COMPILER'];
      if (config.rust.ast_backend) required.push('AST');
      if (config.rust.clippy) required.push('LINT');
      return required;
    }
    case 'SHELL': {
      // Spec §7: the shell parser (COMPILER) and bounded rg (RG_FALLBACK) are unconditional for any
      // in-scope shell file; only lint is "configured". Gating parser/rg on base-tree ownership would
      // let a change that adds the repository's first shell script approve with zero diagnostics.
      const required: Capability[] = ['COMPILER', 'RG_FALLBACK'];
      if (config.shell.lint) required.push('LINT');
      return required;
    }
    case 'STRUCTURED_DATA': {
      const required: Capability[] = [];
      if (config.structured_data.parser || config.structured_data.schema) {
        required.push('COMPILER');
      }
      if (config.structured_data.lint) required.push('LINT');
      return required;
    }
    case 'UNKNOWN_TEXT':
      return ['RG_FALLBACK'];
    default:
      return [];
  }
}

function fallbackTargets(
  capability: Capability,
  applicableKinds: ReadonlySet<FileKind>,
  config: FrozenCapabilityConfig,
): Array<'LSP' | 'AST'> {
  if (capability !== 'COMPILER' && capability !== 'LINT' && capability !== 'RG_FALLBACK') return [];
  const targets = new Set<'LSP' | 'AST'>();
  const typescriptFallback = capability === 'RG_FALLBACK'
    || (capability === 'COMPILER' && config.typescript_javascript.compiler_or_typecheck)
    || (capability === 'LINT' && config.typescript_javascript.lint);
  if (applicableKinds.has('TYPESCRIPT_JAVASCRIPT') && typescriptFallback) {
    targets.add('LSP');
    targets.add('AST');
  }
  return ['LSP', 'AST'].filter((target): target is 'LSP' | 'AST' => targets.has(target as 'LSP' | 'AST'));
}

export function buildCapabilityPlan(
  files: readonly ScopeFile[],
  options: BuildCapabilityPlanOptions = {},
): CapabilityPlan {
  const config = parseFrozenCapabilityConfig(options.trustedFrozenConfig);
  const fileKinds = files
    .map((file) => ({ path: file.path, kind: classifyReviewFile(file) }))
    .sort((left, right) => byteCompare(left.path, right.path));
  const kindSet = new Set(fileKinds.map((entry) => entry.kind));
  const capabilities = CAPABILITY_ORDER.map((capability): CapabilityPlanEntry => {
    const requiredKinds = FILE_KIND_ORDER.filter((kind) =>
      kindSet.has(kind) && requiredCapabilities(kind, config).includes(capability),
    );
    const fallbacks = fallbackTargets(capability, kindSet, config);
    const coveredKinds = new Set(requiredKinds);
    if (fallbacks.length > 0 && kindSet.has('TYPESCRIPT_JAVASCRIPT')) {
      coveredKinds.add('TYPESCRIPT_JAVASCRIPT');
    }
    const kinds = FILE_KIND_ORDER.filter((kind) => coveredKinds.has(kind));
    return {
      capability,
      applicability: kinds.length > 0 ? 'APPLICABLE' : 'NOT_APPLICABLE',
      file_kinds: kinds,
      required_for: requiredKinds,
      fallback_for: fallbacks,
    };
  });
  return {
    file_kinds: fileKinds,
    capabilities,
    inherently_degraded: kindSet.has('UNKNOWN_TEXT'),
  };
}

export function buildCapabilityPlanForScope(
  scope: ScopeManifest,
  files: readonly ScopeFile[] = scope.files,
): CapabilityPlan {
  return buildCapabilityPlan(files, {
    trustedFrozenConfig: scope.frozen_capability_config,
  });
}

function failedEvaluation(reasons: string[]): CapabilityEvaluation {
  return {
    evidence_status: 'DEGRADED_EVIDENCE',
    maximum_recommendation: 'REQUEST CHANGES',
    reasons: [...new Set(reasons)],
  };
}

function isObservationCapability(value: unknown): value is Capability {
  return CAPABILITY_ORDER.some((capability) => capability === value);
}

function isObservationOutcome(
  value: unknown,
): value is CapabilityObservation['outcome'] {
  return value === 'PASS'
    || value === 'FAIL'
    || value === 'TIMED_OUT'
    || value === 'MALFORMED'
    || value === 'NOT_RUN';
}

function parseCapabilityObservation(value: unknown): CapabilityObservation | null {
  if (!isPlainObject(value)
    || !isObservationCapability(value.capability)
    || !isObservationOutcome(value.outcome)) return null;
  const execution = value.execution;
  if (execution === 'ACCEPTED_EQUIVALENT') {
    if (!hasExactKeys(value, [
      'capability', 'execution', 'outcome', 'source_ref', 'program', 'args',
    ]) || !isCapability(value.capability) || value.outcome !== 'PASS') return null;
    const sourceRef = boundedString(value.source_ref);
    const program = safeProgram(value.program);
    const args = safeArgs(value.args);
    if (sourceRef === null || program === null || args === null) return null;
    return {
      capability: value.capability,
      execution,
      outcome: 'PASS',
      source_ref: sourceRef,
      program,
      args,
    };
  }
  if (!hasExactKeys(value, ['capability', 'execution', 'outcome'])) return null;
  if (execution === 'NATIVE') {
    return value.outcome === 'NOT_RUN'
      ? null
      : { capability: value.capability, execution, outcome: value.outcome };
  }
  if (execution === 'FALLBACK') {
    return isCapability(value.capability) || value.outcome === 'NOT_RUN'
      ? null
      : { capability: value.capability, execution, outcome: value.outcome };
  }
  if (execution === 'UNAVAILABLE' || execution === 'SKIPPED') {
    return value.outcome === 'NOT_RUN'
      ? { capability: value.capability, execution, outcome: 'NOT_RUN' }
      : null;
  }
  return null;
}

function parseAcceptedEquivalentList(value: unknown): AcceptedEquivalent[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const accepted: AcceptedEquivalent[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)
      || !hasExactKeys(entry, ['capability', 'program', 'args', 'source', 'source_ref'])
      || !isCapability(entry.capability)
      || (entry.source !== 'EXPLICIT_USER' && entry.source !== 'REPO_CONTRACT')) return null;
    const sourceRef = boundedString(entry.source_ref);
    const program = safeProgram(entry.program);
    const args = safeArgs(entry.args);
    if (sourceRef === null || program === null || args === null) return null;
    accepted.push({
      capability: entry.capability,
      source: entry.source,
      source_ref: sourceRef,
      program,
      args,
    });
  }
  const identities = accepted.map((entry) => `${entry.capability}\0${entry.source_ref}`);
  return new Set(identities).size === identities.length ? accepted : null;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function evaluateCapabilityEvidence(
  plan: CapabilityPlan,
  observations: readonly CapabilityObservation[],
  acceptedEquivalents: readonly AcceptedEquivalent[] = [],
): CapabilityEvaluation {
  const applicable = plan.capabilities.filter((entry) => entry.applicability === 'APPLICABLE');
  const applicableNames = new Set(applicable.map((entry) => entry.capability));
  const byCapability = new Map<Capability, CapabilityObservation>();
  const invalid: string[] = [];
  if (!Array.isArray(observations)) return failedEvaluation(['OBSERVATIONS_MALFORMED']);
  const accepted = parseAcceptedEquivalentList(acceptedEquivalents);
  if (accepted === null) invalid.push('ACCEPTED_EQUIVALENTS_MALFORMED');
  for (let index = 0; index < observations.length; index += 1) {
    const observation = parseCapabilityObservation(observations[index]);
    if (observation === null) {
      invalid.push(`OBSERVATION_MALFORMED:${index}`);
      continue;
    }
    if (!applicableNames.has(observation.capability)) {
      invalid.push(`UNEXPECTED_CAPABILITY:${observation.capability}`);
      continue;
    }
    if (byCapability.has(observation.capability)) {
      invalid.push(`DUPLICATE_CAPABILITY:${observation.capability}`);
      continue;
    }
    byCapability.set(observation.capability, observation);
  }
  for (const entry of applicable) {
    if (entry.required_for.length > 0 && !byCapability.has(entry.capability)) {
      invalid.push(`MISSING_CAPABILITY:${entry.capability}`);
    }
  }

  for (const entry of applicable) {
    const observation = byCapability.get(entry.capability);
    if (observation?.execution === 'FALLBACK'
      && !entry.fallback_for.some((target) =>
        byCapability.get(target)?.execution === 'UNAVAILABLE')) {
      invalid.push(`UNEXPECTED_FALLBACK:${entry.capability}`);
    }
    if (observation?.execution === 'ACCEPTED_EQUIVALENT') {
      const matches = (accepted ?? []).filter((equivalent) =>
        equivalent.capability === observation.capability
        && equivalent.source_ref === observation.source_ref
        && equivalent.program === observation.program
        && sameStringArray(equivalent.args, observation.args ?? []),
      );
      if (matches.length !== 1) {
        invalid.push(`UNACCEPTED_EQUIVALENT:${entry.capability}`);
      }
    }
  }
  if (invalid.length > 0) return failedEvaluation(invalid);

  let degraded = plan.inherently_degraded;
  let hardFailure = false;
  const reasons: string[] = plan.inherently_degraded ? ['UNKNOWN_TEXT_REQUIRES_MANUAL_REVIEW'] : [];
  for (const entry of applicable) {
    const observation = byCapability.get(entry.capability);
    if (observation === undefined) continue;
    const unavailable = (entry.capability === 'LSP' || entry.capability === 'AST')
      && observation.execution === 'UNAVAILABLE';
    if (unavailable) {
      const unavailableCapability = entry.capability as 'LSP' | 'AST';
      reasons.push(`${entry.capability}_UNAVAILABLE`);
      const fallbacks = applicable.filter((candidate) =>
        candidate.fallback_for.includes(unavailableCapability),
      );
      if (fallbacks.length === 0 || !fallbacks.every((fallback) => {
        const result = byCapability.get(fallback.capability);
        return result?.execution === 'FALLBACK' && result.outcome === 'PASS';
      })) {
        hardFailure = true;
        reasons.push(`${entry.capability}_FALLBACK_INCOMPLETE`);
      }
      continue;
    }
    if (observation.execution === 'FALLBACK') {
      degraded = true;
      if (observation.outcome !== 'PASS') {
        hardFailure = true;
        reasons.push(`${entry.capability}_FALLBACK_${observation.outcome}`);
      }
      continue;
    }
    if (observation.outcome !== 'PASS'
      || observation.execution === 'UNAVAILABLE'
      || observation.execution === 'SKIPPED') {
      hardFailure = true;
      reasons.push(`${entry.capability}_${observation.outcome}`);
      continue;
    }
  }

  if (hardFailure) return failedEvaluation(reasons);
  return {
    evidence_status: degraded ? 'DEGRADED_EVIDENCE' : 'FULL_EVIDENCE',
    maximum_recommendation: degraded ? 'COMMENT' : 'APPROVE',
    reasons: [...new Set(reasons)],
  };
}

export function parseAcceptedEquivalentRequests(value: unknown): AcceptedEquivalentRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new CapabilitiesError('INVALID_EQUIVALENT_REQUEST', 'accepted equivalent requests must be an array');
  }
  const requests = value.map((entry): AcceptedEquivalentRequest => {
    if (!isPlainObject(entry) || !hasExactKeys(entry, ['capability', 'source_ref'])
      || !isCapability(entry.capability)) {
      throw new CapabilitiesError('INVALID_EQUIVALENT_REQUEST', 'accepted equivalent request is malformed');
    }
    const sourceRef = boundedString(entry.source_ref);
    if (sourceRef === null) {
      throw new CapabilitiesError('INVALID_EQUIVALENT_REQUEST', 'accepted equivalent source_ref is invalid');
    }
    return { capability: entry.capability, source_ref: sourceRef };
  });
  const identities = requests.map((request) => `${request.capability}\0${request.source_ref}`);
  if (new Set(identities).size !== identities.length) {
    throw new CapabilitiesError('INVALID_EQUIVALENT_REQUEST', 'accepted equivalent request is duplicated');
  }
  return requests;
}

interface ParsedHookApproval {
  session_id: string;
  root_thread_id: string;
  turn_id: string;
  capability: 'LSP' | 'AST';
  source_ref: string;
  program: string;
  args: string[];
  approved_at: string;
  nonce: string;
}

function parseHookApproval(value: unknown): ParsedHookApproval | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ['approval', 'provenance'])
    || !isPlainObject(value.approval) || !isPlainObject(value.provenance)) return null;
  const approval = value.approval;
  const provenance = value.provenance;
  if (!hasExactKeys(approval, [
    'schema_version', 'session_id', 'root_thread_id', 'turn_id', 'capability', 'source_ref',
    'program', 'args', 'approved_at', 'nonce',
  ]) || !hasExactKeys(provenance, ['event_ref', 'nonce'])
    || approval.schema_version !== 1 || !isCapability(approval.capability)
  ) return null;
  const sessionId = boundedString(approval.session_id, 160);
  const rootThreadId = boundedString(approval.root_thread_id, 160);
  const turnId = boundedString(approval.turn_id, 160);
  const sourceRef = boundedString(approval.source_ref);
  const program = safeProgram(approval.program);
  const args = safeArgs(approval.args);
  const approvedAt = boundedString(approval.approved_at, 64);
  const nonce = boundedString(approval.nonce, 160);
  const provenanceNonce = boundedString(provenance.nonce, 160);
  const eventRef = boundedString(provenance.event_ref);
  if (sessionId === null || rootThreadId === null || turnId === null || sourceRef === null
    || program === null || args === null || approvedAt === null || nonce === null
    || provenanceNonce !== nonce || eventRef === null || !Number.isFinite(Date.parse(approvedAt))) return null;
  return {
    session_id: sessionId,
    root_thread_id: rootThreadId,
    turn_id: turnId,
    capability: approval.capability,
    source_ref: sourceRef,
    program,
    args,
    approved_at: approvedAt,
    nonce,
  };
}

function parseHookApprovalLedger(value: unknown): ParsedHookApproval[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const entries: ParsedHookApproval[] = [];
  for (const candidate of value) {
    const entry = parseHookApproval(candidate);
    if (entry === null) return null;
    entries.push(entry);
  }
  return entries;
}

interface EquivalentConsumptionInput {
  nonce: string;
  review_id: string;
  capability: 'LSP' | 'AST';
  source_ref: string;
}

function validateConsumptionIdentity(value: unknown): EquivalentConsumptionInput {
  if (!isPlainObject(value) || !hasExactKeys(value, ['nonce', 'review_id', 'capability', 'source_ref'])
    || !isCapability(value.capability)) {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'equivalent consumption identity is malformed');
  }
  const nonce = boundedString(value.nonce, 160);
  const reviewId = boundedString(value.review_id, 64);
  const sourceRef = boundedString(value.source_ref);
  if (nonce === null || reviewId === null || !isUuid(reviewId) || sourceRef === null) {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'equivalent consumption identity is malformed');
  }
  return { nonce, review_id: reviewId, capability: value.capability, source_ref: sourceRef };
}

function parseConsumption(
  value: unknown,
): PreparedEquivalentConsumption | CommittedEquivalentConsumption {
  if (!isPlainObject(value) || (value.state !== 'PREPARED' && value.state !== 'COMMITTED')) {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'equivalent consumption is malformed');
  }
  const committed = value.state === 'COMMITTED';
  const keys = committed
    ? ['schema_version', 'state', 'nonce', 'review_id', 'capability', 'source_ref', 'prepared_at', 'committed_at']
    : ['schema_version', 'state', 'nonce', 'review_id', 'capability', 'source_ref', 'prepared_at'];
  if (!hasExactKeys(value, keys) || value.schema_version !== 1 || !isCapability(value.capability)) {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'equivalent consumption is malformed');
  }
  const identity = validateConsumptionIdentity({
    nonce: value.nonce,
    review_id: value.review_id,
    capability: value.capability,
    source_ref: value.source_ref,
  });
  const preparedAt = boundedString(value.prepared_at, 64);
  const committedAt = committed ? boundedString(value.committed_at, 64) : null;
  if (preparedAt === null || !Number.isFinite(Date.parse(preparedAt))
    || (committed && (committedAt === null || !Number.isFinite(Date.parse(committedAt))))) {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'equivalent consumption timestamp is invalid');
  }
  const prepared: PreparedEquivalentConsumption = {
    schema_version: 1,
    state: 'PREPARED',
    ...identity,
    prepared_at: preparedAt,
  };
  return committed
    ? { ...prepared, state: 'COMMITTED', committed_at: committedAt as string }
    : prepared;
}

function sameConsumptionIdentity(
  left: EquivalentConsumptionInput,
  right: EquivalentConsumptionInput,
): boolean {
  return left.nonce === right.nonce
    && left.review_id === right.review_id
    && left.capability === right.capability
    && left.source_ref === right.source_ref;
}

function assertSameConsumption(
  expected: EquivalentConsumptionInput,
  existing: PreparedEquivalentConsumption | CommittedEquivalentConsumption,
): void {
  if (!sameConsumptionIdentity(expected, existing)) {
    throw new CapabilitiesError(
      'EQUIVALENT_CONSUMPTION_CONFLICT',
      'approval nonce is already bound to a different review',
    );
  }
}

export function prepareEquivalentConsumption(
  inputValue: EquivalentConsumptionInput,
  existing?: unknown,
  now = new Date(),
): PreparedEquivalentConsumption | CommittedEquivalentConsumption {
  const input = validateConsumptionIdentity(inputValue);
  if (existing !== undefined) {
    const parsed = parseConsumption(existing);
    assertSameConsumption(input, parsed);
    return parsed;
  }
  return {
    schema_version: 1,
    state: 'PREPARED',
    ...input,
    prepared_at: now.toISOString(),
  };
}

export function commitEquivalentConsumption(
  preparedValue: PreparedEquivalentConsumption,
  existing?: unknown,
  now = new Date(),
): CommittedEquivalentConsumption {
  const prepared = parseConsumption(preparedValue);
  if (prepared.state !== 'PREPARED') {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'only a prepared consumption can commit');
  }
  if (existing !== undefined) {
    const parsed = parseConsumption(existing);
    assertSameConsumption(prepared, parsed);
    if (parsed.state === 'COMMITTED') return parsed;
  }
  return { ...prepared, state: 'COMMITTED', committed_at: now.toISOString() };
}

export function recoverEquivalentConsumption(
  preparedValue: PreparedEquivalentConsumption,
  existing: unknown,
): PreparedEquivalentConsumption | CommittedEquivalentConsumption {
  const prepared = parseConsumption(preparedValue);
  if (prepared.state !== 'PREPARED') {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'recovery intent is not prepared');
  }
  const parsed = parseConsumption(existing);
  assertSameConsumption(prepared, parsed);
  return parsed;
}

interface RepositoryEquivalent {
  capability: 'LSP' | 'AST';
  program: string;
  args: string[];
  rule_id: string;
}

function parseRepositoryContract(text: string): RepositoryEquivalent[] | null {
  if (Buffer.byteLength(text, 'utf8') > 64 * 1_024) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(value) || !hasExactKeys(value, ['schema_version', 'equivalents'])
    || value.schema_version !== 1 || !Array.isArray(value.equivalents)
    || value.equivalents.length > 128) return null;
  const equivalents: RepositoryEquivalent[] = [];
  for (const entry of value.equivalents) {
    if (!isPlainObject(entry)
      || !hasExactKeys(entry, ['capability', 'program', 'args', 'rule_id'])
      || !isCapability(entry.capability)) return null;
    const program = safeProgram(entry.program);
    const args = safeArgs(entry.args);
    const ruleId = boundedString(entry.rule_id, 160);
    if (program === null || args === null || ruleId === null
      || !/^[a-zA-Z0-9_.-]+$/u.test(ruleId)) return null;
    equivalents.push({ capability: entry.capability, program, args, rule_id: ruleId });
  }
  if (new Set(equivalents.map((entry) => entry.rule_id)).size !== equivalents.length) return null;
  return equivalents;
}

function rawConsumptionNonce(value: unknown): unknown {
  return isPlainObject(value) ? value.nonce : undefined;
}

function reason(capability: 'LSP' | 'AST', code: string): string {
  return `${capability}_${code}`;
}

function validateResolutionOptions(
  value: unknown,
): { requests: unknown; context: EquivalentResolutionContext } {
  if (!isPlainObject(value) || !hasExactKeys(value, ['requests', 'context'])
    || !isPlainObject(value.context)) {
    throw new CapabilitiesError(
      'INVALID_EQUIVALENT_CONTEXT',
      'equivalent resolution input is malformed',
    );
  }
  const context = value.context;
  const contextKeys = context.base_sha === undefined
    ? ['workingDirectory', 'session_id', 'root_thread_id', 'turn_id', 'review_id']
    : ['workingDirectory', 'session_id', 'root_thread_id', 'turn_id', 'review_id', 'base_sha'];
  if (!hasExactKeys(context, contextKeys)) {
    throw new CapabilitiesError(
      'INVALID_EQUIVALENT_CONTEXT',
      'equivalent resolution context is malformed',
    );
  }
  const workingDirectory = boundedString(context.workingDirectory);
  const sessionId = boundedString(context.session_id, 160);
  const rootThreadId = boundedString(context.root_thread_id, 160);
  const turnId = boundedString(context.turn_id, 160);
  const reviewId = boundedString(context.review_id, 64);
  let baseSha: string | undefined;
  if (context.base_sha !== undefined) {
    const parsedBaseSha = boundedString(context.base_sha, 128);
    if (parsedBaseSha === null) {
      throw new CapabilitiesError(
        'INVALID_EQUIVALENT_CONTEXT',
        'equivalent resolution context is malformed',
      );
    }
    baseSha = parsedBaseSha;
  }
  if (workingDirectory === null || sessionId === null || rootThreadId === null
    || turnId === null || reviewId === null || !isUuid(reviewId)) {
    throw new CapabilitiesError(
      'INVALID_EQUIVALENT_CONTEXT',
      'equivalent resolution context is malformed',
    );
  }
  return {
    requests: value.requests,
    context: {
      workingDirectory,
      session_id: sessionId,
      root_thread_id: rootThreadId,
      turn_id: turnId,
      review_id: reviewId,
      ...(baseSha === undefined ? {} : { base_sha: baseSha }),
    },
  };
}

function compareEquivalentRequests(
  left: AcceptedEquivalentRequest,
  right: AcceptedEquivalentRequest,
): number {
  const capabilityOrder = { LSP: 0, AST: 1 } as const;
  return capabilityOrder[left.capability] - capabilityOrder[right.capability]
    || byteCompare(left.source_ref, right.source_ref);
}

export async function resolveTrustedEquivalents(
  options: ResolveTrustedEquivalentsOptions,
  trustedDependencies: TrustedEquivalentDependencies = {},
): Promise<TrustedEquivalentResolution> {
  const input = validateResolutionOptions(options);
  const requests = parseAcceptedEquivalentRequests(input.requests).sort(compareEquivalentRequests);
  const now = trustedDependencies.now ?? new Date();
  const ttl = trustedDependencies.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const consumptions = trustedDependencies.existingConsumptions ?? [];
  const accepted: AcceptedEquivalent[] = [];
  const reasons: string[] = [];
  const preparedConsumptions: PreparedEquivalentConsumption[] = [];
  let repositoryContract: RepositoryEquivalent[] | null | undefined;
  let ledger: ParsedHookApproval[] = [];
  if (trustedDependencies.loadHookOwnedApprovalLedger !== undefined && requests.length > 0) {
    try {
      ledger = parseHookApprovalLedger(await trustedDependencies.loadHookOwnedApprovalLedger({
        session_id: input.context.session_id,
        root_thread_id: input.context.root_thread_id,
        turn_id: input.context.turn_id,
      })) ?? [];
    } catch {
      ledger = [];
    }
  }
  const nonceCounts = new Map<string, number>();
  for (const entry of ledger) {
    nonceCounts.set(entry.nonce, (nonceCounts.get(entry.nonce) ?? 0) + 1);
  }
  const duplicatedNonces = new Set(
    [...nonceCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([nonce]) => nonce),
  );

  for (const request of requests) {
    const candidates = ledger.filter((entry) =>
      entry.capability === request.capability && entry.source_ref === request.source_ref);
    if (candidates.length > 0) {
      if (candidates.length !== 1) {
        reasons.push(reason(request.capability, 'EXPLICIT_APPROVAL_DUPLICATE'));
        continue;
      }
      const approval = candidates[0] as ParsedHookApproval;
      if (duplicatedNonces.has(approval.nonce)) {
        reasons.push(reason(request.capability, 'APPROVAL_NONCE_CONFLICT'));
        continue;
      }
      const approvedAt = Date.parse(approval.approved_at);
      if (approval.session_id !== input.context.session_id
        || approval.root_thread_id !== input.context.root_thread_id
        || approval.turn_id !== input.context.turn_id
        || approval.capability !== request.capability
        || approval.source_ref !== request.source_ref
        || !Number.isSafeInteger(ttl) || ttl <= 0
        || approvedAt > now.getTime()
        || now.getTime() - approvedAt > ttl) {
        reasons.push(reason(request.capability, 'EXPLICIT_APPROVAL_UNAVAILABLE'));
        continue;
      }

      const matchingConsumptions = [...consumptions, ...preparedConsumptions]
        .filter((entry) => rawConsumptionNonce(entry) === approval.nonce);
      if (matchingConsumptions.length > 1) {
        reasons.push(reason(request.capability, 'APPROVAL_NONCE_CONFLICT'));
        continue;
      }
      let existing: PreparedEquivalentConsumption | CommittedEquivalentConsumption | undefined;
      if (matchingConsumptions.length === 1) {
        try {
          existing = parseConsumption(matchingConsumptions[0]);
        } catch {
          reasons.push(reason(request.capability, 'APPROVAL_CONSUMPTION_UNVERIFIABLE'));
          continue;
        }
      }
      const identity: EquivalentConsumptionInput = {
        nonce: approval.nonce,
        review_id: input.context.review_id,
        capability: request.capability,
        source_ref: request.source_ref,
      };
      let consumption: PreparedEquivalentConsumption | CommittedEquivalentConsumption;
      try {
        consumption = prepareEquivalentConsumption(identity, existing, now);
      } catch {
        reasons.push(reason(request.capability, 'APPROVAL_NONCE_CONFLICT'));
        continue;
      }
      accepted.push({
        capability: request.capability,
        source: 'EXPLICIT_USER',
        source_ref: request.source_ref,
        program: approval.program,
        args: [...approval.args],
      });
      if (consumption.state === 'PREPARED') preparedConsumptions.push(consumption);
      continue;
    }

    const baseSha = input.context.base_sha;
    if (baseSha === undefined || !FULL_GIT_OBJECT_ID.test(baseSha)) {
      reasons.push(reason(request.capability, 'TRUSTED_SOURCE_UNAVAILABLE'));
      continue;
    }
    const prefix = `${baseSha}:code-review-equivalents.json#`;
    if (!request.source_ref.startsWith(prefix)) {
      reasons.push(reason(request.capability, 'TRUSTED_SOURCE_UNAVAILABLE'));
      continue;
    }
    const ruleId = request.source_ref.slice(prefix.length);
    if (!/^[a-zA-Z0-9_.-]+$/u.test(ruleId)
      || trustedDependencies.readBaseContract === undefined) {
      reasons.push(reason(request.capability, 'REPO_CONTRACT_UNAVAILABLE'));
      continue;
    }
    if (repositoryContract === undefined) {
      try {
        const text = await trustedDependencies.readBaseContract(
          input.context.workingDirectory,
          ['show', `${baseSha}:code-review-equivalents.json`],
        );
        repositoryContract = parseRepositoryContract(text);
      } catch {
        repositoryContract = null;
      }
    }
    if (repositoryContract === null) {
      reasons.push(reason(request.capability, 'REPO_CONTRACT_INVALID'));
      continue;
    }
    const matches = repositoryContract.filter((entry) =>
      entry.rule_id === ruleId && entry.capability === request.capability,
    );
    if (matches.length !== 1) {
      reasons.push(reason(request.capability, 'REPO_RULE_UNAVAILABLE'));
      continue;
    }
    const equivalent = matches[0] as RepositoryEquivalent;
    accepted.push({
      capability: equivalent.capability,
      program: equivalent.program,
      args: [...equivalent.args],
      source: 'REPO_CONTRACT',
      source_ref: request.source_ref,
    });
  }

  return {
    accepted_equivalents: accepted,
    reasons,
    prepared_consumptions: preparedConsumptions,
  };
}
