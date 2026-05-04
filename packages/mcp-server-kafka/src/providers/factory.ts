// src/providers/factory.ts
import type { AppConfig } from "../config/schemas.ts";
import { logger } from "../utils/logger.ts";
import { ConfluentKafkaProvider } from "./confluent.ts";
import { KafkaProviderError } from "./errors.ts";
import { LocalKafkaProvider } from "./local.ts";
import { MskKafkaProvider } from "./msk.ts";
import type { KafkaProvider } from "./types.ts";

export function createProvider(config: AppConfig): KafkaProvider {
	const { kafka } = config;
	const summary = providerSummary(config);
	logger.info(summary, "Creating Kafka provider");

	if (kafka.provider === "msk" && !process.env.MSK_AUTH_MODE) {
		logger.warn(
			{ resolvedAuthMode: config.msk.authMode },
			"MSK_AUTH_MODE is unset; defaulting to 'none' (PLAINTEXT, unauthenticated). " +
				"If your MSK cluster requires IAM auth, set MSK_AUTH_MODE=iam (or =tls for TLS-only).",
		);
	}

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
				config.msk.authMode,
			);

		default:
			throw new KafkaProviderError(`Unknown provider: ${kafka.provider}`, "PROVIDER_NOT_FOUND", kafka.provider);
	}
}

// Surface the resolved auth mode at info level so the connection posture is never
// ambiguous from the logs -- especially important now that MSK defaults to PLAINTEXT.
function providerSummary(config: AppConfig): Record<string, unknown> {
	const { kafka } = config;
	if (kafka.provider === "msk") {
		return {
			provider: "msk",
			authMode: config.msk.authMode,
			region: config.msk.region,
			bootstrapSource: config.msk.bootstrapBrokers ? "env" : "discovery",
		};
	}
	if (kafka.provider === "confluent") {
		return { provider: "confluent", bootstrapServers: config.confluent.bootstrapServers };
	}
	return { provider: "local", bootstrapServers: config.local.bootstrapServers };
}
