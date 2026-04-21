export interface NotificationPayload {
  kind: 'status' | 'warning' | 'error' | 'summary';
  title: string;
  body: string;
  dedupeKey?: string;
}

export interface GitHubCommentsApi {
  createComment(opts: { issueNumber: number; body: string }): Promise<{ id: number }>;
}

export interface GitHubCheckRunsApi {
  updateCheckRun(opts: {
    name: string;
    status: 'queued' | 'in_progress' | 'completed';
    conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled';
    summary: string;
  }): Promise<{ id: number }>;
}

export interface NotificationTransport {
  send(payload: NotificationPayload): Promise<void>;
}

export interface GitHubTransportOptions {
  issueNumber: number;
  comments: GitHubCommentsApi;
  checkRuns?: GitHubCheckRunsApi;
  checkRunName?: string;
  cooldownMs?: number;
  now?: () => number;
}

export class GitHubNotificationTransport implements NotificationTransport {
  private readonly lastSentAt = new Map<string, number>();
  private readonly opts: GitHubTransportOptions;
  private readonly now: () => number;

  constructor(opts: GitHubTransportOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  async send(payload: NotificationPayload): Promise<void> {
    if (payload.dedupeKey) {
      const last = this.lastSentAt.get(payload.dedupeKey);
      const cooldown = this.opts.cooldownMs ?? 0;
      if (last != null && this.now() - last < cooldown) return;
      this.lastSentAt.set(payload.dedupeKey, this.now());
    }

    const body = `**${payload.title}**\n\n${payload.body}`;
    await this.opts.comments.createComment({
      issueNumber: this.opts.issueNumber,
      body,
    });

    if (payload.kind === 'status' && this.opts.checkRuns && this.opts.checkRunName) {
      await this.opts.checkRuns.updateCheckRun({
        name: this.opts.checkRunName,
        status: 'in_progress',
        summary: payload.title,
      });
    }

    if (payload.kind === 'summary' && this.opts.checkRuns && this.opts.checkRunName) {
      await this.opts.checkRuns.updateCheckRun({
        name: this.opts.checkRunName,
        status: 'completed',
        conclusion: 'success',
        summary: payload.title,
      });
    }

    if (payload.kind === 'error' && this.opts.checkRuns && this.opts.checkRunName) {
      await this.opts.checkRuns.updateCheckRun({
        name: this.opts.checkRunName,
        status: 'completed',
        conclusion: 'failure',
        summary: payload.title,
      });
    }
  }
}
