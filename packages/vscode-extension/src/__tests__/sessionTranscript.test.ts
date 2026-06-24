import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatSessionMessage, trimTranscript } from '../sessionTranscript';

describe('session transcript formatting', () => {
  it('keeps session metadata before streamed output', () => {
    assert.equal(formatSessionMessage('Running', {
      session_id: 'vscode-1',
      log_path: '/repo/.omx/logs/vscode/vscode-1.log',
    }, 'hello\n'), [
      'Status: Running',
      'Session: vscode-1',
      'Log: /repo/.omx/logs/vscode/vscode-1.log',
      '',
      'hello',
    ].join('\n'));
  });

  it('bounds long transcripts from the front', () => {
    assert.equal(trimTranscript('abcdef', 4), '... trimmed 2 chars ...\ncdef');
  });
});
