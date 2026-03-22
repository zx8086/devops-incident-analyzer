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

  test("throws on non-OK response", async () => {
    mockFetch(400, "Bad request");
    const service = new KsqlService(mockConfig);
    expect(service.getServerInfo()).rejects.toThrow("ksqlDB error 400");
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
});
