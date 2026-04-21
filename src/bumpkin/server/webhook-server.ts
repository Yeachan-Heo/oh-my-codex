import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { handleWebhook, type QueuedAction, type WebhookEvent } from '../github/webhook-handler.js';
import type { ActionQueue } from './action-queue.js';
import { verifySignature } from './verify-signature.js';

export interface WebhookServerOptions {
  secret: string;
  queue: ActionQueue;
  path?: string;
  autoDrain?: boolean;
  onError?: (err: Error) => void;
}

export interface StartedWebhookServer {
  server: Server;
  address: { host: string; port: number };
  stop(): Promise<void>;
}

export function createWebhookHandler(options: WebhookServerOptions) {
  const path = options.path ?? '/webhook';
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('method not allowed');
      return;
    }
    if (req.url !== path) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const body = await readBody(req);
    const signature = headerValue(req.headers['x-hub-signature-256']);
    if (!verifySignature(options.secret, body, signature)) {
      res.statusCode = 401;
      res.end('bad signature');
      return;
    }

    const eventType = headerValue(req.headers['x-github-event']);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      res.statusCode = 400;
      res.end('invalid json');
      return;
    }

    const event = parsePayload(eventType, payload);
    if (!event) {
      res.statusCode = 202;
      res.end(JSON.stringify({ status: 'ignored', reason: 'unsupported event' }));
      return;
    }

    const action: QueuedAction = handleWebhook(event);
    if (action.type === 'ignore') {
      res.statusCode = 202;
      res.end(JSON.stringify({ status: 'ignored', reason: action.reason }));
      return;
    }

    const item = options.queue.enqueue(action);
    if (options.autoDrain) {
      void options.queue.drain().catch((err) => options.onError?.(err as Error));
    }

    res.statusCode = 202;
    res.end(JSON.stringify({ status: 'queued', id: item.id, action: action.type }));
  };
}

export async function startWebhookServer(options: WebhookServerOptions & { port?: number; host?: string }): Promise<StartedWebhookServer> {
  const handler = createWebhookHandler(options);
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      options.onError?.(err as Error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal error');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server returned unexpected address');
  }
  return {
    server,
    address: { host: addr.address, port: addr.port },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function headerValue(h: string | string[] | undefined): string | undefined {
  if (h === undefined) return undefined;
  return Array.isArray(h) ? h[0] : h;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function parsePayload(eventType: string | undefined, payload: Record<string, unknown>): WebhookEvent | null {
  if (!eventType) return null;

  const installation = payload.installation as { id?: number; account?: { login?: string } } | undefined;

  switch (eventType) {
    case 'installation': {
      const action = String(payload.action ?? '');
      if (action !== 'created' && action !== 'deleted' && action !== 'suspend' && action !== 'unsuspend') return null;
      const repositories = (payload.repositories as Array<{ full_name?: string; private?: boolean }> | undefined) ?? [];
      return {
        type: 'installation',
        action,
        installationId: installation?.id ?? 0,
        accountLogin: installation?.account?.login ?? '',
        repositories: repositories.map((r) => ({ fullName: r.full_name ?? '', private: r.private ?? false })),
      };
    }
    case 'installation_repositories': {
      const action = payload.action === 'added' ? 'added' : payload.action === 'removed' ? 'removed' : null;
      if (!action) return null;
      const result: WebhookEvent = {
        type: 'installation_repositories',
        action,
        installationId: installation?.id ?? 0,
      };
      const added = payload.repositories_added as Array<{ full_name?: string; private?: boolean }> | undefined;
      const removed = payload.repositories_removed as Array<{ full_name?: string; private?: boolean }> | undefined;
      if (added) {
        (result as { repositoriesAdded?: Array<{ fullName: string; private: boolean }> }).repositoriesAdded =
          added.map((r) => ({ fullName: r.full_name ?? '', private: r.private ?? false }));
      }
      if (removed) {
        (result as { repositoriesRemoved?: Array<{ fullName: string; private: boolean }> }).repositoriesRemoved =
          removed.map((r) => ({ fullName: r.full_name ?? '', private: r.private ?? false }));
      }
      return result;
    }
    case 'issue_comment': {
      if (payload.action !== 'created') return null;
      const comment = payload.comment as { body?: string; user?: { login?: string } } | undefined;
      const issue = payload.issue as { number?: number } | undefined;
      const repo = payload.repository as { full_name?: string } | undefined;
      return {
        type: 'issue_comment',
        action: 'created',
        installationId: installation?.id ?? 0,
        repoFullName: repo?.full_name ?? '',
        issueNumber: issue?.number ?? 0,
        commenterLogin: comment?.user?.login ?? '',
        body: comment?.body ?? '',
      };
    }
    case 'pull_request': {
      const action = payload.action === 'opened' || payload.action === 'synchronize' || payload.action === 'closed' ? payload.action : null;
      if (!action) return null;
      const pr = payload.pull_request as { number?: number; merged?: boolean } | undefined;
      const repo = payload.repository as { full_name?: string } | undefined;
      const evt: WebhookEvent = {
        type: 'pull_request',
        action,
        installationId: installation?.id ?? 0,
        repoFullName: repo?.full_name ?? '',
        prNumber: pr?.number ?? 0,
      };
      if (pr?.merged !== undefined) {
        (evt as { merged?: boolean }).merged = pr.merged;
      }
      return evt;
    }
    case 'schedule': {
      const repo = payload.repository as { full_name?: string } | undefined;
      return {
        type: 'schedule',
        installationId: installation?.id ?? 0,
        repoFullName: repo?.full_name ?? '',
      };
    }
    default:
      return null;
  }
}
