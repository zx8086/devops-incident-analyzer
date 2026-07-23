// tests/services/ksql-service.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppConfig } from "../../src/config/schemas.ts";
import { KsqlService } from "../../src/services/ksql-service.ts";

const mockConfig = {
	ksql: {
		enabled: true,
		endpoint: "http://localhost:8088",
		apiKey: "",
		apiSecret: "",
	},
} as AppConfig;

const mockConfigWithAuth = {
	ksql: {
		enabled: true,
		endpoint: "http://localhost:8088",
		apiKey: "test-key",
		apiSecret: "test-secret",
	},
} as AppConfig;

let originalFetch: typeof globalThis.fetch;

function mockFetch(status: number, body: unknown) {
	globalThis.fetch = mock(() =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		),
	) as unknown as typeof globalThis.fetch;
}

describe("KsqlService", () => {
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("getServerInfo returns server info", async () => {
		const info = {
			KsqlServerInfo: {
				version: "0.29.0",
				kafkaClusterId: "abc123",
				ksqlServiceId: "default_",
				serverStatus: "RUNNING",
			},
		};
		mockFetch(200, info);
		const service = new KsqlService(mockConfig);
		const result = await service.getServerInfo();
		expect(result).toEqual(info);
	});

	// SIO-742: /healthcheck endpoint
	test("getHealthcheck GETs /healthcheck and returns isHealthy", async () => {
		mockFetch(200, { isHealthy: true, details: { kafka: { isHealthy: true } } });
		const service = new KsqlService(mockConfig);
		const result = await service.getHealthcheck();
		expect(result.isHealthy).toBe(true);
		expect(result.details?.kafka?.isHealthy).toBe(true);
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(call?.[0]).toBe("http://localhost:8088/healthcheck");
	});

	// SIO-742: /clusterStatus endpoint parses the per-host map.
	test("getClusterStatus GETs /clusterStatus and parses host map", async () => {
		const body = {
			clusterStatus: {
				"ksql-1.example:8088": { hostAlive: true, lastStatusUpdateMs: 1_700_000_000 },
				"ksql-2.example:8088": { hostAlive: false, lastStatusUpdateMs: 1_699_999_000 },
				"ksql-3.example:8088": { hostAlive: false, lastStatusUpdateMs: 1_699_998_000 },
			},
		};
		mockFetch(200, body);
		const service = new KsqlService(mockConfig);
		const result = await service.getClusterStatus();
		expect(Object.keys(result.clusterStatus)).toHaveLength(3);
		expect(result.clusterStatus["ksql-1.example:8088"]?.hostAlive).toBe(true);
		expect(result.clusterStatus["ksql-2.example:8088"]?.hostAlive).toBe(false);
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(call?.[0]).toBe("http://localhost:8088/clusterStatus");
	});

	test("listStreams parses streams from response", async () => {
		const streams = [
			{
				name: "ORDERS",
				topic: "orders",
				keyFormat: "KAFKA",
				valueFormat: "JSON",
				isWindowed: false,
				type: "STREAM",
			},
		];
		mockFetch(200, [{ "@type": "streams", streams }]);
		const service = new KsqlService(mockConfig);
		const result = await service.listStreams();
		expect(result).toEqual(streams);
		// SIO-1188: the statement MUST stay non-EXTENDED -- EXTENDED responses come
		// back as @type "sourceDescriptions", which this parser (and this fixture)
		// does not model, and the tool silently returns [] forever.
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const body = JSON.parse((call?.[1] as RequestInit)?.body as string) as { ksql: string };
		expect(body.ksql).toBe("LIST STREAMS;");
	});

	test("listTables parses tables from response", async () => {
		const tables = [
			{
				name: "USERS",
				topic: "users",
				keyFormat: "KAFKA",
				valueFormat: "JSON",
				isWindowed: false,
				type: "TABLE",
			},
		];
		mockFetch(200, [{ "@type": "tables", tables }]);
		const service = new KsqlService(mockConfig);
		const result = await service.listTables();
		expect(result).toEqual(tables);
		// SIO-1188: see listStreams -- non-EXTENDED statement is load-bearing.
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const body = JSON.parse((call?.[1] as RequestInit)?.body as string) as { ksql: string };
		expect(body.ksql).toBe("LIST TABLES;");
	});

	test("listStreams returns [] when the response shape is a SourceDescriptionList (EXTENDED regression, SIO-1188)", async () => {
		// If someone reintroduces `LIST STREAMS EXTENDED;`, the upstream answers with
		// this shape and extraction yields [] -- the statement assertions above are the
		// real guard; this documents WHY.
		mockFetch(200, [{ "@type": "sourceDescriptions", sourceDescriptions: [{ name: "ORDERS" }] }]);
		const service = new KsqlService(mockConfig);
		const result = await service.listStreams();
		expect(result).toEqual([]);
	});

	test("listQueries parses queries from response", async () => {
		const queries = [
			{
				queryString: "SELECT * FROM ORDERS EMIT CHANGES;",
				sinks: ["orders-out"],
				id: "CSAS_1",
				queryType: "PERSISTENT",
				state: "RUNNING",
			},
		];
		mockFetch(200, [{ "@type": "queries", queries }]);
		const service = new KsqlService(mockConfig);
		const result = await service.listQueries();
		expect(result).toEqual(queries);
	});

	test("describe parses source description", async () => {
		const sourceDescription = { name: "ORDERS", fields: [], topic: "orders" };
		mockFetch(200, [{ "@type": "sourceDescription", sourceDescription }]);
		const service = new KsqlService(mockConfig);
		const result = await service.describe("ORDERS");
		expect(result).toEqual(sourceDescription);
	});

	test("runQuery sends to /query endpoint", async () => {
		mockFetch(200, [{ header: { queryId: "q1", schema: "`ID` INTEGER" } }]);
		const service = new KsqlService(mockConfig);
		const result = await service.runQuery("SELECT * FROM ORDERS;");
		expect(result).toHaveLength(1);
	});

	// SIO-1191: default-latest offset reset makes push queries hang on quiet streams
	// into the SigV4 proxy's 30s abort (which retries the query). The service now
	// defaults earliest and bounds the request under the proxy budget.
	describe("runQuery steering defaults (SIO-1191)", () => {
		function queryBody(): { streamsProperties: Record<string, string> } {
			const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
			return JSON.parse((call?.[1] as RequestInit)?.body as string);
		}

		test("injects ksql.streams.auto.offset.reset=earliest when no properties given", async () => {
			mockFetch(200, []);
			const service = new KsqlService(mockConfig);
			await service.runQuery("SELECT ID FROM S_ORDERS EMIT CHANGES LIMIT 1;");
			expect(queryBody().streamsProperties["ksql.streams.auto.offset.reset"]).toBe("earliest");
		});

		test("caller-supplied properties override the earliest default", async () => {
			mockFetch(200, []);
			const service = new KsqlService(mockConfig);
			await service.runQuery("SELECT ID FROM S_ORDERS EMIT CHANGES LIMIT 1;", {
				"ksql.streams.auto.offset.reset": "latest",
			});
			expect(queryBody().streamsProperties["ksql.streams.auto.offset.reset"]).toBe("latest");
		});

		test("unrelated caller properties merge alongside the default", async () => {
			mockFetch(200, []);
			const service = new KsqlService(mockConfig);
			await service.runQuery("SELECT ID FROM S_ORDERS EMIT CHANGES LIMIT 1;", { "custom.prop": "x" });
			const props = queryBody().streamsProperties;
			expect(props["ksql.streams.auto.offset.reset"]).toBe("earliest");
			expect(props["custom.prop"]).toBe("x");
		});

		test("bounds the request with an AbortSignal under the proxy's 30s budget", async () => {
			mockFetch(200, []);
			const service = new KsqlService(mockConfig);
			await service.runQuery("SELECT 1 FROM T LIMIT 1;");
			const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
			expect((call?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
			expect(KsqlService.RUN_QUERY_TIMEOUT_MS).toBeLessThan(30_000);
		});
	});

	test("executeStatement sends to /ksql endpoint", async () => {
		mockFetch(200, [{ "@type": "currentStatus", commandStatus: { status: "SUCCESS" } }]);
		const service = new KsqlService(mockConfig);
		const result = await service.executeStatement("DROP STREAM IF EXISTS ORDERS;");
		expect(result).toHaveLength(1);
	});

	test("appends semicolon if missing", async () => {
		mockFetch(200, [{}]);
		const service = new KsqlService(mockConfig);
		await service.executeStatement("LIST STREAMS");
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const body = JSON.parse((fetchCall?.[1] as RequestInit)?.body as string);
		expect(body.ksql).toBe("LIST STREAMS;");
	});

	test("does not double-append semicolon", async () => {
		mockFetch(200, [{}]);
		const service = new KsqlService(mockConfig);
		await service.executeStatement("LIST STREAMS;");
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const body = JSON.parse((fetchCall?.[1] as RequestInit)?.body as string);
		expect(body.ksql).toBe("LIST STREAMS;");
	});

	test("throws on non-OK response with SIO-725 structured fields", async () => {
		mockFetch(400, "Bad request");
		const service = new KsqlService(mockConfig);
		let captured: unknown;
		await service.getServerInfo().catch((err) => {
			captured = err;
		});
		const e = captured as { hostname?: string; statusCode?: number; message: string };
		expect(e.statusCode).toBe(400);
		expect(e.hostname).toBeDefined();
		expect(e.message).toContain("ksqlDB");
		expect(e.message).toContain("400");
	});

	test("includes auth header when credentials provided", async () => {
		mockFetch(200, { KsqlServerInfo: {} });
		const service = new KsqlService(mockConfigWithAuth);
		await service.getServerInfo();
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const headers = (fetchCall?.[1] as RequestInit)?.headers as Record<string, string>;
		expect(headers.Authorization).toStartWith("Basic ");
	});

	test("returns empty array for missing queries key", async () => {
		mockFetch(200, [{ "@type": "unknown" }]);
		const service = new KsqlService(mockConfig);
		const result = await service.listQueries();
		expect(result).toEqual([]);
	});

	describe("probeReachability", () => {
		test("resolves on 200", async () => {
			mockFetch(200, { KsqlServerInfo: { version: "0.29.0" } });
			const service = new KsqlService(mockConfig);
			await expect(service.probeReachability()).resolves.toBeUndefined();
		});

		test("throws on 500 with SIO-725 structured fields", async () => {
			mockFetch(500, "boom");
			const service = new KsqlService(mockConfig);
			let captured: unknown;
			await service.probeReachability().catch((err) => {
				captured = err;
			});
			const e = captured as { statusCode?: number; message: string };
			expect(e.statusCode).toBe(500);
			expect(e.message).toContain("ksqlDB");
		});

		test("hits GET /info with timeout signal", async () => {
			mockFetch(200, {});
			const service = new KsqlService(mockConfig);
			await service.probeReachability(1234);
			const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
			expect(call[0]).toBe("http://localhost:8088/info");
			expect((call[1] as RequestInit).method).toBe("GET");
			expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
		});

		test("propagates fetch network error", async () => {
			globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof globalThis.fetch;
			const service = new KsqlService(mockConfig);
			await expect(service.probeReachability()).rejects.toThrow("ECONNREFUSED");
		});
	});
});
