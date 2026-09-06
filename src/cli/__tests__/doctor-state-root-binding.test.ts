import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkStateRootSessionBinding,
  formatStateRootSessionBindingDiagnostic,
  repairStateProjections,
} from '../doctor.js';
import {
  readCanonicalSessionBindingSnapshot,
  type CanonicalSessionBindingSnapshot,
} from '../../mcp/state-paths.js';

function syntheticSnapshot(
  status: CanonicalSessionBindingSnapshot['status'],
  overrides: Partial<CanonicalSessionBindingSnapshot> = {},
): CanonicalSessionBindingSnapshot {
  return {
    cwd: '/tmp/workspace',
    status,
    rootSource: 'omx-root-env',
    baseStateDir: '/tmp/workspace/.omx/state',
    selectedSessionJson: '/tmp/workspace/.omx/state/session.json',
    verifiedAliases: {},
    ...overrides,
  };
}

describe('doctor state-root/session binding diagnostics', () => {
  it('reports unavailable runtime binding for only an ambient Codex session in an uninitialized workspace', () => {
    const check = checkStateRootSessionBinding(
      syntheticSnapshot('absent', { rootSource: 'cwd-default' }),
      { CODEX_SESSION_ID: 'codex-session' },
    );
    assert.equal(check.status, 'warn');
    assert.match(check.message, /runtime binding unavailable/);
    assert.doesNotMatch(check.message, /bad_selectors|clear|relaunch/);
  });

  it('leaves a fresh workspace untouched when inspecting an ambient Codex session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-doctor-ambient-session-'));
    try {
      const env = { CODEX_SESSION_ID: 'codex-session' };
      const snapshot = await readCanonicalSessionBindingSnapshot(cwd, env);
      assert.equal(snapshot.status, 'absent');
      assert.equal(snapshot.rootSource, 'cwd-default');
      assert.equal(checkStateRootSessionBinding(snapshot, env).status, 'warn');
      assert.deepEqual(await readdir(cwd), []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps explicit runtime selectors and unsafe pointers fail-closed', () => {
    for (const env of [
      { CODEX_SESSION_ID: 'codex-session', OMX_SESSION_ID: 'omx-session' },
      { CODEX_SESSION_ID: 'codex-session', SESSION_ID: 'session' },
      { CODEX_SESSION_ID: 'codex-session', OMX_ROOT: '/explicit' },
      { CODEX_SESSION_ID: 'codex-session', OMX_STATE_ROOT: '/explicit' },
      { CODEX_SESSION_ID: 'codex-session', OMX_TEAM_STATE_ROOT: '/explicit' },
      { CODEX_SESSION_ID: 'invalid/session' },
    ]) {
      assert.equal(checkStateRootSessionBinding(
        syntheticSnapshot('absent', { rootSource: 'cwd-default' }), env,
      ).status, 'fail');
    }
    for (const status of ['foreign-cwd', 'malformed', 'identity-indeterminate', 'usable'] as const) {
      assert.equal(checkStateRootSessionBinding(
        syntheticSnapshot(status, { rootSource: 'cwd-default' }),
        { CODEX_SESSION_ID: 'unverified-codex' },
      ).status, 'fail');
    }
    assert.equal(checkStateRootSessionBinding(
      syntheticSnapshot('absent'), { CODEX_SESSION_ID: 'codex-session' },
    ).status, 'fail');
  });

  it('prefers the winning env root over OMX_SESSION_ID during resolution failure', async () => {
    const env = {
      OMX_ROOT: '/winning-root',
      OMX_SESSION_ID: 'ambient-session',
    };
    const snapshot = await readCanonicalSessionBindingSnapshot('\0', env);
    assert.equal(snapshot.status, 'resolution-error');
    assert.equal(snapshot.rootSource, 'omx-root-env');

    const check = checkStateRootSessionBinding(snapshot, env);
    assert.equal(check.status, 'fail');
    assert.equal(
      check.message,
      [
        'src=omx-root-env',
        'root=OMX_ROOT',
        'clear=OMX_ROOT-if-unintended',
        'ptr=resolve',
        'fix=clear/correct',
        'no-mutation',
        'bad_selectors=OMX_SESSION_ID',
      ].join(';'),
    );
  });

  it('reports absent, foreign, and malformed pointers without mutation', () => {
    const absent = checkStateRootSessionBinding(syntheticSnapshot('absent'), {});
    assert.equal(absent.status, 'pass');
    assert.match(absent.message, /ptr=absent/);

    const foreign = checkStateRootSessionBinding(
      syntheticSnapshot('foreign-cwd'),
      { OMX_SESSION_ID: 'wrong-session' },
    );
    assert.equal(foreign.status, 'fail');
    assert.equal(
      foreign.message,
      [
        'src=omx-root-env',
        'root=OMX_ROOT',
        'clear=OMX_ROOT-if-unintended',
        'ptr=foreign',
        'fix=clear/correct',
        'no-mutation',
        'owner=terminate-verified-only-if-needed',
        'selected=session.json',
        'bad_selectors=OMX_SESSION_ID',
      ].join(';'),
    );

    const malformed = checkStateRootSessionBinding(
      syntheticSnapshot('malformed'),
      { OMX_SESSION_ID: 'wrong-session' },
    );
    assert.equal(malformed.status, 'fail');
    assert.equal(
      malformed.message,
      [
        'src=omx-root-env',
        'root=OMX_ROOT',
        'clear=OMX_ROOT-if-unintended',
        'ptr=malformed',
        'fix=clear/correct',
        'no-mutation',
        'owner=terminate-verified-only-if-needed',
        'selected=session.json',
        'bad_selectors=OMX_SESSION_ID',
      ].join(';'),
    );
  });

  it('keeps mandatory static fields when a diagnostic is capped', () => {
    const message = formatStateRootSessionBindingDiagnostic(
      syntheticSnapshot('resolution-error', {
        selectedSessionJson: `/tmp/${'x'.repeat(400)}/session.json`,
      }),
      {
        OMX_ROOT: '/winning-root',
        OMX_SESSION_ID: 'ambient-session',
        CODEX_SESSION_ID: 'ambient-codex',
        SESSION_ID: 'ambient-session-alias',
      },
      ['SESSION_ID', 'OMX_SESSION_ID', 'CODEX_SESSION_ID'],
    );
    const expected = [
      'src=omx-root-env',
      'root=OMX_ROOT',
      'clear=OMX_ROOT-if-unintended',
      'ptr=resolve',
      'fix=clear/correct',
      'no-mutation',
      'selected=session.json',
      'bad_selectors=OMX_SESSION_ID,CODEX_SESSION_ID,SESSION_ID',
    ].join(';');
    assert.equal(message, expected);
    assert.ok(message.length <= 240);
  });
  it('keeps atomic selected-session and selector fields plus verified-owner recovery in capped diagnostics', () => {
    for (const status of ['malformed', 'foreign-cwd', 'stale-dead', 'identity-indeterminate'] as const) {
      const message = formatStateRootSessionBindingDiagnostic(
        syntheticSnapshot(status, {
          selectedSessionJson: `/tmp/${'x'.repeat(400)}/session.json`,
        }),
        {
          OMX_ROOT: '/winning-root',
          OMX_SESSION_ID: 'ambient-session',
          CODEX_SESSION_ID: 'ambient-codex',
          SESSION_ID: 'ambient-session-alias',
        },
        ['SESSION_ID', 'OMX_SESSION_ID', 'CODEX_SESSION_ID'],
      );
      assert.ok(message.length <= 240, status);
      assert.match(message, /session\.json/, status);
      assert.match(message, /bad_selectors=OMX_SESSION_ID,CODEX_SESSION_ID,SESSION_ID/, status);
      if (status === 'stale-dead') {
        assert.match(message, /(?:positively dead, non-reused owner|recover=dead-nonreused-only)/, status);
        assert.doesNotMatch(message, /recover=omx-session-pointer-recover/, status);
      } else {
        assert.match(message, /(?:terminate only verified owner if necessary|owner=terminate-verified-only-if-needed)/, status);
      }
      assert.doesNotMatch(message, /…$/, status);
    }
  });
  it('does not prescribe verified-dead recovery for reused or uncertain owner identity', () => {
    const message = formatStateRootSessionBindingDiagnostic(
      syntheticSnapshot('stale-dead', { selectedSessionJson: '/tmp/project/.omx/state/session.json' }),
      {},
    );
    assert.match(message, /(?:only for a positively dead, non-reused owner|recover=dead-nonreused-only)/);
    assert.match(message, /(?:reused or uncertain identity requires investigation|reused=investigate)/);
  });
  it('keeps all selector recovery fields atomic for owner diagnostics at the final cap fallback', () => {
    const cases = [
      { source: 'omx-root-env' as const, selector: 'OMX_ROOT', env: { OMX_ROOT: '/winning-root' } },
      { source: 'omx-state-root-env' as const, selector: 'OMX_STATE_ROOT', env: { OMX_STATE_ROOT: '/winning-state-root' } },
      { source: 'team-env' as const, selector: 'OMX_TEAM_STATE_ROOT', env: { OMX_TEAM_STATE_ROOT: '/winning-team-root' } },
    ];
    for (const testCase of cases) {
      const message = formatStateRootSessionBindingDiagnostic(
        syntheticSnapshot('identity-indeterminate', {
          rootSource: testCase.source,
          selectedSessionJson: `/tmp/${'x'.repeat(400)}/session.json`,
        }),
        {
          ...testCase.env,
          OMX_SESSION_ID: 'ambient-session',
          CODEX_SESSION_ID: 'ambient-codex',
          SESSION_ID: 'ambient-session-alias',
        },
        ['SESSION_ID', 'OMX_SESSION_ID', 'CODEX_SESSION_ID'],
      );
      const expected = [
        `src=${testCase.source}`,
        `root=${testCase.selector}`,
        `clear=${testCase.selector}-if-unintended`,
        'ptr=indet',
        'fix=clear/correct',
        'no-mutation',
        'owner=terminate-verified-only-if-needed',
        'selected=session.json',
        'bad_selectors=OMX_SESSION_ID,CODEX_SESSION_ID,SESSION_ID',
      ].join(';');
      assert.equal(message, expected, testCase.source);
      assert.ok(message.length <= 240, testCase.source);
    }
  });

  it('archives stale projections while preserving the current scope and unrelated artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-doctor-repair-state-'));
    try {
      const stateRoot = join(cwd, '.omx', 'state');
      const currentSession = join(stateRoot, 'sessions', 'current-session');
      const staleSession = join(stateRoot, 'sessions', 'stale-session');
      await mkdir(currentSession, { recursive: true });
      await mkdir(staleSession, { recursive: true });
      await writeFile(join(stateRoot, 'session.json'), JSON.stringify({
        session_id: 'current-session',
        cwd,
        state_root: stateRoot,
      }));
      await writeFile(join(stateRoot, 'root-state.json'), 'root projection');
      await writeFile(join(currentSession, 'current-state.json'), 'current projection');
      await writeFile(join(staleSession, 'stale-state.json'), 'stale projection');
      await writeFile(join(cwd, '.omx', 'plans.md'), 'keep plans');
      await writeFile(join(cwd, '.omx', 'specs.md'), 'keep specs');
      await writeFile(join(cwd, '.omx', 'context.md'), 'keep context');

      const first = await repairStateProjections(cwd, {});
      assert.equal(first.archived.length, 2);
      assert.equal(await readFile(join(currentSession, 'current-state.json'), 'utf8'), 'current projection');
      assert.equal(await readFile(join(stateRoot, 'session.json'), 'utf8') !== '', true);
      assert.equal(await readFile(join(cwd, '.omx', 'plans.md'), 'utf8'), 'keep plans');
      assert.equal(await readFile(join(cwd, '.omx', 'specs.md'), 'utf8'), 'keep specs');
      assert.equal(await readFile(join(cwd, '.omx', 'context.md'), 'utf8'), 'keep context');
      assert.equal(await readFile(join(cwd, '.omx', 'archive', 'state', 'root-state.json'), 'utf8'), 'root projection');
      assert.equal(await readFile(join(cwd, '.omx', 'archive', 'state', 'sessions', 'stale-session', 'stale-state.json'), 'utf8'), 'stale projection');

      const second = await repairStateProjections(cwd, {});
      assert.deepEqual(second.archived, []);
      assert.equal((await readdir(join(cwd, '.omx', 'archive', 'state'))).includes('root-state.json'), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not archive symlink projections without file ownership proof', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-doctor-repair-state-link-'));
    try {
      const stateRoot = join(cwd, '.omx', 'state');
      await mkdir(stateRoot, { recursive: true });
      const target = join(cwd, 'foreign-state.json');
      const projection = join(stateRoot, 'foreign-state.json');
      await writeFile(target, 'foreign');
      await symlink(target, projection);
      const result = await repairStateProjections(cwd, {});
      assert.deepEqual(result.archived, []);
      assert.equal(await readFile(projection, 'utf8'), 'foreign');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
