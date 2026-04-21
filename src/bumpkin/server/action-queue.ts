import type { QueuedAction } from '../github/webhook-handler.js';

export interface QueuedItem {
  id: number;
  action: QueuedAction;
  enqueuedAt: string;
}

export interface ActionHandler {
  (item: QueuedItem): Promise<void>;
}

export interface ActionQueueOptions {
  handler: ActionHandler;
  now?: () => string;
  onError?: (err: Error, item: QueuedItem) => void;
}

export class ActionQueue {
  private readonly queue: QueuedItem[] = [];
  private nextId = 1;
  private draining = false;
  private readonly opts: ActionQueueOptions;
  private readonly processed: QueuedItem[] = [];
  private readonly errors: Array<{ item: QueuedItem; error: Error }> = [];

  constructor(opts: ActionQueueOptions) {
    this.opts = opts;
  }

  enqueue(action: QueuedAction): QueuedItem {
    const now = this.opts.now?.() ?? new Date().toISOString();
    const item: QueuedItem = { id: this.nextId++, action, enqueuedAt: now };
    this.queue.push(item);
    return item;
  }

  size(): number {
    return this.queue.length;
  }

  pendingItems(): ReadonlyArray<QueuedItem> {
    return this.queue.slice();
  }

  processedItems(): ReadonlyArray<QueuedItem> {
    return this.processed;
  }

  errorItems(): ReadonlyArray<{ item: QueuedItem; error: Error }> {
    return this.errors;
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) break;
        try {
          await this.opts.handler(item);
          this.processed.push(item);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.errors.push({ item, error });
          this.opts.onError?.(error, item);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
