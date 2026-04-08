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

type ClaritySession = {
  SessionId: string;
  UserId?: string;
  StartTime: string;
  EndTime?: string;
  Duration?: number; // seconds
  PagesViewed?: number;
  ClickCount?: number;
  ScrollDepth?: number;
  Device?: "Desktop" | "Mobile" | "Tablet";
  Browser?: string;
  OS?: string;
  Country?: string;
  Resolution?: string;
  HasRageClicks?: boolean;
  HasDeadClicks?: boolean;
  HasErrors?: boolean;
  ExcessiveScrolling?: boolean;
  QuickBacks?: boolean;
  ReferrerUrl?: string;
  LandingPageUrl?: string;
};

type ClaritySessionsResponse = {
  Sessions: ClaritySession[];
  NextPageToken: string | null;
  TotalCount?: number;
};

type ClarityEvent = {
  EventId: string;
  SessionId: string;
  Type: string;
  Timestamp: string;
  PageUrl?: string;
  Selector?: string;
  Text?: string;
  Coordinates?: { X: number; Y: number };
  StatusCode?: number;
  ErrorMessage?: string;
  Metadata?: Record<string, unknown>;
};

type ClarityEventsResponse = {
  Events: ClarityEvent[];
  SessionId: string;
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

function mapDevice(d?: ClaritySession["Device"]): Session["deviceType"] {
  switch (d) {
    case "Desktop":
      return "desktop";
    case "Mobile":
      return "mobile";
    case "Tablet":
      return "tablet";
    default:
      return "unknown";
  }
}

export class ClarityConnector extends ReplayConnector {
  private readonly http: AxiosInstance;
  private readonly limiter: RateLimiter;
  private readonly logger = createLogger("clarity-connector");

  constructor(config: ConnectorConfig) {
    super(config);
    if (!config.projectId) {
      throw new Error("ClarityConnector requires config.projectId");
    }

    const baseURL = config.apiUrl ?? "https://www.clarity.ms/export/api/v1";
    this.http = axios.create({
      baseURL,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "x-clarity-project": config.projectId,
      },
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
    return "Microsoft Clarity";
  }

  get providerId(): string {
    return "clarity";
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
          this.logger.warn({ attempt, error }, "Retrying Clarity request");
        },
      }
    );
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const checkedAt = new Date();
    const start = Date.now();
    try {
      await this.fetchSessions({ limit: 1 });
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
    const limit = Math.min(
      Math.max(1, params.limit ?? this.config.defaultPageSize),
      this.config.maxPageSize
    );

    const query: Record<string, unknown> = {
      projectId: this.config.projectId,
      limit,
      startDate: toIsoDate(params.after),
      endDate: toIsoDate(params.before),
      pageToken: params.cursor,
      userId: params.userId,
      hasErrors: params.hasErrors,
      minDuration: typeof params.minDurationMs === "number" ? Math.floor(params.minDurationMs / 1000) : undefined,
    };

    const data = await this.get<ClaritySessionsResponse>("/sessions", query);
    const sessions = data.Sessions.map((s) => this.normalizeSession(s));

    return {
      data: sessions,
      cursor: data.NextPageToken ?? null,
      hasMore: data.NextPageToken !== null && data.NextPageToken !== "",
      total: typeof data.TotalCount === "number" ? data.TotalCount : undefined,
    };
  }

  async fetchSessionEvents(providerSessionId: string): Promise<SessionEvent[]> {
    const data = await this.get<ClarityEventsResponse>(`/sessions/${encodeURIComponent(providerSessionId)}/events`);
    return data.Events.map((e) => this.normalizeEvent(e));
  }

  async fetchSessionMetadata(providerSessionId: string): Promise<Session | null> {
    try {
      const data = await this.get<ClaritySession>(`/sessions/${encodeURIComponent(providerSessionId)}`);
      return this.normalizeSession(data);
    } catch (err: unknown) {
      const maybe = err as { response?: { status?: number } };
      if (maybe.response?.status === 404) return null;
      throw err;
    }
  }

  private normalizeSession(s: ClaritySession): Session {
    const startedAt = new Date(s.StartTime);
    const endedAt = s.EndTime ? new Date(s.EndTime) : undefined;
    const durationMs =
      typeof s.Duration === "number" && s.Duration >= 0 ? Math.round(s.Duration * 1000) : undefined;

    return {
      id: uuidv4(),
      tenantId: NIL_UUID,
      providerSessionId: s.SessionId,
      provider: "clarity",
      userId: s.UserId,
      startedAt,
      endedAt,
      durationMs,
      deviceType: mapDevice(s.Device),
      browser: s.Browser,
      os: s.OS,
      country: s.Country,
      screenResolution: s.Resolution,
      pageCount: Math.max(0, s.PagesViewed ?? 0),
      eventCount: Math.max(0, s.ClickCount ?? 0),
      hasErrors: Boolean(s.HasErrors),
      hasRageClicks: Boolean(s.HasRageClicks),
      hasDeadClicks: Boolean(s.HasDeadClicks),
      status: "pending",
      retryCount: 0,
    };
  }

  private normalizeEvent(e: ClarityEvent): SessionEvent {
    const type = this.mapEventType(e.Type);
    return {
      id: e.EventId || uuidv4(),
      sessionId: NIL_UUID,
      tenantId: NIL_UUID,
      type,
      timestamp: new Date(e.Timestamp),
      data: {
        url: e.PageUrl,
        selector: e.Selector,
        text: e.Text,
        statusCode: typeof e.StatusCode === "number" ? e.StatusCode : undefined,
        errorMessage: e.ErrorMessage,
        coordinates: e.Coordinates ? { x: e.Coordinates.X, y: e.Coordinates.Y } : undefined,
        metadata: e.Metadata ?? {},
      },
    };
  }

  private mapEventType(t: string): SessionEventType {
    switch (t) {
      case "Click":
        return "click";
      case "Input":
        return "input";
      case "Scroll":
        return "scroll";
      case "Navigation":
        return "navigation";
      case "NetworkRequest":
        return "network_request";
      case "ConsoleLog":
        return "console_log";
      case "ConsoleError":
        return "console_error";
      case "ConsoleWarn":
        return "console_warn";
      case "RageClick":
        return "rage_click";
      case "DeadClick":
        return "dead_click";
      case "Error":
        return "error";
      case "PageView":
        return "page_view";
      case "DomMutation":
        return "dom_mutation";
      default:
        return "custom";
    }
  }
}

