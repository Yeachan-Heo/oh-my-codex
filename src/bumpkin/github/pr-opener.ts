import type { UpgradeTarget } from '../skills/upgrade-planner.js';
import type { PhaseTransition } from '../phase-controller.js';

export interface UpgradeRunResult {
  target: UpgradeTarget;
  status: 'ready-to-ship' | 'escalated' | 'failed';
  transitions: ReadonlyArray<PhaseTransition>;
  gateOutcomes: ReadonlyArray<{ gate: string; pass: boolean; reason: string }>;
  reviewerVerdict?: 'APPROVE' | 'REJECT';
  reviewerRationale?: string;
  escalationReason?: string;
  tokenSpend: { ossTokens: number; frontierTokens: number };
  diffStats: { files: number; lines: number };
  safetyCriticalPathsTouched: readonly string[];
}

export interface PullRequestSpec {
  branchName: string;
  title: string;
  body: string;
  labels: string[];
  draft: boolean;
  autoMerge: boolean;
}

export interface PrOpenerOptions {
  autoMergeDevDepPatches?: boolean;
  branchPrefix?: string;
}

export function sanitizeDependencyForBranch(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

export function buildPullRequestSpec(
  result: UpgradeRunResult,
  options: PrOpenerOptions = {},
): PullRequestSpec {
  const prefix = options.branchPrefix ?? 'bumpkin';
  const safeName = sanitizeDependencyForBranch(result.target.name);
  const branchName = `${prefix}/${safeName}-${result.target.from}-to-${result.target.to}`;

  const isMajorBump = versionBumpKind(result.target.from, result.target.to) === 'major';
  const isSafetyCritical = result.safetyCriticalPathsTouched.length > 0;
  const isEscalated = result.status === 'escalated';

  const labels: string[] = ['bumpkin', `risk:${result.target.riskLevel}`];
  if (isMajorBump) labels.push('major-bump');
  if (isSafetyCritical) labels.push('safety-critical', 'needs-human-review');
  if (isEscalated) labels.push('auto-fix-failed', 'needs-human-review');

  const draft = isEscalated || result.status === 'failed';
  const autoMerge = computeAutoMerge(result, isMajorBump, isSafetyCritical, options);

  const title =
    result.status === 'escalated'
      ? `[bumpkin] could not auto-upgrade ${result.target.name} to ${result.target.to} — human review needed`
      : `Bump ${result.target.name} from ${result.target.from} to ${result.target.to}`;

  return { branchName, title, body: renderBody(result), labels, draft, autoMerge };
}

function computeAutoMerge(
  result: UpgradeRunResult,
  isMajor: boolean,
  isSafetyCritical: boolean,
  options: PrOpenerOptions,
): boolean {
  if (result.status !== 'ready-to-ship') return false;
  if (isMajor) return false;
  if (isSafetyCritical) return false;
  if (!options.autoMergeDevDepPatches) return false;
  return versionBumpKind(result.target.from, result.target.to) === 'patch';
}

export function versionBumpKind(from: string, to: string): 'patch' | 'minor' | 'major' | 'unknown' {
  const parse = (v: string) =>
    v
      .replace(/^[\^~=v]/, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10));
  const [fM, fm, fp] = parse(from);
  const [tM, tm, tp] = parse(to);
  if ([fM, fm, fp, tM, tm, tp].some((n) => !Number.isFinite(n))) return 'unknown';
  if (tM !== fM) return 'major';
  if (tm !== fm) return 'minor';
  if (tp !== fp) return 'patch';
  return 'patch';
}

function renderBody(result: UpgradeRunResult): string {
  const lines: string[] = [];
  lines.push(`## Upgrade: \`${result.target.name}\` ${result.target.from} → ${result.target.to}`);
  lines.push('');
  lines.push(`**Risk:** ${result.target.riskLevel}`);
  lines.push(`**Status:** ${result.status}`);
  if (result.target.rationale) lines.push(`**Rationale:** ${result.target.rationale}`);
  lines.push('');

  if (result.status === 'escalated' && result.escalationReason) {
    lines.push(`> ⚠️ **Escalated:** ${result.escalationReason}. Human review required — auto-merge disabled.`);
    lines.push('');
  }

  if (result.safetyCriticalPathsTouched.length > 0) {
    lines.push(
      `> ⚠️ **Safety-critical paths touched:** ${result.safetyCriticalPathsTouched.join(', ')}. Auto-merge disabled.`,
    );
    lines.push('');
  }

  lines.push('### Gate results');
  lines.push('');
  lines.push('| Gate | Result | Reason |');
  lines.push('|---|---|---|');
  for (const g of result.gateOutcomes) {
    const check = g.pass ? '✅' : '❌';
    lines.push(`| ${g.gate} | ${check} | ${escapeTableCell(g.reason)} |`);
  }

  if (result.reviewerVerdict) {
    lines.push('');
    lines.push(`**Reviewer verdict:** ${result.reviewerVerdict}`);
    if (result.reviewerRationale) lines.push(`> ${result.reviewerRationale}`);
  }

  lines.push('');
  lines.push('### Diff stats');
  lines.push(`- Files changed: ${result.diffStats.files}`);
  lines.push(`- Lines changed: ${result.diffStats.lines}`);

  lines.push('');
  lines.push('<details><summary>Audit trail (phase transitions)</summary>');
  lines.push('');
  for (const t of result.transitions) {
    const reason = t.reason ? ` — ${t.reason}` : '';
    lines.push(`- \`${t.at}\`: ${t.from} → ${t.to}${reason}`);
  }
  lines.push('');
  lines.push('</details>');

  lines.push('');
  lines.push('### Token spend');
  const total = result.tokenSpend.ossTokens + result.tokenSpend.frontierTokens;
  const ossShare = total === 0 ? 0 : result.tokenSpend.ossTokens / total;
  lines.push(
    `- OSS: ${result.tokenSpend.ossTokens} tokens (${(ossShare * 100).toFixed(1)}%) · Frontier: ${result.tokenSpend.frontierTokens}`,
  );

  lines.push('');
  lines.push('---');
  lines.push('_Opened by [Bumpkin](https://github.com/yi-here/orcacoder-harness) — AI-native dependency upgrades._');
  return lines.join('\n');
}

function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
