import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KEYWORD_TRIGGER_DEFINITIONS } from '../keyword-registry.js';
import { REMOVED_SKILLS } from '../sunset-stub.js';

// dist/hooks/__tests__/ -> repo root
const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

interface CatalogSkill {
  name: string;
  status: string;
}

function catalogSkills(): CatalogSkill[] {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'src', 'catalog', 'manifest.json'), 'utf-8'),
  ) as { skills: CatalogSkill[] };
  return manifest.skills;
}

/** Names a user can invoke and reach a real surface: active, internal, or an alias/merge target. */
function invocableSkillNames(): Set<string> {
  return new Set(
    catalogSkills()
      .filter((skill) => ['active', 'internal', 'alias', 'merged'].includes(skill.status))
      .map((skill) => skill.name),
  );
}

/** Documentation lines may name a retired skill only when the same line says so. */
const REMOVAL_LABELS = [
  'Removed in OMX 0.21',
  'was removed in OMX 0.21',
  'OMX 0.21 移除',
  'OMX 0.21 降級',
  'sunset stub',
  'has been removed',
];

const DOC_SURFACES = [
  join('docs', 'skills.html'),
  join('docs', 'readme', 'README.zh-TW.md'),
  join('docs', 'prompt-guidance-contract.md'),
];

describe('sunset routing contract', () => {
  it('drops the over-broad parallel trigger', () => {
    const parallel = KEYWORD_TRIGGER_DEFINITIONS.filter((entry) => entry.keyword === 'parallel');
    assert.deepEqual(
      parallel,
      [],
      'a bare English word must not activate a workflow; `parallel` routed to the ultrawork sunset stub',
    );
  });

  it('resolves every sunset replacement directly to an invocable skill', () => {
    const invocable = invocableSkillNames();
    const deadEnds: string[] = [];

    for (const [removed, info] of Object.entries(REMOVED_SKILLS)) {
      if (info.replacement === null) continue;
      const target = info.replacement.replace(/^\$/, '');
      if (!invocable.has(target)) {
        deadEnds.push(`$${removed} -> ${info.replacement} (${target} is not invocable)`);
      }
    }

    assert.deepEqual(
      deadEnds,
      [],
      'a replacement that points at another retired skill is a two-hop dead end: '
      + `${deadEnds.join(', ')}`,
    );
  });

  it('emits a non-activating diagnostic for a sunset token and mutates no workflow state', async () => {
    // The terminal critic's B1: the approved decision is that a sunset skill token produces a
    // DIAGNOSTIC, not an activation. A registry trigger is what makes a token activate, so the check
    // that matters is both halves - nothing routes, and nothing is written.
    const { detectPrimaryKeyword, recordSkillActivation } = await import('../keyword-detector.js');
    const { mkdtemp, mkdir, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { realpathSync, existsSync } = await import('node:fs');

    for (const token of ['$ralph', '$ultrawork', 'ulw', "don't stop", 'keep going', 'must complete']) {
      assert.equal(
        detectPrimaryKeyword(`${token} carry this on`),
        null,
        `${token} must not activate a workflow`,
      );
    }

    // Non-activation, asserted on what actually distinguishes it: a REFUSAL record is written
    // (active false, no active skills) and NO `<mode>-state.json` projection is created. An audit
    // record of the refusal is legitimate; a workflow projection would be the violation.
    for (const [token, mode] of [['$ralph', 'ralph'], ['$ultrawork', 'ultrawork']]) {
      const cwd = await mkdtemp(join(realpathSync(tmpdir()), 'omx-sunset-nostate-'));
      try {
        const stateDir = join(cwd, '.omx', 'state');
        const sessionId = 'sess-sunset';
        await mkdir(stateDir, { recursive: true });
        const result = await recordSkillActivation({
          stateDir,
          text: `${token} continue verification`,
          sessionId,
          nowIso: '2026-04-10T00:00:00.000Z',
        });
        assert.match(
          String((result as { transition_error?: string } | null)?.transition_error ?? ''),
          /has been removed/,
          `${token} must surface the sunset diagnostic`,
        );
        assert.equal((result as { active?: boolean } | null)?.active, false, `${token} must not report active`);
        assert.equal(
          existsSync(join(stateDir, 'sessions', sessionId, `${mode}-state.json`)),
          false,
          `${token} must not create a ${mode} workflow projection`,
        );
        const canonical = JSON.parse(
          await readFile(join(stateDir, 'sessions', sessionId, 'skill-active-state.json'), 'utf-8'),
        ) as { active?: boolean; active_skills?: unknown[] };
        assert.equal(canonical.active, false, `${token} must persist a refusal, not an activation`);
        assert.deepEqual(canonical.active_skills, [], `${token} must leave no active skill`);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }

    // And each retired token is declared so the diagnostic path has something to say.
    for (const [name, replacement] of [['ralph', '$ultragoal'], ['ultrawork', '$team']]) {
      const info = REMOVED_SKILLS[name];
      assert.ok(info, `${name} must be declared in REMOVED_SKILLS`);
      assert.equal(info.replacement, replacement);
    }
  });

  it('keeps every removed-skill message actionable', () => {
    for (const [removed, info] of Object.entries(REMOVED_SKILLS)) {
      assert.match(info.message, /removed/i, `${removed} message must say it was removed`);
      if (info.replacement !== null) {
        assert.ok(
          info.message.includes(info.replacement),
          `${removed} message must name its replacement ${info.replacement}`,
        );
      }
    }
  });

  it('never routes a keyword trigger at a skill the catalog does not ship', () => {
    const shipped = new Set(catalogSkills().map((skill) => skill.name));
    const unknown = KEYWORD_TRIGGER_DEFINITIONS
      .filter((entry) => !shipped.has(entry.skill))
      .map((entry) => `${entry.keyword} -> ${entry.skill}`);

    assert.deepEqual(
      unknown,
      [],
      `these triggers activate a skill absent from the catalog manifest: ${unknown.join(', ')}`,
    );
  });

  it('advertises no retired skill token in documentation without labelling it', () => {
    const invocable = invocableSkillNames();
    const violations: string[] = [];

    for (const relPath of DOC_SURFACES) {
      const content = readFileSync(join(repoRoot, relPath), 'utf-8');
      content.split('\n').forEach((line, index) => {
        // Each retired token must be bound to its OWN declaration: a removal label exempts only the
        // part of the line that follows it, so one generic "Removed in ..." phrase cannot silently
        // license every other token sitting earlier on the same line.
        const labelOffsets = REMOVAL_LABELS
          .map((label) => line.indexOf(label))
          .filter((offset) => offset >= 0);
        const earliestLabel = labelOffsets.length > 0 ? Math.min(...labelOffsets) : -1;
        for (const match of line.matchAll(/\$([a-z][a-z0-9-]*)/g)) {
          const token = match[1];
          // `$name` is a prose placeholder, not a skill invocation.
          if (token === 'name') continue;
          if (invocable.has(token)) continue;
          const exempt = earliestLabel >= 0 && match.index > earliestLabel;
          if (!exempt) violations.push(`${relPath}:${index + 1} $${token}`);
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      'documentation must not advertise a retired skill without a removal label: '
      + `${violations.join(', ')}`,
    );
  });

  it('keeps the ralplan skill mirrors byte-identical', () => {
    const root = readFileSync(join(repoRoot, 'skills', 'ralplan', 'SKILL.md'), 'utf-8');
    const mirror = readFileSync(
      join(repoRoot, 'plugins', 'oh-my-codex', 'skills', 'ralplan', 'SKILL.md'),
      'utf-8',
    );
    assert.equal(mirror, root, 'the plugin mirror must match the canonical ralplan skill exactly');
  });

  it('binds each retired token to its own removal label', () => {
    // Regression for a permissive allowlist: a label must not license a token that precedes it.
    const invocable = invocableSkillNames();
    const line = 'Use `$deepsearch` freely. Removed in OMX 0.21: `$tdd`';
    const labelOffset = line.indexOf('Removed in OMX 0.21');
    const offenders: string[] = [];
    for (const match of line.matchAll(/\$([a-z][a-z0-9-]*)/g)) {
      if (invocable.has(match[1])) continue;
      if (match.index < labelOffset) offenders.push(match[1]);
    }
    assert.deepEqual(offenders, ['deepsearch'], 'a token before the label must still be reported');
  });

  it('does not cite a deleted prompt or role as available', () => {
    for (const relPath of [
      join('skills', 'ralplan', 'SKILL.md'),
      join('plugins', 'oh-my-codex', 'skills', 'ralplan', 'SKILL.md'),
    ]) {
      const content = readFileSync(join(repoRoot, relPath), 'utf-8');
      assert.doesNotMatch(
        content,
        /Scholastic/,
        `${relPath} must not cite the Scholastic role; prompts/scholastic.md was deleted in OMX 0.21`,
      );
    }
    const contract = readFileSync(join(repoRoot, 'docs', 'prompt-guidance-contract.md'), 'utf-8');
    assert.doesNotMatch(
      contract,
      /`prompts\/sisyphus-lite\.md` should be treated/,
      'the contract must not tell overlays to compose the deleted sisyphus-lite prompt',
    );
  });
});


describe('active workflow handoff hygiene', () => {
  const retiredExecutionTokens = /\$(?:ralph|ultrawork|pipeline|autoresearch-goal)\b/;
  const retiredProseHandoff = /\b(?:run|use|start|launch|invoke|hand off to|explicit|separate)\s+(?:a\s+|an\s+|the\s+)?(?:Ralph|Ultrawork|Pipeline|Autoresearch-goal)\b/i;
  const migrationOnly = /(?:was|has been) (?:removed|retired)|(?:legacy|historical) (?:artifact|state)|compatibility (?:input|cleanup)/i;
  function staleHandoffs(text: string): string[] {
    return text.split('\n').filter((line) => (retiredExecutionTokens.test(line) || retiredProseHandoff.test(line)) && !migrationOnly.test(line));
  }

  it('distinguishes a labeled migration from an executable legacy fallback', () => {
    assert.deepEqual(staleHandoffs('`$ralph` was removed; use `$ultragoal`.'), []);
    assert.deepEqual(staleHandoffs('Read historical artifacts from `$autoresearch-goal`.'), []);
    assert.equal(staleHandoffs('Use `$ralph` as a legacy fallback.').length, 1);
    assert.equal(staleHandoffs('### Hand off to `$ralph`').length, 1);
    assert.equal(staleHandoffs('Run a separate Ralph loop.').length, 1);
    assert.equal(staleHandoffs('Use an explicit Ralph verification pass.').length, 1);
  });

  it('active and internal skill cards do not hand off to retired execution tokens', () => {
    const failures = catalogSkills()
      .filter((skill) => ['active', 'internal'].includes(skill.status))
      .flatMap((skill) => staleHandoffs(readFileSync(join(repoRoot, 'skills', skill.name, 'SKILL.md'), 'utf-8'))
        .map((line) => `${skill.name}: ${line}`));
    assert.deepEqual(failures, []);
  });
});
