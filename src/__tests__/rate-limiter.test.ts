import { RateLimiter } from "../utils/rate-limiter";

describe("RateLimiter", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("starts with full token bucket", () => {
    const rl = new RateLimiter(60);
    expect(rl.available()).toBe(60);
  });

  test("acquire() returns 0 when tokens available", async () => {
    const rl = new RateLimiter(60);
    await expect(rl.acquire()).resolves.toBe(0);
  });

  test("acquire() consumes tokens (available decreases)", async () => {
    const rl = new RateLimiter(60);
    const before = rl.available();
    await rl.acquire();
    const after = rl.available();
    expect(after).toBe(before - 1);
  });

  test("canAcquire() returns false when bucket empty", async () => {
    const rl = new RateLimiter(2);
    await rl.acquire();
    await rl.acquire();
    expect(rl.canAcquire()).toBe(false);
  });

  test("tokens refill over time", async () => {
    const rl = new RateLimiter(60); // 1 token/sec
    await rl.acquire();
    await rl.acquire();
    expect(rl.available()).toBe(58);

    jest.advanceTimersByTime(2000);
    jest.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    expect(rl.available()).toBe(60);
  });

  test("multiple rapid acquire() calls eventually block", async () => {
    const rl = new RateLimiter(1); // 1/min
    await rl.acquire(); // immediate

    const p = rl.acquire();
    jest.advanceTimersByTime(60000);
    jest.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
    await expect(p).resolves.toBeGreaterThan(0);
  });
});

