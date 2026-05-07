# Confluent Platform Write & REST Proxy Tools — Design

## Context

SIO-680 added read-only MCP tools for Kafka Connect and forwarded the existing read-only Schema Registry tools through `deploy.sh`. Read coverage is now reasonable: 4 Connect read tools, 8 Schema Registry read tools, 7 ksqlDB read tools (the latter two pre-existed but weren't reaching the AgentCore deployment). What remains is a **coverage gap on writes and on Confluent REST Proxy**:

1. **Connect** has no write tools. When an incident playbook says *"if connector X is FAILED, restart it"*, the analyzer can identify the FAILED state (via `connect_get_connector_status`, shipped in SIO-680) but can't act on it. Operators have to leave the analyzer, run `curl` against the Connect REST API, then come back.
2. **Schema Registry** has no write tools. When schema-related incidents call for registering a corrected schema, raising a compatibility level temporarily, or cleaning up an orphaned subject, the same friction applies.
3. **Confluent REST Proxy** has no MCP integration at all (no `restproxy-service.ts`, no tools). The REST Proxy is a separate Confluent Platform component (`restproxy-service:8082`, on the *public* ALB `confluent-prd-alb`) used as the HTTP-fronted produce/consume path. Several use cases (replaying DLQ messages, injecting synthetic events, consuming from environments without broker-port reachability) require this path.

PVH runs all four Confluent components self-hosted on ECS in `confluent-prd` (eu-central-1), no application-layer auth. The MCP services already accept empty `apiKey`/`apiSecret` — the same pattern applies to all new code in this spec.

This spec covers all three additions in one go because they share the same architectural patterns, the same deployment context, and the same gating model. Three separate specs would be repetition.

## Goals

1. **Operators can act from the analyzer without leaving it.** Writing/destructive remediation steps the playbooks already document become first-class MCP tools.
2. **Reuse existing patterns.** Tool layouts (`tools/write/`, `tools/destructive/`), gating flags (`kafka.allowWrites`, `kafka.allowDestructive`), service shapes (Basic auth optional), config keys (`*_ENABLED`, `*_URL`/`*_ENDPOINT`, `*_API_KEY`/`*_API_SECRET`), and `deploy.sh` forwarding all extend what's already shipped under SIO-680.
3. **Conservative safety on destructive operations.** Hard deletes and connector deletion sit behind `allowDestructive`. Soft deletes and writes that are reversible-ish (pause/resume/restart) sit behind `allowWrites`. No new gating mechanisms.
4. **REST Proxy is a full integration**, not a half-baked one — produce, consume (stateful consumer lifecycle), and metadata. Use cases include incident replay, synthetic event injection, and operating from networks where the broker port isn't reachable.

## Non-goals

- Replacing the broker-client tools that already work via MSK. REST Proxy duplicates some metadata reads; that's acceptable. The native tools remain primary.
- Confluent ksqlDB write/execute_statement is already shipped (`ksql_execute_statement` exists in `tools/ksql/tools.ts`). Not re-touched here.
- New auth modes. Empty creds = no-auth, set creds = Basic auth. Same as SIO-680.
- Changing `deploy.sh`'s VPC config (`AGENTCORE_SUBNETS` / `AGENTCORE_SECURITY_GROUPS`) — already supports VPC mode.
- REST Proxy v3 endpoints (cluster-level Kafka API). Sticking to the v2 Confluent REST Proxy API which matches what the `confluent-prd` cluster runs.

## Architecture

Three independent additions, sharing patterns:

```
packages/mcp-server-kafka/src/
├── services/
│   ├── connect-service.ts          # EDITED: add 5 write/destructive methods
│   ├── schema-registry-service.ts  # EDITED: add 7 write/destructive methods
│   └── restproxy-service.ts        # NEW: full REST Proxy v2 client
├── tools/
│   ├── connect/
│   │   ├── tools.ts                # EDITED: register 5 new write/destructive tools when allowed
│   │   ├── operations.ts           # EDITED: 5 new operation wrappers
│   │   ├── parameters.ts           # EDITED: 5 new zod schemas
│   │   └── prompts.ts              # EDITED: 5 new tool descriptions
│   ├── schema/
│   │   ├── tools.ts                # EDITED: register 7 new tools when allowed
│   │   ├── operations.ts           # EDITED: 7 new wrappers
│   │   ├── parameters.ts           # EDITED: 7 new schemas
│   │   └── prompts.ts              # EDITED: 7 new descriptions
│   └── restproxy/                  # NEW dir mirroring connect/ksql layout
│       ├── tools.ts                # 9 tools (3 metadata, 1 produce, 5 consumer-lifecycle)
│       ├── operations.ts
│       ├── parameters.ts
│       └── prompts.ts
├── config/
│   ├── schemas.ts                  # EDITED: add restproxySchema + validation
│   ├── defaults.ts                 # EDITED: add restproxy block
│   ├── envMapping.ts               # EDITED: add RESTPROXY_* mappings
│   └── loader.ts                   # EDITED: add restproxy.enabled to booleanPaths
├── tools/index.ts                  # EDITED: ToolRegistrationOptions + count + wire-up
└── index.ts                        # EDITED: instantiate RestProxyService when restproxy.enabled

packages/mcp-server-kafka/tests/
├── services/
│   ├── connect-service-writes.test.ts        # NEW: write/destructive method tests
│   ├── schema-registry-writes.test.ts        # NEW: write/destructive method tests
│   └── restproxy-service.test.ts             # NEW: full service test
└── tools/
    └── restproxy/operations.test.ts          # NEW: operation wrapper tests

scripts/agentcore/deploy.sh                   # EDITED: forward RESTPROXY_* env vars
```

## Gating model (consistent across all three)

Reuses existing flags, no new ones:

| Operation kind | Flag required | Examples |
|---|---|---|
| **Read** | none | `connect_get_connector_status`, `sr_get_subject_versions`, `restproxy_list_topics` |
| **Write (reversible-ish)** | `kafka.allowWrites=true` | `connect_pause_connector`, `connect_resume_connector`, `connect_restart_connector`, `sr_register_schema`, `sr_set_compatibility`, `restproxy_produce`, all consumer-lifecycle endpoints (REST Proxy consumer state is server-side, must be cleaned up — but creating one isn't destructive) |
| **Destructive (irreversible or recoverable-but-disruptive)** | `kafka.allowDestructive=true` | `connect_delete_connector`, `sr_hard_delete_*`, `sr_soft_delete_*` (still destructive in spirit even if recoverable), `connect_restart_connector_task` (restart is destructive at the task level — drops in-flight messages) |

Tool registration is conditional. When the flag is off, the tool simply isn't on the `tools/list` response. No "ask for permission" pattern; the gate is binary at server start.

## Component 1: Connect writes (5 tools)

### Service methods (added to `connect-service.ts`)

```ts
// All return the parsed JSON body of the Connect response (or void for 204 No Content).
async pauseConnector(name: string): Promise<void>;
async resumeConnector(name: string): Promise<void>;
async restartConnector(name: string, options?: { includeTasks?: boolean; onlyFailed?: boolean }): Promise<void>;
async restartConnectorTask(name: string, taskId: number): Promise<void>;
async deleteConnector(name: string): Promise<void>;
```

REST endpoints:
- `pauseConnector` → `PUT /connectors/{name}/pause` (Connect returns 202, no body)
- `resumeConnector` → `PUT /connectors/{name}/resume` (202, no body)
- `restartConnector` → `POST /connectors/{name}/restart?includeTasks={bool}&onlyFailed={bool}` (200/204)
- `restartConnectorTask` → `POST /connectors/{name}/tasks/{id}/restart` (204)
- `deleteConnector` → `DELETE /connectors/{name}` (204)

URL-encoding of the connector name uses the same `encodeURIComponent(name)` pattern from the existing `getConnectorStatus`. The shared `request<T>` helper handles 204 No Content correctly (returns `undefined as T`).

### Tools

| Tool | Gate | Description |
|---|---|---|
| `connect_pause_connector` | allowWrites | Pause a running connector. Stops new task work; existing tasks finish in-flight. Reversible via resume. |
| `connect_resume_connector` | allowWrites | Resume a paused connector. |
| `connect_restart_connector` | allowWrites | Restart connector + optionally its tasks (`includeTasks`, `onlyFailed`). Use this when a connector or task is FAILED. |
| `connect_restart_connector_task` | allowDestructive | Restart a single task. Drops in-flight messages on that task — destructive at the message level. |
| `connect_delete_connector` | allowDestructive | Delete connector permanently. Irreversible (config and offsets are gone unless externally backed up). |

## Component 2: Schema Registry writes (7 tools)

### Service methods (added to `schema-registry-service.ts`)

```ts
async registerSchema(subject: string, schema: string, schemaType?: "AVRO" | "JSON" | "PROTOBUF"): Promise<{ id: number }>;
async checkCompatibility(subject: string, version: string | number, schema: string): Promise<{ is_compatible: boolean; messages?: string[] }>;
async getCompatibility(subject?: string): Promise<{ compatibilityLevel: string }>;
async setCompatibility(level: "BACKWARD" | "BACKWARD_TRANSITIVE" | "FORWARD" | "FORWARD_TRANSITIVE" | "FULL" | "FULL_TRANSITIVE" | "NONE", subject?: string): Promise<{ compatibility: string }>;
async softDeleteSubject(subject: string): Promise<number[]>;
async softDeleteSubjectVersion(subject: string, version: string | number): Promise<number>;
async hardDeleteSubject(subject: string): Promise<number[]>;
async hardDeleteSubjectVersion(subject: string, version: string | number): Promise<number>;
```

REST endpoints:
- `registerSchema` → `POST /subjects/{name}/versions` (returns `{id}`)
- `checkCompatibility` → `POST /compatibility/subjects/{subject}/versions/{version}` (returns `{is_compatible, messages?}`)
- `getCompatibility` → `GET /config` (global) or `GET /config/{subject}` (subject-level)
- `setCompatibility` → `PUT /config` (global) or `PUT /config/{subject}` (subject-level)
- `softDeleteSubject` → `DELETE /subjects/{name}` (returns array of deleted version numbers)
- `softDeleteSubjectVersion` → `DELETE /subjects/{name}/versions/{version}` (returns deleted version number)
- `hardDeleteSubject` → `DELETE /subjects/{name}?permanent=true` (must be soft-deleted first)
- `hardDeleteSubjectVersion` → `DELETE /subjects/{name}/versions/{version}?permanent=true` (must be soft-deleted first)

### Tools

| Tool | Gate | Description |
|---|---|---|
| `sr_register_schema` | allowWrites | Register a new schema version on a subject. Subject is created if it doesn't exist. Returns the schema ID. |
| `sr_check_compatibility` | allowWrites | Check whether a candidate schema is compatible with a specific version of a subject. Read-in-spirit but uses POST per Confluent API. |
| `sr_set_compatibility` | allowWrites | Set compatibility level globally or for a specific subject. Affects future registrations. |
| `sr_soft_delete_subject` | allowDestructive | Soft-delete all versions of a subject. Recoverable until hard-deleted. |
| `sr_soft_delete_subject_version` | allowDestructive | Soft-delete a single version. |
| `sr_hard_delete_subject` | allowDestructive | Permanently delete a soft-deleted subject. Irreversible. |
| `sr_hard_delete_subject_version` | allowDestructive | Permanently delete a soft-deleted version. Irreversible. |

The hard-delete endpoints require the soft-delete to have happened first; Schema Registry returns 404 otherwise. The tool prompt explicitly says so. No automatic soft-then-hard sequencing — that would hide a destructive action behind a single tool call.

## Component 3: REST Proxy (full integration, 9 tools)

REST Proxy v2 API. Confluent's docs: <https://docs.confluent.io/platform/current/kafka-rest/api.html>.

### Config additions

```ts
// schemas.ts: new restproxySchema mirrors connectSchema
export const restproxySchema = z
  .object({
    enabled: z.boolean().describe("Whether REST Proxy integration is enabled"),
    url: z.string().describe("REST Proxy URL (e.g., http://kafka-rest:8082 for self-hosted)"),
    apiKey: z.string().describe("REST Proxy API key for basic auth. Leave empty for self-hosted no-auth deployments. Set for Confluent Cloud."),
    apiSecret: z.string().describe("REST Proxy API secret for basic auth. Leave empty for self-hosted no-auth deployments. Set for Confluent Cloud."),
  })
  .strict();

// defaults.ts
restproxy: { enabled: false, url: "http://localhost:8082", apiKey: "", apiSecret: "" },

// envMapping.ts
RESTPROXY_ENABLED: "restproxy.enabled",
RESTPROXY_URL: "restproxy.url",
RESTPROXY_API_KEY: "restproxy.apiKey",
RESTPROXY_API_SECRET: "restproxy.apiSecret",

// loader.ts: add "restproxy.enabled" to booleanPaths
```

Validation in `superRefine`: when `restproxy.enabled` is true, `restproxy.url` must be non-empty (mirrors the existing pattern for ksql/connect).

### Service (`restproxy-service.ts`)

Mirrors `connect-service.ts` shape: `baseUrl`, `headers` (Content-Type/Accept set to REST Proxy v2 media type `application/vnd.kafka.json.v2+json`, optional Basic auth), shared `request<T>` helper.

```ts
// Topic metadata (read)
async listTopics(): Promise<string[]>;
async getTopic(name: string): Promise<{ name: string; configs: Record<string, string>; partitions: Array<...> }>;
async getPartitions(topic: string): Promise<Array<{ partition: number; leader: number; replicas: Array<{...}> }>>;

// Producer (write)
async produceMessages(
  topic: string,
  records: Array<{ key?: unknown; value: unknown; partition?: number }>,
  format?: "json" | "binary",
): Promise<{ key_schema_id?: number; value_schema_id?: number; offsets: Array<{ partition: number; offset: number; error_code?: number; error?: string }> }>;

// Consumer lifecycle (write)
async createConsumer(
  group: string,
  options?: { name?: string; format?: "json" | "binary"; autoOffsetReset?: "earliest" | "latest"; autoCommitEnable?: boolean },
): Promise<{ instance_id: string; base_uri: string }>;
async subscribe(group: string, instance: string, topics: string[]): Promise<void>;
async consumeRecords(
  group: string,
  instance: string,
  options?: { timeoutMs?: number; maxBytes?: number },
): Promise<Array<{ topic: string; key?: unknown; value: unknown; partition: number; offset: number }>>;
async commitOffsets(
  group: string,
  instance: string,
  offsets?: Array<{ topic: string; partition: number; offset: number }>,
): Promise<void>;
async deleteConsumer(group: string, instance: string): Promise<void>;
```

REST endpoints (all under `${baseUrl}` prefix):
- `listTopics` → `GET /topics`
- `getTopic` → `GET /topics/{name}`
- `getPartitions` → `GET /topics/{name}/partitions`
- `produceMessages` → `POST /topics/{name}` (Content-Type: `application/vnd.kafka.json.v2+json` or binary variant)
- `createConsumer` → `POST /consumers/{group}` (returns `instance_id` + `base_uri`)
- `subscribe` → `POST /consumers/{group}/instances/{instance}/subscription`
- `consumeRecords` → `GET /consumers/{group}/instances/{instance}/records`
- `commitOffsets` → `POST /consumers/{group}/instances/{instance}/offsets`
- `deleteConsumer` → `DELETE /consumers/{group}/instances/{instance}`

URL-encoding via `encodeURIComponent` for `name`, `group`, `instance`.

### Tools

| Tool | Gate | Description |
|---|---|---|
| `restproxy_list_topics` | none | List topics via REST Proxy. |
| `restproxy_get_topic` | none | Get topic configuration and partition list. |
| `restproxy_get_partitions` | none | Get partition leadership and replica details. |
| `restproxy_produce` | allowWrites | Produce one or more messages to a topic via REST Proxy. Returns per-partition offsets and per-record error codes. |
| `restproxy_create_consumer` | allowWrites | Create a stateful REST Proxy consumer instance. Returns `instance_id` for subsequent calls. The caller is responsible for `restproxy_delete_consumer` when done. |
| `restproxy_subscribe` | allowWrites | Subscribe a consumer instance to one or more topics. |
| `restproxy_consume` | allowWrites | Fetch records from a subscribed consumer instance. |
| `restproxy_commit_offsets` | allowWrites | Commit offsets for the consumer instance (manual mode). Defaults to committing the latest fetched offsets if no explicit offsets provided. |
| `restproxy_delete_consumer` | allowWrites | Tear down a REST Proxy consumer instance. Always call this when done — leaked consumers stay in REST Proxy state until idle timeout. |

### Consumer-lifecycle pattern

REST Proxy consumers are **stateful** server-side objects. The MCP can't manage that lifecycle automatically across tool calls — each call is independent. The tool prompts make this explicit: *"create → subscribe → (consume + commit)* → delete is the standard sequence; the LLM is responsible for completing it. Tool descriptions for each phase reference the next-expected step.

A common bug pattern: forgetting to call `restproxy_delete_consumer`. Mitigation: REST Proxy has its own idle timeout (default 5 minutes), so leaked consumers self-cleanup. The tool description for `create_consumer` mentions this.

## `deploy.sh` extension

Edit `scripts/agentcore/deploy.sh` kafka case (already extended in SIO-680 to forward `KSQL_*`/`SCHEMA_REGISTRY_*`/`CONNECT_*`) to additionally forward when set:

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

REST Proxy is on the **public** ALB (`confluent-prd-alb`) — no VPC peering needed. The connectivity gap discussed for ksql/SR/Connect doesn't apply.

## Wire-up

`packages/mcp-server-kafka/src/tools/index.ts`:
```ts
export interface ToolRegistrationOptions {
  schemaRegistryService?: SchemaRegistryService;
  ksqlService?: KsqlService;
  connectService?: ConnectService;
  restProxyService?: RestProxyService;  // NEW
}
```

Tool count update: `15 + (schemaRegistryService ? 8+7 : 0) + (ksqlService ? 7 : 0) + (connectService ? 4+5 : 0) + (restProxyService ? 9 : 0)`. Conditional on the gating flags too — when `allowWrites=false`, the +7/+5 components don't apply.

`packages/mcp-server-kafka/src/index.ts`: instantiate `RestProxyService` when `config.restproxy.enabled`. Mirror existing pattern for ksqlService.

## Testing

**Unit (mocking `globalThis.fetch`, mirroring existing patterns):**

`tests/services/connect-service-writes.test.ts`:
- `pauseConnector`, `resumeConnector` send PUT to correct URL, no body, headers correct.
- `restartConnector` includes query params `includeTasks` and `onlyFailed`.
- `restartConnectorTask` URL builds correctly with task ID.
- `deleteConnector` sends DELETE.
- All write methods URL-encode the connector name.
- All methods throw on non-OK with `Kafka Connect error <status>` message.
- Empty creds = no Authorization header; non-empty = Basic header.

`tests/services/schema-registry-writes.test.ts`:
- `registerSchema` returns the `{id}` body from a 200 response.
- `checkCompatibility` returns `{is_compatible, messages}`.
- `getCompatibility` works for both global and subject-level.
- `setCompatibility` sends the right `compatibility` field.
- `softDeleteSubject`/`softDeleteSubjectVersion` parse the response correctly.
- `hardDelete*` send `?permanent=true` query param.
- 404 from hard-delete (when soft-delete prerequisite missing) surfaces as a `Schema Registry error 404` exception.

`tests/services/restproxy-service.test.ts`:
- All 10 service methods send to the correct URLs with correct content-type headers.
- `produceMessages` body shape matches REST Proxy v2 spec.
- Consumer lifecycle: create → subscribe → consume → commit → delete, each method tested independently with mocked fetch.
- URL-encoding for `topic`, `group`, `instance`.
- Empty creds = no Authorization header.

**Integration / wire-up:**
- Tool count assertions: with each combination of `allowWrites`/`allowDestructive` and `*_ENABLED`, the registered tool list matches expected.
- `tools/list` against a server with `RESTPROXY_ENABLED=true` includes the 9 restproxy tools.
- `tools/list` against a server with `CONNECT_ENABLED=true KAFKA_ALLOW_WRITES=true` (no destructive) includes connect_pause/resume/restart/restart_task but NOT connect_delete_connector. (Wait — restart_task is destructive in this design. Test verifies that `pause/resume/restart` are present but `restart_task` and `delete_connector` are absent.)

## Verification

1. `bun run --filter @devops-agent/mcp-server-kafka typecheck` passes.
2. `bun run --filter @devops-agent/mcp-server-kafka test` passes (existing 129 + new tests).
3. `bun run lint` clean.
4. After AgentCore redeploy with `KAFKA_ALLOW_WRITES=true RESTPROXY_ENABLED=true RESTPROXY_URL=http://confluent-prd-alb-...:8082 ...`: `tools/list` includes the new tools matching the gating combination.
5. End-to-end: `connect_pause_connector` against a known test connector returns 202; `connect_get_connector_status` immediately after shows `state: "PAUSED"`. Reverse with `connect_resume_connector`. Same shape for SR `register_schema` + `check_compatibility` + REST Proxy `produce`.

## Out of scope

- ksqlDB write/destructive tools — `ksql_execute_statement` already exists in `tools/ksql/tools.ts`.
- REST Proxy v3 endpoints — sticking to v2 because that's what `confluent-prd` runs.
- Confirmation prompts before destructive actions. The gating flags are the safety mechanism. Adding a "are you sure?" round-trip would require a tool-call protocol the MCP spec doesn't natively support.
- Per-component allowWrites flags (e.g., `connect.allowWrites` separate from `kafka.allowWrites`). Re-using the existing flags is simpler and matches the user's preference recorded in this brainstorm.
- Bulk operations (e.g., delete-all-failed-connectors). Each tool acts on one entity; bulk is the LLM's responsibility through repeated calls.

## Risks

- **LLM autonomously calling destructive tools.** The `allowDestructive` flag is the gate. If you don't trust the LLM with a particular tool, leave the flag off — that's the design. No additional guardrails beyond the existing pattern.
- **Schema Registry hard deletes are irreversible**. Mitigated by requiring soft-delete first (Schema Registry enforces this; we don't auto-sequence). Tool prompt says so explicitly.
- **REST Proxy consumer leaks.** Mitigated by REST Proxy's own idle timeout (~5 min default). Tool prompts emphasize the create→delete pairing.
- **Public ALB for REST Proxy means anything with the URL can hit it** if no auth is configured. This is a Confluent Platform deployment property, not introduced by the MCP. Out of scope to fix here. Worth noting for the network team if this becomes a concern.
- **Tool surface is now ~70 tools when fully enabled.** Action-driven tool selection in the gitagent layer (already shipped) filters this down per invocation, so the LLM doesn't see all 70 at once. The growth is acceptable given that pattern.
