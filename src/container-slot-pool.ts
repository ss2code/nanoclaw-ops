export class SlotPoolClosedError extends Error {
  constructor() {
    super('Container slot pool is closed');
    this.name = 'SlotPoolClosedError';
  }
}

type Release = () => void;

interface Waiter {
  label: string;
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
}

/**
 * Small FIFO semaphore for long-lived agent containers.
 *
 * A lease lasts until the child process emits close/error, not merely until
 * `spawn()` returns. This is the global guardrail that makes shared-vCPU VPS
 * sizing predictable when several agent groups wake at once.
 */
export class ContainerSlotPool {
  private active = 0;
  private closed = false;
  private readonly queue: Waiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Container slot limit must be a positive integer, got ${limit}`);
    }
  }

  acquire(label: string): Promise<Release> {
    if (this.closed) return Promise.reject(new SlotPoolClosedError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<Release>((resolve, reject) => {
      this.queue.push({ label, resolve, reject });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      waiter.reject(new SlotPoolClosedError());
    }
  }

  snapshot(): { limit: number; active: number; queued: number } {
    return { limit: this.limit, active: this.active, queued: this.queue.length };
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    if (this.closed) return;
    const waiter = this.queue.shift();
    if (!waiter) return;
    this.active += 1;
    waiter.resolve(this.makeRelease());
  }
}
