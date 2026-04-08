import { ConnectorRegistry } from "../connectors/registry";
import type { ConnectorConfig } from "../types";
import { ReplayConnector } from "../connectors/base";
import type { FetchSessionsParams, HealthCheckResult, PaginatedResult, Session, SessionEvent } from "../types";

describe("ConnectorRegistry", () => {
  const posthogConfig: ConnectorConfig = {
    provider: "posthog",
    apiKey: "x",
    projectId: "p",
    maxRequestsPerMinute: 1000,
    maxConcurrentRequests: 5,
    defaultPageSize: 100,
    maxPageSize: 1000,
    maxRetries: 0,
    retryDelayMs: 1,
    retryBackoffMultiplier: 2,
  };

  const clarityConfig: ConnectorConfig = {
    provider: "clarity",
    apiKey: "x",
    projectId: "p",
    maxRequestsPerMinute: 1000,
    maxConcurrentRequests: 5,
    defaultPageSize: 100,
    maxPageSize: 1000,
    maxRetries: 0,
    retryDelayMs: 1,
    retryBackoffMultiplier: 2,
  };

  test("has posthog and clarity factories registered on construction", () => {
    const r = new ConnectorRegistry();
    expect(r.listProviders()).toEqual(["clarity", "posthog"]);
  });

  test("getConnector creates instance and caches it", () => {
    const r = new ConnectorRegistry();
    const c1 = r.getConnector("t1", posthogConfig);
    const c2 = r.getConnector("t1", posthogConfig);
    expect(c1).toBe(c2);
  });

  test("different tenantId returns different instance (tenant isolation)", () => {
    const r = new ConnectorRegistry();
    const c1 = r.getConnector("t1", posthogConfig);
    const c2 = r.getConnector("t2", posthogConfig);
    expect(c1).not.toBe(c2);
  });

  test("removeConnector removes from cache, next getConnector creates fresh", () => {
    const r = new ConnectorRegistry();
    const c1 = r.getConnector("t1", posthogConfig);
    expect(r.removeConnector("t1", "posthog")).toBe(true);
    const c2 = r.getConnector("t1", posthogConfig);
    expect(c2).not.toBe(c1);
  });

  test("throws error for unknown provider with helpful message", () => {
    const r = new ConnectorRegistry();
    expect(() =>
      r.getConnector("t1", { ...posthogConfig, provider: "custom", projectId: "x" })
    ).toThrow(/Known providers/);
  });

  test("registerFactory adds custom provider", () => {
    const r = new ConnectorRegistry();
    class DummyConnector extends ReplayConnector {
      get providerName(): string {
        return "Dummy";
      }
      get providerId(): string {
        return "custom";
      }
      async healthCheck(): Promise<HealthCheckResult> {
        return { healthy: true, provider: "custom", latencyMs: 0, checkedAt: new Date() };
      }
      async fetchSessions(_params: FetchSessionsParams): Promise<PaginatedResult<Session>> {
        return { data: [], cursor: null, hasMore: false };
      }
      async fetchSessionEvents(_providerSessionId: string): Promise<SessionEvent[]> {
        return [];
      }
      async fetchSessionMetadata(_providerSessionId: string): Promise<Session | null> {
        return null;
      }
    }

    r.registerFactory("custom", (cfg) => new DummyConnector(cfg));
    expect(r.listProviders()).toContain("custom");
  });

  test("healthCheckAll returns results for all active connectors", async () => {
    const r = new ConnectorRegistry();
    const posthog = r.getConnector("t1", posthogConfig);
    const clarity = r.getConnector("t1", clarityConfig);

    jest.spyOn(posthog, "healthCheck").mockResolvedValueOnce({
      healthy: true,
      provider: "posthog",
      latencyMs: 1,
      checkedAt: new Date(),
    });
    jest.spyOn(clarity, "healthCheck").mockResolvedValueOnce({
      healthy: true,
      provider: "clarity",
      latencyMs: 1,
      checkedAt: new Date(),
    });

    const res = await r.healthCheckAll();
    expect(res.size).toBe(2);
    expect(res.get("t1:posthog")?.healthy).toBe(true);
    expect(res.get("t1:clarity")?.healthy).toBe(true);
  });

  test("clear() empties the instance cache", () => {
    const r = new ConnectorRegistry();
    r.getConnector("t1", posthogConfig);
    expect(r.listActiveConnectors()).toEqual(["t1:posthog"]);
    r.clear();
    expect(r.listActiveConnectors()).toEqual([]);
  });
});

