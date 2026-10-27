import type { DemoRuntime } from '../modules/demo-session/demo-runtime.js';

/** In-process lifecycle timer; no overlap, no background dispatch or reconciliation. */
export class DemoMaintenance {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(private readonly runtime: DemoRuntime, private readonly batch: number,
    private readonly log: (event: string) => void) {}
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runtime.reset.maintainInactiveSessions(this.batch)
      .then(() => this.log('demo_maintenance_completed'))
      .catch(() => this.log('demo_maintenance_failed'))
      .finally(() => { this.running = undefined; });
    return this.running;
  }
  start(intervalMs: number): void {
    if (this.timer) throw new Error('Demo maintenance already scheduled');
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer); this.timer = undefined;
    await this.running;
  }
}
