import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeWebviewMessage } from '../chatProtocol';

describe('webview protocol', () => {
  it('accepts only known commands', () => {
    assert.deepEqual(normalizeWebviewMessage({ command: 'send', text: 'hello' }), { command: 'send', text: 'hello' });
    assert.deepEqual(normalizeWebviewMessage({ command: 'stop', text: 'ignored' }), { command: 'stop' });
    assert.equal(normalizeWebviewMessage({ command: 'deleteEverything' }), null);
    assert.equal(normalizeWebviewMessage(null), null);
  });

  it('drops non-string path and id payloads', () => {
    assert.deepEqual(normalizeWebviewMessage({ command: 'openLog', logPath: 123 }), {
      command: 'openLog',
      logPath: undefined,
    });
    assert.deepEqual(normalizeWebviewMessage({ command: 'selectConversation', conversationId: {} }), {
      command: 'selectConversation',
      conversationId: undefined,
    });
  });
});
