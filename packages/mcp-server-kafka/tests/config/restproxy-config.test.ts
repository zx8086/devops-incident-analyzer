// tests/config/restproxy-config.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetConfigCache } from "../../src/config/config.ts";
import { loadConfig } from "../../src/config/loader.ts";

const ENV_KEYS = [
	"RESTPROXY_ENABLED",
	"RESTPROXY_URL",
	"RESTPROXY_API_KEY",
	"RESTPROXY_API_SECRET",
];

function clearEnv() {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
}

describe("restproxy config", () => {
	beforeEach(() => {
		clearEnv();
		resetConfigCache();
	});

	afterEach(() => {
		clearEnv();
		resetConfigCache();
	});

	test("disabled by default", () => {
		const config = loadConfig();
		expect(config.restproxy.enabled).toBe(false);
	});

	test("RESTPROXY_ENABLED=true wires the block", () => {
		process.env.RESTPROXY_ENABLED = "true";
		process.env.RESTPROXY_URL = "http://kafka-rest:8082";
		const config = loadConfig();
		expect(config.restproxy.enabled).toBe(true);
		expect(config.restproxy.url).toBe("http://kafka-rest:8082");
	});

	test("RESTPROXY_ENABLED=true with empty URL fails validation", () => {
		process.env.RESTPROXY_ENABLED = "true";
		process.env.RESTPROXY_URL = "";
		expect(() => loadConfig()).toThrow();
	});

	test("Basic auth credentials accepted", () => {
		process.env.RESTPROXY_ENABLED = "true";
		process.env.RESTPROXY_URL = "http://x:8082";
		process.env.RESTPROXY_API_KEY = "k";
		process.env.RESTPROXY_API_SECRET = "s";
		const config = loadConfig();
		expect(config.restproxy.apiKey).toBe("k");
		expect(config.restproxy.apiSecret).toBe("s");
	});
});
