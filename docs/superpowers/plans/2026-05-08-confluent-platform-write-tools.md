# Confluent Platform Write Tools + REST Proxy Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Linear:** [SIO-682](https://linear.app/siobytes/issue/SIO-682/confluent-platform-write-tools-rest-proxy-integration)
**Spec:** `docs/superpowers/specs/2026-05-07-confluent-platform-write-tools-design.md`

**Goal:** Add 5 Connect write/destructive tools, 7 Schema Registry write/destructive tools, and 9 REST Proxy v2 tools (full integration: metadata, produce, consumer lifecycle) to `packages/mcp-server-kafka/`, gated by existing `kafka.allowWrites` / `kafka.allowDestructive` flags. Forward `RESTPROXY_*` env vars from `deploy.sh`.

**Architecture:** Pure additive. Edit existing `connect-service.ts` and `schema-registry-service.ts` to add write methods. Create new `restproxy-service.ts` mirroring `connect-service.ts` shape exactly. Mirror existing tools/connect, tools/ksql layout for tools/restproxy. Extend config schemas/defaults/envMapping/loader for restproxy. Conditional registration in `tools/index.ts` based on the gating flags.

**Tech Stack:** Bun, TypeScript strict, Zod, native fetch. No new dependencies.

---

## Component 1: Connect writes (5 tools)

### Task B1.1: Add 5 write methods to connect-service.ts

**Files:**
- Modify: `packages/mcp-server-kafka/src/services/connect-service.ts`
- Test: `packages/mcp-server-kafka/tests/services/connect-service-writes.test.ts` (new)

- [ ] **Step 1: Write failing tests**

```ts
// packages/mcp-server-kafka/tests/services/connect-service-writes.test.ts
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { ConnectService } from "../../src/services/connect-service";
import type { AppConfig } from "../../src/config/schemas";

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
    expect(call[0]).toBe(
      "http://connect:8083/connectors/orders-sink/restart?includeTasks=true&onlyFailed=true",
    );
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

  test("throws on non-OK with status in message", async () => {
    mockFetch(500, "boom");
    const svc = new ConnectService(baseConfig);
    await expect(svc.pauseConnector("x")).rejects.toThrow(/Kafka Connect error 500/);
  });
});
```

- [ ] **Step 2: Run, verify failures**

- [ ] **Step 3: Implement the 5 write methods**

In `packages/mcp-server-kafka/src/services/connect-service.ts`, append (the existing read methods end around line 76):

```ts
async pauseConnector(name: string): Promise<void> {
  await this.request<void>("PUT", `/connectors/${encodeURIComponent(name)}/pause`);
}

async resumeConnector(name: string): Promise<void> {
  await this.request<void>("PUT", `/connectors/${encodeURIComponent(name)}/resume`);
}

async restartConnector(
  name: string,
  options?: { includeTasks?: boolean; onlyFailed?: boolean },
): Promise<void> {
  const qs: string[] = [];
  if (options?.includeTasks !== undefined) qs.push(`includeTasks=${options.includeTasks}`);
  if (options?.onlyFailed !== undefined) qs.push(`onlyFailed=${options.onlyFailed}`);
  const path = `/connectors/${encodeURIComponent(name)}/restart${qs.length ? `?${qs.join("&")}` : ""}`;
  await this.request<void>("POST", path);
}

async restartConnectorTask(name: string, taskId: number): Promise<void> {
  await this.request<void>(
    "POST",
    `/connectors/${encodeURIComponent(name)}/tasks/${taskId}/restart`,
  );
}

async deleteConnector(name: string): Promise<void> {
  await this.request<void>("DELETE", `/connectors/${encodeURIComponent(name)}`);
}
```

The existing `request<T>` already returns `undefined as T` for 204 (line 90).

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-kafka/src/services/connect-service.ts \
        packages/mcp-server-kafka/tests/services/connect-service-writes.test.ts
git commit -m "SIO-682: add Connect write methods (pause/resume/restart/delete)"
```

### Task B1.2: Register 5 Connect write tools (gated)

**Files:**
- Modify: `packages/mcp-server-kafka/src/tools/connect/parameters.ts`
- Modify: `packages/mcp-server-kafka/src/tools/connect/prompts.ts`
- Modify: `packages/mcp-server-kafka/src/tools/connect/operations.ts`
- Modify: `packages/mcp-server-kafka/src/tools/connect/tools.ts`
- Modify: `packages/mcp-server-kafka/src/tools/index.ts` (tool count)
- Test: `packages/mcp-server-kafka/tests/tools/connect-tools.test.ts` (new)

- [ ] **Step 1: Write failing tool-registration tests**

```ts
// packages/mcp-server-kafka/tests/tools/connect-tools.test.ts
import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../../src/tools";
import type { AppConfig } from "../../src/config/schemas";
import { ConnectService } from "../../src/services/connect-service";

function buildConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    kafka: { allowWrites: false, allowDestructive: false } as never,
    connect: { enabled: true, url: "http://x", apiKey: "", apiSecret: "" },
    schemaRegistry: { enabled: false, url: "", apiKey: "", apiSecret: "" } as never,
    ksql: { enabled: false, endpoint: "", apiKey: "", apiSecret: "" } as never,
    restproxy: { enabled: false, url: "", apiKey: "", apiSecret: "" } as never,
    ...over,
  } as AppConfig;
}

describe("Connect tool registration gating", () => {
  test("read-only when allowWrites=false", () => {
    const server = new McpServer({ name: "test", version: "0" });
    const config = buildConfig();
    registerTools(server, config, { connectService: new ConnectService(config) });
    const tools = listToolNames(server);
    expect(tools).toContain("connect_get_cluster_info");
    expect(tools).not.toContain("connect_pause_connector");
    expect(tools).not.toContain("connect_delete_connector");
  });

  test("writes registered when allowWrites=true, destructive still gated", () => {
    const server = new McpServer({ name: "test", version: "0" });
    const config = buildConfig({ kafka: { allowWrites: true, allowDestructive: false } as never });
    registerTools(server, config, { connectService: new ConnectService(config) });
    const tools = listToolNames(server);
    expect(tools).toContain("connect_pause_connector");
    expect(tools).toContain("connect_resume_connector");
    expect(tools).toContain("connect_restart_connector");
    expect(tools).not.toContain("connect_restart_connector_task");
    expect(tools).not.toContain("connect_delete_connector");
  });

  test("all writes + destructives registered when both flags true", () => {
    const server = new McpServer({ name: "test", version: "0" });
    const config = buildConfig({
      kafka: { allowWrites: true, allowDestructive: true } as never,
    });
    registerTools(server, config, { connectService: new ConnectService(config) });
    const tools = listToolNames(server);
    expect(tools).toContain("connect_pause_connector");
    expect(tools).toContain("connect_restart_connector_task");
    expect(tools).toContain("connect_delete_connector");
  });
});

function listToolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: object })._registeredTools);
}
```

- [ ] **Step 2: Run tests, verify they fail**

- [ ] **Step 3: Add Zod parameters**

In `packages/mcp-server-kafka/src/tools/connect/parameters.ts`, append:

```ts
export const ConnectPauseConnectorParams = z.object({
  name: z.string().min(1).describe("Connector name to pause"),
});
export const ConnectResumeConnectorParams = z.object({
  name: z.string().min(1).describe("Connector name to resume"),
});
export const ConnectRestartConnectorParams = z.object({
  name: z.string().min(1).describe("Connector name to restart"),
  includeTasks: z
    .boolean()
    .optional()
    .describe("Whether to also restart the connector's tasks. Default: false."),
  onlyFailed: z
    .boolean()
    .optional()
    .describe("If includeTasks is true, restart only FAILED tasks instead of all. Default: false."),
});
export const ConnectRestartConnectorTaskParams = z.object({
  name: z.string().min(1).describe("Connector name owning the task"),
  taskId: z.number().int().nonnegative().describe("Task ID to restart"),
});
export const ConnectDeleteConnectorParams = z.object({
  name: z.string().min(1).describe("Connector name to delete (irreversible)"),
});
```

- [ ] **Step 4: Add prompts**

In `packages/mcp-server-kafka/src/tools/connect/prompts.ts`, append:

```ts
export const CONNECT_PAUSE_CONNECTOR_DESCRIPTION =
  "Pause a running connector. Stops new task work; tasks already running finish in-flight. Reversible via connect_resume_connector.";
export const CONNECT_RESUME_CONNECTOR_DESCRIPTION = "Resume a paused connector.";
export const CONNECT_RESTART_CONNECTOR_DESCRIPTION =
  "Restart a connector and optionally its tasks. Use this when connect_get_connector_status reports FAILED state. Pass includeTasks=true to restart tasks too; pass onlyFailed=true to limit to FAILED tasks.";
export const CONNECT_RESTART_CONNECTOR_TASK_DESCRIPTION =
  "Restart a single task on a connector. Drops in-flight messages on that task — destructive at the message level. Prefer connect_restart_connector with onlyFailed=true unless targeting one specific task.";
export const CONNECT_DELETE_CONNECTOR_DESCRIPTION =
  "Permanently delete a connector. Irreversible — config and offsets are gone unless externally backed up.";
```

- [ ] **Step 5: Add operation wrappers**

In `packages/mcp-server-kafka/src/tools/connect/operations.ts`, append:

```ts
export async function pauseConnector(service: ConnectService, args: { name: string }) {
  await service.pauseConnector(args.name);
  return { paused: args.name };
}
export async function resumeConnector(service: ConnectService, args: { name: string }) {
  await service.resumeConnector(args.name);
  return { resumed: args.name };
}
export async function restartConnector(
  service: ConnectService,
  args: { name: string; includeTasks?: boolean; onlyFailed?: boolean },
) {
  await service.restartConnector(args.name, {
    includeTasks: args.includeTasks,
    onlyFailed: args.onlyFailed,
  });
  return { restarted: args.name, includeTasks: args.includeTasks ?? false };
}
export async function restartConnectorTask(
  service: ConnectService,
  args: { name: string; taskId: number },
) {
  await service.restartConnectorTask(args.name, args.taskId);
  return { restarted: args.name, taskId: args.taskId };
}
export async function deleteConnector(service: ConnectService, args: { name: string }) {
  await service.deleteConnector(args.name);
  return { deleted: args.name };
}
```

- [ ] **Step 6: Register tools conditionally in tools.ts**

In `packages/mcp-server-kafka/src/tools/connect/tools.ts`, after the existing 4 read tool registrations, add:

```ts
if (config.kafka.allowWrites) {
  server.tool(
    "connect_pause_connector",
    prompts.CONNECT_PAUSE_CONNECTOR_DESCRIPTION,
    params.ConnectPauseConnectorParams.shape,
    wrapHandler("connect_pause_connector", config, async (args) => {
      const result = await ops.pauseConnector(service, args);
      return ResponseBuilder.success(result);
    }),
  );
  server.tool(
    "connect_resume_connector",
    prompts.CONNECT_RESUME_CONNECTOR_DESCRIPTION,
    params.ConnectResumeConnectorParams.shape,
    wrapHandler("connect_resume_connector", config, async (args) => {
      const result = await ops.resumeConnector(service, args);
      return ResponseBuilder.success(result);
    }),
  );
  server.tool(
    "connect_restart_connector",
    prompts.CONNECT_RESTART_CONNECTOR_DESCRIPTION,
    params.ConnectRestartConnectorParams.shape,
    wrapHandler("connect_restart_connector", config, async (args) => {
      const result = await ops.restartConnector(service, args);
      return ResponseBuilder.success(result);
    }),
  );
}

if (config.kafka.allowDestructive) {
  server.tool(
    "connect_restart_connector_task",
    prompts.CONNECT_RESTART_CONNECTOR_TASK_DESCRIPTION,
    params.ConnectRestartConnectorTaskParams.shape,
    wrapHandler("connect_restart_connector_task", config, async (args) => {
      const result = await ops.restartConnectorTask(service, args);
      return ResponseBuilder.success(result);
    }),
  );
  server.tool(
    "connect_delete_connector",
    prompts.CONNECT_DELETE_CONNECTOR_DESCRIPTION,
    params.ConnectDeleteConnectorParams.shape,
    wrapHandler("connect_delete_connector", config, async (args) => {
      const result = await ops.deleteConnector(service, args);
      return ResponseBuilder.success(result);
    }),
  );
}
```

- [ ] **Step 7: Update tool count in tools/index.ts**

Existing line 53–56 reads:

```ts
const toolCount =
  15 + (options?.schemaRegistryService ? 8 : 0) + (options?.ksqlService ? 7 : 0) + (options?.connectService ? 4 : 0);
```

Change to:

```ts
const connectWrites = options?.connectService && config.kafka.allowWrites ? 3 : 0;
const connectDestructive = options?.connectService && config.kafka.allowDestructive ? 2 : 0;
const toolCount =
  15 +
  (options?.schemaRegistryService ? 8 : 0) +
  (options?.ksqlService ? 7 : 0) +
  (options?.connectService ? 4 : 0) +
  connectWrites +
  connectDestructive;
```

`config` must already be in scope inside `registerTools`. If not, thread it through.

- [ ] **Step 8: Run tests, verify pass**

- [ ] **Step 9: Commit**

```bash
git add packages/mcp-server-kafka/src/tools/connect/ \
        packages/mcp-server-kafka/src/tools/index.ts \
        packages/mcp-server-kafka/tests/tools/connect-tools.test.ts
git commit -m "SIO-682: register 5 Connect write/destructive tools (gated)"
```

---

## Component 2: Schema Registry writes (7 tools)

### Task B2.1: Add 7 write methods to schema-registry-service.ts

**Files:**
- Modify: `packages/mcp-server-kafka/src/services/schema-registry-service.ts`
- Test: `packages/mcp-server-kafka/tests/services/schema-registry-writes.test.ts` (new)

The probe found that `registerSchema` and `checkCompatibility` already exist on the service. The implementer **must verify** their current shape and either reuse them or add what's missing. Do not duplicate.

- [ ] **Step 1: Read current state**

Read `packages/mcp-server-kafka/src/services/schema-registry-service.ts`. List which of the 7 spec methods already exist:
- `registerSchema(subject, schema, schemaType?)` — probe says exists; verify signature matches spec.
- `checkCompatibility(subject, version, schema)` — probe says exists; verify.
- `getCompatibility(subject?)` — verify.
- `setCompatibility(level, subject?)` — likely missing.
- `softDeleteSubject(subject)` — likely missing.
- `softDeleteSubjectVersion(subject, version)` — likely missing.
- `hardDeleteSubject(subject)` — likely missing.
- `hardDeleteSubjectVersion(subject, version)` — likely missing.

For each method that already exists with a matching signature: skip its addition, but write a regression test if none exists.

For each missing method: implement per spec.

- [ ] **Step 2: Write failing tests for the missing methods**

```ts
// packages/mcp-server-kafka/tests/services/schema-registry-writes.test.ts
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
```

- [ ] **Step 3: Run, verify failures**

- [ ] **Step 4: Implement missing methods**

Append to `schema-registry-service.ts` (only methods not already present):

```ts
async setCompatibility(
  level: "BACKWARD" | "BACKWARD_TRANSITIVE" | "FORWARD" | "FORWARD_TRANSITIVE" | "FULL" | "FULL_TRANSITIVE" | "NONE",
  subject?: string,
): Promise<{ compatibility: string }> {
  const path = subject ? `/config/${encodeURIComponent(subject)}` : "/config";
  return this.request<{ compatibility: string }>("PUT", path, { compatibility: level });
}

async softDeleteSubject(subject: string): Promise<number[]> {
  return this.request<number[]>("DELETE", `/subjects/${encodeURIComponent(subject)}`);
}

async softDeleteSubjectVersion(subject: string, version: string | number): Promise<number> {
  return this.request<number>(
    "DELETE",
    `/subjects/${encodeURIComponent(subject)}/versions/${encodeURIComponent(String(version))}`,
  );
}

async hardDeleteSubject(subject: string): Promise<number[]> {
  return this.request<number[]>(
    "DELETE",
    `/subjects/${encodeURIComponent(subject)}?permanent=true`,
  );
}

async hardDeleteSubjectVersion(subject: string, version: string | number): Promise<number> {
  return this.request<number>(
    "DELETE",
    `/subjects/${encodeURIComponent(subject)}/versions/${encodeURIComponent(String(version))}?permanent=true`,
  );
}
```

For `getCompatibility` (read but listed in spec for completeness): if not present, add. If present, ensure it accepts an optional `subject` and routes to `/config/{subject}` vs `/config`.

For `registerSchema` and `checkCompatibility` (already present per probe): verify signatures match spec. If they don't (e.g., `registerSchema` doesn't accept `schemaType`), extend.

- [ ] **Step 5: Run tests, verify pass**

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server-kafka/src/services/schema-registry-service.ts \
        packages/mcp-server-kafka/tests/services/schema-registry-writes.test.ts
git commit -m "SIO-682: add Schema Registry write/destructive methods"
```

### Task B2.2: Register 7 SR tools (gated)

**Files:**
- Modify: `packages/mcp-server-kafka/src/tools/schema/parameters.ts`
- Modify: `packages/mcp-server-kafka/src/tools/schema/prompts.ts`
- Modify: `packages/mcp-server-kafka/src/tools/schema/operations.ts`
- Modify: `packages/mcp-server-kafka/src/tools/schema/tools.ts`
- Modify: `packages/mcp-server-kafka/src/tools/index.ts` (tool count)
- Test: `packages/mcp-server-kafka/tests/tools/schema-tools.test.ts` (new)

Same shape as B1.2 — write the gating tests first, then add zod params, prompts, ops, and conditional registrations. The tools to register:

| Tool | Gate |
|---|---|
| `sr_register_schema` | allowWrites |
| `sr_check_compatibility` | allowWrites |
| `sr_set_compatibility` | allowWrites |
| `sr_soft_delete_subject` | allowDestructive |
| `sr_soft_delete_subject_version` | allowDestructive |
| `sr_hard_delete_subject` | allowDestructive |
| `sr_hard_delete_subject_version` | allowDestructive |

- [ ] **Step 1: Write gating tests** mirroring `connect-tools.test.ts` structure for the 3 flag-combo cases.

- [ ] **Step 2: Run, verify fails.**

- [ ] **Step 3: Add Zod params for all 7 tools.** Use `.describe()` on every field, especially `level` (enum of 7 values) and `schemaType` (enum AVRO/JSON/PROTOBUF). For `version` use `z.union([z.string(), z.number().int()])`.

- [ ] **Step 4: Add prompts.** For destructive tools, the prompt explicitly says "Schema Registry returns 404 if you try to hard-delete without first soft-deleting; this tool will not auto-sequence" — per spec.

- [ ] **Step 5: Add operation wrappers** following the same pattern as B1.2 step 5.

- [ ] **Step 6: Conditionally register in `schema/tools.ts`** — `allowWrites` group: register, check_compat, set_compat. `allowDestructive` group: 4 deletes.

- [ ] **Step 7: Update tool count in `tools/index.ts`:**

```ts
const srWrites = options?.schemaRegistryService && config.kafka.allowWrites ? 3 : 0;
const srDestructive = options?.schemaRegistryService && config.kafka.allowDestructive ? 4 : 0;
const toolCount =
  15 +
  (options?.schemaRegistryService ? 8 : 0) +
  (options?.ksqlService ? 7 : 0) +
  (options?.connectService ? 4 : 0) +
  connectWrites +
  connectDestructive +
  srWrites +
  srDestructive;
```

- [ ] **Step 8: Run tests, verify pass.**

- [ ] **Step 9: Commit**

```bash
git add packages/mcp-server-kafka/src/tools/schema/ \
        packages/mcp-server-kafka/src/tools/index.ts \
        packages/mcp-server-kafka/tests/tools/schema-tools.test.ts
git commit -m "SIO-682: register 7 Schema Registry write/destructive tools (gated)"
```

---

## Component 3: REST Proxy (full integration, 9 tools)

### Task B3.1: Add restproxy config block

**Files:**
- Modify: `packages/mcp-server-kafka/src/config/schemas.ts`
- Modify: `packages/mcp-server-kafka/src/config/defaults.ts`
- Modify: `packages/mcp-server-kafka/src/config/envMapping.ts`
- Modify: `packages/mcp-server-kafka/src/config/loader.ts`
- Test: `packages/mcp-server-kafka/tests/config/restproxy-config.test.ts` (new)

- [ ] **Step 1: Write failing tests for the config block**

```ts
// packages/mcp-server-kafka/tests/config/restproxy-config.test.ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/loader";

describe("restproxy config", () => {
  test("disabled by default", () => {
    const config = loadConfig({});
    expect(config.restproxy.enabled).toBe(false);
  });

  test("RESTPROXY_ENABLED=true wires the block", () => {
    const config = loadConfig({
      RESTPROXY_ENABLED: "true",
      RESTPROXY_URL: "http://kafka-rest:8082",
    });
    expect(config.restproxy.enabled).toBe(true);
    expect(config.restproxy.url).toBe("http://kafka-rest:8082");
  });

  test("RESTPROXY_ENABLED=true with empty URL fails validation", () => {
    expect(() => loadConfig({ RESTPROXY_ENABLED: "true", RESTPROXY_URL: "" })).toThrow();
  });

  test("Basic auth credentials accepted", () => {
    const config = loadConfig({
      RESTPROXY_ENABLED: "true",
      RESTPROXY_URL: "http://x:8082",
      RESTPROXY_API_KEY: "k",
      RESTPROXY_API_SECRET: "s",
    });
    expect(config.restproxy.apiKey).toBe("k");
    expect(config.restproxy.apiSecret).toBe("s");
  });
});
```

- [ ] **Step 2: Run, verify fails.**

- [ ] **Step 3: Add `restproxySchema` to `schemas.ts`**

After `connectSchema` (line 87+), add:

```ts
export const restproxySchema = z
  .object({
    enabled: z.boolean().describe("Whether REST Proxy integration is enabled"),
    url: z.string().describe("REST Proxy URL (e.g., http://kafka-rest:8082 for self-hosted)"),
    apiKey: z.string().describe("REST Proxy API key for basic auth. Leave empty for self-hosted no-auth deployments. Set for Confluent Cloud."),
    apiSecret: z.string().describe("REST Proxy API secret for basic auth. Leave empty for self-hosted no-auth deployments. Set for Confluent Cloud."),
  })
  .strict();
```

Then add `restproxy: restproxySchema` to the top-level config schema where `connect: connectSchema` and `ksql: ksqlSchema` are wired. Update the `superRefine` (or add one if needed) to enforce `restproxy.enabled === true => restproxy.url !== ""`.

- [ ] **Step 4: Add defaults block in `defaults.ts`**

```ts
restproxy: { enabled: false, url: "http://localhost:8082", apiKey: "", apiSecret: "" },
```

- [ ] **Step 5: Add env mappings in `envMapping.ts`**

```ts
RESTPROXY_ENABLED: "restproxy.enabled",
RESTPROXY_URL: "restproxy.url",
RESTPROXY_API_KEY: "restproxy.apiKey",
RESTPROXY_API_SECRET: "restproxy.apiSecret",
```

- [ ] **Step 6: Add `"restproxy.enabled"` to `booleanPaths` in `loader.ts`**

```ts
const booleanPaths = new Set([
  "kafka.allowWrites",
  "kafka.allowDestructive",
  "schemaRegistry.enabled",
  "ksql.enabled",
  "connect.enabled",
  "restproxy.enabled",
  "telemetry.enabled",
]);
```

- [ ] **Step 7: Run tests, verify pass.**

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-server-kafka/src/config/ \
        packages/mcp-server-kafka/tests/config/restproxy-config.test.ts
git commit -m "SIO-682: add restproxy config block with validation"
```

### Task B3.2: Implement `RestProxyService`

**Files:**
- Create: `packages/mcp-server-kafka/src/services/restproxy-service.ts`
- Test: `packages/mcp-server-kafka/tests/services/restproxy-service.test.ts` (new)

- [ ] **Step 1: Write failing tests for all 10 methods**

```ts
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
```

- [ ] **Step 2: Run, verify fails (module missing).**

- [ ] **Step 3: Implement `restproxy-service.ts`**

```ts
// packages/mcp-server-kafka/src/services/restproxy-service.ts
import type { AppConfig } from "../config/schemas";

const REST_PROXY_V2_CONTENT_TYPE = "application/vnd.kafka.json.v2+json";

export class RestProxyService {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: AppConfig) {
    this.baseUrl = config.restproxy.url.replace(/\/$/, "");
    this.headers = {
      "Content-Type": REST_PROXY_V2_CONTENT_TYPE,
      Accept: REST_PROXY_V2_CONTENT_TYPE,
    };
    if (config.restproxy.apiKey && config.restproxy.apiSecret) {
      this.headers.Authorization = `Basic ${btoa(`${config.restproxy.apiKey}:${config.restproxy.apiSecret}`)}`;
    }
  }

  async listTopics(): Promise<string[]> {
    return this.request<string[]>("GET", "/topics");
  }

  async getTopic(name: string): Promise<{
    name: string;
    configs: Record<string, string>;
    partitions: Array<{ partition: number; leader: number; replicas: Array<unknown> }>;
  }> {
    return this.request("GET", `/topics/${encodeURIComponent(name)}`);
  }

  async getPartitions(topic: string): Promise<
    Array<{ partition: number; leader: number; replicas: Array<{ broker: number; leader: boolean; in_sync: boolean }> }>
  > {
    return this.request("GET", `/topics/${encodeURIComponent(topic)}/partitions`);
  }

  async produceMessages(
    topic: string,
    records: Array<{ key?: unknown; value: unknown; partition?: number }>,
    _format: "json" | "binary" = "json",
  ): Promise<{
    key_schema_id?: number;
    value_schema_id?: number;
    offsets: Array<{ partition: number; offset: number; error_code?: number; error?: string }>;
  }> {
    return this.request("POST", `/topics/${encodeURIComponent(topic)}`, { records });
  }

  async createConsumer(
    group: string,
    options?: {
      name?: string;
      format?: "json" | "binary";
      autoOffsetReset?: "earliest" | "latest";
      autoCommitEnable?: boolean;
    },
  ): Promise<{ instance_id: string; base_uri: string }> {
    const body: Record<string, unknown> = {};
    if (options?.name) body.name = options.name;
    if (options?.format) body.format = options.format;
    if (options?.autoOffsetReset) body["auto.offset.reset"] = options.autoOffsetReset;
    if (options?.autoCommitEnable !== undefined) body["auto.commit.enable"] = String(options.autoCommitEnable);
    return this.request("POST", `/consumers/${encodeURIComponent(group)}`, body);
  }

  async subscribe(group: string, instance: string, topics: string[]): Promise<void> {
    await this.request<void>(
      "POST",
      `/consumers/${encodeURIComponent(group)}/instances/${encodeURIComponent(instance)}/subscription`,
      { topics },
    );
  }

  async consumeRecords(
    group: string,
    instance: string,
    options?: { timeoutMs?: number; maxBytes?: number },
  ): Promise<Array<{ topic: string; key?: unknown; value: unknown; partition: number; offset: number }>> {
    const qs: string[] = [];
    if (options?.timeoutMs !== undefined) qs.push(`timeout=${options.timeoutMs}`);
    if (options?.maxBytes !== undefined) qs.push(`max_bytes=${options.maxBytes}`);
    const path = `/consumers/${encodeURIComponent(group)}/instances/${encodeURIComponent(instance)}/records${qs.length ? `?${qs.join("&")}` : ""}`;
    return this.request("GET", path);
  }

  async commitOffsets(
    group: string,
    instance: string,
    offsets?: Array<{ topic: string; partition: number; offset: number }>,
  ): Promise<void> {
    await this.request<void>(
      "POST",
      `/consumers/${encodeURIComponent(group)}/instances/${encodeURIComponent(instance)}/offsets`,
      offsets ? { offsets } : undefined,
    );
  }

  async deleteConsumer(group: string, instance: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/consumers/${encodeURIComponent(group)}/instances/${encodeURIComponent(instance)}`,
    );
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = { method, headers: this.headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      throw new Error(`REST Proxy error ${response.status}: ${errorBody}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
```

- [ ] **Step 4: Run tests, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-kafka/src/services/restproxy-service.ts \
        packages/mcp-server-kafka/tests/services/restproxy-service.test.ts
git commit -m "SIO-682: add RestProxyService (v2 metadata/produce/consumer lifecycle)"
```

### Task B3.3: Add 9 REST Proxy tools

**Files:**
- Create: `packages/mcp-server-kafka/src/tools/restproxy/parameters.ts`
- Create: `packages/mcp-server-kafka/src/tools/restproxy/prompts.ts`
- Create: `packages/mcp-server-kafka/src/tools/restproxy/operations.ts`
- Create: `packages/mcp-server-kafka/src/tools/restproxy/tools.ts`
- Modify: `packages/mcp-server-kafka/src/tools/index.ts`
- Test: `packages/mcp-server-kafka/tests/tools/restproxy-tools.test.ts` (new)

- [ ] **Step 1: Write failing gating tests** mirroring connect/sr structure for the four flag combos:
  - (`enabled=false`, `*`): no restproxy_* tools
  - (`enabled=true`, `allowWrites=false`): only the 3 metadata reads
  - (`enabled=true`, `allowWrites=true`): all 9 tools

- [ ] **Step 2: Add Zod params, prompts, operations** for all 9 tools:
  - `restproxy_list_topics` — `z.object({})`
  - `restproxy_get_topic` — `{ name }`
  - `restproxy_get_partitions` — `{ topic }`
  - `restproxy_produce` — `{ topic, records: z.array(z.object({ key: z.unknown().optional(), value: z.unknown(), partition: z.number().int().nonnegative().optional() })), format: z.enum(["json","binary"]).optional() }`
  - `restproxy_create_consumer` — `{ group, name?, format?, autoOffsetReset?, autoCommitEnable? }`
  - `restproxy_subscribe` — `{ group, instance, topics: z.array(z.string().min(1)).min(1) }`
  - `restproxy_consume` — `{ group, instance, timeoutMs?, maxBytes? }`
  - `restproxy_commit_offsets` — `{ group, instance, offsets?: z.array(z.object({ topic, partition, offset })) }`
  - `restproxy_delete_consumer` — `{ group, instance }`

For prompts: each must reference the next-expected step in the consumer lifecycle. `create_consumer` must mention REST Proxy's idle-timeout cleanup safety net (~5 min).

- [ ] **Step 3: Register tools conditionally in `restproxy/tools.ts`**

3 reads register unconditionally (the service alone is the gate — when the service is undefined, none register). The other 6 register when `config.kafka.allowWrites === true`.

- [ ] **Step 4: Update `tools/index.ts`**

Add to `ToolRegistrationOptions`:
```ts
restProxyService?: RestProxyService;
```

Update tool count:
```ts
const restProxyReads = options?.restProxyService ? 3 : 0;
const restProxyWrites = options?.restProxyService && config.kafka.allowWrites ? 6 : 0;
const toolCount =
  15 +
  (options?.schemaRegistryService ? 8 : 0) +
  (options?.ksqlService ? 7 : 0) +
  (options?.connectService ? 4 : 0) +
  connectWrites +
  connectDestructive +
  srWrites +
  srDestructive +
  restProxyReads +
  restProxyWrites;
```

Wire `restProxyService` into the registration call so `restproxy/tools.ts` is invoked when the service is present.

- [ ] **Step 5: Run tests, verify pass.**

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server-kafka/src/tools/restproxy/ \
        packages/mcp-server-kafka/src/tools/index.ts \
        packages/mcp-server-kafka/tests/tools/restproxy-tools.test.ts
git commit -m "SIO-682: register 9 REST Proxy tools (3 reads + 6 writes gated)"
```

### Task B3.4: Instantiate RestProxyService in src/index.ts

**Files:**
- Modify: `packages/mcp-server-kafka/src/index.ts`

- [ ] **Step 1: Mirror the existing ConnectService instantiation block**

The probe found at lines 97–99:

```ts
if (config.connect.enabled) {
  toolOptions.connectService = new ConnectService(config);
  logger.info({ url: config.connect.url }, "Kafka Connect enabled");
}
```

Add (alongside ksql/connect):

```ts
if (config.restproxy.enabled) {
  toolOptions.restProxyService = new RestProxyService(config);
  logger.info({ url: config.restproxy.url }, "REST Proxy enabled");
}
```

Plus the import.

- [ ] **Step 2: Run typecheck + full test suite.**

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server-kafka/src/index.ts
git commit -m "SIO-682: instantiate RestProxyService when restproxy.enabled"
```

### Task B3.5: Forward RESTPROXY_* in deploy.sh

**Files:**
- Modify: `scripts/agentcore/deploy.sh`

- [ ] **Step 1: Add the forwarding block**

Inside the kafka case (where the existing CONNECT block lives at lines 335–346), append:

```bash
if [ -n "${RESTPROXY_ENABLED:-}" ]; then
  ENV_VARS="${ENV_VARS},RESTPROXY_ENABLED=${RESTPROXY_ENABLED}"
fi
if [ -n "${RESTPROXY_URL:-}" ]; then
  ENV_VARS="${ENV_VARS},RESTPROXY_URL=${RESTPROXY_URL}"
fi
if [ -n "${RESTPROXY_API_KEY:-}" ]; then
  ENV_VARS="${ENV_VARS},RESTPROXY_API_KEY=${RESTPROXY_API_KEY}"
fi
if [ -n "${RESTPROXY_API_SECRET:-}" ]; then
  ENV_VARS="${ENV_VARS},RESTPROXY_API_SECRET=${RESTPROXY_API_SECRET}"
fi
```

- [ ] **Step 2: Eyeball-diff against the existing CONNECT block** — confirm same shape, semicolons, indentation.

- [ ] **Step 3: Commit**

```bash
git add scripts/agentcore/deploy.sh
git commit -m "SIO-682: forward RESTPROXY_* env vars from deploy.sh"
```

---

## Task B4: End-to-end verification

- [ ] **Step 1: Full package test + lint + typecheck**

Run in parallel:
- `bun run --filter @devops-agent/mcp-server-kafka test`
- `bun run --filter @devops-agent/mcp-server-kafka typecheck`
- `bun run lint`

Expected: all pass.

- [ ] **Step 2: Local MCP smoke**

Start the kafka-mcp server with combinations of env flags and confirm `tools/list` returns expected counts:

```bash
# Combo 1: nothing extra
KAFKA_PROVIDER=local bun run --filter @devops-agent/mcp-server-kafka dev
# expected: 15 tools

# Combo 2: connect read-only
KAFKA_PROVIDER=local CONNECT_ENABLED=true CONNECT_URL=http://x:8083 bun run ...
# expected: 19 tools (15 + 4)

# Combo 3: connect + writes
KAFKA_PROVIDER=local CONNECT_ENABLED=true CONNECT_URL=http://x:8083 KAFKA_ALLOW_WRITES=true bun run ...
# expected: 22 tools (15 + 4 + 3)

# Combo 4: connect + writes + destructive
KAFKA_PROVIDER=local CONNECT_ENABLED=true CONNECT_URL=http://x:8083 KAFKA_ALLOW_WRITES=true KAFKA_ALLOW_DESTRUCTIVE=true bun run ...
# expected: 24 tools (15 + 4 + 3 + 2)

# Combo 5: full Confluent stack
KAFKA_PROVIDER=local CONNECT_ENABLED=true CONNECT_URL=http://x:8083 \
  SCHEMA_REGISTRY_ENABLED=true SCHEMA_REGISTRY_URL=http://x:8081 \
  KSQL_ENABLED=true KSQL_ENDPOINT=http://x:8088 \
  RESTPROXY_ENABLED=true RESTPROXY_URL=http://x:8082 \
  KAFKA_ALLOW_WRITES=true KAFKA_ALLOW_DESTRUCTIVE=true bun run ...
# expected: 15 + 8 + 7 + 4 + 3 + 2 + 3 + 4 + 9 = 55 tools
```

- [ ] **Step 3: AgentCore deploy + tools/list**

After `scripts/agentcore/deploy.sh kafka` redeploy, hit `tools/list` against the AgentCore endpoint and verify the count matches.

- [ ] **Step 4: Live integration smoke (optional, requires reachable Confluent)**

Call `connect_pause_connector` against a known test connector → 202; immediately `connect_get_connector_status` → `state: "PAUSED"`. Reverse with `connect_resume_connector`. For SR: `sr_register_schema` then `sr_check_compatibility`. For REST Proxy: `restproxy_produce` to a test topic, then `restproxy_list_topics` confirms it.

- [ ] **Step 5: Open PR**

Title: `SIO-682: Confluent Platform write tools + REST Proxy integration`
Body: link the spec; tool counts; gating model summary; deploy.sh changes.
