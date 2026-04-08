import { Queue, Worker, QueueEvents, type JobsOptions, type Job } from "bullmq";
import IORedis from "ioredis";

import type { ConnectorConfig, IngestionJob, Session, SessionEvent } from "../types";
import { IngestionJobSchema, NIL_UUID } from "../types";
import type { ConnectorRegistry } from "../connectors/registry";
import { createLogger } from "../utils/logger";

export interface IngestionPipelineConfig {
  redis: { host: string; port: number; password?: string; db?: number; keyPrefix?: string };
  queue: {
    name?: string;
    concurrency?: number;
    maxRetries?: number;
    retryDelayMs?: number;
    stalledInterval?: number;
  };
  deadLetterQueue?: { name?: string; maxSize?: number };
}

export interface IngestionResult {
  sessionId: string;
  tenantId: string;
  provider: string;
  eventsIngested: number;
  durationMs: number;
  status: "success" | "partial" | "failed";
  error?: string;
}

export interface PipelineMetrics {
  totalProcessed: number;
  totalFailed: number;
  totalDeadLettered: number;
  activeJobs: number;
  waitingJobs: number;
  averageProcessingTimeMs: number;
  byTenant: Map<string, { processed: number; failed: number }>;
  byProvider: Map<string, { processed: number; failed: number }>;
}

export interface TenantConfigStore {
  getConfig(tenantId: string): Promise<ConnectorConfig | null>;
}

export interface SessionStore {
  saveSession(session: Session): Promise<void>;
  saveEvents(events: SessionEvent[]): Promise<void>;
  markSessionStatus(
    sessionId: string,
    status: Session["status"],
    failureReason?: string
  ): Promise<void>;
}

type DeadLetterPayload = {
  original: IngestionJob;
  error: string;
  timestamp: string;
  attemptsMade: number;
};

export class IngestionPipeline {
  private readonly logger = createLogger("ingestion-pipeline");

  private readonly redis: IORedis;
  private readonly queue: Queue<IngestionJob, IngestionResult>;
  private readonly dlq?: Queue<DeadLetterPayload, void>;
  private readonly queueEvents: QueueEvents;
  private worker?: Worker<IngestionJob, IngestionResult>;

  private readonly timings: number[] = [];
  private readonly maxTimings = 1000;
  private totalTimingMs = 0;

  private totalProcessed = 0;
  private totalFailed = 0;
  private totalDeadLettered = 0;
  private readonly byTenant = new Map<string, { processed: number; failed: number }>();
  private readonly byProvider = new Map<string, { processed: number; failed: number }>();

  constructor(
    private readonly config: IngestionPipelineConfig,
    private readonly registry: ConnectorRegistry,
    private readonly tenantStore: TenantConfigStore,
    private readonly sessionStore: SessionStore
  ) {
    this.redis = new IORedis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      keyPrefix: config.redis.keyPrefix,
      maxRetriesPerRequest: null,
    });

    const queueName = config.queue.name ?? "lucent:ingestion";
    this.queue = new Queue(queueName, { connection: this.redis });
    this.queueEvents = new QueueEvents(queueName, { connection: this.redis });

    const dlqName = config.deadLetterQueue?.name ?? "lucent:ingestion:dlq";
    this.dlq = new Queue(dlqName, { connection: this.redis });
  }

  async enqueue(job: IngestionJob): Promise<void> {
    const parsed = IngestionJobSchema.parse(job);
    const jobId = `${parsed.tenantId}:${parsed.provider}:${parsed.providerSessionId}`;

    const priorityMap: Record<IngestionJob["priority"], number> = {
      critical: 1,
      high: 2,
      normal: 3,
      low: 4,
    };

    const maxRetries = this.config.queue.maxRetries ?? 5;
    const retryDelayMs = this.config.queue.retryDelayMs ?? 1000;

    const opts: JobsOptions = {
      jobId,
      priority: priorityMap[parsed.priority],
      attempts: maxRetries,
      backoff: { type: "exponential", delay: retryDelayMs },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    };

    await this.queue.add("ingest", parsed, opts);
  }

  async enqueueBatch(jobs: IngestionJob[]): Promise<void> {
    for (const j of jobs) {
      await this.enqueue(j);
    }
  }

  async start(): Promise<void> {
    if (this.worker) return;
    const concurrency = this.config.queue.concurrency ?? 5;

    this.worker = new Worker<IngestionJob, IngestionResult>(
      this.queue.name,
      async (job) => this.processJob(job),
      {
        connection: this.redis,
        concurrency,
        stalledInterval: this.config.queue.stalledInterval,
      }
    );

    this.worker.on("completed", () => {
      // no-op: metrics tracked in processJob
    });

    this.worker.on("failed", async (job, err) => {
      if (!job) return;
      this.totalFailed += 1;
      this.bumpTenant(job.data.tenantId, { failed: 1 });
      this.bumpProvider(job.data.provider, { failed: 1 });

      const maxRetries = this.config.queue.maxRetries ?? 5;
      if (job.attemptsMade >= maxRetries) {
        await this.moveToDLQ(job, err);
      }
    });
  }

  private bumpTenant(tenantId: string, delta: { processed?: number; failed?: number }): void {
    const cur = this.byTenant.get(tenantId) ?? { processed: 0, failed: 0 };
    this.byTenant.set(tenantId, {
      processed: cur.processed + (delta.processed ?? 0),
      failed: cur.failed + (delta.failed ?? 0),
    });
  }

  private bumpProvider(provider: string, delta: { processed?: number; failed?: number }): void {
    const cur = this.byProvider.get(provider) ?? { processed: 0, failed: 0 };
    this.byProvider.set(provider, {
      processed: cur.processed + (delta.processed ?? 0),
      failed: cur.failed + (delta.failed ?? 0),
    });
  }

  async processJob(job: Job<IngestionJob, IngestionResult>): Promise<IngestionResult> {
    const started = Date.now();
    const { tenantId, provider, providerSessionId } = job.data;

    try {
      await job.updateProgress(5);

      const tenantConfig = await this.tenantStore.getConfig(tenantId);
      if (!tenantConfig) {
        return {
          sessionId: NIL_UUID,
          tenantId,
          provider,
          eventsIngested: 0,
          durationMs: Date.now() - started,
          status: "failed",
          error: "Missing tenant config",
        };
      }

      await job.updateProgress(15);

      const connector = this.registry.getConnector(tenantId, tenantConfig);

      await job.updateProgress(30);

      const session = await connector.fetchSessionMetadata(providerSessionId);
      if (!session) {
        return {
          sessionId: NIL_UUID,
          tenantId,
          provider,
          eventsIngested: 0,
          durationMs: Date.now() - started,
          status: "failed",
          error: "Session not found",
        };
      }

      const stampedSession: Session = { ...session, tenantId };
      await this.sessionStore.saveSession(stampedSession);

      await job.updateProgress(55);

      const events = await connector.fetchSessionEvents(providerSessionId);
      const stampedEvents: SessionEvent[] = events.map((e) => ({
        ...e,
        tenantId,
        sessionId: stampedSession.id,
      }));

      await this.sessionStore.saveEvents(stampedEvents);

      await job.updateProgress(80);

      await this.sessionStore.markSessionStatus(stampedSession.id, "analyzing");

      await job.updateProgress(100);

      const elapsed = Date.now() - started;
      this.recordTiming(elapsed);
      this.totalProcessed += 1;
      this.bumpTenant(tenantId, { processed: 1 });
      this.bumpProvider(provider, { processed: 1 });

      return {
        sessionId: stampedSession.id,
        tenantId,
        provider,
        eventsIngested: stampedEvents.length,
        durationMs: elapsed,
        status: "success",
      };
    } catch (err: unknown) {
      const elapsed = Date.now() - started;
      this.recordTiming(elapsed);
      this.totalFailed += 1;
      this.bumpTenant(tenantId, { failed: 1 });
      this.bumpProvider(provider, { failed: 1 });

      const message = err instanceof Error ? err.message : "Unknown error";
      this.logger.error({ err, tenantId, provider, providerSessionId }, "Job failed");
      return {
        sessionId: NIL_UUID,
        tenantId,
        provider,
        eventsIngested: 0,
        durationMs: elapsed,
        status: "failed",
        error: message,
      };
    }
  }

  private recordTiming(ms: number): void {
    this.timings.push(ms);
    this.totalTimingMs += ms;
    if (this.timings.length > this.maxTimings) {
      const removed = this.timings.shift();
      if (typeof removed === "number") this.totalTimingMs -= removed;
    }
  }

  private async moveToDLQ(job: Job<IngestionJob, IngestionResult>, error: unknown): Promise<void> {
    if (!this.dlq) return;
    this.totalDeadLettered += 1;

    const payload: DeadLetterPayload = {
      original: job.data,
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp: new Date().toISOString(),
      attemptsMade: job.attemptsMade,
    };

    await this.dlq.add("dlq", payload, { removeOnComplete: true });
  }

  async getMetrics(): Promise<PipelineMetrics> {
    const counts = await this.queue.getJobCounts("active", "waiting");
    const avg =
      this.timings.length === 0 ? 0 : Math.round((this.totalTimingMs / this.timings.length) * 100) / 100;

    return {
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      totalDeadLettered: this.totalDeadLettered,
      activeJobs: counts.active ?? 0,
      waitingJobs: counts.waiting ?? 0,
      averageProcessingTimeMs: avg,
      byTenant: new Map(this.byTenant),
      byProvider: new Map(this.byProvider),
    };
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queueEvents.close();
    await this.queue.close();
    await this.dlq?.close();
    await this.redis.quit();
    this.worker = undefined;
  }

  async drain(): Promise<void> {
    await this.queue.drain(true);
    await this.dlq?.drain(true);
  }
}

