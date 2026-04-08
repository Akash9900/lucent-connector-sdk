# lucent-connector-sdk

Extensible session replay connector layer for Lucent — adds Microsoft Clarity support and a provider-agnostic ingestion pipeline.

## Architecture

```
Provider APIs          Connectors              Pipeline              Store
┌──────────┐     ┌──────────────────┐    ┌──────────────┐    ┌────────────┐
│ PostHog  │────▶│ PostHogConnector │───▶│              │    │            │
└──────────┘     └──────────────────┘    │   BullMQ     │───▶│  Your DB   │
┌──────────┐     ┌──────────────────┐    │   Ingestion  │    │ (implement │
│ Clarity  │────▶│ ClarityConnector │───▶│   Pipeline   │    │  SessionStore)│
└──────────┘     └──────────────────┘    │              │    │            │
┌──────────┐     ┌──────────────────┐    │  ┌────────┐  │    └────────────┘
│ Future   │────▶│  YourConnector   │───▶│  │  DLQ   │  │
│ Provider │     │  (extend base)   │    │  └────────┘  │
└──────────┘     └──────────────────┘    └──────────────┘
```

## Quick Start

```bash
git clone https://github.com/Akash9900/lucent-connector-sdk
cd lucent-connector-sdk
npm install
npm test          # run test suite (all tests pass, no Redis needed)
npm run demo      # see the full pipeline in action
npm run build     # compile TypeScript
docker compose up -d   # optional: Redis for production BullMQ pipeline
```

## See It Run

```bash
npm run demo
```

End-to-end simulation — no API keys or Redis. Shows tenant registration, mock session discovery, priority ingestion, retry/DLQ narrative, metrics, and runtime FullStory registration.

## Adding a New Provider

Implement `ReplayConnector` and register a factory in `ConnectorRegistry`. The connector surface is intentionally small: normalize sessions + events, expose a health check, and paginate.

```ts
import type { ConnectorConfig, FetchSessionsParams, PaginatedResult, Session, SessionEvent, HealthCheckResult } from "lucent-connector-sdk";
import { ReplayConnector, ConnectorRegistry } from "lucent-connector-sdk";

class MyConnector extends ReplayConnector {
  get providerName() { return "MyProvider"; }
  get providerId() { return "custom"; }
  async healthCheck(): Promise<HealthCheckResult> { return { healthy: true, provider: this.providerId, latencyMs: 0, checkedAt: new Date() }; }
  async fetchSessions(_p: FetchSessionsParams): Promise<PaginatedResult<Session>> { return { data: [], cursor: null, hasMore: false }; }
  async fetchSessionEvents(_id: string): Promise<SessionEvent[]> { return []; }
  async fetchSessionMetadata(_id: string): Promise<Session | null> { return null; }
}

const registry = new ConnectorRegistry();
registry.registerFactory("custom", (cfg: ConnectorConfig) => new MyConnector(cfg));
```

## Design Decisions

- **Zod**: runtime validation at tenant boundaries (configs/jobs), not just compile-time types.
- **Token-bucket rate limiting**: per-connector, prevents one tenant from burning another’s quota.
- **BullMQ**: Redis-backed, production-proven, priority queues, retries/backoff, and DLQ support.
- **Tenant-scoped connector instances**: credential isolation + independent rate limits + straightforward revocation.
- **`TenantConfigStore` / `SessionStore` interfaces**: this SDK doesn’t own persistence; Lucent plugs in its DB layer.

## What I’d Build Next

- FullStory and Amplitude connectors
- SOC 2 audit logging on every data access
- Webhook delivery for real-time Slack/Linear alerts
- Per-tenant cost tracking (API calls × provider pricing)
- Snapshot data compression for blob storage
- Horizontal scaling: partition queues by tenant for independent scaling

