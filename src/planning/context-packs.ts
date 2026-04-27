import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { advanceMarkdownFenceState, isIndentedMarkdownCodeLine, type MarkdownFenceState } from './markdown-structure.js';
import { isCanonicalContextPackPath, normalizePlanningRepoRelativePath } from './path-utils.js';

export const CONTEXT_PACK_SCHEMA = 'omx-context-pack-v1';
const CONTEXT_PACK_FILE_PATTERN = /^context-(?<timestamp>\d{8}T\d{6}Z)-(?<slug>.+)\.json$/i;
const COMPACT_TOKEN_PATTERN = /^[a-z][a-z0-9-]*$/;
const HEADING_PATTERN = /^(?<level>#{1,6})\s+(?<title>.+?)\s*$/;
const SHORT_SOURCE_MAX_WORDS = 240;
const SHORT_SOURCE_MAX_NON_EMPTY_LINES = 28;
const DEFAULT_HEADING_EXCERPT_MAX_WORDS = 160;
const MAX_HEADING_EXCERPT_MAX_WORDS = 240;
const MAX_TAGS_PER_ENTRY = 8;
const MAX_RELATION_PATH_STEPS = 5;
const MAX_RELATION_TARGET_LENGTH = 180;
const MAX_LABEL_LENGTH = 80;
const MAX_SLUG_LENGTH = 120;
const MAX_PATH_LENGTH = 240;
const SHA1_PATTERN = /^[0-9a-f]{40}$/i;
const PRD_FILENAME_PATTERN = /^prd-(?<slug>.*)\.md$/i;
const TEST_SPEC_FILENAME_PATTERN = /^test-?spec-(?<slug>.*)\.md$/i;
const CONTEXT_PACK_VIEW_NOTES_START = '<!-- OMX:CONTEXT:VIEW-NOTES:START -->';
const CONTEXT_PACK_VIEW_NOTES_END = '<!-- OMX:CONTEXT:VIEW-NOTES:END -->';
const CONTEXT_PACK_VIEW_NOTES_PLACEHOLDER = '<!-- Optional planner-added notes on when to use specific role or tag views. Keep them concise, advisory, and focused on when a role/tag view helps answer a concrete implementation question. -->';

export const CONTEXT_PACK_ROLES = ['scope', 'build', 'verify'] as const;
export type ContextPackRole = (typeof CONTEXT_PACK_ROLES)[number];
export const REQUIRED_CONTEXT_PACK_ROLES = [...CONTEXT_PACK_ROLES];

const MAX_ENTRY_ROLES = CONTEXT_PACK_ROLES.length;
const CONTEXT_PACK_ROLE_SET = new Set<string>(CONTEXT_PACK_ROLES);
const CONTEXT_PACK_ROLE_ORDER = new Map(CONTEXT_PACK_ROLES.map((role, index) => [role, index]));
const CONTEXT_PACK_INDEX_VIEW_ORDER: readonly ContextPackRole[] = ['build', 'verify', 'scope'];

export interface ContextPackRelationStep {
  tag: string;
  target: string;
}

export type ContextPackSelector =
  | {
    type: 'heading';
    value: string;
    maxWords?: number;
  }
  | {
    type: 'lines';
    start: number;
    end: number;
  };

export interface ContextPackEntry {
  label: string;
  path: string;
  roles: ContextPackRole[];
  tags: string[];
  selector?: ContextPackSelector;
  relationPath: ContextPackRelationStep[];
}

export interface ContextPackBasisObject {
  path: string;
  sha1: string;
}

export interface ContextPackBasis {
  prd: ContextPackBasisObject;
  testSpecs: ContextPackBasisObject[];
}

export interface ContextPackDocument {
  schema: string;
  slug: string;
  basis?: ContextPackBasis;
  entries: ContextPackEntry[];
}

export interface ContextPackEntryInput {
  path: string;
  label?: string;
  roles?: readonly ContextPackRole[];
  tags?: readonly string[];
  selector?: ContextPackSelector;
  relationPath?: readonly ContextPackRelationStep[];
}

export interface ContextPackPathInfo {
  timestamp: string;
  slugHint: string;
}

export interface ContextPackExecutionRef {
  roles: ContextPackRole[];
  label: string;
  // Delivery path executors should open first: either the direct source file or a generated excerpt.
  path: string;
  // Canonical repo source behind this ref, even when `path` points at a generated excerpt.
  sourcePath: string;
  delivery: 'file' | 'excerpt';
  // Advisory graph metadata. Roles remain the behavioral authority for execution.
  relationPath: ContextPackRelationStep[];
  tags: string[];
}

export interface ContextPackExecutionRefResolution {
  refs: ContextPackExecutionRef[];
  issues: string[];
}

export interface ContextPackUpsertResult {
  packPath: string;
  indexPath: string;
  slug: string;
  addedLabels: string[];
  updatedLabels: string[];
  document: ContextPackDocument;
}

export interface ContextPackGeneratedIndexInspection {
  status: 'ready' | 'missing' | 'invalid';
  issues: string[];
}

export interface ContextPackWriteOptions {
  repoRoot?: string;
  refreshBasis?: boolean;
}

interface ValidateContextPackManifestOptions {
  packPath: string;
  expectedSlug?: string;
  repoRoot: string;
  requireFreshBasis?: boolean;
  requireGeneratedIndex?: boolean;
}

interface MaterializeContextPackRefsOptions extends ValidateContextPackManifestOptions {
  roles?: readonly ContextPackRole[];
  labels?: readonly string[];
  tags?: readonly string[];
}

function compactToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function countNonEmptyLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '').length;
}

function isShortSourceText(text: string): boolean {
  return countWords(text) <= SHORT_SOURCE_MAX_WORDS
    && countNonEmptyLines(text) <= SHORT_SOURCE_MAX_NON_EMPTY_LINES;
}

function slugifyToken(raw: string): string {
  return compactToken(raw).slice(0, MAX_LABEL_LENGTH);
}

function compactTokenOrThrow(raw: unknown, message: string): string {
  if (typeof raw !== 'string') {
    throw new Error(message);
  }
  const normalized = slugifyToken(raw);
  if (!COMPACT_TOKEN_PATTERN.test(normalized)) {
    throw new Error(message);
  }
  return normalized;
}

export function normalizeContextPackCompactToken(raw: unknown, message: string): string {
  return compactTokenOrThrow(raw, message);
}

function normalizeSourcePath(rawPath: unknown, message: string): string {
  if (typeof rawPath !== 'string') {
    throw new Error(message);
  }
  const trimmed = rawPath.trim().replace(/^`|`$/g, '');
  const normalized = normalizePlanningRepoRelativePath(rawPath);
  const segments = normalized.split('/');
  if (
    normalized === ''
    || normalized === '.'
    || /^[A-Za-z]:/.test(trimmed)
    || /^[A-Za-z]:/.test(normalized)
    || normalized.startsWith('/')
    || /^(?:https?:|file:)/i.test(normalized)
    || segments.includes('..')
    || normalized.length > MAX_PATH_LENGTH
  ) {
    throw new Error(message);
  }
  return normalized;
}

function normalizeSha1(raw: unknown, message: string): string {
  if (typeof raw !== 'string' || !SHA1_PATTERN.test(raw.trim())) {
    throw new Error(message);
  }
  return raw.trim().toLowerCase();
}

function computeGitBlobSha1(buffer: Buffer): string {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

export function computeContextPackObjectSha1(filePath: string): string {
  try {
    const hash = execFileSync('git', ['hash-object', '--no-filters', filePath], {
      cwd: dirname(filePath),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (SHA1_PATTERN.test(hash)) {
      return hash.toLowerCase();
    }
  } catch {
    // Fall through to the built-in blob-hash implementation.
  }

  return computeGitBlobSha1(readFileSync(filePath));
}

function assertRelationTargetLength(
  target: string,
  options?: { manifestFile?: string; label?: string },
): string {
  if (target.length <= MAX_RELATION_TARGET_LENGTH) {
    return target;
  }
  if (options?.manifestFile && options.label) {
    throw new Error(`${options.manifestFile} entry "${options.label}" inferred selector target must be at most ${MAX_RELATION_TARGET_LENGTH} characters.`);
  }
  throw new Error(`Inferred selector target must be at most ${MAX_RELATION_TARGET_LENGTH} characters.`);
}

function buildHeadingTarget(
  path: string,
  headingValue: string,
  options?: { manifestFile?: string; label?: string },
): string {
  const title = headingValue.trim().replace(/^#{1,6}\s*/, '');
  const slug = slugifyToken(title) || 'excerpt';
  return assertRelationTargetLength(`${path}#${slug}`, options);
}

function buildRelationTarget(
  path: string,
  selector?: ContextPackSelector,
  options?: { manifestFile?: string; label?: string },
): string {
  if (!selector) {
    return path;
  }
  if (selector.type === 'lines') {
    return assertRelationTargetLength(`${path}:${selector.start}-${selector.end}`, options);
  }
  return buildHeadingTarget(path, selector.value, options);
}

function inferRelationTag(roles: readonly ContextPackRole[]): string {
  for (const role of roles) {
    switch (role) {
      case 'scope':
        return 'bounds';
      case 'build':
        return 'implements';
      case 'verify':
        return 'verifies';
    }
  }
  return 'implements';
}

function allowedRelationTagsForRoles(roles: readonly ContextPackRole[]): string[] {
  return [...new Set(roles.map((role) => inferRelationTag([role])))];
}

function inferRelationPath(
  slug: string,
  path: string,
  roles: readonly ContextPackRole[],
  selector?: ContextPackSelector,
  options?: { manifestFile?: string; label?: string },
): ContextPackRelationStep[] {
  return [
    { tag: 'plan', target: slug },
    { tag: inferRelationTag(roles), target: buildRelationTarget(path, selector, options) },
  ];
}

function validateCustomRelationPathAgainstEntryContext(
  entry: ContextPackEntry,
  slug: string,
  manifestFile: string,
): string[] {
  let expectedRelationPath: ContextPackRelationStep[];
  try {
    expectedRelationPath = inferRelationPath(slug, entry.path, entry.roles, entry.selector, {
      manifestFile,
      label: entry.label,
    });
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const expectedStart = expectedRelationPath[0];
  const expectedEnd = expectedRelationPath[expectedRelationPath.length - 1];
  const allowedEndTags = allowedRelationTagsForRoles(entry.roles);
  const actualStart = entry.relationPath[0];
  const actualEnd = entry.relationPath.at(-1);
  const issues: string[] = [];

  if (!actualStart || actualStart.tag !== expectedStart.tag || actualStart.target !== expectedStart.target) {
    issues.push(`${manifestFile} entry "${entry.label}" relationPath must start with ${expectedStart.tag}: ${expectedStart.target}.`);
  }
  if (!actualEnd || !allowedEndTags.includes(actualEnd.tag) || actualEnd.target !== expectedEnd.target) {
    const expectedEndDescription = allowedEndTags.length === 1
      ? `${expectedEnd.tag}: ${expectedEnd.target}`
      : `one of ${allowedEndTags.join(', ')}: ${expectedEnd.target}`;
    issues.push(`${manifestFile} entry "${entry.label}" relationPath must end with ${expectedEndDescription}.`);
  }
  return issues;
}

export function contextPackIndexPath(packPath: string): string {
  return packPath.replace(/\.json$/i, '.md');
}

function buildRuntimeExcerptCacheKey(packPath: string): string {
  return createHash('sha1').update(packPath).digest('hex').slice(0, 12);
}

export function contextPackExcerptPath(packPath: string, index: number, label: string): string {
  const excerptDir = join(
    tmpdir(),
    'omx-context-pack-excerpts',
    `${basename(packPath, '.json')}-${buildRuntimeExcerptCacheKey(packPath)}`,
  );
  return join(excerptDir, `${String(index + 1).padStart(2, '0')}-${label}.md`);
}

export function rebindContextRefsForRepoRoot(
  refs: readonly ContextPackExecutionRef[],
  sourceRepoRoot: string,
  targetRepoRoot: string,
): ContextPackExecutionRef[] {
  return refs.map((ref) => {
    if (ref.delivery !== 'file') {
      return ref;
    }

    const repoRelativeSourcePath = normalizePlanningRepoRelativePath(relative(sourceRepoRoot, ref.sourcePath));
    if (
      repoRelativeSourcePath === ''
      || repoRelativeSourcePath === '.'
      || repoRelativeSourcePath.startsWith('..')
      || repoRelativeSourcePath.startsWith('../')
    ) {
      return ref;
    }

    const reboundPath = join(targetRepoRoot, repoRelativeSourcePath);
    if (!existsSync(reboundPath)) {
      return ref;
    }
    return {
      ...ref,
      path: reboundPath,
    };
  });
}

function formatSelector(selector: ContextPackSelector): string {
  if (selector.type === 'heading') {
    const maxWords = selector.maxWords ?? DEFAULT_HEADING_EXCERPT_MAX_WORDS;
    return `heading ${JSON.stringify(selector.value)} (maxWords=${maxWords})`;
  }
  return `lines ${selector.start}-${selector.end}`;
}

function selectorsEqual(
  left: ContextPackSelector | undefined,
  right: ContextPackSelector | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.type !== right.type) return false;
  if (left.type === 'heading' && right.type === 'heading') {
    return left.value === right.value && (left.maxWords ?? DEFAULT_HEADING_EXCERPT_MAX_WORDS) === (right.maxWords ?? DEFAULT_HEADING_EXCERPT_MAX_WORDS);
  }
  if (left.type === 'lines' && right.type === 'lines') {
    return left.start === right.start && left.end === right.end;
  }
  return false;
}

function rolesEqual(
  left: readonly ContextPackRole[],
  right: readonly ContextPackRole[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((role, index) => role === right[index]);
}

export function formatRelationPath(steps: readonly ContextPackRelationStep[]): string {
  return steps.map((step) => `${step.tag}: ${step.target}`).join(' -> ');
}

export function groupContextRefsByRole(
  refs: readonly ContextPackExecutionRef[],
): Partial<Record<ContextPackRole, ContextPackExecutionRef[]>> {
  const grouped: Partial<Record<ContextPackRole, ContextPackExecutionRef[]>> = {};
  for (const ref of refs) {
    for (const role of ref.roles) {
      if (!grouped[role]) {
        grouped[role] = [];
      }
      grouped[role]!.push(ref);
    }
  }
  return grouped;
}

export function describeContextRef(ref: ContextPackExecutionRef): string {
  return `${ref.label}=${ref.path} [${ref.delivery}]`;
}

function validateRawSlugOrThrow(raw: unknown, message: string): string {
  if (typeof raw !== 'string') {
    throw new Error(message);
  }
  if (
    raw.length === 0
    || raw.length > MAX_SLUG_LENGTH
    || raw.trim().length === 0
    || raw.includes('/')
    || raw.includes('\\')
  ) {
    throw new Error(message);
  }
  return raw;
}

export function parseContextPackPathInfo(packPath: string): ContextPackPathInfo | null {
  const match = basename(packPath).match(CONTEXT_PACK_FILE_PATTERN);
  if (!match?.groups) return null;
  return {
    timestamp: match.groups.timestamp,
    slugHint: match.groups.slug,
  };
}

function assertCanonicalContextPackPath(packPath: string): void {
  if (!isCanonicalContextPackPath(packPath)) {
    throw new Error('Context pack path must be .omx/context/context-<timestamp>-<slug>.json.');
  }
}

function inferRepoRootFromPackPath(packPath: string): string | null {
  if (!parseContextPackPathInfo(packPath) || !isCanonicalContextPackPath(packPath)) {
    return null;
  }
  const contextDir = dirname(packPath);
  const omxDir = dirname(contextDir);
  if (basename(contextDir) !== 'context' || basename(omxDir) !== '.omx') {
    return null;
  }
  return dirname(omxDir);
}

export function resolveContextPackRepoRoot(packPath: string, fallbackCwd: string): string {
  return inferRepoRootFromPackPath(packPath) ?? fallbackCwd;
}

function normalizeBasisObject(
  rawBasisObject: unknown,
  manifestFile: string,
  label: string,
): ContextPackBasisObject {
  if (rawBasisObject == null || typeof rawBasisObject !== 'object' || Array.isArray(rawBasisObject)) {
    throw new Error(`${manifestFile} ${label} basis must be an object.`);
  }

  const raw = rawBasisObject as Record<string, unknown>;
  ensureAllowedKeys(raw, ['path', 'sha1'], `${manifestFile} ${label} basis uses an unsupported key`);
  return {
    path: normalizeSourcePath(raw.path, `${manifestFile} ${label} basis must provide a repo-relative path.`),
    sha1: normalizeSha1(raw.sha1, `${manifestFile} ${label} basis must provide a 40-character sha1.`),
  };
}

function normalizeBasis(
  rawBasis: unknown,
  manifestFile: string,
): ContextPackBasis | undefined {
  if (rawBasis == null) {
    return undefined;
  }
  if (typeof rawBasis !== 'object' || Array.isArray(rawBasis)) {
    throw new Error(`${manifestFile} basis must be an object.`);
  }

  const raw = rawBasis as Record<string, unknown>;
  ensureAllowedKeys(raw, ['prd', 'testSpecs'], `${manifestFile} basis uses an unsupported key`);
  const prd = normalizeBasisObject(raw.prd, manifestFile, 'prd');
  if (!Array.isArray(raw.testSpecs) || raw.testSpecs.length === 0) {
    throw new Error(`${manifestFile} basis testSpecs must contain at least one object.`);
  }

  const testSpecs = raw.testSpecs
    .map((entry, index) => normalizeBasisObject(entry, manifestFile, `testSpecs[${index}]`))
    .sort((left, right) => left.path.localeCompare(right.path));
  const seenPaths = new Set<string>();
  for (const testSpec of testSpecs) {
    if (seenPaths.has(testSpec.path)) {
      throw new Error(`${manifestFile} basis testSpecs path "${testSpec.path}" is repeated.`);
    }
    seenPaths.add(testSpec.path);
  }

  return { prd, testSpecs };
}

function matchPlanningArtifactSlug(fileName: string, pattern: RegExp, slug: string): boolean {
  const match = fileName.match(pattern);
  return (match?.groups?.slug ?? null) === slug;
}

function selectPlanningArtifactFileNames(
  planFileNames: readonly string[],
  slug: string,
): {
    prdFileName: string;
    testSpecFileNames: string[];
  } | null {
  const prdFileName = planFileNames.includes(`prd-${slug}.md`)
    ? `prd-${slug}.md`
    : [...planFileNames]
      .filter((fileName) => matchPlanningArtifactSlug(fileName, PRD_FILENAME_PATTERN, slug))
      .sort((left, right) => left.localeCompare(right))
      .at(0);
  if (!prdFileName) {
    return null;
  }

  const testSpecFileNames = planFileNames
    .filter((fileName) => matchPlanningArtifactSlug(fileName, TEST_SPEC_FILENAME_PATTERN, slug))
    .sort((left, right) => left.localeCompare(right));
  if (testSpecFileNames.length === 0) {
    return null;
  }

  return { prdFileName, testSpecFileNames };
}

export function buildContextPackBasis(repoRoot: string, slug: string): ContextPackBasis | null {
  const plansDir = join(repoRoot, '.omx', 'plans');
  if (!existsSync(plansDir)) {
    return null;
  }

  let artifactFileNames: ReturnType<typeof selectPlanningArtifactFileNames>;
  try {
    artifactFileNames = selectPlanningArtifactFileNames(readdirSync(plansDir), slug);
  } catch {
    return null;
  }

  if (!artifactFileNames) {
    return null;
  }

  const prdRelativePath = normalizePlanningRepoRelativePath(join('.omx', 'plans', artifactFileNames.prdFileName));
  const prdAbsolutePath = join(repoRoot, prdRelativePath);
  const testSpecRelativePaths = artifactFileNames.testSpecFileNames
    .map((fileName) => normalizePlanningRepoRelativePath(join('.omx', 'plans', fileName)));

  return {
    prd: {
      path: prdRelativePath,
      sha1: computeContextPackObjectSha1(prdAbsolutePath),
    },
    testSpecs: testSpecRelativePaths.map((relativePath) => ({
      path: relativePath,
      sha1: computeContextPackObjectSha1(join(repoRoot, relativePath)),
    })),
  };
}

function ensureAllowedKeys(
  raw: Record<string, unknown>,
  allowedKeys: readonly string[],
  message: string,
): void {
  const allowed = new Set(allowedKeys);
  const extra = Object.keys(raw).find((key) => !allowed.has(key));
  if (extra) {
    throw new Error(`${message} "${extra}".`);
  }
}

function normalizeSelector(
  selector: unknown,
  manifestFile: string,
  label: string,
): ContextPackSelector | null {
  if (selector == null) return null;
  if (typeof selector !== 'object' || Array.isArray(selector)) {
    throw new Error(`${manifestFile} entry "${label}" selector must be an object.`);
  }

  const raw = selector as Record<string, unknown>;
  if (raw.type === 'heading') {
    ensureAllowedKeys(raw, ['type', 'value', 'maxWords'], `${manifestFile} entry "${label}" heading selector uses an unsupported key`);
    if (typeof raw.value !== 'string' || raw.value.trim() === '') {
      throw new Error(`${manifestFile} entry "${label}" heading selector must provide a non-empty value.`);
    }
    if (raw.maxWords != null && (!Number.isInteger(raw.maxWords) || (raw.maxWords as number) < 40 || (raw.maxWords as number) > MAX_HEADING_EXCERPT_MAX_WORDS)) {
      throw new Error(`${manifestFile} entry "${label}" heading selector maxWords must be an integer between 40 and ${MAX_HEADING_EXCERPT_MAX_WORDS}.`);
    }
    return {
      type: 'heading',
      value: raw.value.trim(),
      maxWords: typeof raw.maxWords === 'number' ? raw.maxWords : undefined,
    };
  }

  if (raw.type === 'lines') {
    ensureAllowedKeys(raw, ['type', 'start', 'end'], `${manifestFile} entry "${label}" line selector uses an unsupported key`);
    if (!Number.isInteger(raw.start) || !Number.isInteger(raw.end)) {
      throw new Error(`${manifestFile} entry "${label}" line selector must provide integer start/end values.`);
    }
    if ((raw.start as number) < 1 || (raw.end as number) < (raw.start as number)) {
      throw new Error(`${manifestFile} entry "${label}" line selector must use 1-based inclusive ranges with end >= start.`);
    }
    return {
      type: 'lines',
      start: raw.start as number,
      end: raw.end as number,
    };
  }

  throw new Error(`${manifestFile} entry "${label}" selector type must be "heading" or "lines".`);
}

function normalizeRelationPath(
  relationPath: unknown,
  manifestFile: string,
  label: string,
): ContextPackRelationStep[] | null {
  if (relationPath == null) return null;
  if (!Array.isArray(relationPath) || relationPath.length === 0 || relationPath.length > MAX_RELATION_PATH_STEPS) {
    throw new Error(`${manifestFile} entry "${label}" relationPath must contain 1-${MAX_RELATION_PATH_STEPS} steps.`);
  }

  return relationPath.map((step, index) => {
    if (step == null || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`${manifestFile} entry "${label}" relationPath step ${index + 1} must be an object.`);
    }
    const raw = step as Record<string, unknown>;
    ensureAllowedKeys(raw, ['tag', 'target'], `${manifestFile} entry "${label}" relationPath step ${index + 1} uses an unsupported key`);
    const tag = compactTokenOrThrow(raw.tag, `${manifestFile} entry "${label}" relationPath step ${index + 1} must use a compact tag.`);
    if (typeof raw.target !== 'string' || raw.target.trim() === '' || raw.target.trim().length > MAX_RELATION_TARGET_LENGTH) {
      throw new Error(`${manifestFile} entry "${label}" relationPath step ${index + 1} must use a non-empty target under ${MAX_RELATION_TARGET_LENGTH} characters.`);
    }
    return {
      tag,
      target: raw.target.trim(),
    };
  });
}

function inferLabelFromPath(path: string, reservedLabels: ReadonlySet<string>): string {
  const base = slugifyToken(basename(path, extname(path))) || slugifyToken(path.replace(/\//g, '-')) || 'entry';
  if (!reservedLabels.has(base)) {
    return base;
  }
  const pathLabel = slugifyToken(path.replace(/[/.]+/g, '-')) || base;
  if (!reservedLabels.has(pathLabel)) {
    return pathLabel;
  }
  let suffix = 2;
  while (reservedLabels.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function normalizeRoles(
  roles: unknown,
  manifestFile: string,
  label: string,
): ContextPackRole[] {
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > MAX_ENTRY_ROLES) {
    throw new Error(`${manifestFile} entry "${label}" roles must contain 1-${MAX_ENTRY_ROLES} compact values.`);
  }
  const normalized = new Set<ContextPackRole>();
  for (const role of roles) {
    const normalizedRole = compactTokenOrThrow(role, `${manifestFile} entry "${label}" roles must use compact values.`);
    if (!CONTEXT_PACK_ROLE_SET.has(normalizedRole)) {
      throw new Error(`${manifestFile} entry "${label}" roles must use only: ${CONTEXT_PACK_ROLES.join(', ')}.`);
    }
    normalized.add(normalizedRole as ContextPackRole);
  }
  return [...normalized].sort(
    (left, right) => (CONTEXT_PACK_ROLE_ORDER.get(left) ?? 0) - (CONTEXT_PACK_ROLE_ORDER.get(right) ?? 0),
  );
}

function normalizeTags(
  tags: unknown,
  manifestFile: string,
  label: string,
): string[] {
  if (tags == null) {
    return [];
  }
  if (!Array.isArray(tags) || tags.length > MAX_TAGS_PER_ENTRY) {
    throw new Error(`${manifestFile} entry "${label}" tags must contain 0-${MAX_TAGS_PER_ENTRY} compact values.`);
  }
  const normalized = new Set<string>();
  for (const tag of tags) {
    normalized.add(compactTokenOrThrow(tag, `${manifestFile} entry "${label}" tags must use compact values.`));
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function normalizeEntry(
  entry: unknown,
  manifestFile: string,
  reservedLabels: ReadonlySet<string>,
  slug: string,
  defaultRoles?: readonly ContextPackRole[],
): ContextPackEntry {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${manifestFile} entries must contain objects.`);
  }
  const raw = entry as Record<string, unknown>;
  ensureAllowedKeys(raw, ['label', 'path', 'roles', 'tags', 'selector', 'relationPath'], `${manifestFile} entry uses an unsupported key`);

  const path = normalizeSourcePath(raw.path, `${manifestFile} entries must provide a repo-relative path.`);
  const label = raw.label == null
    ? inferLabelFromPath(path, reservedLabels)
    : compactTokenOrThrow(raw.label, `${manifestFile} entry path "${path}" must use a compact label.`);
  if (reservedLabels.has(label)) {
    throw new Error(`${manifestFile} entry label "${label}" is repeated.`);
  }

  const selector = normalizeSelector(raw.selector, manifestFile, label) ?? undefined;
  const roles = normalizeRoles(raw.roles ?? defaultRoles, manifestFile, label);
  const relationPath = normalizeRelationPath(raw.relationPath, manifestFile, label) ?? inferRelationPath(
    slug,
    path,
    roles,
    selector,
    { manifestFile, label },
  );
  const tags = normalizeTags(raw.tags, manifestFile, label);

  return {
    label,
    path,
    roles,
    tags,
    selector,
    relationPath,
  };
}

function normalizeDocument(
  manifest: unknown,
  packPath: string,
): ContextPackDocument {
  const pathInfo = parseContextPackPathInfo(packPath);
  if (!pathInfo) {
    throw new Error(`${basename(packPath)} must follow context-<timestamp>-<slug>.json naming.`);
  }
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${basename(packPath)} must contain a JSON object.`);
  }

  const raw = manifest as Record<string, unknown>;
  ensureAllowedKeys(raw, ['schema', 'slug', 'basis', 'entries'], `${basename(packPath)} uses an unsupported top-level key`);

  const schema = typeof raw.schema === 'string' ? raw.schema.trim() : '';
  if (schema !== CONTEXT_PACK_SCHEMA) {
    throw new Error(`${basename(packPath)} must declare schema ${CONTEXT_PACK_SCHEMA}.`);
  }
  const slug = validateRawSlugOrThrow(raw.slug, `${basename(packPath)} must declare a slug under ${MAX_SLUG_LENGTH} characters.`);
  if (slug !== pathInfo.slugHint) {
    throw new Error(`${basename(packPath)} filename slug must match the declared slug ${slug}.`);
  }
  const basis = normalizeBasis(raw.basis, basename(packPath));

  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    throw new Error(`${basename(packPath)} must declare at least 1 entry.`);
  }

  const entries: ContextPackEntry[] = [];
  const usedLabels = new Set<string>();
  for (const rawEntry of raw.entries) {
    const normalized = normalizeEntry(rawEntry, basename(packPath), usedLabels, slug);
    usedLabels.add(normalized.label);
    entries.push(normalized);
  }

  return {
    schema: CONTEXT_PACK_SCHEMA,
    slug,
    ...(basis ? { basis } : {}),
    entries,
  };
}

function loadContextPackDocument(
  packPath: string,
): { document: ContextPackDocument | null; error: string | null } {
  if (!existsSync(packPath)) {
    return { document: null, error: null };
  }

  try {
    return {
      document: normalizeDocument(JSON.parse(readFileSync(packPath, 'utf-8')) as unknown, packPath),
      error: null,
    };
  } catch (error) {
    return {
      document: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function renderTagIndex(entries: readonly ContextPackEntry[]): string[] {
  const tagMap = new Map<string, { labels: string[]; roles: Set<ContextPackRole> }>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const current = tagMap.get(tag) ?? { labels: [], roles: new Set<ContextPackRole>() };
      current.labels.push(entry.label);
      for (const role of entry.roles) {
        current.roles.add(role);
      }
      tagMap.set(tag, current);
    }
  }

  return [...tagMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tag, metadata]) => {
      const sortedLabels = metadata.labels.sort((a, b) => a.localeCompare(b));
      const roleSummary = [...metadata.roles]
        .sort((left, right) => (CONTEXT_PACK_ROLE_ORDER.get(left) ?? 0) - (CONTEXT_PACK_ROLE_ORDER.get(right) ?? 0))
        .join(',');
      return `- ${tag} (${sortedLabels.length}): ${sortedLabels.join(', ')} | roles=${roleSummary} | query=--tag ${tag}`;
    });
}

function renderRoleIndex(entries: readonly ContextPackEntry[]): string[] {
  const roleMap = new Map<ContextPackRole, string[]>();
  for (const entry of entries) {
    for (const role of entry.roles) {
      const current = roleMap.get(role) ?? [];
      current.push(entry.label);
      roleMap.set(role, current);
    }
  }

  return [...roleMap.entries()]
    .sort((a, b) => CONTEXT_PACK_INDEX_VIEW_ORDER.indexOf(a[0]) - CONTEXT_PACK_INDEX_VIEW_ORDER.indexOf(b[0]))
    .map(([role, labels]) => {
      const sortedLabels = labels.sort((a, b) => a.localeCompare(b));
      return `- ${role} (${sortedLabels.length}): ${sortedLabels.join(', ')} | query=--role ${role}`;
    });
}

function renderEntryLine(entry: ContextPackEntry): string {
  const parts = [`${entry.label}: ${entry.path}`];
  parts.push(`roles=${entry.roles.join(',')}`);
  if (entry.selector) {
    parts.push(`selector=${formatSelector(entry.selector)}`);
  }
  if (entry.tags.length > 0) {
    parts.push(`tags=${entry.tags.join(',')}`);
  }
  return `- ${parts.join(' | ')}`;
}

function renderPackSummary(document: ContextPackDocument): string[] {
  const roleCounts = new Map<ContextPackRole, number>();
  const tagCounts = new Map<string, number>();
  let selectorBackedEntries = 0;

  for (const entry of document.entries) {
    if (entry.selector) {
      selectorBackedEntries += 1;
    }
    for (const role of entry.roles) {
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const roleSummary = CONTEXT_PACK_INDEX_VIEW_ORDER
    .filter((role) => roleCounts.has(role))
    .map((role) => `${role}=${roleCounts.get(role)}`)
    .join(', ');
  const tagSummary = [...tagCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tag, count]) => `${tag}=${count}`)
    .join(', ');

  return [
    '## Pack Summary',
    `- entries: ${document.entries.length}`,
    `- roles: ${roleSummary || 'none'}`,
    `- tagged-entries: ${document.entries.filter((entry) => entry.tags.length > 0).length}`,
    `- tags: ${tagSummary || 'none'}`,
    `- selector-backed-entries: ${selectorBackedEntries}`,
    `- direct-file-entries: ${document.entries.length - selectorBackedEntries}`,
  ];
}

function readPreservedContextPackViewNotes(indexPath: string): string[] {
  if (!existsSync(indexPath)) {
    return [];
  }

  const lines = readFileSync(indexPath, 'utf-8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === CONTEXT_PACK_VIEW_NOTES_START);
  const end = lines.findIndex((line, index) => index > start && line.trim() === CONTEXT_PACK_VIEW_NOTES_END);
  if (start === -1 || end === -1 || end <= start) {
    return [];
  }

  const preserved = lines.slice(start + 1, end);
  while (preserved.length > 0 && preserved[0]!.trim() === '') {
    preserved.shift();
  }
  while (preserved.length > 0 && preserved[preserved.length - 1]!.trim() === '') {
    preserved.pop();
  }
  return preserved;
}

function renderContextPackIndex(
  packPath: string,
  document: ContextPackDocument,
  preservedViewNotes: readonly string[] = [],
): string {
  const roleIndex = renderRoleIndex(document.entries);
  const tagIndex = renderTagIndex(document.entries);
  const summaryLines = renderPackSummary(document);
  const defaultView = listContextPackRoles(document).includes('build')
    ? 'build'
    : listContextPackRoles(document)[0] ?? 'build';
  return [
    '# Context Pack Index',
    `- pack: ${basename(packPath)}`,
    `- slug: ${document.slug}`,
    `- default-view: ${defaultView}`,
    '',
    ...summaryLines,
    '',
    '## View Guide',
    '- build: default implementation view; query `--role build` for refs, then use `view --role build` when you need the actual brief.',
    '- verify: proof view; query `--role verify` for refs, then use `view --role verify` when preparing completion evidence.',
    '- scope: boundary-recovery view; query `--role scope` before opening broader source files.',
    ...(tagIndex.length > 0
      ? ['- tags: optional topical cross-cuts; query `--tag <tag>` first to narrow the ref set around a concrete theme, add `--role` when you need one lane, and remember that multiple tag filters intersect.']
      : []),
    '',
    '## Role Views',
    ...roleIndex,
    ...(tagIndex.length > 0 ? ['', '## Tag Views', ...tagIndex] : []),
    '',
    '## View Notes',
    CONTEXT_PACK_VIEW_NOTES_START,
    ...(preservedViewNotes.length > 0 ? preservedViewNotes : [CONTEXT_PACK_VIEW_NOTES_PLACEHOLDER]),
    CONTEXT_PACK_VIEW_NOTES_END,
    '',
    '## Refs',
    ...document.entries.map(renderEntryLine),
    '',
  ].join('\n');
}

function normalizeContextPackIndexSnapshotForComparison(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\n+$/g, '');
}

export function inspectContextPackGeneratedIndex(
  packPath: string,
  document: ContextPackDocument,
): ContextPackGeneratedIndexInspection {
  const packFile = basename(packPath);
  const indexPath = contextPackIndexPath(packPath);
  const indexFile = basename(indexPath);
  if (!existsSync(indexPath)) {
    return {
      status: 'missing',
      issues: [`${packFile} is missing generated index ${indexFile}.`],
    };
  }

  try {
    const actualIndex = normalizeContextPackIndexSnapshotForComparison(readFileSync(indexPath, 'utf-8'));
    const expectedIndex = normalizeContextPackIndexSnapshotForComparison(
      renderContextPackIndex(packPath, document, readPreservedContextPackViewNotes(indexPath)),
    );
    if (actualIndex === expectedIndex) {
      return {
        status: 'ready',
        issues: [],
      };
    }
    return {
      status: 'invalid',
      issues: [`${packFile} generated index ${indexFile} must remain scaffold-only outside View Notes.`],
    };
  } catch {
    return {
      status: 'invalid',
      issues: [`${packFile} generated index ${indexFile} could not be read.`],
    };
  }
}

export function readContextPackDocument(packPath: string): ContextPackDocument | null {
  return loadContextPackDocument(packPath).document;
}

export function writeContextPackDocument(
  packPath: string,
  document: ContextPackDocument,
  options: ContextPackWriteOptions = {},
): ContextPackDocument {
  assertCanonicalContextPackPath(packPath);
  const repoRoot = options.refreshBasis
    ? options.repoRoot ?? inferRepoRootFromPackPath(packPath)
    : null;
  const indexPath = contextPackIndexPath(packPath);
  const preservedViewNotes = readPreservedContextPackViewNotes(indexPath);
  const inferredBasis = repoRoot ? buildContextPackBasis(repoRoot, document.slug) : null;
  const normalized = normalizeDocument(
    inferredBasis ? { ...document, basis: inferredBasis } : document,
    packPath,
  );
  mkdirSync(dirname(packPath), { recursive: true });
  writeFileSync(packPath, `${JSON.stringify(normalized, null, 2)}\n`);
  writeFileSync(indexPath, renderContextPackIndex(packPath, normalized, preservedViewNotes));
  return normalized;
}

export function upsertContextPackEntries(
  packPath: string,
  inputs: readonly ContextPackEntryInput[],
  options: ContextPackWriteOptions = {},
): ContextPackUpsertResult {
  if (inputs.length === 0) {
    throw new Error('Context pack updates must include at least one entry.');
  }

  assertCanonicalContextPackPath(packPath);
  const pathInfo = parseContextPackPathInfo(packPath);
  if (!pathInfo) {
    throw new Error(`${basename(packPath)} must follow context-<timestamp>-<slug>.json naming.`);
  }

  const existingDocumentResult = loadContextPackDocument(packPath);
  if (existingDocumentResult.error) {
    throw new Error(`Could not read context pack: ${packPath}`);
  }
  const existingDocument = existingDocumentResult.document;

  const baseDocument = existingDocument ?? {
    schema: CONTEXT_PACK_SCHEMA,
    slug: pathInfo.slugHint,
    entries: [],
  };
  const nextEntries = [...baseDocument.entries];
  const addedLabels: string[] = [];
  const updatedLabels: string[] = [];

  for (const input of inputs) {
    const explicitLabel = input.label == null
      ? null
      : compactTokenOrThrow(input.label, 'Context pack entries must use compact labels.');
    const normalizedPath = normalizeSourcePath(input.path, 'Context pack entries must provide a repo-relative path.');
    const normalizedSelector = input.selector ?? undefined;
    const existingIndex = explicitLabel
      ? nextEntries.findIndex((entry) => entry.label === explicitLabel)
      : nextEntries.findIndex((entry) => entry.path === normalizedPath && selectorsEqual(entry.selector, normalizedSelector));
    const reservedLabels = new Set(
      nextEntries
        .filter((_, index) => index !== existingIndex)
        .map((entry) => entry.label),
    );
    const existingEntry = existingIndex >= 0 ? nextEntries[existingIndex] : null;
    const mergedInput = existingEntry
      ? {
        path: normalizedPath,
        label: input.label ?? existingEntry.label,
        roles: input.roles == null ? existingEntry.roles : [...existingEntry.roles, ...input.roles],
        tags: input.tags == null ? existingEntry.tags : [...existingEntry.tags, ...input.tags],
        selector: input.selector ?? (normalizedPath === existingEntry.path ? existingEntry.selector : undefined),
        relationPath: input.relationPath ?? existingEntry.relationPath,
      }
      : { ...input, path: normalizedPath };
    let normalizedEntry = normalizeEntry(
      mergedInput,
      basename(packPath),
      reservedLabels,
      baseDocument.slug,
      existingEntry?.roles ?? input.roles ?? ['build'],
    );
    if (
      existingEntry
      && input.relationPath == null
      && (
        existingEntry.path !== normalizedEntry.path
        || !rolesEqual(existingEntry.roles, normalizedEntry.roles)
        || !selectorsEqual(existingEntry.selector, normalizedEntry.selector)
      )
    ) {
      const preservedRelationIssues = validateCustomRelationPathAgainstEntryContext(
        normalizedEntry,
        baseDocument.slug,
        basename(packPath),
      );
      if (preservedRelationIssues.length > 0) {
        normalizedEntry = {
          ...normalizedEntry,
          relationPath: inferRelationPath(
            baseDocument.slug,
            normalizedEntry.path,
            normalizedEntry.roles,
            normalizedEntry.selector,
            { manifestFile: basename(packPath), label: normalizedEntry.label },
          ),
        };
      }
    }
    if (existingIndex >= 0) {
      nextEntries[existingIndex] = normalizedEntry;
      updatedLabels.push(normalizedEntry.label);
    } else {
      nextEntries.push(normalizedEntry);
      addedLabels.push(normalizedEntry.label);
    }
  }

  const candidateDocument = normalizeDocument({
    schema: CONTEXT_PACK_SCHEMA,
    slug: baseDocument.slug,
    entries: nextEntries,
  }, packPath);
  if (options.repoRoot) {
    const issues = validateResolvedContextPackDocument(candidateDocument, packPath, options.repoRoot);
    if (issues.length > 0) {
      throw new Error(issues.join(' | '));
    }
  }
  const document = writeContextPackDocument(packPath, candidateDocument, {
    repoRoot: options.repoRoot,
    refreshBasis: options.refreshBasis,
  });

  return {
    packPath,
    indexPath: contextPackIndexPath(packPath),
    slug: document.slug,
    addedLabels,
    updatedLabels,
    document,
  };
}

function readSourceText(repoRoot: string, repoRelativePath: string): string {
  return readFileSync(join(repoRoot, repoRelativePath), 'utf-8');
}

function findHeadingSection(
  sourceText: string,
  headingValue: string,
): { excerpt: string; matchedHeading: string } | null {
  const lines = sourceText.split(/\r?\n/);
  const targetHeading = headingValue.trim();
  let start = -1;
  let startLevel = 0;
  let matchedHeading = '';
  let activeFence: MarkdownFenceState | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    activeFence = advanceMarkdownFenceState(activeFence, line);
    const trimmed = line.trim();
    if (activeFence) {
      continue;
    }
    if (isIndentedMarkdownCodeLine(line)) {
      continue;
    }
    const headingMatch = trimmed.match(HEADING_PATTERN);
    if (!headingMatch?.groups?.level || !headingMatch.groups.title) {
      continue;
    }
    const level = headingMatch.groups.level.length;
    const title = headingMatch.groups.title.trim();
    if (
      trimmed === targetHeading
      || title.localeCompare(targetHeading, undefined, { sensitivity: 'accent' }) === 0
    ) {
      start = index;
      startLevel = level;
      matchedHeading = trimmed;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  let end = lines.length;
  activeFence = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    activeFence = advanceMarkdownFenceState(activeFence, line);
    const trimmed = line.trim();
    if (activeFence) {
      continue;
    }
    if (isIndentedMarkdownCodeLine(line)) {
      continue;
    }
    const headingMatch = trimmed.match(HEADING_PATTERN);
    if (!headingMatch?.groups?.level) {
      continue;
    }
    const level = headingMatch.groups.level.length;
    if (level <= startLevel) {
      end = index;
      break;
    }
  }

  return {
    excerpt: lines.slice(start, end).join('\n').trim(),
    matchedHeading,
  };
}

function truncateExcerptByWords(text: string, maxWords: number): string {
  if (countWords(text) <= maxWords) {
    return text.trim();
  }

  function truncateLineToWordBudget(line: string, wordBudget: number): string {
    if (wordBudget <= 0) {
      return '';
    }
    const trimmed = line.trim();
    if (!trimmed) {
      return line;
    }
    const leadingWhitespace = line.match(/^\s*/)?.[0] ?? '';
    return `${leadingWhitespace}${trimmed.split(/\s+/).slice(0, wordBudget).join(' ')}`;
  }

  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let words = 0;
  for (const line of lines) {
    const lineWords = countWords(line);
    if (lineWords === 0) {
      kept.push(line);
      continue;
    }
    if (kept.length === 0 || words + lineWords <= maxWords) {
      kept.push(line);
      words += lineWords;
      if (words >= maxWords) {
        break;
      }
      continue;
    }

    const remainingWords = maxWords - words;
    if (remainingWords > 0) {
      kept.push(truncateLineToWordBudget(line, remainingWords));
      words += remainingWords;
    }
    if (words >= maxWords) {
      break;
    }
  }

  return `${kept.join('\n').trim()}\n\n[excerpt truncated after ${maxWords} words]`;
}

function extractExcerptFromSource(
  sourceText: string,
  selector: ContextPackSelector,
): { excerpt: string; selectorDescription: string } {
  if (selector.type === 'lines') {
    const lines = sourceText.split(/\r?\n/);
    if (selector.end > lines.length) {
      throw new Error(`line selector ${selector.start}-${selector.end} exceeds the source length (${lines.length} lines).`);
    }
    return {
      excerpt: lines.slice(selector.start - 1, selector.end).join('\n'),
      selectorDescription: formatSelector(selector),
    };
  }

  const section = findHeadingSection(sourceText, selector.value);
  if (!section) {
    throw new Error(`heading selector ${JSON.stringify(selector.value)} was not found.`);
  }
  const maxWords = selector.maxWords ?? DEFAULT_HEADING_EXCERPT_MAX_WORDS;
  return {
    excerpt: truncateExcerptByWords(section.excerpt, maxWords),
    selectorDescription: formatSelector({ ...selector, value: section.matchedHeading }),
  };
}

function matchesFilters(
  entry: ContextPackEntry,
  options: {
    roles?: readonly ContextPackRole[];
    labels?: readonly string[];
    tags?: readonly string[];
  },
): boolean {
  const { roles, labels, tags } = options;
  if (roles && roles.length > 0 && !roles.some((role) => entry.roles.includes(role))) {
    return false;
  }
  if (labels && labels.length > 0 && !labels.includes(entry.label)) {
    return false;
  }
  if (tags && tags.length > 0 && !tags.every((tag) => entry.tags.includes(tag))) {
    return false;
  }
  return true;
}

export function filterContextPackEntries(
  document: ContextPackDocument,
  options: {
    roles?: readonly ContextPackRole[];
    labels?: readonly string[];
    tags?: readonly string[];
  } = {},
): ContextPackEntry[] {
  return document.entries.filter((entry) => matchesFilters(entry, options));
}

export function listContextPackRoles(document: ContextPackDocument): ContextPackRole[] {
  return [...new Set(document.entries.flatMap((entry) => entry.roles))]
    .sort((left, right) => (CONTEXT_PACK_ROLE_ORDER.get(left) ?? 0) - (CONTEXT_PACK_ROLE_ORDER.get(right) ?? 0));
}

export function findMissingContextPackRoles(
  document: ContextPackDocument,
  requiredRoles: readonly ContextPackRole[] = REQUIRED_CONTEXT_PACK_ROLES,
): ContextPackRole[] {
  const presentRoles = new Set(listContextPackRoles(document));
  return requiredRoles.filter((role) => !presentRoles.has(role));
}

function validateFreshContextPackBasis(
  document: ContextPackDocument,
  packPath: string,
  repoRoot: string,
  expectedSlug?: string,
): string[] {
  const file = basename(packPath);
  if (!document.basis) {
    return [`${file} must declare basis hashes for the approved PRD/test-spec artifacts.`];
  }

  const slug = expectedSlug ?? document.slug;
  const expectedBasis = buildContextPackBasis(repoRoot, slug);
  if (!expectedBasis) {
    return [`${file} could not resolve the approved PRD/test-spec basis for slug ${slug}.`];
  }

  const issues: string[] = [];
  if (document.basis.prd.path !== expectedBasis.prd.path) {
    issues.push(`${file} basis prd path ${document.basis.prd.path} does not match ${expectedBasis.prd.path}.`);
  }
  if (document.basis.prd.sha1 !== expectedBasis.prd.sha1) {
    issues.push(`${file} basis prd hash for ${document.basis.prd.path} does not match the current approved PRD.`);
  }

  const storedTestSpecs = new Map(document.basis.testSpecs.map((testSpec) => [testSpec.path, testSpec.sha1]));
  const expectedTestSpecs = new Map(expectedBasis.testSpecs.map((testSpec) => [testSpec.path, testSpec.sha1]));
  for (const expectedTestSpec of expectedBasis.testSpecs) {
    const storedHash = storedTestSpecs.get(expectedTestSpec.path);
    if (!storedHash) {
      issues.push(`${file} basis is missing test-spec ${expectedTestSpec.path}.`);
      continue;
    }
    if (storedHash !== expectedTestSpec.sha1) {
      issues.push(`${file} basis test-spec hash for ${expectedTestSpec.path} does not match the current approved test spec.`);
    }
  }
  for (const storedTestSpecPath of storedTestSpecs.keys()) {
    if (!expectedTestSpecs.has(storedTestSpecPath)) {
      issues.push(`${file} basis includes unexpected test-spec ${storedTestSpecPath}.`);
    }
  }

  return issues;
}

function validateResolvedContextPackDocument(
  document: ContextPackDocument,
  packPath: string,
  repoRoot: string,
): string[] {
  const issues: string[] = [];
  const file = basename(packPath);
  for (const entry of document.entries) {
    issues.push(...validateCustomRelationPathAgainstEntryContext(entry, document.slug, file));
    const absoluteSourcePath = join(repoRoot, entry.path);
    if (!existsSync(absoluteSourcePath)) {
      issues.push(`${file} entry "${entry.label}" points at missing source ${entry.path}.`);
      continue;
    }

    let sourceText = '';
    try {
      sourceText = readSourceText(repoRoot, entry.path);
    } catch {
      issues.push(`${file} entry "${entry.label}" could not read source ${entry.path}.`);
      continue;
    }

    if (!entry.selector) {
      if (!isShortSourceText(sourceText)) {
        issues.push(`${file} entry "${entry.label}" must declare a selector because ${entry.path} exceeds the short-file threshold.`);
      }
      continue;
    }

    try {
      extractExcerptFromSource(sourceText, entry.selector);
    } catch (error) {
      issues.push(`${file} entry "${entry.label}" ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return issues;
}

function collectContextPackManifestIssues(
  document: ContextPackDocument,
  options: ValidateContextPackManifestOptions,
): string[] {
  const issues: string[] = [];
  const file = basename(options.packPath);
  if (!isCanonicalContextPackPath(options.packPath)) {
    issues.push(`${file} must live at .omx/context/context-<timestamp>-<slug>.json.`);
  }
  if (options.expectedSlug && document.slug !== options.expectedSlug) {
    issues.push(`${file} declares slug ${document.slug}, but the approved plan slug is ${options.expectedSlug}.`);
  }
  if (options.requireGeneratedIndex) {
    issues.push(...inspectContextPackGeneratedIndex(options.packPath, document).issues);
  }
  if (options.requireFreshBasis) {
    issues.push(...validateFreshContextPackBasis(document, options.packPath, options.repoRoot, options.expectedSlug));
  }

  issues.push(...validateResolvedContextPackDocument(document, options.packPath, options.repoRoot));

  return issues;
}

function loadValidatedContextPackDocument(
  options: ValidateContextPackManifestOptions,
): { document: ContextPackDocument | null; issues: string[] } {
  if (!existsSync(options.packPath)) {
    return {
      document: null,
      issues: [`${basename(options.packPath)} is required for runtime context refs.`],
    };
  }

  const loadedDocument = loadContextPackDocument(options.packPath);
  if (!loadedDocument.document) {
    return {
      document: null,
      issues: [loadedDocument.error ?? `Could not read context pack: ${options.packPath}`],
    };
  }

  return {
    document: loadedDocument.document,
    issues: collectContextPackManifestIssues(loadedDocument.document, options),
  };
}

export function validateContextPackManifest(
  options: ValidateContextPackManifestOptions,
): string[] {
  return loadValidatedContextPackDocument(options).issues;
}

export function materializeContextPackRefs(
  options: MaterializeContextPackRefsOptions,
): ContextPackExecutionRefResolution {
  const loadedContextPack = loadValidatedContextPackDocument(options);
  if (loadedContextPack.issues.length > 0 || !loadedContextPack.document) {
    return {
      refs: [],
      issues: loadedContextPack.issues,
    };
  }

  const refs: ContextPackExecutionRef[] = [];
  const filteredEntries = filterContextPackEntries(loadedContextPack.document, {
    roles: options.roles,
    labels: options.labels,
    tags: options.tags,
  });
  let excerptCount = 0;

  try {
    for (const entry of filteredEntries) {
      const absoluteSourcePath = join(options.repoRoot, entry.path);
      const sourceText = readSourceText(options.repoRoot, entry.path);
      if (!entry.selector && isShortSourceText(sourceText)) {
        refs.push({
          roles: entry.roles,
          label: entry.label,
          path: absoluteSourcePath,
          sourcePath: absoluteSourcePath,
          delivery: 'file',
          relationPath: entry.relationPath,
          tags: entry.tags,
        });
        continue;
      }

      if (!entry.selector) {
        return {
          refs: [],
          issues: [`${basename(options.packPath)} entry "${entry.label}" must declare a selector because ${entry.path} exceeds the short-file threshold.`],
        };
      }

      const { excerpt, selectorDescription } = extractExcerptFromSource(sourceText, entry.selector);
      const excerptPath = contextPackExcerptPath(options.packPath, excerptCount, entry.label);
      excerptCount += 1;
      mkdirSync(dirname(excerptPath), { recursive: true });
      writeFileSync(
        excerptPath,
        [
          '# Context Excerpt',
          `- label: ${entry.label}`,
          `- roles: ${entry.roles.join(', ')}`,
          `- source: ${entry.path}`,
          `- selector: ${selectorDescription}`,
          ...(entry.tags.length > 0 ? [`- tags: ${entry.tags.join(', ')}`] : []),
          `- relation-path: ${formatRelationPath(entry.relationPath)}`,
          '',
          '## Excerpt',
          excerpt,
          '',
        ].join('\n'),
      );
      refs.push({
        roles: entry.roles,
        label: entry.label,
        path: excerptPath,
        sourcePath: absoluteSourcePath,
        delivery: 'excerpt',
        relationPath: entry.relationPath,
        tags: entry.tags,
      });
    }
  } catch (error) {
    return {
      refs: [],
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }

  return {
    refs,
    issues: [],
  };
}
