// tests/config/loader.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetConfigCache } from "../../src/config/config.ts";
import { loadConfig } from "../../src/config/loader.ts";

const ENV_KEYS = [
	"KAFKA_PROVIDER",
	"KAFKA_CLIENT_ID",
	"KAFKA_ALLOW_WRITES",
	"KAFKA_ALLOW_DESTRUCTIVE",
	"KAFKA_CONSUME_MAX_MESSAGES",
	"KAFKA_CONSUME_TIMEOUT_MS",
	"LOCAL_BOOTSTRAP_SERVERS",
	"MSK_BOOTSTRAP_BROKERS",
	"MSK_CLUSTER_ARN",
	"MSK_AUTH_MODE",
	"SCHEMA_REGISTRY_ENABLED",
	"SCHEMA_REGISTRY_URL",
	"SCHEMA_REGISTRY_API_KEY",
	"SCHEMA_REGISTRY_API_SECRET",
	"KSQL_ENABLED",
	"KSQL_ENDPOINT",
	"KSQL_API_KEY",
	"KSQL_API_SECRET",
	"TELEMETRY_ENABLED",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
];

function clearEnv() {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
}

describe("loadConfig", () => {
	beforeEach(() => {
		clearEnv();
		resetConfigCache();
	});

	afterEach(() => {
		clearEnv();
		resetConfigCache();
	});

	test("returns defaults when no env vars are set", () => {
		const config = loadConfig();
		expect(config.kafka.provider).toBe("local");
		expect(config.kafka.allowWrites).toBe(false);
		expect(config.kafka.allowDestructive).toBe(false);
		expect(config.schemaRegistry.enabled).toBe(false);
		expect(config.schemaRegistry.url).toBe("http://localhost:8081");
		expect(config.ksql.enabled).toBe(false);
		expect(config.ksql.endpoint).toBe("http://localhost:8088");
	});

	test("maps SCHEMA_REGISTRY_ENABLED as boolean", () => {
		process.env.SCHEMA_REGISTRY_ENABLED = "true";
		const config = loadConfig();
		expect(config.schemaRegistry.enabled).toBe(true);
	});

	test("maps SCHEMA_REGISTRY_ENABLED=false as boolean", () => {
		process.env.SCHEMA_REGISTRY_ENABLED = "false";
		const config = loadConfig();
		expect(config.schemaRegistry.enabled).toBe(false);
	});

	test("maps KSQL_ENABLED as boolean", () => {
		process.env.KSQL_ENABLED = "true";
		const config = loadConfig();
		expect(config.ksql.enabled).toBe(true);
	});

	test("maps SCHEMA_REGISTRY_URL", () => {
		process.env.SCHEMA_REGISTRY_URL = "https://registry.example.com";
		const config = loadConfig();
		expect(config.schemaRegistry.url).toBe("https://registry.example.com");
	});

	test("maps KSQL_ENDPOINT", () => {
		process.env.KSQL_ENDPOINT = "https://ksql.example.com";
		const config = loadConfig();
		expect(config.ksql.endpoint).toBe("https://ksql.example.com");
	});

	test("maps Schema Registry API credentials", () => {
		process.env.SCHEMA_REGISTRY_API_KEY = "sr-key";
		process.env.SCHEMA_REGISTRY_API_SECRET = "sr-secret";
		const config = loadConfig();
		expect(config.schemaRegistry.apiKey).toBe("sr-key");
		expect(config.schemaRegistry.apiSecret).toBe("sr-secret");
	});

	test("maps ksqlDB API credentials", () => {
		process.env.KSQL_API_KEY = "ksql-key";
		process.env.KSQL_API_SECRET = "ksql-secret";
		const config = loadConfig();
		expect(config.ksql.apiKey).toBe("ksql-key");
		expect(config.ksql.apiSecret).toBe("ksql-secret");
	});

	test("validates Schema Registry URL when enabled", () => {
		process.env.SCHEMA_REGISTRY_ENABLED = "true";
		process.env.SCHEMA_REGISTRY_URL = "";
		expect(() => loadConfig()).toThrow();
	});

	test("validates ksqlDB endpoint when enabled", () => {
		process.env.KSQL_ENABLED = "true";
		process.env.KSQL_ENDPOINT = "";
		expect(() => loadConfig()).toThrow();
	});

	test("allows Schema Registry disabled with empty URL", () => {
		process.env.SCHEMA_REGISTRY_URL = "";
		const config = loadConfig();
		expect(config.schemaRegistry.enabled).toBe(false);
		expect(config.schemaRegistry.url).toBe("");
	});

	test("defaults msk.authMode to none when MSK_AUTH_MODE is unset", () => {
		const config = loadConfig();
		expect(config.msk.authMode).toBe("none");
	});

	test("MSK_AUTH_MODE=iam maps to msk.authMode (explicit opt-in)", () => {
		process.env.KAFKA_PROVIDER = "msk";
		process.env.MSK_BOOTSTRAP_BROKERS = "b-1.example:9098";
		process.env.MSK_AUTH_MODE = "iam";
		const config = loadConfig();
		expect(config.msk.authMode).toBe("iam");
	});

	test("MSK_AUTH_MODE=tls maps to msk.authMode", () => {
		process.env.KAFKA_PROVIDER = "msk";
		process.env.MSK_BOOTSTRAP_BROKERS = "b-1.example:9094";
		process.env.MSK_AUTH_MODE = "tls";
		const config = loadConfig();
		expect(config.msk.authMode).toBe("tls");
	});

	test("MSK_AUTH_MODE rejects invalid values", () => {
		process.env.KAFKA_PROVIDER = "msk";
		process.env.MSK_BOOTSTRAP_BROKERS = "b-1.example:9092";
		process.env.MSK_AUTH_MODE = "garbage";
		expect(() => loadConfig()).toThrow();
	});
});
