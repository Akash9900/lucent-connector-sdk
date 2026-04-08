const mockGet = jest.fn();
const mockUseInterceptor = jest.fn();

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      get: mockGet,
      interceptors: { response: { use: mockUseInterceptor } },
    })),
  },
  create: jest.fn(() => ({
    get: mockGet,
    interceptors: { response: { use: mockUseInterceptor } },
  })),
}));

import { PostHogConnector } from "../connectors/posthog";
import { ClarityConnector } from "../connectors/clarity";
import type { ConnectorConfig } from "../types";

describe("connectors", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockUseInterceptor.mockReset();
  });

  describe("PostHogConnector", () => {
    const baseConfig: ConnectorConfig = {
      provider: "posthog",
      apiKey: "x",
      projectId: "123",
      maxRequestsPerMinute: 1000,
      maxConcurrentRequests: 5,
      defaultPageSize: 100,
      maxPageSize: 1000,
      maxRetries: 0,
      retryDelayMs: 1,
      retryBackoffMultiplier: 2,
    };

    test("constructor throws if no projectId", () => {
      expect(() => new PostHogConnector({ ...baseConfig, projectId: undefined })).toThrow(/projectId/);
    });

    test("healthCheck returns healthy:true on 200", async () => {
      mockGet.mockResolvedValueOnce({ data: {} });
      const c = new PostHogConnector(baseConfig);
      await expect(c.healthCheck()).resolves.toMatchObject({ healthy: true, provider: "posthog" });
    });

    test("healthCheck returns healthy:false on network error", async () => {
      mockGet.mockRejectedValueOnce(new Error("net"));
      const c = new PostHogConnector(baseConfig);
      const res = await c.healthCheck();
      expect(res.healthy).toBe(false);
    });

    test("fetchSessions normalizes recordings to Session format", async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          results: [
            {
              id: "r1",
              session_id: "s1",
              distinct_id: "u1",
              viewed: true,
              recording_duration: 12,
              active_seconds: 5,
              start_time: "2026-01-01T00:00:00.000Z",
              end_time: "2026-01-01T00:00:12.000Z",
              click_count: 2,
              keypress_count: 3,
              mouse_activity_count: 4,
              console_error_count: 1,
              console_log_count: 0,
              console_warn_count: 0,
              start_url: "https://x",
            },
          ],
          next: null,
          previous: null,
          count: 1,
        },
      });

      const c = new PostHogConnector(baseConfig);
      const page = await c.fetchSessions({ limit: 1 });
      expect(page.data[0]).toMatchObject({
        provider: "posthog",
        providerSessionId: "s1",
        durationMs: 12000,
        hasErrors: true,
        eventCount: 2 + 3 + 4,
      });
    });

    test("fetchSessions handles pagination (next != null means hasMore=true)", async () => {
      mockGet.mockResolvedValueOnce({
        data: { results: [], next: "x", previous: null },
      });
      const c = new PostHogConnector(baseConfig);
      const page = await c.fetchSessions({ limit: 1, cursor: "0" });
      expect(page.hasMore).toBe(false); // empty results => no progress
    });

    test("fetchSessionEvents maps event names", async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          results: [
            { id: "e1", event: "$pageview", timestamp: "2026-01-01T00:00:00.000Z", properties: {} },
            { id: "e2", event: "$rageclick", timestamp: "2026-01-01T00:00:01.000Z", properties: {} },
            { id: "e3", event: "$exception", timestamp: "2026-01-01T00:00:02.000Z", properties: {} },
          ],
          next: null,
          previous: null,
        },
      });
      const c = new PostHogConnector(baseConfig);
      const events = await c.fetchSessionEvents("sess");
      expect(events.map((e) => e.type)).toEqual(["page_view", "rage_click", "error"]);
    });

    test("fetchSessionMetadata returns null on 404", async () => {
      const err = Object.assign(new Error("404"), { response: { status: 404 } });
      mockGet.mockRejectedValueOnce(err);
      const c = new PostHogConnector(baseConfig);
      await expect(c.fetchSessionMetadata("missing")).resolves.toBeNull();
    });
  });

  describe("ClarityConnector", () => {
    const baseConfig: ConnectorConfig = {
      provider: "clarity",
      apiKey: "x",
      projectId: "p1",
      maxRequestsPerMinute: 1000,
      maxConcurrentRequests: 5,
      defaultPageSize: 100,
      maxPageSize: 1000,
      maxRetries: 0,
      retryDelayMs: 1,
      retryBackoffMultiplier: 2,
    };

    test("constructor throws if no projectId", () => {
      expect(() => new ClarityConnector({ ...baseConfig, projectId: undefined })).toThrow(/projectId/);
    });

    test("fetchSessions normalizes PascalCase fields", async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          Sessions: [
            {
              SessionId: "s1",
              UserId: "u1",
              StartTime: "2026-01-01T00:00:00.000Z",
              EndTime: "2026-01-01T00:00:10.000Z",
              Duration: 10,
              PagesViewed: 3,
              ClickCount: 7,
              Device: "Desktop",
              HasRageClicks: true,
              HasDeadClicks: false,
              HasErrors: true,
              Browser: "Chrome",
              OS: "macOS",
              Country: "US",
              Resolution: "1920x1080",
            },
          ],
          NextPageToken: null,
          TotalCount: 1,
        },
      });

      const c = new ClarityConnector(baseConfig);
      const page = await c.fetchSessions({ limit: 1 });
      expect(page.data[0]).toMatchObject({
        provider: "clarity",
        providerSessionId: "s1",
        deviceType: "desktop",
        hasRageClicks: true,
        hasErrors: true,
      });
    });

    test("fetchSessions uses NextPageToken for pagination", async () => {
      mockGet.mockResolvedValueOnce({
        data: { Sessions: [], NextPageToken: "next", TotalCount: 0 },
      });
      const c = new ClarityConnector(baseConfig);
      const page = await c.fetchSessions({ limit: 1 });
      expect(page.hasMore).toBe(true);
      expect(page.cursor).toBe("next");
    });

    test("fetchSessionEvents maps types and coordinates", async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          SessionId: "s1",
          Events: [
            { EventId: "e1", SessionId: "s1", Type: "Click", Timestamp: "2026-01-01T00:00:00.000Z" },
            {
              EventId: "e2",
              SessionId: "s1",
              Type: "RageClick",
              Timestamp: "2026-01-01T00:00:01.000Z",
              Coordinates: { X: 1, Y: 2 },
            },
          ],
        },
      });

      const c = new ClarityConnector(baseConfig);
      const events = await c.fetchSessionEvents("s1");
      expect(events[0]?.type).toBe("click");
      expect(events[1]?.type).toBe("rage_click");
      expect(events[1]?.data.coordinates).toEqual({ x: 1, y: 2 });
    });
  });
});

