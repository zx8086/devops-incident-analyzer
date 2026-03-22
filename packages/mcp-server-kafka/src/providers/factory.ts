// src/providers/factory.ts
import type { AppConfig } from "../config/schemas.ts";
import { ConfluentKafkaProvider } from "./confluent.ts";
import { KafkaProviderError } from "./errors.ts";
import { LocalKafkaProvider } from "./local.ts";
import { MskKafkaProvider } from "./msk.ts";
import type { KafkaProvider } from "./types.ts";

export function createProvider(config: AppConfig): KafkaProvider {
	const { kafka } = config;

	switch (kafka.provider) {
		case "local":
			return new LocalKafkaProvider(config.local.bootstrapServers, kafka.clientId);

		case "confluent":
			return new ConfluentKafkaProvider(
				config.confluent.bootstrapServers,
				config.confluent.apiKey,
				config.confluent.apiSecret,
				kafka.clientId,
				config.confluent.restEndpoint || undefined,
				config.confluent.clusterId || undefined,
			);

		case "msk":
			return new MskKafkaProvider(
				config.msk.bootstrapBrokers,
				config.msk.clusterArn,
				config.msk.region,
				kafka.clientId,
			);

		default:
			throw new KafkaProviderError(`Unknown provider: ${kafka.provider}`, "PROVIDER_NOT_FOUND", kafka.provider);
	}
}
