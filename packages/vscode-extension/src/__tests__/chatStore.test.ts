import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  appendMessage,
  createConversation,
  listConversations,
  readConversation,
  updateMessage,
} from '../chatStore';

async function withTempDir(test: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-vscode-chat-store-'));
  try {
    await test(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function conversationFile(cwd: string, id: string): string {
  return join(cwd, '.omx', 'vscode', 'conversations', `${id}.json`);
}

describe('VSCode chat store', () => {
  it('creates, appends, updates, and summarizes conversations', async () => {
    await withTempDir(async (cwd) => {
      const conversation = await createConversation(cwd);
      const withUser = await appendMessage(cwd, conversation.id, {
        id: 'msg-user',
        role: 'user',
        text: '  explain this log  ',
        created_at: '2026-06-13T00:00:00.000Z',
      });
      const updated = await updateMessage(cwd, conversation.id, 'msg-user', {
        text: 'explain this log',
        session_id: 'vscode-test-session',
      });

      assert.equal(withUser.title, 'explain this log');
      assert.equal(updated.messages[0]?.text, 'explain this log');
      assert.equal(updated.messages[0]?.session_id, 'vscode-test-session');
      assert.deepEqual(await listConversations(cwd), [{
        id: conversation.id,
        title: 'explain this log',
        created_at: conversation.created_at,
        updated_at: updated.updated_at,
        message_count: 1,
      }]);
    });
  });

  it('skips malformed or mismatched conversation files', async () => {
    await withTempDir(async (cwd) => {
      const valid = await createConversation(cwd, 'valid conversation');
      await mkdir(join(cwd, '.omx', 'vscode', 'conversations'), { recursive: true });
      await writeFile(conversationFile(cwd, 'chat-broken'), '{"schema_version":"omx.vscode/conversation/v1"');
      await writeFile(conversationFile(cwd, 'chat-foreign'), JSON.stringify({
        schema_version: 'omx.vscode/conversation/v1',
        id: 'chat-other',
        messages: [],
      }));
      await writeFile(join(cwd, '.omx', 'vscode', 'conversations', 'chat bad.json'), '{}');

      assert.equal(await readConversation(cwd, 'chat-broken'), null);
      assert.equal(await readConversation(cwd, 'chat-foreign'), null);
      assert.deepEqual((await listConversations(cwd)).map((item) => item.id), [valid.id]);
    });
  });

  it('rejects unsafe conversation ids before touching the filesystem', async () => {
    await withTempDir(async (cwd) => {
      await assert.rejects(() => readConversation(cwd, '../outside'), /invalid conversation id/);
      assert.equal(await readFile(join(cwd, '.omx')).catch(() => null), null);
    });
  });
});
