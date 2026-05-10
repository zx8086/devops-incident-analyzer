// src/services/client-manager.ts
import { Admin, Consumer, Producer } from "@platformatic/kafka";
import type { KafkaConnectionConfig, KafkaProvider } from "../providers/types.ts";
import { logger } from "../utils/logger.ts";

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
	// SIO-710: library option is `timeout` (per-RPC). Library default is 5s; we lift
	// to 30s via KAFKA_TOOL_TIMEOUT_MS so sleepy MSK clusters don't trip on first call.
	if (config.timeout !== undefined) opts.timeout = config.timeout;
	if (config.retries !== undefined) opts.retries = config.retries;
	if (config.retryDelay !== undefined) opts.retryDelay = config.retryDelay;
	return opts;
}

export class KafkaClientManager {
	private producer: Producer | null = null;
	private admin: Admin | null = null;
	// SIO-710: thundering-herd guard so concurrent withAdmin callers share one ctor.
	private adminInitPromise: Promise<Admin> | null = null;
	private cachedConfig: KafkaConnectionConfig | null = null;

	constructor(
		private readonly provider: KafkaProvider,
		private readonly toolTimeoutMs: number = 30_000,
	) {}

	async withAdmin<T>(fn: (admin: Admin) => Promise<T>): Promise<T> {
		const admin = await this.getAdmin();
		return fn(admin);
	}

	async getProducer(): Promise<Producer> {
		if (this.producer && !this.producer.closed) {
			logger.debug("Reusing existing producer");
			return this.producer;
		}
		logger.info("Creating new Kafka producer");
		const config = await this.getConnectionConfig();
		this.producer = new Producer(buildClientOptions(config));
		return this.producer;
	}

	async createConsumer(groupId: string): Promise<Consumer> {
		logger.info({ groupId }, "Creating Kafka consumer");
		const config = await this.getConnectionConfig();
		return new Consumer({ ...buildClientOptions(config), groupId });
	}

	getProvider(): KafkaProvider {
		return this.provider;
	}

	async close(): Promise<void> {
		logger.info("Closing Kafka client manager");
		if (this.admin && !this.admin.closed) {
			await this.admin.close().catch(() => {});
		}
		if (this.producer && !this.producer.closed) {
			await this.producer.close().catch(() => {});
		}

		await this.provider.close();

		this.admin = null;
		this.producer = null;
		this.cachedConfig = null;
		logger.info("Kafka client manager closed");
	}

	// SIO-710: shared Admin per process. Mirrors getProducer() cache pattern.
	// Each Admin owns its own ConnectionPool (see @platformatic/kafka Base.kConnections);
	// constructing one per tool call thrashed broker connections and caused MSK timeouts.
	private async getAdmin(): Promise<Admin> {
		if (this.admin && !this.admin.closed) {
			logger.debug("Reusing existing admin");
			return this.admin;
		}
		if (this.adminInitPromise) {
			return this.adminInitPromise;
		}
		this.adminInitPromise = (async () => {
			logger.info("Creating new Kafka admin client");
			const config = await this.getConnectionConfig();
			const admin = new Admin(buildClientOptions(config));
			this.admin = admin;
			return admin;
		})();
		try {
			return await this.adminInitPromise;
		} finally {
			this.adminInitPromise = null;
		}
	}

	private async getConnectionConfig(): Promise<KafkaConnectionConfig> {
		if (!this.cachedConfig) {
			const providerConfig = await this.provider.getConnectionConfig();
			// Provider-supplied timeout wins (e.g. MSK overrides for cold-start latency);
			// otherwise apply the manager-level default from KAFKA_TOOL_TIMEOUT_MS.
			this.cachedConfig = {
				...providerConfig,
				timeout: providerConfig.timeout ?? this.toolTimeoutMs,
			};
		}
		return this.cachedConfig;
	}
}
