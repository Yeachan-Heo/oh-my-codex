import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkProcessIdentityReadiness,
} from '../doctor.js';
import type {
  ProcessInspectionProvider,
  ProcessObservation,
} from '../../hooks/session.js';

function providerReturning(observation: ProcessObservation): Pick<ProcessInspectionProvider, 'observeProcess'> {
  return {
    observeProcess: () => observation,
  };
}

function providerReturningMalformed(observation: unknown): Pick<ProcessInspectionProvider, 'observeProcess'> {
  return {
    observeProcess: () => observation as ProcessObservation,
  };
}

describe('doctor native process identity readiness', () => {
  it('passes when the provider identifies the current process for the current platform', () => {
    const calls: Array<{ pid: number; platform: NodeJS.Platform }> = [];
    const check = checkProcessIdentityReadiness({
      platform: 'darwin',
      pid: 4242,
      provider: {
        observeProcess(pid, platform) {
          calls.push({ pid, platform });
          return {
            kind: 'identity',
            identity: { platform: 'darwin', birth: '123456' },
          };
        },
      },
    });

    assert.deepEqual(calls, [{ pid: 4242, platform: 'darwin' }]);
    assert.deepEqual(check, {
      name: 'Process identity',
      status: 'pass',
      message: 'native process identity provider is ready',
    });
  });

  it('preserves Linux compatibility by omitting the native runtime check', () => {
    let called = false;
    const check = checkProcessIdentityReadiness({
      platform: 'linux',
      provider: {
        observeProcess() {
          called = true;
          return { kind: 'error' };
        },
      },
    });

    assert.equal(check, null);
    assert.equal(called, false);
  });

  it('fails safely when the native runtime is missing or unsupported', () => {
    const check = checkProcessIdentityReadiness({
      platform: 'win32',
      provider: providerReturning({ kind: 'unsupported' }),
    });

    assert.equal(check?.status, 'fail');
    assert.equal(
      check?.message,
      'native process identity is unavailable (provider unavailable); reinstall or update OMX and rerun doctor',
    );
  });

  it('fails safely for ambiguous current-process observations', () => {
    for (const observation of [{ kind: 'gone' }, { kind: 'denied' }] as const) {
      const check = checkProcessIdentityReadiness({
        platform: 'darwin',
        provider: providerReturning(observation),
      });

      assert.equal(check?.status, 'fail');
      assert.match(check?.message ?? '', /reinstall or update OMX and rerun doctor$/);
    }
  });

  it('rejects foreign-platform identity evidence without trusting or repairing it', () => {
    const check = checkProcessIdentityReadiness({
      platform: 'darwin',
      provider: providerReturning({
        kind: 'identity',
        identity: { platform: 'win32', birth: '123456' },
      }),
    });

    assert.equal(check?.status, 'fail');
    assert.match(check?.message ?? '', /platform mismatch/);
  });

  it('fails safely for malformed, error, and throwing provider outcomes', () => {
    const providers: Array<Pick<ProcessInspectionProvider, 'observeProcess'>> = [
      providerReturning({ kind: 'error' }),
      providerReturning({
        kind: 'identity',
        identity: { platform: 'darwin', birth: '' },
      }),
      {
        observeProcess() {
          throw new Error('synthetic provider failure');
        },
      },
      providerReturningMalformed(undefined),
      providerReturningMalformed(null),
      providerReturningMalformed(42),
    ];

    for (const provider of providers) {
      const check = checkProcessIdentityReadiness({ platform: 'darwin', provider });
      assert.equal(check?.status, 'fail');
      assert.match(check?.message ?? '', /provider response unverifiable/);
    }
  });
});
