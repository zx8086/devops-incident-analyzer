// tests/tools/shared/health-envelope.test.ts
import { describe, expect, test } from "bun:test";
import { upstreamError } from "../../../src/lib/errors.ts";
import { runHealthProbe } from "../../../src/tools/shared/health-envelope.ts";

describe("SIO-742: health envelope helper", () => {
	test("status=up on successful probe; preserves details", async () => {
		const env = await runHealthProbe("ksqlDB", "http://ksql:8088/healthcheck", async () => ({ isHealthy: true }));
		expect(env.status).toBe("up");
		expect(env.service).toBe("ksqlDB");
		expect(env.endpoint).toBe("http://ksql:8088/healthcheck");
		expect(env.details).toEqual({ isHealthy: true });
		expect(env.error).toBeUndefined();
		expect(typeof env.latencyMs).toBe("number");
	});

	test("status=up without details when probe returns undefined", async () => {
		const env = await runHealthProbe("REST Proxy", "http://rest:8082/topics", async () => undefined);
		expect(env.status).toBe("up");
		expect(env.details).toBeUndefined();
	});

	test("status=down on KafkaToolError with HTTP statusCode (5xx)", async () => {
		const env = await runHealthProbe("Schema Registry", "http://sr:8081/subjects", async () => {
			throw upstreamError("Schema Registry (sr.example.com) error 503", {
				hostname: "sr.example.com",
				statusCode: 503,
				upstreamContentType: "text/html",
			});
		});
		expect(env.status).toBe("down");
		expect(env.hostname).toBe("sr.example.com");
		expect(env.error?.statusCode).toBe(503);
		expect(env.error?.upstreamContentType).toBe("text/html");
	});

	test("status=down on KafkaToolError with HTTP statusCode (4xx)", async () => {
		const env = await runHealthProbe("Kafka Connect", "http://connect:8083/", async () => {
			throw upstreamError("Kafka Connect error 401", { hostname: "connect.example.com", statusCode: 401 });
		});
		expect(env.status).toBe("down");
		expect(env.error?.statusCode).toBe(401);
	});

	test("status=unreachable when no statusCode (network/timeout)", async () => {
		const env = await runHealthProbe("ksqlDB", "http://ksql:8088/healthcheck", async () => {
			throw upstreamError("ksqlDB (ksql.example.com) timed out", { hostname: "ksql.example.com" });
		});
		expect(env.status).toBe("unreachable");
		expect(env.hostname).toBe("ksql.example.com");
		expect(env.error?.message).toContain("timed out");
		expect(env.error?.statusCode).toBeUndefined();
	});

	test("status=unreachable on plain Error", async () => {
		const env = await runHealthProbe("REST Proxy", "http://rest:8082/topics", async () => {
			throw new Error("ECONNREFUSED");
		});
		expect(env.status).toBe("unreachable");
		expect(env.error?.message).toBe("ECONNREFUSED");
	});
});
