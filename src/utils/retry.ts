import { createLogger } from "./logger";

const logger = createLogger("retry");

export class RetryableError extends Error {
  readonly statusCode?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, opts?: { statusCode?: number; retryAfterMs?: number; cause?: unknown }) {
    super(message);
    this.name = "RetryableError";
    this.statusCode = opts?.statusCode;
    this.retryAfterMs = opts?.retryAfterMs;
    // Preserve cause if runtime supports it.
    if (opts?.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  backoffMultiplier: number;
  retryableStatuses?: number[];
  onRetry?: (attempt: number, error: unknown) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const statusCode = record["statusCode"];
  return typeof statusCode === "number" ? statusCode : undefined;
}

function isRetryable(error: unknown, retryableStatuses: number[]): boolean {
  if (error instanceof RetryableError) return true;
  const statusCode = getStatusCode(error);
  return statusCode !== undefined && retryableStatuses.includes(statusCode);
}

function computeDelayMs(attempt: number, baseDelayMs: number, backoffMultiplier: number): number {
  const raw = baseDelayMs * Math.pow(backoffMultiplier, attempt);
  const jitterFactor = 0.75 + Math.random() * 0.5;
  return Math.max(0, Math.round(raw * jitterFactor));
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const retryableStatuses = options.retryableStatuses ?? [429, 500, 502, 503, 504];
  if (options.maxRetries < 0) throw new Error("maxRetries must be non-negative");

  let attempt = 0;
  // attempt = 0 means "first retry" after the initial failure.
  // We will run fn(), and on failure potentially retry up to maxRetries times.
  // Total calls = 1 + maxRetries (worst case).
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!isRetryable(err, retryableStatuses)) {
        throw err;
      }

      if (attempt >= options.maxRetries) {
        throw err;
      }

      options.onRetry?.(attempt + 1, err);

      const delayMs =
        err instanceof RetryableError && typeof err.retryAfterMs === "number"
          ? Math.max(0, Math.round(err.retryAfterMs))
          : computeDelayMs(attempt, options.baseDelayMs, options.backoffMultiplier);

      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries: options.maxRetries,
          delayMs,
          statusCode: err instanceof RetryableError ? err.statusCode : getStatusCode(err),
          err,
        },
        "Retrying operation"
      );

      await sleep(delayMs);
      attempt += 1;
    }
  }
}

