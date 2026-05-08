// tests/services/schema-registry-writes.test.ts
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { SchemaRegistryService } from "../../src/services/schema-registry-service";
import type { AppConfig } from "../../src/config/schemas";

let originalFetch: typeof globalThis.fetch;
const baseConfig = {
  schemaRegistry: { enabled: true, url: "http://sr:8081", apiKey: "", apiSecret: "" },
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

describe("SchemaRegistryService — writes (additions)", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("setCompatibility(level) PUTs /config", async () => {
    mockFetch(200, { compatibility: "BACKWARD" });
    const svc = new SchemaRegistryService(baseConfig);
    const out = await svc.setCompatibility("BACKWARD");
    expect(out).toEqual({ compatibility: "BACKWARD" });
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://sr:8081/config");
    expect((call[1] as RequestInit).method).toBe("PUT");
  });

  test("setCompatibility(level, subject) PUTs /config/{subject}", async () => {
    mockFetch(200, { compatibility: "FULL" });
    const svc = new SchemaRegistryService(baseConfig);
    await svc.setCompatibility("FULL", "orders-value");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://sr:8081/config/orders-value");
  });

  test("softDeleteSubject DELETEs /subjects/{name}", async () => {
    mockFetch(200, [1, 2, 3]);
    const svc = new SchemaRegistryService(baseConfig);
    const versions = await svc.softDeleteSubject("orders-value");
    expect(versions).toEqual([1, 2, 3]);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://sr:8081/subjects/orders-value");
    expect((call[1] as RequestInit).method).toBe("DELETE");
  });

  test("softDeleteSubjectVersion targets specific version", async () => {
    mockFetch(200, 3);
    const svc = new SchemaRegistryService(baseConfig);
    const v = await svc.softDeleteSubjectVersion("orders-value", 3);
    expect(v).toBe(3);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://sr:8081/subjects/orders-value/versions/3");
  });

  test("hardDeleteSubject sends ?permanent=true", async () => {
    mockFetch(200, [1, 2, 3]);
    const svc = new SchemaRegistryService(baseConfig);
    await svc.hardDeleteSubject("orders-value");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://sr:8081/subjects/orders-value?permanent=true");
  });

  test("hardDeleteSubjectVersion sends ?permanent=true", async () => {
    mockFetch(200, 3);
    const svc = new SchemaRegistryService(baseConfig);
    await svc.hardDeleteSubjectVersion("orders-value", 3);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://sr:8081/subjects/orders-value/versions/3?permanent=true");
  });

  test("hardDelete on not-yet-soft-deleted surfaces 404", async () => {
    mockFetch(404, "Subject not soft-deleted");
    const svc = new SchemaRegistryService(baseConfig);
    await expect(svc.hardDeleteSubject("orders-value")).rejects.toThrow(/Schema Registry error 404/);
  });
});
