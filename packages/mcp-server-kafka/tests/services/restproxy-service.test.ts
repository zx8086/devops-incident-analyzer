// packages/mcp-server-kafka/tests/services/restproxy-service.test.ts
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { RestProxyService } from "../../src/services/restproxy-service";
import type { AppConfig } from "../../src/config/schemas";

let originalFetch: typeof globalThis.fetch;
const baseConfig = {
  restproxy: { enabled: true, url: "http://rest:8082", apiKey: "", apiSecret: "" },
} as unknown as AppConfig;

function mockFetch(status: number, body: unknown = "") {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/vnd.kafka.v2+json" },
      }),
    ),
  ) as unknown as typeof globalThis.fetch;
}

describe("RestProxyService", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("listTopics GETs /topics", async () => {
    mockFetch(200, ["a", "b"]);
    const svc = new RestProxyService(baseConfig);
    expect(await svc.listTopics()).toEqual(["a", "b"]);
  });

  test("getTopic GETs /topics/{name}", async () => {
    mockFetch(200, { name: "orders", configs: {}, partitions: [] });
    const svc = new RestProxyService(baseConfig);
    await svc.getTopic("orders");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://rest:8082/topics/orders");
  });

  test("produceMessages POSTs with v2 content-type", async () => {
    mockFetch(200, { offsets: [{ partition: 0, offset: 100 }] });
    const svc = new RestProxyService(baseConfig);
    await svc.produceMessages("orders", [{ value: { id: 1 } }]);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/vnd.kafka.json.v2+json");
    expect(JSON.parse(init.body as string)).toEqual({ records: [{ value: { id: 1 } }] });
  });

  test("createConsumer POSTs to /consumers/{group}", async () => {
    mockFetch(200, { instance_id: "i1", base_uri: "http://rest:8082/consumers/g1/instances/i1" });
    const svc = new RestProxyService(baseConfig);
    const out = await svc.createConsumer("g1", { name: "i1", format: "json" });
    expect(out.instance_id).toBe("i1");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://rest:8082/consumers/g1");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({ name: "i1", format: "json" });
  });

  test("subscribe POSTs to consumer subscription", async () => {
    mockFetch(204);
    const svc = new RestProxyService(baseConfig);
    await svc.subscribe("g1", "i1", ["orders"]);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://rest:8082/consumers/g1/instances/i1/subscription");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ topics: ["orders"] });
  });

  test("consumeRecords GETs /records", async () => {
    mockFetch(200, [{ topic: "orders", value: { id: 1 }, partition: 0, offset: 5 }]);
    const svc = new RestProxyService(baseConfig);
    const records = await svc.consumeRecords("g1", "i1");
    expect(records).toHaveLength(1);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://rest:8082/consumers/g1/instances/i1/records");
  });

  test("commitOffsets POSTs to /offsets", async () => {
    mockFetch(200);
    const svc = new RestProxyService(baseConfig);
    await svc.commitOffsets("g1", "i1");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://rest:8082/consumers/g1/instances/i1/offsets");
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  test("deleteConsumer DELETEs the instance", async () => {
    mockFetch(204);
    const svc = new RestProxyService(baseConfig);
    await svc.deleteConsumer("g1", "i1");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://rest:8082/consumers/g1/instances/i1");
    expect((call[1] as RequestInit).method).toBe("DELETE");
  });

  test("URL-encodes group and instance with special chars", async () => {
    mockFetch(204);
    const svc = new RestProxyService(baseConfig);
    await svc.deleteConsumer("group/1", "inst@a");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("http://rest:8082/consumers/group%2F1/instances/inst%40a");
  });

  test("no Authorization header when creds empty", async () => {
    mockFetch(200, ["a"]);
    const svc = new RestProxyService(baseConfig);
    await svc.listTopics();
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(new Headers((call[1] as RequestInit).headers).get("Authorization")).toBeNull();
  });

  test("Basic auth when creds provided", async () => {
    mockFetch(200, ["a"]);
    const svc = new RestProxyService({
      restproxy: { enabled: true, url: "http://rest:8082", apiKey: "k", apiSecret: "s" },
    } as unknown as AppConfig);
    await svc.listTopics();
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(new Headers((call[1] as RequestInit).headers).get("Authorization")).toBe(
      `Basic ${btoa("k:s")}`,
    );
  });
});
