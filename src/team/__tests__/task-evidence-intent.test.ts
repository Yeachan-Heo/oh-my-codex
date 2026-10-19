import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inferTaskEvidenceIntent } from '../task-evidence-intent.js';

describe('task evidence intent', () => {
  it('distinguishes audience destinations and explicit read-only directives', () => {
    for (const [text, codeChangeRequested] of [
      ['Write a report for the team in docs/latency.md', true],
      ['Write a report for the owners of this project in docs/latency.md', true],
      ['Write a report about retry support for requests in src/api.ts without changing files', false],
      ['Do not make any code changes', false],
      ['Do not touch any files; only summarize the current behavior', false],
      ['Analyze latency and touch docs/report.md to record findings', true],
      ['Do not implement anything', false],
      ['Never apply a patch', false],
      ['Do not apply the patch; only summarize the current behavior', false],
      ['Write a report about latency for the team in docs/latency.md', true],
      ['Write a report for the team about the API in src/api.ts', false],
      ['Write findings for reviewers at `docs/latency and findings.md`', true],
      ['Write a report about the API in src/api.ts without changing files', false],
      ['Write a report about the API in the file src/api.ts without changing any files', false],
      ['Write a report about retry support for requests in src/api.ts without changing the file', false],
      ['Write a report for the team in the file docs/latency.md', true],
      ['Please do not change any files; only summarize the current behavior', false],
      ["Don't modify files; just summarize the current behavior", false],
      ['Do not change any files', false],
      ['Just summarize the current behavior', false],
      ['Only please summarize the current behavior', false],
      ['Write a report of retry support for requests in src/api.ts without changing files', false],
      ['Write a report of retry support for requests in src/api.ts without changing the files', false],
      ['Only analyze the current behavior', false],
      ['Only analyze latency; then apply the approved patch', true],
      ['How does caching work, just apply the approved patch', true],
      ['How does caching work, only apply the approved patch', true],
    ] as const) assert.deepEqual(inferTaskEvidenceIntent(text), { codeChangeRequested, analysisOnly: !codeChangeRequested }, text);
  });

  it('recognizes apply commands and polite repair requests appended to questions', () => {
    for (const text of [
      'Investigate the TypeScript build failure and apply the approved patch',
      'Investigate the build failure before applying the approved patch',
      'How does the TypeScript build work, and can you please fix the compilation error?',
      'Explain how the build works and could you please apply the approved patch',
    ]) assert.equal(inferTaskEvidenceIntent(text).codeChangeRequested, true, text);
    assert.equal(inferTaskEvidenceIntent('How do I fix the cache and update the tests?').analysisOnly, true);
  });

  it('preserves labels and evaluated options while requiring evidence for file outputs', () => {
    for (const [text, codeChangeRequested] of [
      ['Analyze request latency and write findings to docs/latency-report.md', true],
      ['Write findings to README.', true],
      ['Task: Write findings to README.', true],
      ['Write a report to "latency and findings.md"', true],
      ['Write a report to "Latency Report. Final.md"', true],
      ['Write a report to "latency and update findings.md"', true],
      ['Explain how caching works, but please apply the approved fix', true],
      ['Explain how caching works, but apply the approved fix', true],
      ['Explain how caching works but apply the approved fix', true],
      ['How does caching work but fix the broken cache with regression tests', false],
      ['Explain why we add retries but remove failed jobs', false],
      ['How does caching work, but fix the broken cache with regression tests', true],
      ['Explain these steps: 1. add retries 2. update tests, but apply the approved fix', true],
      ['How does caching work, but why does it fail?', false],
      ['Explain why caching improves latency but updating tests does not improve runtime performance', false],
      ['Explain why refactoring improves maintainability, but adding caches increases memory usage', false],
      ['Why do we add retries but remove failed jobs?', false],
      ['Why does the server add retries but remove failed jobs?', false],
      ['Why does it add retries but remove failed jobs?', false],
      ['How does the server add retries but remove failed jobs?', false],
      ['When does the server add retries but remove failed jobs?', false],
      ['Evaluate options: retain the package but modify the adapter', false],
      ['Evaluate options: 1. retain the package but modify the adapter', false],
      ['Explain these steps: 1. add retries 2. update tests, but please apply the approved fix', true],
      ['Write findings to README', true],
      ['Write findings to: docs/report.md', true],
      ['Write findings to:\ndocs/report.md', true],
      ['Write a report to "latency report.md"', true],
      ['Write a report to `latency report.md`', true],
      ['Write findings to a Markdown file named report.md', true],
      ['Write findings to a file', true],
      ['Analyze request latency and save the findings to docs/latency-report.md', true],
      ['Write a report about the API in src/api.ts without changing files', false],
      ['Write a report about the API in the file src/api.ts without changing any files', false],
      ['Write a report about retry support for requests in src/api.ts without changing the file', false],
      ['Write a report for the team in the file docs/latency.md', true],
      ['Evaluate package options:\n- replace package A\n- modify the adapter\n- retain the current package', false],
      ['Evaluate package options: 1. replace package A 2. modify the adapter 3. retain the current package', false],
      ['Evaluate package options:\n- replace package A\n- retain the current package\nThen implement the approved option', true],
      ['Write findings to `docs/latency-report.md`', true],
      ['Write a summary in report.md', true],
      ['Write findings to the file REPORT', true],
      ['Write findings to C:\\docs\\report.md', true],
      ['Write a report about src/cache.ts', false],
      ['Write findings to stdout', false],
      ['Write a report to https://example.com/file', false],
      ['Task: Analyze request latency', false],
      ['Task: Explain how to fix the cache and update tests', false],
      ['Task: Analyze latency and implement a fix with tests', true],
      ['Evaluate package options: replace package A, modify the adapter, or retain the current package', false],
      ['Evaluate package options: replace package A or retain it, then implement the approved option', true],
      ['Evaluate package options and implement the approved choice', true],
    ] as const) {
      assert.deepEqual(inferTaskEvidenceIntent(text), { codeChangeRequested, analysisOnly: !codeChangeRequested }, text);
    }
  });

  it('recognizes localized mutations and subordinate implementation actions', () => {
    for (const text of [
      '빌드 오류 수정', '컴파일 오류 해결', '보안 기능 구현', '테스트 추가', '문서 업데이트',
      'Investigate authentication failures before implementing a fix with regression tests',
      'Analyze latency before fixing the cache',
      'Review authentication after updating the middleware',
      'Investigate failures while writing regression tests',
      'Analyze latency in order to change the cache',
      'Investigate failures so as to repair the handler',
      'Investigate failures to fix the cache',
      'Analyze cache behavior without tests before implementing a fix',
      'Investigate how to resolve authentication failures before implementing a fix with regression tests',
      'Analyze how to fix the cache before implementing the repair with regression tests',
      'Explain how to fix the cache, then implement the approved fix with regression tests',
      'Investigate how to fix the cache, then implement the approved fix with regression tests',
      'Analyze failures:\n- implement a fix\n- add regression tests',
      'Explain these steps:\n- add retries\n- update tests\nThen implement the approved fix',
      'Explain these steps: 1. add retries 2. update tests. Then implement the approved fix',
      'Explain these steps: 1. add retries 2. update tests; then implement the approved fix',
      'Explain these steps:\n- add retries\n- update tests. Then implement the approved fix',
      'Explain these steps:\n- add retries\n- update tests; also implement the approved fix',
      'Explain these steps: 1. add retries 2. update tests, and then implement the approved fix',
      'Explain these steps: 1. add retries 2. upgrade to Node 22. Then implement the approved fix',
      'Explain these steps:\n- upgrade to Node 22. Also implement the approved fix',
      'Explain these steps: 1. add retries 2. upgrade to Node 22. Implement the approved fix',
      'Explain these steps:\n- upgrade to Node 22. Implement the approved fix',
      'Explain these steps: 1. add retries 2. upgrade to Node 2. Implement the approved fix',
      'Explain this step: 1. Inspect HTTP/2. Implement the approved cache fix with regression tests',
      'Explain this step: 1. Inspect Node 2. Implement the approved cache fix with regression tests',
      'Explain these steps:\n1. upgrade the API to version 2. Implement the upgrade with tests.\n2. update the docs',
      'Explain this step: 1. Inspect release 2. Implement the upgrade with tests',
      '빌드 오류를 수정해서 테스트가 통과하게 해 주세요',
      '컴파일 오류를 해결해주시고 회귀 테스트도 작성해주세요',
    ]) {
      assert.equal(inferTaskEvidenceIntent(text).codeChangeRequested, true, text);
    }
  });

  it('keeps explanations and questions optional without hiding a separate mutation', () => {
    for (const text of [
      'Explain how authentication is wired',
      'Describe the authentication flow',
      'What causes these authentication failures?',
      'Why does the cache miss?',
      'How does authentication work?',
      'Where is the cache configured?',
      'Which module handles retries?',
      'Explain how to fix authentication failures',
      'Explain the effects of implementing a cache',
      'Investigate authentication failures without implementing changes',
      'Investigate how to implement a cache',
      'Analyze failures and recommend a fix',
      'Explain what happens after updating the middleware',
      'How does authentication work after changing the token format?',
      'Explain how to implement a cache and write regression tests',
      'How do I fix the cache and update the tests?',
      'Explain why we review before implementing a fix',
      'Analyze latency without needing to change the cache implementation',
      'Investigate failures without having to modify source code',
      'Explain the steps needed to fix the cache and update the tests',
      'Explain how to add a cache and then write tests',
      'Explain the effects of implementing a cache and updating the tests',
      'How do I fix the cache and then write tests?',
      'Investigate how to fix the cache and update the tests',
      'Investigate whether to implement retries and update the tests',
      'Analyze latency while not planning to change the implementation',
      'Explain these steps:\n- add retries\n- update tests',
      'Explain how to: 1. add retries 2. update tests',
      'Explain these steps: 1. Implement a cache; 2. Add regression tests',
      'Explain these steps: 1) Implement a cache; 2) Add regression tests',
      'Explain these steps: 1. Implement a cache 2. Add regression tests',
    ]) {
      assert.deepEqual(inferTaskEvidenceIntent(text), { codeChangeRequested: false, analysisOnly: true }, text);
    }
    assert.equal(inferTaskEvidenceIntent('Explain authentication and implement a fix with tests').codeChangeRequested, true);
    assert.equal(inferTaskEvidenceIntent('Explain how to fix failures; then implement the fix').codeChangeRequested, true);
    assert.equal(inferTaskEvidenceIntent('빌드 오류 수정 방법을 설명해 주세요').codeChangeRequested, false);
    assert.equal(inferTaskEvidenceIntent('How does authentication work?', 'Implement a fix').codeChangeRequested, true);
  });
});
