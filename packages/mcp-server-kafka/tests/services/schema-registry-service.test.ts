// tests/services/schema-registry-service.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppConfig } from "../../src/config/schemas.ts";
import { SchemaRegistryService } from "../../src/services/schema-registry-service.ts";

const mockConfig = {
	schemaRegistry: {
		enabled: true,
		url: "http://localhost:8081",
		apiKey: "",
		apiSecret: "",
	},
} as AppConfig;

const mockConfigWithAuth = {
	schemaRegistry: {
		enabled: true,
		url: "http://localhost:8081",
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

describe("SchemaRegistryService", () => {
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("listSubjects returns array of subjects", async () => {
		mockFetch(200, ["orders-value", "users-key"]);
		const service = new SchemaRegistryService(mockConfig);
		const result = await service.listSubjects();
		expect(result).toEqual(["orders-value", "users-key"]);
	});

	test("getSchemaVersions returns version array", async () => {
		mockFetch(200, [1, 2, 3]);
		const service = new SchemaRegistryService(mockConfig);
		const result = await service.getSchemaVersions("orders-value");
		expect(result).toEqual([1, 2, 3]);
	});

	test("getSchema returns schema info", async () => {
		const schemaInfo = {
			subject: "orders-value",
			id: 1,
			version: 1,
			schemaType: "AVRO",
			schema: '{"type":"record","name":"Order","fields":[]}',
		};
		mockFetch(200, schemaInfo);
		const service = new SchemaRegistryService(mockConfig);
		const result = await service.getSchema("orders-value", 1);
		expect(result).toEqual(schemaInfo);
	});

	test("getSchemaById returns schema", async () => {
		const schemaBody = { schema: '{"type":"record"}', schemaType: "AVRO" };
		mockFetch(200, schemaBody);
		const service = new SchemaRegistryService(mockConfig);
		const result = await service.getSchemaById(1);
		expect(result).toEqual(schemaBody);
	});

	test("registerSchema sends POST and returns id", async () => {
		mockFetch(200, { id: 42 });
		const service = new SchemaRegistryService(mockConfig);
		const result = await service.registerSchema("test-value", '{"type":"string"}', "AVRO");
		expect(result).toEqual({ id: 42 });
	});

	test("checkCompatibility returns compatibility result", async () => {
		mockFetch(200, { is_compatible: true });
		const service = new SchemaRegistryService(mockConfig);
		const result = await service.checkCompatibility("test-value", '{"type":"string"}');
		expect(result).toEqual({ is_compatible: true });
	});

	test("getSubjectConfig returns compatibility level", async () => {
		mockFetch(200, { compatibilityLevel: "BACKWARD" });
		const service = new SchemaRegistryService(mockConfig);
		const result = await service.getSubjectConfig("orders-value");
		expect(result).toEqual({ compatibilityLevel: "BACKWARD" });
	});

	test("setSubjectConfig sends PUT and returns result", async () => {
		mockFetch(200, { compatibility: "FULL" });
		const service = new SchemaRegistryService(mockConfig);
		const result = await service.setSubjectConfig("FULL", "orders-value");
		expect(result).toEqual({ compatibility: "FULL" });
	});

	test("deleteSubject returns deleted versions", async () => {
		mockFetch(200, [1, 2, 3]);
		const service = new SchemaRegistryService(mockConfig);
		const result = await service.deleteSubject("orders-value");
		expect(result).toEqual([1, 2, 3]);
	});

	test("throws on non-OK response", async () => {
		mockFetch(404, "Subject not found");
		const service = new SchemaRegistryService(mockConfig);
		expect(service.listSubjects()).rejects.toThrow("Schema Registry error 404");
	});

	test("includes auth header when API credentials provided", async () => {
		mockFetch(200, []);
		const service = new SchemaRegistryService(mockConfigWithAuth);
		await service.listSubjects();
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		const headers = (fetchCall?.[1] as RequestInit)?.headers as Record<string, string>;
		expect(headers.Authorization).toStartWith("Basic ");
	});

	test("strips trailing slash from URL", () => {
		const configWithSlash = {
			schemaRegistry: { enabled: true, url: "http://localhost:8081/", apiKey: "", apiSecret: "" },
		} as AppConfig;
		mockFetch(200, []);
		const service = new SchemaRegistryService(configWithSlash);
		service.listSubjects();
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
		expect((fetchCall?.[0] as string).includes("//subjects")).toBe(false);
	});
});
