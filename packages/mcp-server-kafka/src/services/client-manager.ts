// src/services/client-manager.ts
import { Admin, Consumer, Producer } from "@platformatic/kafka";
import type { KafkaConnectionConfig, KafkaProvider } from "../providers/types.ts";

type KafkaClientOptions = ConstructorParameters<typeof Admin>[0];

// Build options object omitting undefined values so @platformatic/kafka
// uses its own defaults (passing explicit undefined overrides them to broken values).
function buildClientOptions(config: KafkaConnectionConfig): KafkaClientOptions {
  const opts: KafkaClientOptions = {
    clientId: config.clientId,
    bootstrapBrokers: config.bootstrapBrokers,
  };
  if (config.sasl) opts.sasl = config.sasl;
  if (config.tls) opts.tls = config.tls;
  if (config.connectTimeout !== undefined) opts.connectTimeout = config.connectTimeout;
  if (config.requestTimeout !== undefined) opts.requestTimeout = config.requestTimeout;
  if (config.retries !== undefined) opts.retries = config.retries;
  if (config.retryDelay !== undefined) opts.retryDelay = config.retryDelay;
  return opts;
}

export class KafkaClientManager {
  private producer: Producer | null = null;
  private cachedConfig: KafkaConnectionConfig | null = null;

  constructor(private readonly provider: KafkaProvider) {}

  async withAdmin<T>(fn: (admin: Admin) => Promise<T>): Promise<T> {
    const config = await this.getConnectionConfig();
    const admin = new Admin(buildClientOptions(config));
    const result = await fn(admin);
    admin.close().catch(() => {});
    return result;
  }

  async getProducer(): Promise<Producer> {
    if (this.producer && !this.producer.closed) {
      return this.producer;
    }
    const config = await this.getConnectionConfig();
    this.producer = new Producer(buildClientOptions(config));
    return this.producer;
  }

  async createConsumer(groupId: string): Promise<Consumer> {
    const config = await this.getConnectionConfig();
    return new Consumer({ ...buildClientOptions(config), groupId });
  }

  getProvider(): KafkaProvider {
    return this.provider;
  }

  async close(): Promise<void> {
    if (this.producer && !this.producer.closed) {
      await this.producer.close().catch(() => {});
    }

    await this.provider.close();

    this.producer = null;
    this.cachedConfig = null;
  }

  private async getConnectionConfig(): Promise<KafkaConnectionConfig> {
    if (!this.cachedConfig) {
      this.cachedConfig = await this.provider.getConnectionConfig();
    }
    return this.cachedConfig;
  }
}
