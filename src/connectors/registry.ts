import type { ConnectorConfig, HealthCheckResult } from "../types";
import { createLogger } from "../utils/logger";
import { ClarityConnector } from "./clarity";
import { PostHogConnector } from "./posthog";
import { ReplayConnector } from "./base";

export class ConnectorRegistry {
  private readonly logger = createLogger("connector-registry");

  private readonly factories = new Map<string, (config: ConnectorConfig) => ReplayConnector>();
  private readonly instances = new Map<string, ReplayConnector>();

  constructor() {
    this.registerFactory("posthog", (config) => new PostHogConnector(config));
    this.registerFactory("clarity", (config) => new ClarityConnector(config));
  }

  registerFactory(providerId: string, factory: (config: ConnectorConfig) => ReplayConnector): void {
    if (this.factories.has(providerId)) {
      this.logger.warn({ providerId }, "Overwriting existing connector factory");
    }
    this.factories.set(providerId, factory);
  }

  getConnector(tenantId: string, config: ConnectorConfig): ReplayConnector {
    const key = `${tenantId}:${config.provider}`;
    const existing = this.instances.get(key);
    if (existing) return existing;

    const factory = this.factories.get(config.provider);
    if (!factory) {
      throw new Error(
        `No connector factory registered for provider "${config.provider}". Known providers: ${this.listProviders().join(
          ", "
        )}`
      );
    }

    const instance = factory(config);
    this.instances.set(key, instance);
    return instance;
  }

  removeConnector(tenantId: string, provider: string): boolean {
    return this.instances.delete(`${tenantId}:${provider}`);
  }

  async healthCheckAll(): Promise<Map<string, HealthCheckResult>> {
    const entries = Array.from(this.instances.entries());
    const settled = await Promise.allSettled(entries.map(([, c]) => c.healthCheck()));

    const out = new Map<string, HealthCheckResult>();
    settled.forEach((res, idx) => {
      const key = entries[idx]?.[0] ?? `unknown:${idx}`;
      if (res.status === "fulfilled") {
        out.set(key, res.value);
      } else {
        out.set(key, {
          healthy: false,
          provider: entries[idx]?.[1]?.providerId ?? "unknown",
          latencyMs: 0,
          details: { error: res.reason },
          checkedAt: new Date(),
        });
      }
    });
    return out;
  }

  listProviders(): string[] {
    return Array.from(this.factories.keys()).sort();
  }

  listActiveConnectors(): string[] {
    return Array.from(this.instances.keys()).sort();
  }

  clear(): void {
    this.instances.clear();
  }
}

