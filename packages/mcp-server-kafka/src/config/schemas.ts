// src/config/schemas.ts

import { z } from "zod";

export const kafkaSchema = z
	.object({
		provider: z.enum(["local", "msk", "confluent"]).describe("Kafka provider type"),
		clientId: z.string().describe("Kafka client identifier"),
		allowWrites: z.boolean().describe("Whether write operations (produce, create topic) are permitted"),
		allowDestructive: z.boolean().describe("Whether destructive operations (delete topic) are permitted"),
		consumeMaxMessages: z.number().int().positive().describe("Maximum number of messages to consume per request"),
		consumeTimeoutMs: z.number().int().positive().describe("Consume timeout in milliseconds"),
	})
	.strict();

export const mskSchema = z
	.object({
		bootstrapBrokers: z.string().describe("Comma-separated MSK bootstrap broker endpoints"),
		clusterArn: z.string().describe("MSK cluster ARN for IAM authentication"),
		region: z.string().describe("AWS region for MSK cluster"),
	})
	.strict();

export const confluentSchema = z
	.object({
		bootstrapServers: z.string().describe("Confluent Cloud bootstrap server endpoints"),
		apiKey: z.string().describe("Confluent Cloud API key"),
		apiSecret: z.string().describe("Confluent Cloud API secret"),
		restEndpoint: z.string().describe("Confluent Cloud REST API endpoint"),
		clusterId: z.string().describe("Confluent Cloud cluster identifier"),
	})
	.strict();

export const localSchema = z
	.object({
		bootstrapServers: z.string().describe("Local Kafka bootstrap server endpoints"),
	})
	.strict();

export const schemaRegistrySchema = z
	.object({
		enabled: z.boolean().describe("Whether Schema Registry integration is enabled"),
		url: z.string().describe("Schema Registry URL"),
		apiKey: z.string().describe("Schema Registry API key (for Confluent Cloud or basic auth)"),
		apiSecret: z.string().describe("Schema Registry API secret (for Confluent Cloud or basic auth)"),
	})
	.strict();

export const ksqlSchema = z
	.object({
		enabled: z.boolean().describe("Whether ksqlDB integration is enabled"),
		endpoint: z.string().describe("ksqlDB REST API endpoint"),
		apiKey: z.string().describe("ksqlDB API key (for Confluent Cloud or basic auth)"),
		apiSecret: z.string().describe("ksqlDB API secret (for Confluent Cloud or basic auth)"),
	})
	.strict();

export const loggingSchema = z
	.object({
		level: z.enum(["silent", "debug", "info", "warn", "error"]).describe("Log verbosity level"),
		backend: z.enum(["pino"]).describe("Logging backend to use"),
	})
	.strict();

export const telemetrySchema = z
	.object({
		enabled: z.boolean().describe("Whether OpenTelemetry tracing is enabled"),
		serviceName: z.string().describe("Service name reported in telemetry spans"),
		mode: z.enum(["console", "otlp", "both"]).describe("Telemetry export mode"),
		otlpEndpoint: z.string().url().describe("OTLP HTTP exporter endpoint"),
	})
	.strict();

export const transportSchema = z
	.object({
		mode: z.enum(["stdio", "http", "both"]).describe("Transport mode"),
		port: z.number().int().min(1024).max(65535).describe("HTTP server port"),
		host: z.string().describe("HTTP server bind address"),
		path: z.string().startsWith("/").describe("MCP endpoint path"),
		sessionMode: z.enum(["stateless", "stateful"]).describe("HTTP session mode"),
		apiKey: z.string().describe("Optional API key for Bearer token auth"),
		allowedOrigins: z.string().describe("Comma-separated allowed origins"),
		idleTimeout: z.number().int().min(10).max(255).describe("Bun.serve() idle timeout in seconds"),
	})
	.strict();

export const configSchema = z
	.object({
		kafka: kafkaSchema,
		msk: mskSchema,
		confluent: confluentSchema,
		local: localSchema,
		schemaRegistry: schemaRegistrySchema,
		ksql: ksqlSchema,
		logging: loggingSchema,
		telemetry: telemetrySchema,
		transport: transportSchema,
	})
	.superRefine((config, ctx) => {
		if (config.kafka.provider === "msk") {
			const hasBrokers = config.msk.bootstrapBrokers.length > 0;
			const hasArn = config.msk.clusterArn.length > 0;
			if (!hasBrokers && !hasArn) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["msk"],
					message: "MSK provider requires msk.bootstrapBrokers or msk.clusterArn to be set",
				});
			}
		}

		if (config.kafka.provider === "confluent") {
			if (config.confluent.bootstrapServers.length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["confluent", "bootstrapServers"],
					message: "Confluent provider requires confluent.bootstrapServers to be set",
				});
			}
			if (config.confluent.apiKey.length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["confluent", "apiKey"],
					message: "Confluent provider requires confluent.apiKey to be set",
				});
			}
			if (config.confluent.apiSecret.length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["confluent", "apiSecret"],
					message: "Confluent provider requires confluent.apiSecret to be set",
				});
			}
		}

		if (config.schemaRegistry.enabled) {
			if (config.schemaRegistry.url.length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["schemaRegistry", "url"],
					message: "Schema Registry requires schemaRegistry.url to be set when enabled",
				});
			}
		}

		if (config.ksql.enabled) {
			if (config.ksql.endpoint.length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["ksql", "endpoint"],
					message: "ksqlDB requires ksql.endpoint to be set when enabled",
				});
			}
		}
	});

export type AppConfig = z.infer<typeof configSchema>;
