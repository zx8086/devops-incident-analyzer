// packages/mcp-server-kafka/tests/services/connect-service-writes.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppConfig } from "../../src/config/schemas";
import { ConnectService } from "../../src/services/connect-service";

let originalFetch: typeof globalThis.fetch;

const baseConfig = {
	connect: { enabled: true, url: "http://connect:8083", apiKey: "", apiSecret: "" },
} as unknown as AppConfig;

function mockFetch(status: number, body: unknown = "") {
	globalThis.fetch = mock(() =>
		Promise.resolve(
			new Response(typeof body === "string" ? body : JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		),
	) as unknown as typeof globalThis.fetch;
}

describe("ConnectService — write methods", () => {
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("pauseConnector sends PUT and accepts 202", async () => {
		mockFetch(202);
		const svc = new ConnectService(baseConfig);
		await expect(svc.pauseConnector("orders-sink")).resolves.toBeUndefined();
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(call[0]).toBe("http://connect:8083/connectors/orders-sink/pause");
		expect((call[1] as RequestInit).method).toBe("PUT");
	});

	test("resumeConnector sends PUT", async () => {
		mockFetch(202);
		const svc = new ConnectService(baseConfig);
		await svc.resumeConnector("orders-sink");
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(call[0]).toBe("http://connect:8083/connectors/orders-sink/resume");
		expect((call[1] as RequestInit).method).toBe("PUT");
	});

	test("restartConnector forwards includeTasks and onlyFailed query params", async () => {
		mockFetch(204);
		const svc = new ConnectService(baseConfig);
		await svc.restartConnector("orders-sink", { includeTasks: true, onlyFailed: true });
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(call[0]).toBe("http://connect:8083/connectors/orders-sink/restart?includeTasks=true&onlyFailed=true");
		expect((call[1] as RequestInit).method).toBe("POST");
	});

	test("restartConnector omits query params when none provided", async () => {
		mockFetch(204);
		const svc = new ConnectService(baseConfig);
		await svc.restartConnector("orders-sink");
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(call[0]).toBe("http://connect:8083/connectors/orders-sink/restart");
	});

	test("restartConnectorTask builds task URL", async () => {
		mockFetch(204);
		const svc = new ConnectService(baseConfig);
		await svc.restartConnectorTask("orders-sink", 0);
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(call[0]).toBe("http://connect:8083/connectors/orders-sink/tasks/0/restart");
		expect((call[1] as RequestInit).method).toBe("POST");
	});

	test("deleteConnector sends DELETE", async () => {
		mockFetch(204);
		const svc = new ConnectService(baseConfig);
		await svc.deleteConnector("orders-sink");
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(call[0]).toBe("http://connect:8083/connectors/orders-sink");
		expect((call[1] as RequestInit).method).toBe("DELETE");
	});

	test("URL-encodes connector names with special characters", async () => {
		mockFetch(202);
		const svc = new ConnectService(baseConfig);
		await svc.pauseConnector("my connector/with slash");
		const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect(call[0]).toBe("http://connect:8083/connectors/my%20connector%2Fwith%20slash/pause");
	});

	test("throws on non-OK with SIO-725 structured fields", async () => {
		mockFetch(500, "boom");
		const svc = new ConnectService(baseConfig);
		let captured: unknown;
		await svc.pauseConnector("x").catch((err) => {
			captured = err;
		});
		const e = captured as { statusCode?: number; message: string };
		expect(e.statusCode).toBe(500);
		expect(e.message).toMatch(/Kafka Connect/);
	});
});
