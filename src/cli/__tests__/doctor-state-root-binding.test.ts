import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkStateRootSessionBinding,
  formatStateRootSessionBindingDiagnostic,
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
      assert.match(message, /(?:terminate only verified owner if necessary|owner=terminate-verified-only-if-needed)/, status);
      assert.doesNotMatch(message, /…$/, status);
    }
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
});
