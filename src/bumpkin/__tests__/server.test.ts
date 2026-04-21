import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeSignature, verifySignature } from '../server/verify-signature.js';
import { ActionQueue, type QueuedItem } from '../server/action-queue.js';
import { startWebhookServer } from '../server/webhook-server.js';

const SECRET = 'super-secret';

function signedPayload(body: string): { signature: string } {
  return { signature: computeSignature(SECRET, body) };
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });
  return { status: response.status, body: await response.text() };
}

describe('bumpkin/verify-signature', () => {
  it('computeSignature produces a sha256=<hex> token', () => {
    const sig = computeSignature('k', 'body');
    assert.match(sig, /^sha256=[a-f0-9]{64}$/);
  });

  it('verifySignature returns true for a correct signature', () => {
    const sig = computeSignature(SECRET, 'x');
    assert.equal(verifySignature(SECRET, 'x', sig), true);
  });

  it('verifySignature returns false for wrong signature', () => {
    assert.equal(verifySignature(SECRET, 'x', 'sha256=deadbeef'), false);
  });

  it('verifySignature returns false for missing header', () => {
    assert.equal(verifySignature(SECRET, 'x', undefined), false);
  });

  it('verifySignature rejects length-mismatched tokens without throwing', () => {
    assert.equal(verifySignature(SECRET, 'x', 'short'), false);
  });
});

describe('bumpkin/action-queue', () => {
  it('enqueues items with monotonically increasing ids', () => {
    const queue = new ActionQueue({ handler: async () => {} });
    const a = queue.enqueue({ type: 'ignore', reason: 'a' });
    const b = queue.enqueue({ type: 'ignore', reason: 'b' });
    assert.equal(b.id, a.id + 1);
    assert.equal(queue.size(), 2);
  });

  it('drain invokes handler FIFO and records processed items', async () => {
    const seen: number[] = [];
    const queue = new ActionQueue({
      handler: async (item) => {
        seen.push(item.id);
      },
    });
    queue.enqueue({ type: 'ignore', reason: 'a' });
    queue.enqueue({ type: 'ignore', reason: 'b' });
    queue.enqueue({ type: 'ignore', reason: 'c' });
    await queue.drain();
    assert.deepEqual(seen, [1, 2, 3]);
    assert.equal(queue.size(), 0);
    assert.equal(queue.processedItems().length, 3);
  });

  it('captures handler errors without stopping the drain', async () => {
    const handled: QueuedItem[] = [];
    const queue = new ActionQueue({
      handler: async (item) => {
        if (item.id === 2) throw new Error('boom');
        handled.push(item);
      },
    });
    queue.enqueue({ type: 'ignore', reason: 'a' });
    queue.enqueue({ type: 'ignore', reason: 'b' });
    queue.enqueue({ type: 'ignore', reason: 'c' });
    await queue.drain();
    assert.equal(handled.length, 2);
    assert.equal(queue.errorItems().length, 1);
    assert.equal(queue.errorItems()[0]?.error.message, 'boom');
  });
});

describe('bumpkin/webhook-server (real HTTP)', () => {
  it('rejects requests without a valid signature with 401', async () => {
    const queue = new ActionQueue({ handler: async () => {} });
    const started = await startWebhookServer({ secret: SECRET, queue });
    try {
      const url = `http://${started.address.host}:${started.address.port}/webhook`;
      const body = JSON.stringify({ action: 'created' });
      const res = await postJson(url, { 'x-github-event': 'installation' }, body);
      assert.equal(res.status, 401);
      assert.equal(queue.size(), 0);
    } finally {
      await started.stop();
    }
  });

  it('queues a queue-upgrade-run action for a valid @bumpkin comment', async () => {
    const queue = new ActionQueue({ handler: async () => {} });
    const started = await startWebhookServer({ secret: SECRET, queue });
    try {
      const url = `http://${started.address.host}:${started.address.port}/webhook`;
      const body = JSON.stringify({
        action: 'created',
        installation: { id: 42 },
        repository: { full_name: 'acme/web' },
        issue: { number: 7 },
        comment: { body: '@bumpkin react', user: { login: 'alice' } },
      });
      const { signature } = signedPayload(body);
      const res = await postJson(
        url,
        {
          'x-github-event': 'issue_comment',
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      );
      assert.equal(res.status, 202);
      assert.match(res.body, /"status":"queued"/);
      assert.equal(queue.size(), 1);
      const [item] = queue.pendingItems();
      assert.equal(item?.action.type, 'queue-upgrade-run');
    } finally {
      await started.stop();
    }
  });

  it('returns 202 ignored for comments that are not @bumpkin commands', async () => {
    const queue = new ActionQueue({ handler: async () => {} });
    const started = await startWebhookServer({ secret: SECRET, queue });
    try {
      const url = `http://${started.address.host}:${started.address.port}/webhook`;
      const body = JSON.stringify({
        action: 'created',
        installation: { id: 1 },
        repository: { full_name: 'x/y' },
        issue: { number: 1 },
        comment: { body: 'not a command', user: { login: 'z' } },
      });
      const { signature } = signedPayload(body);
      const res = await postJson(
        url,
        { 'x-github-event': 'issue_comment', 'x-hub-signature-256': signature },
        body,
      );
      assert.equal(res.status, 202);
      assert.match(res.body, /"status":"ignored"/);
      assert.equal(queue.size(), 0);
    } finally {
      await started.stop();
    }
  });

  it('auto-drains when autoDrain:true and invokes the handler', async () => {
    const seen: string[] = [];
    const queue = new ActionQueue({
      handler: async (item) => {
        if (item.action.type === 'register-installation') {
          seen.push(String(item.action.installationId));
        }
      },
    });
    const started = await startWebhookServer({ secret: SECRET, queue, autoDrain: true });
    try {
      const url = `http://${started.address.host}:${started.address.port}/webhook`;
      const body = JSON.stringify({
        action: 'created',
        installation: { id: 99, account: { login: 'acme' } },
        repositories: [{ full_name: 'acme/a', private: false }],
      });
      const { signature } = signedPayload(body);
      await postJson(
        url,
        { 'x-github-event': 'installation', 'x-hub-signature-256': signature },
        body,
      );
      // autoDrain is async; wait a tick
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(seen, ['99']);
    } finally {
      await started.stop();
    }
  });

  it('returns 405 for non-POST methods', async () => {
    const queue = new ActionQueue({ handler: async () => {} });
    const started = await startWebhookServer({ secret: SECRET, queue });
    try {
      const url = `http://${started.address.host}:${started.address.port}/webhook`;
      const res = await fetch(url, { method: 'GET' });
      assert.equal(res.status, 405);
    } finally {
      await started.stop();
    }
  });
});
