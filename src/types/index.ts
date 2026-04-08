import { z } from "zod";

export const ProviderIdSchema = z.enum([
  "posthog",
  "clarity",
  "fullstory",
  "amplitude",
  "custom",
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

const UuidSchema = z.string().uuid();
export const NIL_UUID = "00000000-0000-0000-0000-000000000000" as const;

export const TenantSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1),
  provider: ProviderIdSchema,
  config: z.record(z.unknown()),
  createdAt: z.coerce.date(),
  isActive: z.boolean().default(true),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const DeviceTypeSchema = z.enum(["desktop", "mobile", "tablet", "unknown"]);
export type DeviceType = z.infer<typeof DeviceTypeSchema>;

export const SessionStatusSchema = z.enum([
  "pending",
  "ingesting",
  "analyzing",
  "complete",
  "failed",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  providerSessionId: z.string().min(1),
  provider: ProviderIdSchema,

  userId: z.string().min(1).optional(),
  anonymousId: z.string().min(1).optional(),

  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().optional(),
  durationMs: z.number().int().nonnegative().optional(),

  deviceType: DeviceTypeSchema.default("unknown"),
  browser: z.string().optional(),
  os: z.string().optional(),
  country: z.string().optional(),
  screenResolution: z.string().optional(),

  pageCount: z.number().int().nonnegative().default(0),
  eventCount: z.number().int().nonnegative().default(0),

  hasErrors: z.boolean().default(false),
  hasRageClicks: z.boolean().default(false),
  hasDeadClicks: z.boolean().default(false),

  status: SessionStatusSchema.default("pending"),
  ingestedAt: z.coerce.date().optional(),
  analyzedAt: z.coerce.date().optional(),
  failureReason: z.string().optional(),
  retryCount: z.number().int().nonnegative().default(0),
});
export type Session = z.infer<typeof SessionSchema>;

export const SessionEventTypeSchema = z.enum([
  "click",
  "input",
  "scroll",
  "navigation",
  "network_request",
  "console_log",
  "console_error",
  "console_warn",
  "rage_click",
  "dead_click",
  "custom",
  "error",
  "page_view",
  "dom_mutation",
]);
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;

export const SessionEventSchema = z.object({
  id: z.string().min(1),
  sessionId: UuidSchema,
  tenantId: UuidSchema,
  type: SessionEventTypeSchema,
  timestamp: z.coerce.date(),
  data: z.object({
    url: z.string().optional(),
    selector: z.string().optional(),
    text: z.string().optional(),
    statusCode: z.number().int().optional(),
    errorMessage: z.string().optional(),
    coordinates: z
      .object({
        x: z.number(),
        y: z.number(),
      })
      .optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export const ConnectorConfigSchema = z.object({
  provider: ProviderIdSchema,
  apiKey: z.string().min(1),
  apiUrl: z.string().url().optional(),
  projectId: z.string().min(1).optional(),
  maxRequestsPerMinute: z.number().int().positive().default(60),
  maxConcurrentRequests: z.number().int().positive().default(5),
  defaultPageSize: z.number().int().positive().default(100),
  maxPageSize: z.number().int().positive().default(1000),
  maxRetries: z.number().int().nonnegative().default(3),
  retryDelayMs: z.number().int().nonnegative().default(1000),
  retryBackoffMultiplier: z.number().positive().default(2),
  options: z.record(z.unknown()).optional(),
});
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;

export const IngestionJobSchema = z.object({
  tenantId: UuidSchema,
  provider: ProviderIdSchema,
  providerSessionId: z.string().min(1),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  metadata: z.record(z.unknown()).optional(),
});
export type IngestionJob = z.infer<typeof IngestionJobSchema>;

export interface FetchSessionsParams {
  after?: Date;
  before?: Date;
  limit?: number;
  cursor?: string;
  userId?: string;
  hasErrors?: boolean;
  minDurationMs?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  cursor: string | null;
  hasMore: boolean;
  total?: number;
}

export interface HealthCheckResult {
  healthy: boolean;
  provider: string;
  latencyMs: number;
  details?: Record<string, unknown>;
  checkedAt: Date;
}

export interface AnalysisResult {
  sessionId: string;
  tenantId: string;
  bugs: Array<{
    type: string;
    severity: string;
    description: string;
    eventId: string;
    timestamp: Date;
  }>;
  uxIssues: Array<{
    type: string;
    severity: string;
    description: string;
    affectedFlow: string;
  }>;
  summary: string;
  processedAt: Date;
}

