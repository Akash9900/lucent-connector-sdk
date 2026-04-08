import axios, { type AxiosInstance } from "axios";
import { v4 as uuidv4 } from "uuid";

import type {
  ConnectorConfig,
  FetchSessionsParams,
  HealthCheckResult,
  PaginatedResult,
  Session,
  SessionEvent,
  SessionEventType,
} from "../types";
import { NIL_UUID } from "../types";
import { ReplayConnector } from "./base";
import { RateLimiter } from "../utils/rate-limiter";
import { RetryableError, withRetry } from "../utils/retry";
import { createLogger } from "../utils/logger";

type PostHogRecordingsResponse = {
  results: PostHogRecording[];
  next: string | null;
  previous: string | null;
  count?: number;
};

type PostHogRecording = {
  id: string;
  session_id: string;
  distinct_id: string | null;
  viewed: boolean;
  recording_duration: number | null; // seconds
  active_seconds: number | null;
  start_time: string; // ISO
  end_time: string | null; // ISO
  click_count: number | null;
  keypress_count: number | null;
  mouse_activity_count: number | null;
  console_error_count: number | null;
  console_log_count: number | null;
  console_warn_count: number | null;
  start_url: string | null;
  person?: {
    id: string;
    distinct_ids: string[];
    properties?: Record<string, unknown>;
  };
};

type PostHogEventsResponse = {
  results: PostHogEvent[];
  next: string | null;
  previous: string | null;
};

type PostHogEventElement = {
  tag_name: string;
  text?: string;
  attr_class?: string;
  nth_child?: number;
  nth_of_type?: number;
};

type PostHogEvent = {
  id: string;
  event: string;
  timestamp: string;
  properties?: Record<string, unknown>;
  elements?: PostHogEventElement[];
};

function parseRetryAfterMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function isHttpRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function toIsoDate(d?: Date): string | undefined {
  return d ? d.toISOString() : undefined;
}

export class PostHogConnector extends ReplayConnector {
  private readonly http: AxiosInstance;
  private readonly limiter: RateLimiter;
  private readonly logger = createLogger("posthog-connector");

  constructor(config: ConnectorConfig) {
    super(config);
    if (!config.projectId) {
      throw new Error("PostHogConnector requires config.projectId");
    }

    const baseURL = config.apiUrl ?? "https://us.posthog.com";
    this.http = axios.create({
      baseURL,
      headers: { Authorization: `Bearer ${config.apiKey}` },
      timeout: 30000,
    });

    this.http.interceptors.response.use(
      (r) => r,
      (err: unknown) => {
        const maybe = err as { response?: { status?: number; headers?: Record<string, unknown> } };
        const status = maybe.response?.status;
        if (typeof status === "number" && isHttpRetryable(status)) {
          const retryAfterMs = parseRetryAfterMs(maybe.response?.headers?.["retry-after"]);
          throw new RetryableError("Retryable HTTP error", { statusCode: status, retryAfterMs, cause: err });
        }
        throw err;
      }
    );

    this.limiter = new RateLimiter(config.maxRequestsPerMinute);
  }

  get providerName(): string {
    return "PostHog";
  }

  get providerId(): string {
    return "posthog";
  }

  private async get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
    await this.limiter.acquire();
    return withRetry(
      async () => {
        const res = await this.http.get<T>(url, { params });
        return res.data;
      },
      {
        maxRetries: this.config.maxRetries,
        baseDelayMs: this.config.retryDelayMs,
        backoffMultiplier: this.config.retryBackoffMultiplier,
        onRetry: (attempt, error) => {
          this.logger.warn({ attempt, error }, "Retrying PostHog request");
        },
      }
    );
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const checkedAt = new Date();
    const start = Date.now();
    const projectId = this.config.projectId as string;
    try {
      await this.get(`/api/projects/${encodeURIComponent(projectId)}/`);
      return {
        healthy: true,
        provider: this.providerId,
        latencyMs: Date.now() - start,
        checkedAt,
      };
    } catch (err: unknown) {
      return {
        healthy: false,
        provider: this.providerId,
        latencyMs: Date.now() - start,
        details: { error: err },
        checkedAt,
      };
    }
  }

  async fetchSessions(params: FetchSessionsParams): Promise<PaginatedResult<Session>> {
    const projectId = this.config.projectId as string;
    const limit = Math.min(
      Math.max(1, params.limit ?? this.config.defaultPageSize),
      this.config.maxPageSize
    );

    const offset = params.cursor ? Math.max(0, Number(params.cursor)) : 0;

    const query: Record<string, unknown> = {
      limit,
      offset,
      date_from: toIsoDate(params.after),
      date_to: toIsoDate(params.before),
    };

    if (params.userId) query["distinct_id"] = params.userId;
    if (params.hasErrors === true) query["console_error_count__gt"] = 0;
    if (typeof params.minDurationMs === "number") {
      query["recording_duration__gte"] = Math.floor(params.minDurationMs / 1000);
    }

    const data = await this.get<PostHogRecordingsResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/session_recordings/`,
      query
    );

    const sessions = data.results.map((r) => this.normalizeRecording(r));
    const nextOffset = offset + sessions.length;
    const hasMore = Boolean(data.next) && sessions.length > 0;

    return {
      data: sessions,
      cursor: hasMore ? String(nextOffset) : null,
      hasMore,
      total: typeof data.count === "number" ? data.count : undefined,
    };
  }

  async fetchSessionEvents(providerSessionId: string): Promise<SessionEvent[]> {
    const projectId = this.config.projectId as string;

    // PostHog event filtering commonly uses the `properties` query parameter (JSON).
    const properties = JSON.stringify([
      { key: "$session_id", operator: "exact", value: providerSessionId },
    ]);

    const data = await this.get<PostHogEventsResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/events/`,
      { limit: 1000, properties }
    );

    return data.results.map((e) => this.normalizeEvent(e));
  }

  async fetchSessionMetadata(providerSessionId: string): Promise<Session | null> {
    const projectId = this.config.projectId as string;
    try {
      const rec = await this.get<PostHogRecording>(
        `/api/projects/${encodeURIComponent(projectId)}/session_recordings/${encodeURIComponent(
          providerSessionId
        )}/`
      );
      return this.normalizeRecording(rec);
    } catch (err: unknown) {
      const maybe = err as { response?: { status?: number } };
      if (maybe.response?.status === 404) return null;
      throw err;
    }
  }

  private normalizeRecording(r: PostHogRecording): Session {
    const startedAt = new Date(r.start_time);
    const endedAt = r.end_time ? new Date(r.end_time) : undefined;
    const durationMs =
      typeof r.recording_duration === "number" && r.recording_duration >= 0
        ? Math.round(r.recording_duration * 1000)
        : undefined;

    const clickCount = Math.max(0, r.click_count ?? 0);
    const keypressCount = Math.max(0, r.keypress_count ?? 0);
    const mouseCount = Math.max(0, r.mouse_activity_count ?? 0);
    const consoleErrors = Math.max(0, r.console_error_count ?? 0);

    return {
      id: uuidv4(),
      tenantId: NIL_UUID,
      providerSessionId: r.session_id,
      provider: "posthog",
      userId: r.distinct_id ?? undefined,
      startedAt,
      endedAt,
      durationMs,
      deviceType: "unknown",
      pageCount: 0,
      eventCount: clickCount + keypressCount + mouseCount,
      hasErrors: consoleErrors > 0,
      hasRageClicks: false,
      hasDeadClicks: false,
      status: "pending",
      retryCount: 0,
    };
  }

  private normalizeEvent(e: PostHogEvent): SessionEvent {
    const type = this.mapEventType(e.event);
    const selector = this.buildSelector(e.elements?.[0]);

    return {
      id: e.id ?? uuidv4(),
      sessionId: NIL_UUID,
      tenantId: NIL_UUID,
      type,
      timestamp: new Date(e.timestamp),
      data: {
        url: typeof e.properties?.["$current_url"] === "string" ? (e.properties["$current_url"] as string) : undefined,
        selector,
        text: typeof e.elements?.[0]?.text === "string" ? e.elements[0].text : undefined,
        metadata: e.properties ?? {},
      },
    };
  }

  private mapEventType(eventName: string): SessionEventType {
    switch (eventName) {
      case "$pageview":
        return "page_view";
      case "$pageleave":
        return "navigation";
      case "$autocapture":
        return "click";
      case "$rageclick":
        return "rage_click";
      case "$dead_click":
        return "dead_click";
      case "$exception":
        return "error";
      default:
        return "custom";
    }
  }

  private buildSelector(el?: PostHogEventElement): string | undefined {
    if (!el) return undefined;
    const tag = el.tag_name;
    if (!tag) return undefined;

    const classes = el.attr_class
      ? el.attr_class
          .split(" ")
          .map((c) => c.trim())
          .filter(Boolean)
          .map((c) => `.${c}`)
          .join("")
      : "";

    const nth = typeof el.nth_of_type === "number" && el.nth_of_type > 0 ? `:nth-of-type(${el.nth_of_type})` : "";

    return `${tag}${classes}${nth}`;
  }
}

