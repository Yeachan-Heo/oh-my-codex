import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inferTaskEvidenceIntent } from '../task-evidence-intent.js';

describe('task evidence intent', () => {
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
