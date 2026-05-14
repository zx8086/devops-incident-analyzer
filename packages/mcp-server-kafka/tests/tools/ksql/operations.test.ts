// tests/tools/ksql/operations.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { AppConfig } from "../../../src/config/schemas.ts";
import type { KsqlService } from "../../../src/services/ksql-service.ts";
import * as ops from "../../../src/tools/ksql/operations.ts";

const mockConfig = {
	ksql: { enabled: true, endpoint: "http://ksql:8088", apiKey: "", apiSecret: "" },
} as unknown as AppConfig;

function mockService(overrides: Partial<KsqlService> = {}): KsqlService {
	return {
		getServerInfo: mock(() =>
			Promise.resolve({
				KsqlServerInfo: {
					version: "0.29.0",
					kafkaClusterId: "abc123",
					ksqlServiceId: "default_",
					serverStatus: "RUNNING",
				},
			}),
		),
		getHealthcheck: mock(() => Promise.resolve({ isHealthy: true })),
		getClusterStatus: mock(() =>
			Promise.resolve({
				clusterStatus: {
					"ksql-1:8088": { hostAlive: true, lastStatusUpdateMs: 1 },
					"ksql-2:8088": { hostAlive: false, lastStatusUpdateMs: 2 },
					"ksql-3:8088": { hostAlive: false, lastStatusUpdateMs: 3 },
				},
			}),
		),
		listStreams: mock(() =>
			Promise.resolve([
				{
					name: "ORDERS",
					topic: "orders",
					keyFormat: "KAFKA",
					valueFormat: "JSON",
					isWindowed: false,
					type: "STREAM",
				},
			]),
		),
		listTables: mock(() =>
			Promise.resolve([
				{
					name: "USERS",
					topic: "users",
					keyFormat: "KAFKA",
					valueFormat: "JSON",
					isWindowed: false,
					type: "TABLE",
				},
			]),
		),
		listQueries: mock(() =>
			Promise.resolve([
				{
					queryString: "SELECT * FROM ORDERS;",
					sinks: ["orders-out"],
					id: "CSAS_1",
					queryType: "PERSISTENT",
					state: "RUNNING",
				},
			]),
		),
		describe: mock(() => Promise.resolve({ name: "ORDERS", fields: [], topic: "orders" })),
		runQuery: mock(() => Promise.resolve([{ header: { queryId: "q1", schema: "" } }])),
		executeStatement: mock(() => Promise.resolve([{ "@type": "currentStatus" }])),
		...overrides,
	} as unknown as KsqlService;
}

describe("ksql operations", () => {
	test("getServerInfo delegates to service", async () => {
		const service = mockService();
		const result = await ops.getServerInfo(service);
		expect(result.KsqlServerInfo.version).toBe("0.29.0");
	});

	test("listStreams returns streams with count", async () => {
		const service = mockService();
		const result = await ops.listStreams(service);
		expect(result.count).toBe(1);
		expect(result.streams[0]?.name).toBe("ORDERS");
	});

	test("listTables returns tables with count", async () => {
		const service = mockService();
		const result = await ops.listTables(service);
		expect(result.count).toBe(1);
		expect(result.tables[0]?.name).toBe("USERS");
	});

	test("listQueries returns queries with count", async () => {
		const service = mockService();
		const result = await ops.listQueries(service);
		expect(result.count).toBe(1);
		expect(result.queries[0]?.id).toBe("CSAS_1");
	});

	test("describe delegates sourceName to service", async () => {
		const service = mockService();
		await ops.describe(service, { sourceName: "ORDERS" });
		expect(service.describe).toHaveBeenCalledWith("ORDERS");
	});

	test("runQuery passes ksql and properties", async () => {
		const service = mockService();
		const properties = { "auto.offset.reset": "earliest" };
		await ops.runQuery(service, { ksql: "SELECT * FROM ORDERS;", properties });
		expect(service.runQuery).toHaveBeenCalledWith("SELECT * FROM ORDERS;", properties);
	});

	test("executeStatement passes ksql and properties", async () => {
		const service = mockService();
		await ops.executeStatement(service, { ksql: "DROP STREAM ORDERS;" });
		expect(service.executeStatement).toHaveBeenCalledWith("DROP STREAM ORDERS;", undefined);
	});

	// SIO-742: health-check operations wrap probe calls into the standard envelope.
	test("healthCheck returns status=up with isHealthy details", async () => {
		const service = mockService();
		const env = await ops.healthCheck(service, mockConfig);
		expect(env.status).toBe("up");
		expect(env.service).toBe("ksqlDB");
		expect(env.endpoint).toBe("http://ksql:8088/healthcheck");
		expect(env.details?.isHealthy).toBe(true);
	});

	test("clusterStatus summarises aliveHosts/totalHosts and flags degraded", async () => {
		const service = mockService();
		const env = await ops.clusterStatus(service, mockConfig);
		expect(env.status).toBe("up");
		expect(env.endpoint).toBe("http://ksql:8088/clusterStatus");
		expect(env.details?.aliveHosts).toBe(1);
		expect(env.details?.totalHosts).toBe(3);
		expect(env.details?.degraded).toBe(true);
	});

	test("clusterStatus flags degraded=false when all hosts alive", async () => {
		const service = mockService({
			getClusterStatus: mock(() =>
				Promise.resolve({
					clusterStatus: {
						"ksql-1:8088": { hostAlive: true, lastStatusUpdateMs: 1 },
						"ksql-2:8088": { hostAlive: true, lastStatusUpdateMs: 2 },
					},
				}),
			),
		});
		const env = await ops.clusterStatus(service, mockConfig);
		expect(env.details?.aliveHosts).toBe(2);
		expect(env.details?.totalHosts).toBe(2);
		expect(env.details?.degraded).toBe(false);
	});
});
