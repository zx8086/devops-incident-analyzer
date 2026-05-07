// tests/services/connect-service.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppConfig } from "../../src/config/schemas.ts";
import { ConnectService } from "../../src/services/connect-service.ts";

const mockConfig = {
	connect: {
		enabled: true,
		url: "http://localhost:8083",
		apiKey: "",
		apiSecret: "",
	},
} as AppConfig;

const mockConfigWithAuth = {
	connect: {
		enabled: true,
		url: "http://localhost:8083",
		apiKey: "test-key",
		apiSecret: "test-secret",
	},
} as AppConfig;

let originalFetch: typeof globalThis.fetch;

function mockFetch(status: number, body: unknown) {
	globalThis.fetch = mock(() =>
		Promise.resolve(
			new Response(typeof body === "string" ? body : JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		),
	) as unknown as typeof globalThis.fetch;
}

describe("ConnectService", () => {
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("getClusterInfo returns cluster info from GET /", async () => {
		const info = { version: "7.5.0", commit: "abcd1234", kafka_cluster_id: "cluster-xyz" };
		mockFetch(200, info);
		const service = new ConnectService(mockConfig);
		const result = await service.getClusterInfo();
		expect(result).toEqual(info);
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(fetchCall?.[0]).toBe("http://localhost:8083/");
	});

	test("listConnectors wraps the expand=status response with count", async () => {
		const connectors = {
			"sink-couchbase-prices": {
				status: {
					name: "sink-couchbase-prices",
					type: "sink",
					connector: { state: "RUNNING", worker_id: "worker-1" },
					tasks: [{ id: 0, state: "RUNNING", worker_id: "worker-1" }],
				},
			},
			"sink-couchbase-orders": {
				status: {
					name: "sink-couchbase-orders",
					type: "sink",
					connector: { state: "FAILED", worker_id: "worker-2" },
					tasks: [],
				},
			},
		};
		mockFetch(200, connectors);
		const service = new ConnectService(mockConfig);
		const result = await service.listConnectors();
		expect(result.count).toBe(2);
		expect(Object.keys(result.connectors)).toEqual(["sink-couchbase-prices", "sink-couchbase-orders"]);
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(fetchCall?.[0]).toBe("http://localhost:8083/connectors?expand=status&expand=info");
	});

	test("getConnectorStatus URL-encodes connector names with special characters", async () => {
		const status = {
			name: "C_SINK_COUCHBASE/PRICES",
			type: "sink",
			connector: { state: "RUNNING", worker_id: "worker-1" },
			tasks: [],
		};
		mockFetch(200, status);
		const service = new ConnectService(mockConfig);
		await service.getConnectorStatus("C_SINK_COUCHBASE/PRICES");
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(fetchCall?.[0]).toBe("http://localhost:8083/connectors/C_SINK_COUCHBASE%2FPRICES/status");
	});

	test("getConnectorTaskStatus builds path with name and numeric taskId", async () => {
		const taskStatus = { id: 3, state: "FAILED", worker_id: "worker-1", trace: "java.lang.NullPointerException" };
		mockFetch(200, taskStatus);
		const service = new ConnectService(mockConfig);
		const result = await service.getConnectorTaskStatus("my-connector", 3);
		expect(result.id).toBe(3);
		expect(result.trace).toContain("NullPointerException");
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(fetchCall?.[0]).toBe("http://localhost:8083/connectors/my-connector/tasks/3/status");
	});

	test("strips trailing slash from base URL", async () => {
		const configTrailing = {
			connect: { enabled: true, url: "http://localhost:8083/", apiKey: "", apiSecret: "" },
		} as AppConfig;
		mockFetch(200, { version: "7.5.0", commit: "abc", kafka_cluster_id: "x" });
		const service = new ConnectService(configTrailing);
		await service.getClusterInfo();
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(fetchCall?.[0]).toBe("http://localhost:8083/");
	});

	test("includes Authorization Basic header when credentials provided", async () => {
		mockFetch(200, { version: "7.5.0", commit: "abc", kafka_cluster_id: "x" });
		const service = new ConnectService(mockConfigWithAuth);
		await service.getClusterInfo();
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const headers = (fetchCall?.[1] as RequestInit)?.headers as Record<string, string>;
		expect(headers.Authorization).toStartWith("Basic ");
	});

	test("does NOT include Authorization header for no-auth deployments (empty key/secret)", async () => {
		mockFetch(200, { version: "7.5.0", commit: "abc", kafka_cluster_id: "x" });
		const service = new ConnectService(mockConfig);
		await service.getClusterInfo();
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const headers = (fetchCall?.[1] as RequestInit)?.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	test("throws on non-OK response with status code in message", async () => {
		mockFetch(404, "Connector not found");
		const service = new ConnectService(mockConfig);
		expect(service.getConnectorStatus("missing")).rejects.toThrow("Kafka Connect error 404");
	});
});
