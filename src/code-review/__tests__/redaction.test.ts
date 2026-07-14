import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

interface RedactionApi {
  redactReviewText(value: unknown, options?: { repositoryRoot?: string }): string;
  validateReviewFinding(value: unknown): {
    title: string;
    body: string;
    file: string;
    fix: string;
    evidence?: string;
  };
  sanitizeForPersistence<T>(value: T, options?: { repositoryRoot?: string }): T;
}

async function loadRedactionApi(): Promise<RedactionApi> {
  const modulePath: string = '../redaction.js';
  const loaded = await import(modulePath).catch(() => null) as Partial<RedactionApi> | null;
  assert.equal(
    typeof loaded?.redactReviewText,
    'function',
    'expected review redaction to be implemented',
  );
  assert.equal(typeof loaded?.validateReviewFinding, 'function');
  assert.equal(typeof loaded?.sanitizeForPersistence, 'function');
  return loaded as RedactionApi;
}

describe('code-review redaction and validation', () => {
  it('redacts provider tokens, generic secrets, and authorization headers', async () => {
    const api = await loadRedactionApi();
    const sensitive = [
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv',
      'github_token=ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      'password: hunter2',
      'client_secret="secret-client-value"',
      'Authorization: Bearer authorization-secret-value',
    ].join('\n');

    const redacted = api.redactReviewText(sensitive);
    assert.doesNotMatch(
      redacted,
      /sk-proj-|ghp_|hunter2|secret-client-value|authorization-secret-value/u,
    );
    assert.match(redacted, /\[REDACTED\]/u);
  });

  it('redacts AWS access-key identifiers and complete PEM private-key blocks', async () => {
    const api = await loadRedactionApi();
    const rsa = '-----BEGIN RSA PRIVATE KEY-----\nrsa-material\n-----END RSA PRIVATE KEY-----';
    const ec = '-----BEGIN EC PRIVATE KEY-----\nec-material\n-----END EC PRIVATE KEY-----';
    const pkcs8 = '-----BEGIN PRIVATE KEY-----\npkcs8-material\n-----END PRIVATE KEY-----';
    const sensitive = [
      'AKIAIOSFODNN7EXAMPLE',
      'ASIAIOSFODNN7EXAMPLE',
      rsa,
      ec,
      pkcs8,
    ].join('\n');

    const redacted = api.redactReviewText(sensitive);
    assert.doesNotMatch(redacted, /(?:AKIA|ASIA)IOSFODNN7EXAMPLE|BEGIN .*PRIVATE KEY|material/u);
    assert.equal(redacted.match(/\[REDACTED\]/gu)?.length, 5);

    const finding = api.validateReviewFinding({
      severity: 'HIGH',
      title: 'Credentials are exposed',
      body: 'AWS access key AKIAIOSFODNN7EXAMPLE is present.',
      file: 'src/a.ts',
      fix: 'Rotate ASIAIOSFODNN7EXAMPLE immediately.',
      evidence: `${rsa}\n${ec}\n${pkcs8}`,
    });
    assert.doesNotMatch(
      `${finding.body}\n${finding.fix}\n${finding.evidence}`,
      /(?:AKIA|ASIA)IOSFODNN7EXAMPLE|BEGIN .*PRIVATE KEY|material/u,
    );
  });

  it('redacts quoted JSON secret values across case, snake-case, camelCase, and nested metadata', async () => {
    const api = await loadRedactionApi();
    const finding = api.validateReviewFinding({
      severity: 'HIGH',
      title: 'Quoted JSON credentials',
      body: '{"password":"hunter2","API_KEY":"snake-secret"}',
      file: 'src/a.ts',
      fix: '{"Authorization":"Bearer header-secret"}',
      evidence: '{"apiKey":"plain-secret"}',
    });
    const sanitized = api.sanitizeForPersistence({
      reasons: ['{"Password":"reason-secret"}'],
      diagnostics: [{ summary: '{"authorization":"Basic diagnostic-secret"}' }],
      nested: { value: '{"client_secret":"nested-secret"}' },
    });
    const serialized = JSON.stringify({ finding, sanitized });

    assert.doesNotMatch(
      serialized,
      /hunter2|snake-secret|header-secret|plain-secret|reason-secret|diagnostic-secret|nested-secret/u,
    );
    assert.match(serialized, /\\"password\\":\\"\[REDACTED\]\\"/u);
    assert.match(serialized, /\\"apiKey\\":\\"\[REDACTED\]\\"/u);
  });

  it('removes absolute home and repository roots without changing safe relative paths', async () => {
    const api = await loadRedactionApi();
    const repositoryRoot = '/Users/alice/projects/private-repo';
    const redacted = api.redactReviewText(
      `${repositoryRoot}/src/a.ts /Users/alice/.codex/auth.json /home/bob/.config/token src/safe.ts`,
      { repositoryRoot },
    );

    assert.doesNotMatch(redacted, /Users\/alice|home\/bob|private-repo/u);
    assert.match(redacted, /\[REPOSITORY_ROOT\]\/src\/a\.ts/u);
    assert.match(redacted, /src\/safe\.ts/u);
  });

  it('redacts before applying evidence bounds and never truncates invalid evidence', async () => {
    const api = await loadRedactionApi();
    const redactedFirst = api.validateReviewFinding({
      severity: 'HIGH',
      title: 'Credential leak',
      body: 'A credential is exposed.',
      file: 'src/a.ts',
      fix: 'Load the credential from the approved store.',
      evidence: `api_key=${'s'.repeat(700)}`,
    });
    assert.equal(redactedFirst.evidence, 'api_key= [REDACTED]');

    assert.throws(
      () => api.validateReviewFinding({
        severity: 'LOW',
        title: 'Long evidence',
        body: 'Evidence is too long.',
        file: 'src/a.ts',
        fix: 'Use a bounded excerpt.',
        evidence: 'x'.repeat(501),
      }),
      (error: unknown) => (error as { code?: unknown }).code === 'LANE_EVIDENCE_INVALID',
    );
    assert.throws(
      () => api.validateReviewFinding({
        severity: 'LOW',
        title: 'Multiline evidence',
        body: 'Evidence has too many lines.',
        file: 'src/a.ts',
        fix: 'Use at most five lines.',
        evidence: '1\n2\n3\n4\n5\n6',
      }),
      (error: unknown) => (error as { code?: unknown }).code === 'LANE_EVIDENCE_INVALID',
    );
  });

  it('rejects raw diffs, raw model context, prompts, tool output, and environment ledgers', async () => {
    const api = await loadRedactionApi();
    const forbidden = [
      { raw_diff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-secret\n+secret' },
      { raw_model_context: 'system: hidden prompt\nuser: private request' },
      { prompt: 'full reviewer prompt' },
      { tool_output: 'unbounded command output' },
      { env: { OPENAI_API_KEY: 'sk-proj-secretsecret' } },
    ];

    for (const value of forbidden) {
      assert.throws(
        () => api.sanitizeForPersistence(value),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
      );
    }
  });

  it('fails closed on generic sensitive and raw-context keys at every nesting shape', async () => {
    const api = await loadRedactionApi();
    const forbidden = [
      { token: 'plain-token-value' },
      { apiKey: 'plain-api-key-value' },
      { raw_prompt: 'private prompt' },
      { raw_tool_output: 'private tool output' },
      { nested: { 'Credential-Value': 'private credential' } },
      { values: [{ Password: 'private password' }] },
      [{ AUTH: 'private authorization value' }],
    ];

    for (const value of forbidden) {
      assert.throws(
        () => api.sanitizeForPersistence(value),
        (error: unknown) => (error as { code?: unknown }).code === 'PERSISTENCE_FAILED',
        JSON.stringify(value),
      );
    }
  });

  it('strictly validates finding paths, line ranges, string bounds, and unknown fields', async () => {
    const api = await loadRedactionApi();
    const invalidFindings = [
      {
        severity: 'MEDIUM', title: 'Outside', body: 'Bad path.', file: '../outside', fix: 'Use a relative path.',
      },
      {
        severity: 'MEDIUM', title: 'Lines', body: 'Bad range.', file: 'src/a.ts', fix: 'Fix range.', start_line: 5, end_line: 4,
      },
      {
        severity: 'UNKNOWN', title: 'Enum', body: 'Bad enum.', file: 'src/a.ts', fix: 'Use a known enum.',
      },
      {
        severity: 'LOW', title: 'x'.repeat(161), body: 'Long.', file: 'src/a.ts', fix: 'Shorten.',
      },
      {
        severity: 'LOW', title: 'Extra', body: 'Unknown.', file: 'src/a.ts', fix: 'Remove it.', extra: true,
      },
    ];

    for (const finding of invalidFindings) {
      assert.throws(
        () => api.validateReviewFinding(finding),
        (error: unknown) => (error as { code?: unknown }).code === 'LANE_EVIDENCE_INVALID',
      );
    }
  });

  it('rejects every non-string severity without coercing or returning it', async () => {
    const api = await loadRedactionApi();
    const invalidSeverities: Array<readonly [string, unknown]> = [
      ['array', ['HIGH']],
      ['object', { toString: () => 'HIGH' }],
      ['number', 1],
    ];
    const accepted: Array<{ label: string; severity: unknown }> = [];

    for (const [label, severity] of invalidSeverities) {
      try {
        const finding = api.validateReviewFinding({
          severity,
          title: 'Invalid severity',
          body: 'Severity must be a primitive enum.',
          file: 'src/a.ts',
          fix: 'Use a primitive severity string.',
        }) as { severity?: unknown };
        accepted.push({ label, severity: finding.severity });
      } catch (error) {
        assert.equal((error as { code?: unknown }).code, 'LANE_EVIDENCE_INVALID', label);
      }
    }

    assert.deepEqual(accepted, []);
  });

  it('recursively redacts bounded persisted metadata without mutating the caller value', async () => {
    const api = await loadRedactionApi();
    const input = {
      summary: 'Authorization: Bearer very-private-token',
      reasons: ['safe reason', 'api_key=private-key-value'],
    };
    const sanitized = api.sanitizeForPersistence(input);

    assert.notEqual(sanitized, input);
    assert.equal(input.reasons[1], 'api_key=private-key-value');
    assert.doesNotMatch(JSON.stringify(sanitized), /very-private-token|private-key-value/u);
  });

  it('does not impose the finding-body limit on generic persisted strings', async () => {
    const api = await loadRedactionApi();
    const value = { diagnostic_summary: 'x'.repeat(2_048) };

    assert.deepEqual(api.sanitizeForPersistence(value), value);
  });
});
