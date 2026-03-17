import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AutoresearchKeepPolicy, parseSandboxContract, slugifyMissionName } from '../autoresearch/contracts.js';

export interface AutoresearchSeedInputs {
  topic?: string;
  evaluatorCommand?: string;
  keepPolicy?: AutoresearchKeepPolicy;
  slug?: string;
}

export interface AutoresearchDraftCompileTarget {
  topic: string;
  evaluatorCommand: string;
  keepPolicy: AutoresearchKeepPolicy;
  slug: string;
  repoRoot: string;
}

export interface AutoresearchDraftArtifact {
  compileTarget: AutoresearchDraftCompileTarget;
  path: string;
  content: string;
  launchReady: boolean;
  blockedReasons: string[];
}

const BLOCKED_EVALUATOR_PATTERNS = [
  /<[^>]+>/i,
  /\bTODO\b/i,
  /\bTBD\b/i,
  /REPLACE_ME/i,
  /CHANGEME/i,
  /your-command-here/i,
] as const;

function defaultDraftEvaluator(topic: string): string {
  const detail = topic.trim() || 'the mission';
  return `TODO replace with evaluator command for: ${detail}`;
}

export function isLaunchReadyEvaluatorCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return !BLOCKED_EVALUATOR_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildLaunchReadinessSection(launchReady: boolean, blockedReasons: readonly string[]): string {
  if (launchReady) {
    return 'Launch-ready: yes\n- Evaluator command is concrete and can be compiled into sandbox.md';
  }

  return [
    'Launch-ready: no',
    ...blockedReasons.map((reason) => `- ${reason}`),
  ].join('\n');
}

export function buildAutoresearchDraftArtifactContent(
  compileTarget: AutoresearchDraftCompileTarget,
  seedInputs: AutoresearchSeedInputs,
  launchReady: boolean,
  blockedReasons: readonly string[],
): string {
  const seedTopic = seedInputs.topic?.trim() || '(none)';
  const seedEvaluator = seedInputs.evaluatorCommand?.trim() || '(none)';
  const seedKeepPolicy = seedInputs.keepPolicy || '(none)';
  const seedSlug = seedInputs.slug?.trim() || '(none)';

  return [
    `# Deep Interview Autoresearch Draft — ${compileTarget.slug}`,
    '',
    '## Mission Draft',
    compileTarget.topic,
    '',
    '## Evaluator Draft',
    compileTarget.evaluatorCommand,
    '',
    '## Keep Policy',
    compileTarget.keepPolicy,
    '',
    '## Session Slug',
    compileTarget.slug,
    '',
    '## Seed Inputs',
    `- topic: ${seedTopic}`,
    `- evaluator: ${seedEvaluator}`,
    `- keep_policy: ${seedKeepPolicy}`,
    `- slug: ${seedSlug}`,
    '',
    '## Launch Readiness',
    buildLaunchReadinessSection(launchReady, blockedReasons),
    '',
    '## Confirmation Bridge',
    '- refine further',
    '- launch',
    '',
  ].join('\n');
}

export async function writeAutoresearchDraftArtifact(input: {
  repoRoot: string;
  topic: string;
  evaluatorCommand?: string;
  keepPolicy: AutoresearchKeepPolicy;
  slug?: string;
  seedInputs?: AutoresearchSeedInputs;
}): Promise<AutoresearchDraftArtifact> {
  const topic = input.topic.trim();
  if (!topic) {
    throw new Error('Research topic is required.');
  }

  const slug = slugifyMissionName(input.slug?.trim() || topic);
  const evaluatorCommand = (input.evaluatorCommand?.trim() || defaultDraftEvaluator(topic)).replace(/[\r\n]+/g, ' ').trim();
  const compileTarget: AutoresearchDraftCompileTarget = {
    topic,
    evaluatorCommand,
    keepPolicy: input.keepPolicy,
    slug,
    repoRoot: input.repoRoot,
  };

  const blockedReasons: string[] = [];
  if (!isLaunchReadyEvaluatorCommand(evaluatorCommand)) {
    blockedReasons.push('Evaluator command is still a placeholder/template and must be replaced before launch.');
  }

  if (blockedReasons.length === 0) {
    parseSandboxContract(`---\nevaluator:\n  command: ${evaluatorCommand}\n  format: json\n  keep_policy: ${input.keepPolicy}\n---\n`);
  }

  const launchReady = blockedReasons.length === 0;
  const specsDir = join(input.repoRoot, '.omx', 'specs');
  await mkdir(specsDir, { recursive: true });
  const path = join(specsDir, `deep-interview-autoresearch-${slug}.md`);
  const content = buildAutoresearchDraftArtifactContent(compileTarget, input.seedInputs || {}, launchReady, blockedReasons);
  await writeFile(path, content, 'utf-8');

  return { compileTarget, path, content, launchReady, blockedReasons };
}
