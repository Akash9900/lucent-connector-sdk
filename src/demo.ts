/**
 * Lucent Connector SDK — interactive CLI demo (mock data, no Redis/API keys).
 */

import { v4 as uuidv4 } from "uuid";

import { ReplayConnector } from "./connectors/base";
import type {
  ConnectorConfig,
  FetchSessionsParams,
  HealthCheckResult,
  PaginatedResult,
  Session,
  SessionEvent,
} from "./types";
import { NIL_UUID } from "./types";
import { ConnectorConfigSchema } from "./types";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const rnd = (min: number, max: number) =>
  Math.floor(min + Math.random() * (max - min + 1));

type DemoSessionRow = {
  providerSessionId: string;
  durationMs: number;
  eventCount: number;
  errors: number;
  device: Session["deviceType"];
  hasErrors: boolean;
  hasRageClicks: boolean;
  hasDeadClicks: boolean;
};

const ACME_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const STARTUP_TENANT_ID = "22222222-2222-2222-2222-222222222222";

const POSTHOG_ROWS: DemoSessionRow[] = [
  {
    providerSessionId: "ph_sess_a1b2c3",
    durationMs: 4 * 60 * 1000 + 12 * 1000,
    eventCount: 127,
    errors: 2,
    device: "desktop",
    hasErrors: true,
    hasRageClicks: true,
    hasDeadClicks: false,
  },
  {
    providerSessionId: "ph_sess_d4e5f6",
    durationMs: 1 * 60 * 1000 + 48 * 1000,
    eventCount: 43,
    errors: 0,
    device: "mobile",
    hasErrors: false,
    hasRageClicks: false,
    hasDeadClicks: false,
  },
  {
    providerSessionId: "ph_sess_g7h8i9",
    durationMs: 8 * 60 * 1000 + 33 * 1000,
    eventCount: 284,
    errors: 5,
    device: "desktop",
    hasErrors: true,
    hasRageClicks: true,
    hasDeadClicks: false,
  },
  {
    providerSessionId: "ph_sess_j0k1l2",
    durationMs: 22 * 1000,
    eventCount: 8,
    errors: 0,
    device: "tablet",
    hasErrors: false,
    hasRageClicks: false,
    hasDeadClicks: false,
  },
  {
    providerSessionId: "ph_sess_m3n4o5",
    durationMs: 3 * 60 * 1000 + 7 * 1000,
    eventCount: 96,
    errors: 1,
    device: "mobile",
    hasErrors: true,
    hasRageClicks: false,
    hasDeadClicks: false,
  },
];

const CLARITY_ROWS: DemoSessionRow[] = [
  {
    providerSessionId: "cl_sess_x1y2z3",
    durationMs: 2 * 60 * 1000 + 55 * 1000,
    eventCount: 67,
    errors: 0,
    device: "desktop",
    hasErrors: false,
    hasRageClicks: false,
    hasDeadClicks: false,
  },
  {
    providerSessionId: "cl_sess_a4b5c6",
    durationMs: 6 * 60 * 1000 + 41 * 1000,
    eventCount: 198,
    errors: 3,
    device: "mobile",
    hasErrors: true,
    hasRageClicks: false,
    hasDeadClicks: true,
  },
  {
    providerSessionId: "cl_sess_d7e8f9",
    durationMs: 1 * 60 * 1000 + 15 * 1000,
    eventCount: 31,
    errors: 1,
    device: "desktop",
    hasErrors: true,
    hasRageClicks: false,
    hasDeadClicks: false,
  },
  {
    providerSessionId: "cl_sess_g0h1i2",
    durationMs: 4 * 60 * 1000 + 28 * 1000,
    eventCount: 142,
    errors: 0,
    device: "tablet",
    hasErrors: false,
    hasRageClicks: false,
    hasDeadClicks: false,
  },
];

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s)}s`.padStart(8, " ");
}

function rowToSession(row: DemoSessionRow, provider: "posthog" | "clarity"): Session {
  const started = new Date("2026-04-08T12:00:00.000Z");
  return {
    id: uuidv4(),
    tenantId: NIL_UUID,
    providerSessionId: row.providerSessionId,
    provider,
    startedAt: started,
    endedAt: new Date(started.getTime() + row.durationMs),
    durationMs: row.durationMs,
    deviceType: row.device,
    pageCount: 0,
    eventCount: row.eventCount,
    hasErrors: row.hasErrors,
    hasRageClicks: row.hasRageClicks,
    hasDeadClicks: row.hasDeadClicks,
    status: "pending",
    retryCount: 0,
  };
}

/** Mock connector: realistic delays, no network. */
class DemoMockConnector extends ReplayConnector {
  private readonly rows: DemoSessionRow[];
  private readonly pid: "posthog" | "clarity";

  constructor(config: ConnectorConfig, rows: DemoSessionRow[], pid: "posthog" | "clarity") {
    super(config);
    this.rows = rows;
    this.pid = pid;
  }

  get providerName(): string {
    return this.pid === "posthog" ? "PostHog" : "Microsoft Clarity";
  }

  get providerId(): string {
    return this.pid;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const t0 = Date.now();
    await sleep(rnd(38, 85));
    return {
      healthy: true,
      provider: this.pid,
      latencyMs: Date.now() - t0,
      checkedAt: new Date(),
    };
  }

  async fetchSessions(params: FetchSessionsParams): Promise<PaginatedResult<Session>> {
    void params;
    await sleep(rnd(50, 180));
    return {
      data: this.rows.map((r) => rowToSession(r, this.pid)),
      cursor: null,
      hasMore: false,
      total: this.rows.length,
    };
  }

  async fetchSessionEvents(providerSessionId: string): Promise<SessionEvent[]> {
    await sleep(rnd(40, 200));
    const row = this.rows.find((r) => r.providerSessionId === providerSessionId);
    const n = row?.eventCount ?? 0;
    const out: SessionEvent[] = [];
    const ts = new Date();
    for (let i = 0; i < n; i += 1) {
      out.push({
        id: `evt_${providerSessionId}_${i}`,
        sessionId: NIL_UUID,
        tenantId: NIL_UUID,
        type: "click",
        timestamp: new Date(ts.getTime() + i * 10),
        data: {},
      });
    }
    return out;
  }

  async fetchSessionMetadata(providerSessionId: string): Promise<Session | null> {
    await sleep(rnd(50, 220));
    const row = this.rows.find((r) => r.providerSessionId === providerSessionId);
    if (!row) return null;
    return rowToSession(row, this.pid);
  }
}

/** Minimal stub for extensibility demo. */
class FullStoryStubConnector extends ReplayConnector {
  get providerName(): string {
    return "FullStory";
  }

  get providerId(): string {
    return "fullstory";
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, provider: "fullstory", latencyMs: 0, checkedAt: new Date() };
  }

  async fetchSessions(params: FetchSessionsParams): Promise<PaginatedResult<Session>> {
    void params;
    return { data: [], cursor: null, hasMore: false };
  }

  async fetchSessionEvents(providerSessionId: string): Promise<SessionEvent[]> {
    void providerSessionId;
    return [];
  }

  async fetchSessionMetadata(providerSessionId: string): Promise<Session | null> {
    void providerSessionId;
    return null;
  }
}

type IngestionJob = {
  tenantId: string;
  tenantName: string;
  provider: "posthog" | "clarity";
  providerSessionId: string;
  priorityLabel: "high" | "normal";
};

type PipelineStats = {
  totalProcessed: number;
  totalFailed: number;
  totalDeadLettered: number;
  processingTimesMs: number[];
  byTenant: Map<string, { processed: number; failed: number }>;
  byProvider: Map<string, { processed: number; failed: number }>;
};

function bump(
  map: Map<string, { processed: number; failed: number }>,
  key: string,
  field: "processed" | "failed",
  delta: number
): void {
  const cur = map.get(key) ?? { processed: 0, failed: 0 };
  cur[field] += delta;
  map.set(key, cur);
}

function printBox(title: string, lines: string[], width = 49): void {
  const top = `┌${"─".repeat(width)}┐`;
  const bottom = `└${"─".repeat(width)}┘`;
  console.log(cyan(top));
  if (title.trim().length > 0) {
    const padded = title.length > width ? title.slice(0, width) : title.padEnd(width);
    console.log(cyan("│") + bold(` ${padded} `) + cyan("│"));
  }
  for (const line of lines) {
    const inner = line.length > width ? line.slice(0, width - 1) + "…" : line.padEnd(width);
    console.log(cyan("│") + ` ${inner} ` + cyan("│"));
  }
  console.log(cyan(bottom));
}

function printSessionTable(tenantLabel: string, rows: DemoSessionRow[]): void {
  console.log();
  console.log(dim(`${tenantLabel}:`));
  const wId = 16;
  const wDur = 12;
  const wEv = 8;
  const wErr = 6;
  const wDev = 9;
  const top =
    `┌${"─".repeat(wId)}┬${"─".repeat(wDur)}┬${"─".repeat(wEv)}┬${"─".repeat(wErr)}┬${"─".repeat(wDev)}┐`;
  const mid =
    `├${"─".repeat(wId)}┼${"─".repeat(wDur)}┼${"─".repeat(wEv)}┼${"─".repeat(wErr)}┼${"─".repeat(wDev)}┤`;
  const bot =
    `└${"─".repeat(wId)}┴${"─".repeat(wDur)}┴${"─".repeat(wEv)}┴${"─".repeat(wErr)}┴${"─".repeat(wDev)}┘`;
  console.log(top);
  console.log(
    `│ ${bold("Session ID".padEnd(wId - 2))} │ ${bold("Duration".padEnd(wDur - 2))} │ ${bold("Events".padEnd(wEv - 2))} │ ${bold("Errors".padEnd(wErr - 2))} │ ${bold("Device".padEnd(wDev - 2))} │`
  );
  console.log(mid);
  for (const r of rows) {
    const id = r.providerSessionId.padEnd(wId - 2);
    const dur = formatDuration(r.durationMs).trim().padEnd(wDur - 2);
    const ev = String(r.eventCount).padEnd(wEv - 2);
    const er = String(r.errors).padEnd(wErr - 2);
    const dev = r.device.padEnd(wDev - 2);
    console.log(`│ ${id} │ ${dur} │ ${ev} │ ${er} │ ${dev} │`);
  }
  console.log(bot);
}

async function main(): Promise<void> {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";
  const { ConnectorRegistry } = await import("./connectors/registry");

  console.clear();
  printBox(" Lucent Connector SDK — Live Demo ", [
    "",
    " Simulating multi-tenant session ingestion",
    "",
  ]);
  console.log();

  await sleep(rnd(300, 500));

  // Phase 1
  console.log(bold("▸ Registering connectors..."));
  const registry = new ConnectorRegistry();
  registry.registerFactory("posthog", (cfg) => new DemoMockConnector(cfg, POSTHOG_ROWS, "posthog"));
  registry.registerFactory("clarity", (cfg) => new DemoMockConnector(cfg, CLARITY_ROWS, "clarity"));
  console.log(`  ${green("✓")} PostHog connector registered`);
  console.log(`  ${green("✓")} Microsoft Clarity connector registered`);
  console.log(`  ${green("✓")} ${dim(`${registry.listProviders().length} providers available: ${registry.listProviders().join(", ")}`)}`);
  await sleep(rnd(300, 500));

  // Phase 2
  console.log();
  console.log(bold("▸ Onboarding tenants..."));
  const acmeCfg = ConnectorConfigSchema.parse({
    provider: "posthog",
    apiKey: "demo",
    projectId: "demo-acme",
  });
  const startupCfg = ConnectorConfigSchema.parse({
    provider: "clarity",
    apiKey: "demo",
    projectId: "demo-startup",
  });
  registry.getConnector(ACME_TENANT_ID, acmeCfg);
  registry.getConnector(STARTUP_TENANT_ID, startupCfg);
  console.log(`  ${green("✓")} Tenant ${cyan("\"Acme Corp\"")} (PostHog) → connector created`);
  console.log(`  ${green("✓")} Tenant ${cyan("\"Startup Inc\"")} (Clarity) → connector created`);
  console.log(`  ${green("✓")} ${dim(`${registry.listActiveConnectors().length} active connectors`)}`);
  await sleep(rnd(300, 500));

  // Phase 3
  console.log();
  console.log(bold("▸ Running health checks..."));
  const acmeConn = registry.getConnector(ACME_TENANT_ID, acmeCfg);
  const startupConn = registry.getConnector(STARTUP_TENANT_ID, startupCfg);
  const h1 = await acmeConn.healthCheck();
  const h2 = await startupConn.healthCheck();
  console.log(
    `  ${green("✓")} Acme Corp (PostHog): ${green("healthy")} (${h1.latencyMs}ms)`
  );
  console.log(
    `  ${green("✓")} Startup Inc (Clarity): ${green("healthy")} (${h2.latencyMs}ms)`
  );
  await sleep(rnd(300, 500));

  // Phase 4
  console.log();
  console.log(bold("▸ Discovering sessions..."));
  printSessionTable("Acme Corp (PostHog)", POSTHOG_ROWS);
  const phErr = POSTHOG_ROWS.filter((r) => r.hasErrors).length;
  const phRage = POSTHOG_ROWS.filter((r) => r.hasRageClicks).length;
  console.log(
    `  ${dim("→")} ${POSTHOG_ROWS.length} sessions found (${phErr} with errors, ${phRage} rage clicks detected)`
  );
  printSessionTable("Startup Inc (Clarity)", CLARITY_ROWS);
  const clErr = CLARITY_ROWS.filter((r) => r.hasErrors).length;
  const clDead = CLARITY_ROWS.filter((r) => r.hasDeadClicks).length;
  console.log(
    `  ${dim("→")} ${CLARITY_ROWS.length} sessions found (${clErr} with errors, ${clDead} dead click detected)`
  );
  await sleep(rnd(300, 500));

  // Phase 5 — in-memory queue (order per spec)
  const jobs: IngestionJob[] = [
    { tenantId: ACME_TENANT_ID, tenantName: "Acme Corp", provider: "posthog", providerSessionId: "ph_sess_a1b2c3", priorityLabel: "high" },
    { tenantId: ACME_TENANT_ID, tenantName: "Acme Corp", provider: "posthog", providerSessionId: "ph_sess_g7h8i9", priorityLabel: "high" },
    { tenantId: STARTUP_TENANT_ID, tenantName: "Startup Inc", provider: "clarity", providerSessionId: "cl_sess_a4b5c6", priorityLabel: "high" },
    { tenantId: ACME_TENANT_ID, tenantName: "Acme Corp", provider: "posthog", providerSessionId: "ph_sess_m3n4o5", priorityLabel: "high" },
    { tenantId: STARTUP_TENANT_ID, tenantName: "Startup Inc", provider: "clarity", providerSessionId: "cl_sess_d7e8f9", priorityLabel: "high" },
    { tenantId: ACME_TENANT_ID, tenantName: "Acme Corp", provider: "posthog", providerSessionId: "ph_sess_d4e5f6", priorityLabel: "normal" },
    { tenantId: STARTUP_TENANT_ID, tenantName: "Startup Inc", provider: "clarity", providerSessionId: "cl_sess_g0h1i2", priorityLabel: "normal" },
    { tenantId: ACME_TENANT_ID, tenantName: "Acme Corp", provider: "posthog", providerSessionId: "ph_sess_j0k1l2", priorityLabel: "normal" },
    { tenantId: STARTUP_TENANT_ID, tenantName: "Startup Inc", provider: "clarity", providerSessionId: "cl_sess_x1y2z3", priorityLabel: "normal" },
  ];

  const processSpec: Array<{ events: number; ms: number }> = [
    { events: 127, ms: 234 },
    { events: 284, ms: 412 },
    { events: 198, ms: 367 },
    { events: 96, ms: 178 },
    { events: 31, ms: 89 },
    { events: 43, ms: 112 },
    { events: 142, ms: 298 },
    { events: 8, ms: 45 },
    { events: 67, ms: 134 },
  ];

  console.log();
  console.log(bold("▸ Enqueueing sessions for ingestion..."));
  const phHigh = jobs.filter((j) => j.provider === "posthog" && j.priorityLabel === "high").length;
  const phNorm = jobs.filter((j) => j.provider === "posthog" && j.priorityLabel === "normal").length;
  const clHigh = jobs.filter((j) => j.provider === "clarity" && j.priorityLabel === "high").length;
  const clNorm = jobs.filter((j) => j.provider === "clarity" && j.priorityLabel === "normal").length;
  console.log(
    `  ${green("✓")} Queued ${POSTHOG_ROWS.length} PostHog sessions (${phHigh} high priority, ${phNorm} normal)`
  );
  console.log(
    `  ${green("✓")} Queued ${CLARITY_ROWS.length} Clarity sessions (${clHigh} high priority, ${clNorm} normal)`
  );
  await sleep(rnd(300, 450));

  console.log();
  console.log(bold("▸ Processing ingestion queue..."));
  const stats: PipelineStats = {
    totalProcessed: 0,
    totalFailed: 0,
    totalDeadLettered: 0,
    processingTimesMs: [],
    byTenant: new Map(),
    byProvider: new Map(),
  };

  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i]!;
    const spec = processSpec[i]!;
    const cfg =
      job.provider === "posthog"
        ? acmeCfg
        : startupCfg;
    const connector = registry.getConnector(job.tenantId, cfg);
    process.stdout.write(
      `  [${i + 1}/${jobs.length}] ${job.providerSessionId} (${job.tenantName}) → ingesting... `
    );
    await sleep(rnd(80, 220));
    await connector.fetchSessionMetadata(job.providerSessionId);
    await connector.fetchSessionEvents(job.providerSessionId);
    stats.totalProcessed += 1;
    stats.processingTimesMs.push(spec.ms);
    bump(stats.byTenant, job.tenantName, "processed", 1);
    bump(stats.byProvider, job.provider, "processed", 1);
    console.log(
      `${green("✓")} ${spec.events} events ${dim(`(${spec.ms}ms)`)}`
    );
    await sleep(rnd(120, 280));
  }

  await sleep(rnd(300, 450));

  // Phase 6 — failure + DLQ (simulated)
  console.log();
  console.log(bold("▸ Simulating failure scenario..."));
  const maxAttempts = 3;
  for (let a = 1; a <= maxAttempts; a += 1) {
    console.log(
      `  ${red("✗")} ph_sess_ERROR1 (Acme Corp) → API timeout (attempt ${a}/${maxAttempts})`
    );
    await sleep(rnd(280, 450));
  }
  console.log(`  ${yellow("→")} Moved to dead letter queue after ${maxAttempts} failed attempts`);
  stats.totalFailed += 1;
  stats.totalDeadLettered += 1;
  bump(stats.byTenant, "Acme Corp", "failed", 1);
  bump(stats.byProvider, "posthog", "failed", 1);
  await sleep(rnd(300, 450));

  // Phase 7 — metrics
  const totalSpecMs = processSpec.reduce((a, x) => a + x.ms, 0);
  const avgMs =
    stats.processingTimesMs.length === 0
      ? 0
      : Math.floor(totalSpecMs / stats.processingTimesMs.length);

  console.log();
  console.log(bold("▸ Pipeline Metrics"));
  const mw = 47;
  console.log(`  ┌${"─".repeat(mw)}┐`);
  console.log(`  │ ${bold("Total processed:")}    ${String(stats.totalProcessed).padStart(3)}`.padEnd(mw + 12) + ` │`);
  console.log(`  │ ${bold("Total failed:")}       ${String(stats.totalFailed).padStart(3)}`.padEnd(mw + 12) + ` │`);
  console.log(`  │ ${bold("Dead lettered:")}      ${String(stats.totalDeadLettered).padStart(3)}`.padEnd(mw + 12) + ` │`);
  console.log(`  │ ${bold("Avg processing:")}     ${String(avgMs).padStart(3)}ms`.padEnd(mw + 12) + ` │`);
  console.log(`  ├${"─".repeat(mw)}┤`);
  console.log(`  │ ${bold("By Tenant:")}`.padEnd(mw + 2) + ` │`);
  const acmeP = stats.byTenant.get("Acme Corp")?.processed ?? 0;
  const acmeF = stats.byTenant.get("Acme Corp")?.failed ?? 0;
  const suP = stats.byTenant.get("Startup Inc")?.processed ?? 0;
  const suF = stats.byTenant.get("Startup Inc")?.failed ?? 0;
  console.log(
    `  │   Acme Corp:     ${acmeP} processed, ${acmeF} failed`.padEnd(mw + 6) + ` │`
  );
  console.log(
    `  │   Startup Inc:   ${suP} processed, ${suF} failed`.padEnd(mw + 6) + ` │`
  );
  console.log(`  ├${"─".repeat(mw)}┤`);
  console.log(`  │ ${bold("By Provider:")}`.padEnd(mw + 2) + ` │`);
  const phP = stats.byProvider.get("posthog")?.processed ?? 0;
  const phF = stats.byProvider.get("posthog")?.failed ?? 0;
  const clP = stats.byProvider.get("clarity")?.processed ?? 0;
  const clF = stats.byProvider.get("clarity")?.failed ?? 0;
  console.log(
    `  │   PostHog:       ${phP} processed, ${phF} failed`.padEnd(mw + 6) + ` │`
  );
  console.log(
    `  │   Clarity:       ${clP} processed, ${clF} failed`.padEnd(mw + 6) + ` │`
  );
  console.log(`  └${"─".repeat(mw)}┘`);

  await sleep(rnd(300, 450));

  // Phase 8
  console.log();
  console.log(bold("▸ Demonstrating extensibility..."));
  console.log(`  ${dim("→")} Registering custom "FullStory" connector at runtime...`);
  registry.registerFactory("fullstory", (cfg) => new FullStoryStubConnector(cfg));
  console.log(`  ${green("✓")} FullStory connector registered`);
  const provs = registry.listProviders();
  console.log(
    `  ${green("✓")} ${provs.length} providers now available: ${provs.join(", ")}`
  );
  console.log();
  console.log(dim("  This took 0 new infrastructure changes."));
  console.log(dim("  Just extend ReplayConnector and register it."));
  await sleep(rnd(300, 450));

  // Final summary
  console.log();
  printBox("", [
    "",
    `  ${green("✓")} 2 providers (PostHog + Clarity) processing sessions`,
    `  ${green("✓")} Multi-tenant isolation (each tenant has own connector)`,
    `  ${green("✓")} Priority queue with deduplication`,
    `  ${green("✓")} Automatic retries with exponential backoff`,
    `  ${green("✓")} Dead letter queue for permanent failures`,
    `  ${green("✓")} Per-tenant and per-provider metrics`,
    `  ${green("✓")} New providers added at runtime with zero infra changes`,
    "",
    `  ${bold("Ready to process millions of sessions.")}`,
    "",
  ], 61);

  console.log(dim("\nDone.\n"));
}

main().catch((e) => {
  console.error(red(String(e)));
  process.exitCode = 1;
});
