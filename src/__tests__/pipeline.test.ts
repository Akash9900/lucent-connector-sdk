const queueAdd = jest.fn();
const queueGetJobCounts = jest.fn(async () => ({ active: 0, waiting: 0 }));
const queueDrain = jest.fn(async () => undefined);
const queueClose = jest.fn(async () => undefined);

const dlqAdd = jest.fn();
const dlqDrain = jest.fn(async () => undefined);
const dlqClose = jest.fn(async () => undefined);

const queueEventsClose = jest.fn(async () => undefined);

jest.mock("bullmq", () => {
  class Queue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    add = (name: string, data: unknown, opts: unknown) => {
      if (this.name.endsWith(":dlq")) return dlqAdd(name, data, opts);
      return queueAdd(name, data, opts);
    };
    getJobCounts = (_a?: unknown, _b?: unknown) => queueGetJobCounts();
    drain = () => {
      if (this.name.endsWith(":dlq")) return dlqDrain();
      return queueDrain();
    };
    close = () => {
      if (this.name.endsWith(":dlq")) return dlqClose();
      return queueClose();
    };
  }

  class Worker {
    // minimal event emitter-ish
    on = jest.fn();
    close = jest.fn(async () => undefined);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    constructor(_name: string, _processor: unknown) {}
  }

  class QueueEvents {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    constructor(_name: string) {}
    close = () => queueEventsClose();
  }

  return { Queue, Worker, QueueEvents };
});

jest.mock("ioredis", () => {
  return {
    __esModule: true,
    default: class IORedis {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      constructor(_opts: unknown) {}
      quit = jest.fn(async () => undefined);
    },
  };
});

import { IngestionPipeline } from "../queue/ingestion";
import type { ConnectorConfig, IngestionJob, Session, SessionEvent } from "../types";
import { NIL_UUID } from "../types";

describe("IngestionPipeline", () => {
  const config = {
    redis: { host: "localhost", port: 6379 },
    queue: { name: "lucent:ingestion", concurrency: 1, maxRetries: 2, retryDelayMs: 100 },
    deadLetterQueue: { name: "lucent:ingestion:dlq" },
  };

  const tenantConfig: ConnectorConfig = {
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

  const registry = {
    getConnector: jest.fn(),
  };

  const tenantStore = {
    getConfig: jest.fn(async (_tenantId: string) => tenantConfig),
  };

  const sessionStore = {
    saveSession: jest.fn(async (_s: Session) => undefined),
    saveEvents: jest.fn(async (_e: SessionEvent[]) => undefined),
    markSessionStatus: jest.fn(async (_id: string, _status: Session["status"]) => undefined),
  };

  beforeEach(() => {
    queueAdd.mockReset();
    dlqAdd.mockReset();
    registry.getConnector.mockReset();
    tenantStore.getConfig.mockClear();
    sessionStore.saveSession.mockClear();
    sessionStore.saveEvents.mockClear();
    sessionStore.markSessionStatus.mockClear();
  });

  test("enqueue validates job data", async () => {
    const p = new IngestionPipeline(config, registry as never, tenantStore, sessionStore);
    const bad = { tenantId: "nope", provider: "posthog", providerSessionId: "x" } as unknown as IngestionJob;
    await expect(p.enqueue(bad)).rejects.toBeTruthy();
  });

  test("enqueue uses correct jobId format for deduplication", async () => {
    const p = new IngestionPipeline(config, registry as never, tenantStore, sessionStore);
    const job: IngestionJob = {
      tenantId: "00000000-0000-0000-0000-000000000001",
      provider: "posthog",
      providerSessionId: "sess1",
      priority: "normal",
    };
    await p.enqueue(job);
    const opts = queueAdd.mock.calls[0]?.[2] as { jobId?: string };
    expect(opts.jobId).toBe("00000000-0000-0000-0000-000000000001:posthog:sess1");
  });

  test("enqueue maps priority correctly (critical->1, normal->3)", async () => {
    const p = new IngestionPipeline(config, registry as never, tenantStore, sessionStore);
    const critical: IngestionJob = {
      tenantId: "00000000-0000-0000-0000-000000000001",
      provider: "posthog",
      providerSessionId: "sess1",
      priority: "critical",
    };
    await p.enqueue(critical);
    let opts = queueAdd.mock.calls[0]?.[2] as { priority?: number };
    expect(opts.priority).toBe(1);

    const normal: IngestionJob = {
      tenantId: "00000000-0000-0000-0000-000000000001",
      provider: "posthog",
      providerSessionId: "sess2",
      priority: "normal",
    };
    await p.enqueue(normal);
    opts = queueAdd.mock.calls[1]?.[2] as { priority?: number };
    expect(opts.priority).toBe(3);
  });

  test("processJob calls connector methods in order and stamps tenantId on session and events", async () => {
    const p = new IngestionPipeline(config, registry as never, tenantStore, sessionStore);

    const connector = {
      fetchSessionMetadata: jest.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000010",
        tenantId: NIL_UUID,
        providerSessionId: "sess1",
        provider: "posthog",
        startedAt: new Date(),
        deviceType: "unknown",
        pageCount: 0,
        eventCount: 0,
        hasErrors: false,
        hasRageClicks: false,
        hasDeadClicks: false,
        status: "pending",
        retryCount: 0,
      })),
      fetchSessionEvents: jest.fn(async () => [
        {
          id: "e1",
          sessionId: NIL_UUID,
          tenantId: NIL_UUID,
          type: "click",
          timestamp: new Date(),
          data: {},
        },
      ]),
    };
    registry.getConnector.mockReturnValue(connector);

    const updateProgress = jest.fn(async (_n: number) => undefined);
    const job = {
      data: {
        tenantId: "00000000-0000-0000-0000-000000000001",
        provider: "posthog",
        providerSessionId: "sess1",
        priority: "normal",
      },
      updateProgress,
      attemptsMade: 0,
    };

    const res = await p.processJob(job as never);
    expect(res.status).toBe("success");

    const metaOrder = connector.fetchSessionMetadata.mock.invocationCallOrder[0] ?? 0;
    const eventsOrder = connector.fetchSessionEvents.mock.invocationCallOrder[0] ?? 0;
    expect(metaOrder).toBeGreaterThan(0);
    expect(eventsOrder).toBeGreaterThan(0);
    expect(metaOrder).toBeLessThan(eventsOrder);
    expect(sessionStore.saveSession).toHaveBeenCalledTimes(1);
    expect(sessionStore.saveEvents).toHaveBeenCalledTimes(1);
    expect(sessionStore.markSessionStatus).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000010",
      "analyzing"
    );

    const savedSession = sessionStore.saveSession.mock.calls[0]?.[0] as Session;
    expect(savedSession.tenantId).toBe("00000000-0000-0000-0000-000000000001");

    const savedEvents = sessionStore.saveEvents.mock.calls[0]?.[0] as SessionEvent[];
    expect(savedEvents[0]?.tenantId).toBe("00000000-0000-0000-0000-000000000001");
    expect(savedEvents[0]?.sessionId).toBe("00000000-0000-0000-0000-000000000010");
  });

  test("getMetrics returns correct counts after processing", async () => {
    const p = new IngestionPipeline(config, registry as never, tenantStore, sessionStore);
    const connector = {
      fetchSessionMetadata: jest.fn(async () => ({
        id: "00000000-0000-0000-0000-000000000010",
        tenantId: NIL_UUID,
        providerSessionId: "sess1",
        provider: "posthog",
        startedAt: new Date(),
        deviceType: "unknown",
        pageCount: 0,
        eventCount: 0,
        hasErrors: false,
        hasRageClicks: false,
        hasDeadClicks: false,
        status: "pending",
        retryCount: 0,
      })),
      fetchSessionEvents: jest.fn(async () => []),
    };
    registry.getConnector.mockReturnValue(connector);

    await p.processJob({
      data: {
        tenantId: "00000000-0000-0000-0000-000000000001",
        provider: "posthog",
        providerSessionId: "sess1",
        priority: "normal",
      },
      updateProgress: jest.fn(async () => undefined),
      attemptsMade: 0,
    } as never);

    const metrics = await p.getMetrics();
    expect(metrics.totalProcessed).toBe(1);
    expect(metrics.byTenant.get("00000000-0000-0000-0000-000000000001")?.processed).toBe(1);
    expect(metrics.byProvider.get("posthog")?.processed).toBe(1);
  });
});

