import { describe, it, expect, vi } from "vitest";
import { makeThrottler, withTimeout } from "./throttle.js";

describe("makeThrottler", () => {
  it("allows up to burst immediately, then drops", () => {
    const t = makeThrottler(5, 5);
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (t.allow()) allowed += 1;
    expect(allowed).toBeLessThanOrEqual(6); // burst + tiny accrual during loop
    expect(t.droppedSinceLast()).toBeGreaterThan(0);
  });

  it("drops counter resets after read", () => {
    const t = makeThrottler(1, 1);
    t.allow(); // consume token
    t.allow(); // drop
    t.allow(); // drop
    expect(t.droppedSinceLast()).toBeGreaterThan(0);
    expect(t.droppedSinceLast()).toBe(0);
  });

  it("refills over time", async () => {
    const t = makeThrottler(10, 1);
    expect(t.allow()).toBe(true);
    expect(t.allow()).toBe(false);
    await new Promise((r) => setTimeout(r, 250));
    expect(t.allow()).toBe(true);
  });
});

describe("withTimeout", () => {
  it("resolves when inner resolves in time", async () => {
    const r = await withTimeout(Promise.resolve(42), 1000);
    expect(r).toBe(42);
  });

  it("rejects on timeout", async () => {
    const hangs = new Promise<number>(() => undefined);
    await expect(withTimeout(hangs, 20, "hang")).rejects.toThrow(/hang.*timed out/);
  });

  it("clears timer on success", async () => {
    vi.useFakeTimers();
    const p = withTimeout(Promise.resolve("ok"), 5000);
    await expect(p).resolves.toBe("ok");
    // If the timer weren't cleared, fakeTimers would show pending ones.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
