/**
 * Token-bucket rate limiter with drop-on-overflow semantics. Verbose
 * notifications during long autonomous turns would otherwise flood the
 * Telegram API: we'd either hit the bot's 30 msg/sec limit or pile up
 * thousands of pending promises in memory. The throttler silently drops
 * anything beyond `ratePerSec` and counts the drops so we can emit a single
 * "+N messages suppressed" line periodically.
 */
export type Throttler = {
  /** Returns true if the caller should proceed; false = drop. */
  allow(): boolean;
  /** How many callers were dropped since the last consumption. */
  droppedSinceLast(): number;
};

export function makeThrottler(ratePerSec: number, burst: number = ratePerSec): Throttler {
  let tokens = burst;
  let last = Date.now();
  let dropped = 0;
  return {
    allow(): boolean {
      const now = Date.now();
      const delta = (now - last) / 1000;
      last = now;
      tokens = Math.min(burst, tokens + delta * ratePerSec);
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      dropped += 1;
      return false;
    },
    droppedSinceLast(): number {
      const n = dropped;
      dropped = 0;
      return n;
    },
  };
}

/**
 * Wrap a promise with a timeout. On timeout, the original promise is left
 * to settle in the background (we can't reliably cancel it) but the caller
 * gets an Error. This prevents a hung Telegram send from blocking the
 * scheduler's progress path forever.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label = "operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
