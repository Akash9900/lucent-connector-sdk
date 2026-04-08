import { RetryableError, withRetry } from "../utils/retry";

describe("withRetry", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(1); // stable jitter (1.25 factor)
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test("returns result on first success", async () => {
    const fn = jest.fn(async () => "ok");
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 10, backoffMultiplier: 2 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on RetryableError and eventually succeeds", async () => {
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new RetryableError("429", { statusCode: 429 }))
      .mockResolvedValueOnce("ok");

    const p = withRetry(fn, { maxRetries: 3, baseDelayMs: 100, backoffMultiplier: 2 });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("throws after maxRetries exhausted", async () => {
    const fn = jest.fn(async () => {
      throw new RetryableError("boom", { statusCode: 500 });
    });

    const p = withRetry(fn, { maxRetries: 2, baseDelayMs: 10, backoffMultiplier: 2 });
    const assertion = expect(p).rejects.toBeInstanceOf(RetryableError);
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("non-retryable errors throw immediately without retry", async () => {
    const err = new Error("nope");
    const fn = jest.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 10, backoffMultiplier: 2 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("calls onRetry callback with correct attempt number", async () => {
    const onRetry = jest.fn();
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new RetryableError("429", { statusCode: 429 }))
      .mockResolvedValueOnce("ok");

    const p = withRetry(fn, { maxRetries: 3, baseDelayMs: 10, backoffMultiplier: 2, onRetry });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe("ok");
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(RetryableError));
  });

  test("respects retryAfterMs from RetryableError", async () => {
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new RetryableError("429", { statusCode: 429, retryAfterMs: 5000 }))
      .mockResolvedValueOnce("ok");

    const p = withRetry(fn, { maxRetries: 3, baseDelayMs: 10, backoffMultiplier: 2 });
    await jest.advanceTimersByTimeAsync(4999);
    expect(fn).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

