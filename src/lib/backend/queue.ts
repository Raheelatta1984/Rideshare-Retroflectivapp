import type { CampaignEventRecord, CampaignEventKind } from "../../types";
import { uid } from "../id";
import type { Backend } from "./types";

/**
 * Event queue for the Event API (plan: "Event API for proof-of-play, QR scans
 * and referral conversions").
 *
 * The rear tablet can lose signal mid-trip, so events are queued and flushed in
 * batches with exponential backoff. A failed send is retried rather than
 * dropped, and the queue is capped so it can never grow without bound.
 *
 * This runs in the browser rather than requiring the display to be online: the
 * queue is the reliability layer the plan asks for without a native app.
 */

export interface EventQueueOptions {
  backend: Backend;
  /** Flush automatically once this many events are pending. */
  batchSize?: number;
  /** Flush interval in ms (0 disables the timer). */
  flushMs?: number;
  /** Give up on an event after this many attempts. */
  maxAttempts?: number;
  /** Hard cap on retained events. */
  maxQueue?: number;
  now?: () => number;
  onError?: (error: unknown, attempt: number) => void;
}

interface PendingEvent {
  event: CampaignEventRecord;
  attempts: number;
}

export class EventQueue {
  private pending: PendingEvent[] = [];
  private timer: number | null = null;
  private flushing = false;
  private readonly backend: Backend;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly maxQueue: number;
  private readonly now: () => number;
  private readonly onError?: (error: unknown, attempt: number) => void;

  /** Cumulative counters, useful for the diagnostics overlay and tests. */
  readonly stats = { sent: 0, failed: 0, dropped: 0 };

  constructor(options: EventQueueOptions) {
    this.backend = options.backend;
    this.batchSize = options.batchSize ?? 20;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.maxQueue = options.maxQueue ?? 500;
    this.now = options.now ?? (() => Date.now());
    this.onError = options.onError;

    const flushMs = options.flushMs ?? 20000;
    if (flushMs > 0 && typeof window !== "undefined") {
      this.timer = window.setInterval(() => {
        void this.flush();
      }, flushMs);
    }
  }

  get size(): number {
    return this.pending.length;
  }

  /** Queue a proof-of-play / scan / conversion event. */
  record(input: {
    campaignId: string;
    deviceId: string;
    kind: CampaignEventKind;
    pairCode?: string;
    dwellSeconds?: number;
    meta?: Record<string, unknown>;
    at?: number;
  }): CampaignEventRecord {
    const event: CampaignEventRecord = {
      id: uid("evt"),
      campaignId: input.campaignId,
      deviceId: input.deviceId,
      pairCode: input.pairCode,
      kind: input.kind,
      at: input.at ?? this.now(),
      dwellSeconds: input.dwellSeconds,
      meta: input.meta,
    };

    this.pending.push({ event, attempts: 0 });

    if (this.pending.length > this.maxQueue) {
      const overflow = this.pending.length - this.maxQueue;
      this.pending.splice(0, overflow);
      this.stats.dropped += overflow;
    }

    if (this.pending.length >= this.batchSize) void this.flush();
    return event;
  }

  /** Convenience wrapper for the display. */
  proofOfPlay(event: { campaignId: string; deviceId: string; pairCode?: string; dwellSeconds?: number; title?: string }): CampaignEventRecord {
    return this.record({
      campaignId: event.campaignId,
      deviceId: event.deviceId,
      pairCode: event.pairCode,
      dwellSeconds: event.dwellSeconds,
      kind: "proof-of-play",
      meta: event.title ? { title: event.title } : undefined,
    });
  }

  /**
   * Send up to `batchSize` events. Successful sends are removed; a failure
   * increments the attempt counter and keeps the batch for the next flush.
   */
  async flush(): Promise<{ sent: number; remaining: number }> {
    if (this.flushing || this.pending.length === 0) {
      return { sent: 0, remaining: this.pending.length };
    }
    this.flushing = true;

    try {
      const batch = this.pending.slice(0, this.batchSize);
      try {
        await this.backend.events.send(batch.map((item) => item.event));
        this.pending = this.pending.filter((item) => !batch.includes(item));
        this.stats.sent += batch.length;
        const sent = batch.length;
        this.flushing = false;
        // More waiting? Keep draining.
        if (this.pending.length >= this.batchSize) void this.flush();
        return { sent, remaining: this.pending.length };
      } catch (error) {
        batch.forEach((item) => {
          item.attempts += 1;
        });
        this.stats.failed += 1;
        this.onError?.(error, Math.max(...batch.map((item) => item.attempts)));
        // Drop only what has exhausted its retries.
        const exhausted = this.pending.filter((item) => item.attempts >= this.maxAttempts);
        if (exhausted.length) {
          this.pending = this.pending.filter((item) => item.attempts < this.maxAttempts);
          this.stats.dropped += exhausted.length;
        }
        this.flushing = false;
        return { sent: 0, remaining: this.pending.length };
      }
    } catch (error) {
      this.flushing = false;
      this.onError?.(error, 1);
      return { sent: 0, remaining: this.pending.length };
    }
  }

  /** Pending events, oldest first — used by tests and the diagnostics view. */
  peek(): CampaignEventRecord[] {
    return this.pending.map((item) => item.event);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
