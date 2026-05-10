// src/providers/types.ts
import type { ConnectionOptions, SASLOptions } from "@platformatic/kafka";

export type MskAuthMode = "iam" | "tls" | "none";

export interface KafkaConnectionConfig {
	clientId: string;
	bootstrapBrokers: string[];
	sasl?: SASLOptions;
	tls?: ConnectionOptions["tls"];
	connectTimeout?: number;
	timeout?: number;
	retries?: number | boolean;
	retryDelay?: number;
}

export interface KafkaProvider {
	readonly type: "msk" | "confluent" | "local";
	readonly name: string;
	getConnectionConfig(): Promise<KafkaConnectionConfig>;
	getClusterMetadata?(): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}
