// src/config/defaults.ts

export const defaults = {
	kafka: {
		provider: "local" as const,
		clientId: "kafka-mcp-server",
		allowWrites: false,
		allowDestructive: false,
		consumeMaxMessages: 50,
		consumeTimeoutMs: 30000,
	},
	msk: {
		bootstrapBrokers: "",
		clusterArn: "",
		region: "eu-west-1",
	},
	confluent: {
		bootstrapServers: "",
		apiKey: "",
		apiSecret: "",
		restEndpoint: "",
		clusterId: "",
	},
	local: {
		bootstrapServers: "localhost:9092",
	},
	schemaRegistry: {
		enabled: false,
		url: "http://localhost:8081",
		apiKey: "",
		apiSecret: "",
	},
	ksql: {
		enabled: false,
		endpoint: "http://localhost:8088",
		apiKey: "",
		apiSecret: "",
	},
	logging: {
		level: "info" as const,
		backend: "pino" as const,
	},
	telemetry: {
		enabled: false,
		serviceName: "kafka-mcp-server",
		mode: "console" as const,
		otlpEndpoint: "http://localhost:4318",
	},
	transport: {
		mode: "stdio" as const,
		port: 3000,
		host: "127.0.0.1",
		path: "/mcp",
		sessionMode: "stateless" as const,
		apiKey: "",
		allowedOrigins: "",
		idleTimeout: 120,
	},
} as const satisfies Record<string, Record<string, unknown>>;
