// shared/src/__tests__/logger-ecs.test.ts
import { describe, expect, test } from "bun:test";
import pino from "pino";
import { buildEcsOptions, formatLogLine } from "../logger.ts";

function createTestLogger(serviceName: string, env = "production") {
	const output: string[] = [];
	const dest = {
		write(data: string) {
			if (data.trim()) output.push(data.trim());
		},
	};
	const ecsOpts = buildEcsOptions({ serviceName, serviceEnvironment: env });
	const logger = pino({ level: "debug", ...ecsOpts }, dest).child({ service: serviceName });
	return { logger, output };
}

function parseEntry(output: string[], index = 0): Record<string, unknown> {
	const line = output[index];
	if (!line) throw new Error(`No log output at index ${index}`);
	return JSON.parse(line) as Record<string, unknown>;
}

describe("buildEcsOptions", () => {
	test("produces ECS-compliant JSON with all required fields", () => {
		const { logger, output } = createTestLogger("test-service");
		logger.info({ port: 3000 }, "Server started");

		expect(output).toHaveLength(1);
		const entry = parseEntry(output);

		expect(entry["@timestamp"]).toBeString();
		expect(entry["log.level"]).toBe("info");
		expect(entry.message).toBe("Server started");
		expect(entry["ecs.version"]).toBe("8.10.0");
		expect(entry["service.name"]).toBe("test-service");
		expect(entry["service.version"]).toBe("0.1.0");
		expect(entry["service.environment"]).toBe("production");
		expect(entry["event.dataset"]).toBe("test-service");
		expect(entry["process.pid"]).toBeNumber();
		expect(entry["host.hostname"]).toBeString();
	});

	test("respects custom serviceVersion and serviceEnvironment", () => {
		const output: string[] = [];
		const dest = {
			write(data: string) {
				if (data.trim()) output.push(data.trim());
			},
		};
		const ecsOpts = buildEcsOptions({
			serviceName: "custom-svc",
			serviceVersion: "2.5.0",
			serviceEnvironment: "staging",
		});
		const logger = pino({ level: "info", ...ecsOpts }, dest);
		logger.info("Test");

		const entry = parseEntry(output);
		expect(entry["service.name"]).toBe("custom-svc");
		expect(entry["service.version"]).toBe("2.5.0");
		expect(entry["service.environment"]).toBe("staging");
	});

	test("uses 'message' as messageKey (not 'msg')", () => {
		const { logger, output } = createTestLogger("test-service");
		logger.info("Hello world");

		const entry = parseEntry(output);
		expect(entry.message).toBe("Hello world");
		expect(entry.msg).toBeUndefined();
	});

	test("@timestamp is ISO 8601 format", () => {
		const { logger, output } = createTestLogger("test-service");
		logger.info("Timestamp test");

		const entry = parseEntry(output);
		const ts = entry["@timestamp"] as string;
		const parsed = new Date(ts);
		expect(parsed.getTime()).not.toBeNaN();
		expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	test("log.level maps correctly for all levels", () => {
		const { logger, output } = createTestLogger("test-service");

		logger.debug("debug msg");
		logger.info("info msg");
		logger.warn("warn msg");
		logger.error("error msg");

		expect(output).toHaveLength(4);
		expect(parseEntry(output)["log.level"]).toBe("debug");
		expect(parseEntry(output, 1)["log.level"]).toBe("info");
		expect(parseEntry(output, 2)["log.level"]).toBe("warn");
		expect(parseEntry(output, 3)["log.level"]).toBe("error");
	});

	test("redacts sensitive fields", () => {
		const { logger, output } = createTestLogger("test-service");
		logger.info(
			{
				token: "abc123",
				password: "secret",
				apiKey: "key-456",
				authorization: "Bearer xyz",
				accessToken: "tok-789",
				safeField: "visible",
			},
			"Auth context",
		);

		const entry = parseEntry(output);
		expect(entry.token).toBe("[REDACTED]");
		expect(entry.password).toBe("[REDACTED]");
		expect(entry.apiKey).toBe("[REDACTED]");
		expect(entry.authorization).toBe("[REDACTED]");
		expect(entry.accessToken).toBe("[REDACTED]");
		expect(entry.safeField).toBe("visible");
	});

	test("serializes Error via err property to ECS error fields", () => {
		const { logger, output } = createTestLogger("test-service");
		logger.error({ err: new TypeError("Bad input") }, "Validation failed");

		const entry = parseEntry(output);
		expect(entry.error).toBeDefined();
		const errObj = entry.error as Record<string, unknown>;
		expect(errObj.type).toBe("TypeError");
		expect(errObj.message).toBe("Bad input");
		expect(errObj.stack_trace).toContain("TypeError: Bad input");
		// err property should be removed (converted to error.*)
		expect(entry.err).toBeUndefined();
	});

	test("child logger bindings merge into output", () => {
		const { logger, output } = createTestLogger("test-service");
		const child = logger.child({ requestId: "req-001", dataSourceId: "elastic" });
		child.info({ duration: 150 }, "Query completed");

		const entry = parseEntry(output);
		expect(entry.requestId).toBe("req-001");
		expect(entry.dataSourceId).toBe("elastic");
		expect(entry.duration).toBe(150);
		expect(entry.service).toBe("test-service");
	});

	test("preserves complex context values", () => {
		const { logger, output } = createTestLogger("test-service");
		logger.info(
			{
				results: [
					{ dataSourceId: "elastic", status: "success", duration: 100 },
					{ dataSourceId: "kafka", status: "error", duration: 50 },
				],
			},
			"Aggregation summary",
		);

		const entry = parseEntry(output);
		const results = entry.results as Array<Record<string, unknown>>;
		expect(results).toHaveLength(2);
		expect(results[0]?.dataSourceId).toBe("elastic");
		expect(results[1]?.status).toBe("error");
	});
});

describe("formatLogLine", () => {
	test("formats ECS JSON to human-readable line", () => {
		const line = formatLogLine({
			"@timestamp": "2026-03-24T14:25:58.000Z",
			"log.level": "info",
			message: "Server started",
			"ecs.version": "8.10.0",
			"service.name": "test-service",
			"service.version": "0.1.0",
			"service.environment": "development",
			"event.dataset": "test-service",
			"process.pid": 1234,
			"host.hostname": "my-host",
			port: 3000,
		});

		// Should contain time, level, message, and context
		expect(line).toContain("info");
		expect(line).toContain("Server started");
		expect(line).toContain('"port":3000');

		// ECS metadata should be stripped from context
		expect(line).not.toContain('"ecs.version"');
		expect(line).not.toContain('"service.name"');
		expect(line).not.toContain('"process.pid"');
		expect(line).not.toContain('"host.hostname"');
		expect(line).not.toContain('"@timestamp"');
	});

	test("preserves trace and langsmith fields in dev output", () => {
		const line = formatLogLine({
			"@timestamp": "2026-03-24T14:25:58.000Z",
			"log.level": "info",
			message: "Request processed",
			"service.name": "test-service",
			"trace.id": "550e8400e29b41d4",
			"span.id": "550e8400e29b",
			"langsmith.run_id": "019ce563-2abb",
			"langsmith.project": "es-agent",
		});

		expect(line).toContain('"trace.id":"550e8400e29b41d4"');
		expect(line).toContain('"langsmith.run_id":"019ce563-2abb"');
		expect(line).toContain('"langsmith.project":"es-agent"');
	});

	test("applies ANSI color codes per level", () => {
		const infoLine = formatLogLine({ "log.level": "info", message: "test" });
		const errorLine = formatLogLine({ "log.level": "error", message: "test" });
		const debugLine = formatLogLine({ "log.level": "debug", message: "test" });
		const warnLine = formatLogLine({ "log.level": "warn", message: "test" });

		expect(infoLine).toContain("\x1b[32m"); // green
		expect(errorLine).toContain("\x1b[31m"); // red
		expect(debugLine).toContain("\x1b[36m"); // cyan
		expect(warnLine).toContain("\x1b[33m"); // yellow
	});

	test("formats time as h:MM:ss TT", () => {
		const line = formatLogLine({
			"@timestamp": "2026-03-24T22:01:24.000Z",
			"log.level": "info",
			message: "Test",
		});

		// Should have time in 12-hour format with AM/PM
		expect(line).toMatch(/\d{1,2}:\d{2}:\d{2} (AM|PM)/);
	});

	test("handles standard Pino fields as fallback", () => {
		const line = formatLogLine({
			level: 30,
			time: 1711234567000,
			msg: "Pino message",
			pid: 1234,
			hostname: "host",
		});

		expect(line).toContain("info");
		expect(line).toContain("Pino message");
	});

	test("omits context JSON when no extra fields", () => {
		const line = formatLogLine({
			"@timestamp": "2026-03-24T12:00:00.000Z",
			"log.level": "info",
			message: "Simple message",
			"ecs.version": "8.10.0",
			"service.name": "svc",
		});

		// No trailing JSON context
		expect(line).toMatch(/Simple message\n$/);
	});
});
