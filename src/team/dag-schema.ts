import { basename } from 'node:path';
import { readTeamDagArtifactResolution } from '../planning/artifacts.js';

export type TeamDagWorkerCountSource = 'cli-explicit' | 'plan-suggested' | 'default-derived';

export interface TeamDagNode {
  id: string;
  subject: string;
  description: string;
  role?: string;
  lane?: string;
  filePaths?: string[];
  domains?: string[];
  depends_on?: string[];
  requires_code_change?: boolean;
  acceptance?: string[];
}

export interface TeamDagWorkerPolicy {
  requested_count?: number;
  count_source?: TeamDagWorkerCountSource;
  max_count?: number;
  reserve_verification_lane?: boolean;
  strict_max_count?: boolean;
}

export interface TeamDagHandoff {
  schema_version: 1;
  plan_slug?: string;
  source_prd?: string;
  nodes: TeamDagNode[];
  worker_policy?: TeamDagWorkerPolicy;
}

export interface TeamDagResolution {
  dag: TeamDagHandoff | null;
  source: 'sidecar' | 'markdown' | 'none';
  dagState: 'disabled' | 'absent' | 'invalid' | 'valid';
  path?: string;
  planSlug?: string;
  warning?: string;
  error?: string;
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('expected string array');
  }
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('expected string');
  return value;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error('expected boolean');
  return value;
}

function asOptionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('expected positive integer');
  }
  return value;
}

function parseWorkerPolicy(value: unknown): TeamDagWorkerPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('worker_policy must be an object');
  const raw = value as Record<string, unknown>;
  const countSource = raw.count_source;
  if (
    countSource !== undefined
    && countSource !== 'cli-explicit'
    && countSource !== 'plan-suggested'
    && countSource !== 'default-derived'
  ) {
    throw new Error('worker_policy.count_source is invalid');
  }
  return {
    requested_count: asOptionalPositiveInteger(raw.requested_count),
    count_source: countSource as TeamDagWorkerCountSource | undefined,
    max_count: asOptionalPositiveInteger(raw.max_count),
    reserve_verification_lane: asOptionalBoolean(raw.reserve_verification_lane),
    strict_max_count: asOptionalBoolean(raw.strict_max_count),
  };
}

export function parseTeamDagHandoff(value: unknown): TeamDagHandoff {
  if (!value || typeof value !== 'object') throw new Error('Team DAG handoff must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== 1) throw new Error('Team DAG handoff schema_version must be 1');
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) throw new Error('Team DAG handoff nodes must be a non-empty array');

  const seen = new Set<string>();
  const nodes = raw.nodes.map((nodeValue, index): TeamDagNode => {
    if (!nodeValue || typeof nodeValue !== 'object') throw new Error(`node ${index + 1} must be an object`);
    const node = nodeValue as Record<string, unknown>;
    if (typeof node.id !== 'string' || node.id.trim() === '') throw new Error(`node ${index + 1} id is required`);
    if (seen.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    seen.add(node.id);
    if (typeof node.subject !== 'string' || node.subject.trim() === '') throw new Error(`node ${node.id} subject is required`);
    if (typeof node.description !== 'string' || node.description.trim() === '') throw new Error(`node ${node.id} description is required`);
    return {
      id: node.id,
      subject: node.subject,
      description: node.description,
      role: asOptionalString(node.role),
      lane: asOptionalString(node.lane),
      filePaths: asStringArray(node.filePaths),
      domains: asStringArray(node.domains),
      depends_on: asStringArray(node.depends_on),
      requires_code_change: asOptionalBoolean(node.requires_code_change),
      acceptance: asStringArray(node.acceptance),
    };
  });

  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!seen.has(dep)) throw new Error(`node ${node.id} depends on unknown node: ${dep}`);
    }
  }
  assertAcyclic(nodes);

  return {
    schema_version: 1,
    plan_slug: asOptionalString(raw.plan_slug),
    source_prd: asOptionalString(raw.source_prd),
    nodes,
    worker_policy: parseWorkerPolicy(raw.worker_policy),
  };
}

function assertAcyclic(nodes: TeamDagNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`cycle detected at node: ${id}`);
    visiting.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

function parseJsonText(text: string): TeamDagHandoff {
  return parseTeamDagHandoff(JSON.parse(text) as unknown);
}

function assertDagMatchesPlan(dag: TeamDagHandoff, slug: string, prdPath: string): void {
  if (dag.plan_slug !== undefined && dag.plan_slug !== slug) {
    throw new Error(`Team DAG plan_slug ${dag.plan_slug} does not match latest approved plan slug ${slug}`);
  }
  if (dag.source_prd !== undefined && basename(dag.source_prd) !== basename(prdPath)) {
    throw new Error(`Team DAG source_prd ${dag.source_prd} does not match latest approved PRD ${basename(prdPath)}`);
  }
}

export function readTeamDagHandoffForLatestPlan(cwd: string): TeamDagResolution {
  const artifact = readTeamDagArtifactResolution(cwd);
  const source = artifact.source === 'json-sidecar'
    ? 'sidecar'
    : artifact.source === 'markdown-handoff'
      ? 'markdown'
      : 'none';
  if (!artifact.content || !artifact.prdPath || !artifact.planSlug) {
    return {
      dag: null,
      source,
      dagState: 'absent',
      path: artifact.artifactPath,
      planSlug: artifact.planSlug ?? undefined,
      warning: artifact.warnings[0],
      error: artifact.warnings[0],
    };
  }
  try {
    const dag = parseJsonText(artifact.content);
    assertDagMatchesPlan(dag, artifact.planSlug, artifact.prdPath);
    return {
      dag,
      source,
      dagState: 'valid',
      path: artifact.artifactPath ?? artifact.prdPath,
      planSlug: artifact.planSlug,
      warning: artifact.warnings[0],
    };
  } catch (error) {
    return {
      dag: null,
      source,
      dagState: 'invalid',
      path: artifact.artifactPath ?? artifact.prdPath,
      planSlug: artifact.planSlug,
      warning: artifact.warnings[0],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
