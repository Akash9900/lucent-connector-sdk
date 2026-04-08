import type {
  ConnectorConfig,
  FetchSessionsParams,
  HealthCheckResult,
  PaginatedResult,
  Session,
  SessionEvent,
} from "../types";

/**
 * ReplayConnector is the provider-agnostic boundary for session replay ingestion.
 *
 * Design principles:
 * 1) Provider-agnostic: callers never see provider-specific types.
 * 2) Pagination-first: list endpoints return cursored pages (even if provider is offset-based).
 * 3) Fail-safe: health checks should return a HealthCheckResult; they should not throw uncaught.
 * 4) Stateless: connectors do not keep mutable state; safe to run across workers.
 */
export abstract class ReplayConnector {
  protected readonly config: ConnectorConfig;

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  abstract get providerName(): string; // e.g. "PostHog"
  abstract get providerId(): string; // e.g. "posthog"

  abstract healthCheck(): Promise<HealthCheckResult>;
  abstract fetchSessions(params: FetchSessionsParams): Promise<PaginatedResult<Session>>;
  abstract fetchSessionEvents(providerSessionId: string): Promise<SessionEvent[]>;
  abstract fetchSessionMetadata(providerSessionId: string): Promise<Session | null>;

  /**
   * Fetches a single page to infer total session count if the provider returns it.
   * Returns -1 if the provider doesn't support a total count.
   */
  async estimateSessionCount(after?: Date, before?: Date): Promise<number> {
    const page = await this.fetchSessions({ after, before, limit: 1 });
    return typeof page.total === "number" ? page.total : -1;
  }

  /**
   * Auto-paginates through all sessions and yields each page.
   */
  async *fetchAllSessions(params: FetchSessionsParams): AsyncGenerator<Session[], void, unknown> {
    let cursor: string | undefined = params.cursor;
    let hasMore = true;

    while (hasMore) {
      const page = await this.fetchSessions({ ...params, cursor });
      yield page.data;
      hasMore = page.hasMore;
      cursor = page.cursor ?? undefined;
      if (hasMore && !cursor) {
        // Fail-safe for misbehaving providers: if hasMore but no cursor, stop.
        return;
      }
    }
  }

  getConfig(): Readonly<ConnectorConfig> {
    return Object.freeze({ ...this.config });
  }
}

