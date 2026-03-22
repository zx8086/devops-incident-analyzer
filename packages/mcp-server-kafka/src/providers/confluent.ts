// src/providers/confluent.ts

import { ConfluentRestClient } from "./confluent-rest.ts";
import type { KafkaConnectionConfig, KafkaProvider } from "./types.ts";

export class ConfluentKafkaProvider implements KafkaProvider {
	readonly type = "confluent" as const;
	readonly name = "Confluent Cloud";
	private restClient: ConfluentRestClient | null = null;

	constructor(
		private readonly bootstrapServers: string,
		private readonly apiKey: string,
		private readonly apiSecret: string,
		private readonly clientId: string,
		private readonly restEndpoint?: string,
		private readonly clusterId?: string,
	) {
		if (this.restEndpoint && this.clusterId) {
			this.restClient = new ConfluentRestClient(this.restEndpoint, this.apiKey, this.apiSecret);
		}
	}

	async getConnectionConfig(): Promise<KafkaConnectionConfig> {
		return {
			clientId: this.clientId,
			bootstrapBrokers: this.bootstrapServers.split(",").map((s) => s.trim()),
			sasl: {
				mechanism: "PLAIN",
				username: this.apiKey,
				password: this.apiSecret,
			},
			tls: { rejectUnauthorized: true },
		};
	}

	async getClusterMetadata(): Promise<Record<string, unknown>> {
		if (!this.restClient || !this.clusterId) {
			return { provider: "confluent", note: "REST API not configured" };
		}

		try {
			return await this.restClient.getClusterInfo(this.clusterId);
		} catch (error) {
			// Enrichment is additive, not required
			return {
				provider: "confluent",
				restApiError: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async close(): Promise<void> {
		this.restClient = null;
	}
}
