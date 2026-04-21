export type WebhookEvent =
  | {
      type: 'installation';
      action: 'created' | 'deleted' | 'suspend' | 'unsuspend';
      installationId: number;
      accountLogin: string;
      repositories: ReadonlyArray<{ fullName: string; private: boolean }>;
    }
  | {
      type: 'installation_repositories';
      action: 'added' | 'removed';
      installationId: number;
      repositoriesAdded?: ReadonlyArray<{ fullName: string; private: boolean }>;
      repositoriesRemoved?: ReadonlyArray<{ fullName: string; private: boolean }>;
    }
  | {
      type: 'issue_comment';
      action: 'created';
      installationId: number;
      repoFullName: string;
      issueNumber: number;
      commenterLogin: string;
      body: string;
    }
  | {
      type: 'schedule';
      installationId: number;
      repoFullName: string;
    }
  | {
      type: 'pull_request';
      action: 'opened' | 'synchronize' | 'closed';
      installationId: number;
      repoFullName: string;
      prNumber: number;
      merged?: boolean;
    };

export type QueuedAction =
  | { type: 'register-installation'; installationId: number; repositories: ReadonlyArray<{ fullName: string; private: boolean }> }
  | { type: 'unregister-installation'; installationId: number }
  | { type: 'queue-upgrade-run'; installationId: number; repoFullName: string; scope: UpgradeScope; requestedBy?: string; issueNumber?: number }
  | { type: 'record-pr-outcome'; installationId: number; repoFullName: string; prNumber: number; outcome: 'merged' | 'closed' }
  | { type: 'ignore'; reason: string };

export type UpgradeScope =
  | { kind: 'all' }
  | { kind: 'all-minor' }
  | { kind: 'all-patch' }
  | { kind: 'single'; dependency: string };

const BOT_MENTION = /^@bumpkin(?:\s+(.+))?\s*$/i;

export function parseCommandComment(body: string): UpgradeScope | null {
  const trimmed = body.trim();
  const m = trimmed.match(BOT_MENTION);
  if (!m) return null;
  const arg = m[1]?.trim() ?? 'all';
  if (arg === 'all' || arg === '') return { kind: 'all' };
  if (arg === 'all-minor') return { kind: 'all-minor' };
  if (arg === 'all-patch') return { kind: 'all-patch' };
  return { kind: 'single', dependency: arg };
}

export function handleWebhook(event: WebhookEvent): QueuedAction {
  switch (event.type) {
    case 'installation':
      if (event.action === 'created') {
        return {
          type: 'register-installation',
          installationId: event.installationId,
          repositories: event.repositories,
        };
      }
      if (event.action === 'deleted') {
        return { type: 'unregister-installation', installationId: event.installationId };
      }
      return { type: 'ignore', reason: `installation.${event.action}` };

    case 'installation_repositories':
      if (event.action === 'added' && event.repositoriesAdded) {
        return {
          type: 'register-installation',
          installationId: event.installationId,
          repositories: event.repositoriesAdded,
        };
      }
      return { type: 'ignore', reason: `installation_repositories.${event.action}` };

    case 'issue_comment': {
      const scope = parseCommandComment(event.body);
      if (!scope) return { type: 'ignore', reason: 'no bumpkin command' };
      return {
        type: 'queue-upgrade-run',
        installationId: event.installationId,
        repoFullName: event.repoFullName,
        scope,
        requestedBy: event.commenterLogin,
        issueNumber: event.issueNumber,
      };
    }

    case 'schedule':
      return {
        type: 'queue-upgrade-run',
        installationId: event.installationId,
        repoFullName: event.repoFullName,
        scope: { kind: 'all' },
      };

    case 'pull_request':
      if (event.action === 'closed') {
        return {
          type: 'record-pr-outcome',
          installationId: event.installationId,
          repoFullName: event.repoFullName,
          prNumber: event.prNumber,
          outcome: event.merged ? 'merged' : 'closed',
        };
      }
      return { type: 'ignore', reason: `pull_request.${event.action}` };
  }
}
