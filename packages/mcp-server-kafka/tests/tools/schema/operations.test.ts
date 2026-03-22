// tests/tools/schema/operations.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { SchemaRegistryService } from "../../../src/services/schema-registry-service.ts";
import * as ops from "../../../src/tools/schema/operations.ts";

function mockService(overrides: Partial<SchemaRegistryService> = {}): SchemaRegistryService {
  return {
    listSubjects: mock(() => Promise.resolve(["orders-value", "users-key"])),
    getSchemaVersions: mock(() => Promise.resolve([1, 2, 3])),
    getSchema: mock(() =>
      Promise.resolve({
        subject: "orders-value",
        id: 1,
        version: 1,
        schemaType: "AVRO",
        schema: "{}",
      }),
    ),
    getSchemaById: mock(() => Promise.resolve({ schema: "{}", schemaType: "AVRO" })),
    registerSchema: mock(() => Promise.resolve({ id: 42 })),
    checkCompatibility: mock(() => Promise.resolve({ is_compatible: true })),
    getSubjectConfig: mock(() => Promise.resolve({ compatibilityLevel: "BACKWARD" })),
    setSubjectConfig: mock(() => Promise.resolve({ compatibility: "FULL" })),
    deleteSubject: mock(() => Promise.resolve([1, 2])),
    ...overrides,
  } as unknown as SchemaRegistryService;
}

describe("schema operations", () => {
  test("listSchemas returns subjects with count", async () => {
    const service = mockService();
    const result = await ops.listSchemas(service);
    expect(result.subjects).toEqual(["orders-value", "users-key"]);
    expect(result.count).toBe(2);
  });

  test("getSchema defaults to latest version", async () => {
    const service = mockService();
    await ops.getSchema(service, { subject: "orders-value" });
    expect(service.getSchema).toHaveBeenCalledWith("orders-value", "latest");
  });

  test("getSchema passes explicit version", async () => {
    const service = mockService();
    await ops.getSchema(service, { subject: "orders-value", version: 2 });
    expect(service.getSchema).toHaveBeenCalledWith("orders-value", 2);
  });

  test("getSchemaVersions returns subject and versions", async () => {
    const service = mockService();
    const result = await ops.getSchemaVersions(service, { subject: "orders-value" });
    expect(result.subject).toBe("orders-value");
    expect(result.versions).toEqual([1, 2, 3]);
  });

  test("registerSchema defaults schemaType to AVRO", async () => {
    const service = mockService();
    const result = await ops.registerSchema(service, {
      subject: "test-value",
      schema: '{"type":"string"}',
    });
    expect(service.registerSchema).toHaveBeenCalledWith("test-value", '{"type":"string"}', "AVRO");
    expect(result.subject).toBe("test-value");
    expect(result.id).toBe(42);
  });

  test("checkCompatibility defaults to AVRO and latest", async () => {
    const service = mockService();
    await ops.checkCompatibility(service, {
      subject: "test-value",
      schema: '{"type":"string"}',
    });
    expect(service.checkCompatibility).toHaveBeenCalledWith(
      "test-value",
      '{"type":"string"}',
      "AVRO",
      "latest",
    );
  });

  test("getSchemaConfig returns global scope when no subject", async () => {
    const service = mockService();
    const result = await ops.getSchemaConfig(service, {});
    expect(result.scope).toBe("global");
  });

  test("getSchemaConfig returns subject scope when given", async () => {
    const service = mockService();
    const result = await ops.getSchemaConfig(service, { subject: "orders-value" });
    expect(result.scope).toBe("orders-value");
  });

  test("setSchemaConfig delegates to service", async () => {
    const service = mockService();
    const result = await ops.setSchemaConfig(service, {
      compatibilityLevel: "FULL",
      subject: "orders-value",
    });
    expect(service.setSubjectConfig).toHaveBeenCalledWith("FULL", "orders-value");
    expect(result.scope).toBe("orders-value");
  });

  test("deleteSchemaSubject defaults permanent to false", async () => {
    const service = mockService();
    const result = await ops.deleteSchemaSubject(service, { subject: "orders-value" });
    expect(service.deleteSubject).toHaveBeenCalledWith("orders-value", false);
    expect(result.permanent).toBe(false);
    expect(result.deletedVersions).toEqual([1, 2]);
  });

  test("deleteSchemaSubject passes permanent flag", async () => {
    const service = mockService();
    await ops.deleteSchemaSubject(service, { subject: "orders-value", permanent: true });
    expect(service.deleteSubject).toHaveBeenCalledWith("orders-value", true);
  });
});
