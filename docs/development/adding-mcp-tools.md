# Adding MCP Tools

> **Targets:** Bun 1.3.9+ | MCP SDK 1.27+ | TypeScript 5.x
> **Last updated:** 2026-04-04

Adding and modifying MCP tools is the most common development task in this project. Each MCP server exposes tools via the Model Context Protocol, which the LangGraph agent discovers at runtime through `MultiServerMCPClient`. This guide walks through the full lifecycle of adding a tool, from the TypeScript implementation to the gitagent YAML definition.

---

## Overview

```
Tool source file (packages/mcp-server-*/src/tools/)
     |
     v
Server registration (server.tool() in tools/*.ts)
     |
     v
Feature gate check (wrapHandler in tools/wrap.ts)
     |
     v
Agent discovery (MultiServerMCPClient connects to running server)
     |
     v
Gitagent tool YAML (agents/incident-analyzer/tools/*.yaml)
     |
     v
Dynamic prompt (prompt_template with variable substitution)
```

Tools live in the MCP server packages. The agent does not rewrite or re-implement tools -- it connects to MCP servers and discovers their tools dynamically. The gitagent YAML definitions provide additional metadata (prompt templates, related tools, workflow hints) that the gitagent-bridge uses to enrich the agent's behavior.

---

## Step-by-Step: Add a New Tool

### Step 1: Create the Operation File

Each tool category has its own directory under `src/tools/`. Create the operation function that implements the tool's logic.

**File structure example** (`packages/mcp-server-kafka/src/tools/read/`):

```
src/tools/read/
  operations.ts       # Business logic functions
  parameters.ts       # Zod input schemas
  prompts.ts          # Tool description strings
  tools.ts            # server.tool() registrations
```

**Operation function:**

```typescript
// src/tools/read/operations.ts
import type { KafkaService } from "../../services/kafka-service.ts";

export async function listTopics(
  service: KafkaService,
  args: { filter?: string },
): Promise<{ topics: string[]; count: number }> {
  const topics = await service.admin.listTopics();
  const filtered = args.filter
    ? topics.filter((t) => t.includes(args.filter!))
    : topics;
  return { topics: filtered, count: filtered.length };
}
```

### Step 2: Define Zod Parameters

Create the input schema using Zod. Always include `.describe()` on every field -- the MCP SDK uses these descriptions in tool discovery.

```typescript
// src/tools/read/parameters.ts
import { z } from "zod";

export const ListTopicsParams = z.object({
  filter: z
    .string()
    .optional()
    .describe("Substring filter to match against topic names"),
});
```

### Step 3: Write the Tool Description

Tool descriptions are used by the LLM to decide when to invoke a tool. Be specific and action-oriented.

```typescript
// src/tools/read/prompts.ts
export const LIST_TOPICS_DESCRIPTION =
  "List all Kafka topics in the cluster, optionally filtered by name substring.";
```

### Step 4: Register in the MCP Server

Add the `server.tool()` call in the tools registration file. Use `wrapHandler` to get feature gate checks, tracing, and error normalization for free.

```typescript
// src/tools/read/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { KafkaService } from "../../services/kafka-service.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerReadTools(
  server: McpServer,
  service: KafkaService,
  config: AppConfig,
): void {
  server.tool(
    "kafka_list_topics",
    prompts.LIST_TOPICS_DESCRIPTION,
    params.ListTopicsParams.shape,
    wrapHandler("kafka_list_topics", config, async (args) => {
      const result = await ops.listTopics(service, args);
      return ResponseBuilder.success(result);
    }),
  );
}
```

### Step 5: Wire into registerAllTools

Add the new registration function call in `src/tools/index.ts`:

```typescript
// src/tools/index.ts
import { registerReadTools } from "./read/tools.ts";

export function registerAllTools(
  server: McpServer,
  service: KafkaService,
  config: AppConfig,
  options?: ToolRegistrationOptions,
): void {
  registerReadTools(server, service, config);
  // ... other tool categories
}
```

### Step 6: Add Gitagent Tool YAML Definition

Create a YAML file in `agents/incident-analyzer/tools/` that maps the MCP tool to the agent's understanding:

```yaml
name: kafka-introspect
description: >
  Inspect Kafka cluster state including consumer group lag, topic throughput,
  and dead-letter queue contents for incident diagnosis.
version: 1.0.0
input_schema:
  type: object
  properties:
    action:
      type: string
      enum: [consumer_lag, topic_throughput, dlq_messages, cluster_info]
      description: Type of Kafka inspection to perform
    topic:
      type: string
      description: Topic name (required for topic_throughput, dlq_messages)
  required: [action]
output_schema:
  type: object
  properties:
    action: { type: string }
    data: { type: object }
    timestamp: { type: string }
annotations:
  requires_confirmation: false
  read_only: true
  cost: low

prompt_template: >
  Inspect Kafka cluster state for incident diagnosis.
  {{#if datasources}}Available data sources: {{datasources}}.{{/if}}
  {{#if compliance_tier}}Compliance tier: {{compliance_tier}}.{{/if}}

related_tools:
  - "Use elastic-search-logs to check if consumer lag correlates with error spikes"
  - "Use couchbase-cluster-health to check if database slowness causes backpressure"

tool_mapping:
  mcp_server: kafka
  mcp_patterns:
    - "kafka_*"
    - "ksql_*"
```

### Step 7: Test the Tool

Run the MCP server locally and verify the tool works:

```bash
# Start the server
bun run packages/mcp-server-kafka/src/index.ts

# In another terminal, test with MCP inspector or curl
# The tool should appear in the tools/list response
```

Run the automated tests:

```bash
bun test packages/mcp-server-kafka/
bun run typecheck
bun run lint
```

---

## Modifying Existing Tools

When updating an existing tool:

1. **Update the operation** in `operations.ts` if the logic changes
2. **Update the Zod schema** in `parameters.ts` if inputs change -- always keep `.describe()` current
3. **Update the prompt** in `prompts.ts` if the tool's purpose or behavior changes
4. **Update the gitagent YAML** if the input/output schema or description changes
5. **Run tests** -- `bun test`, `bun run typecheck`, `bun run lint`

Do not change tool names after deployment. Tool names are part of the MCP contract. If you need a different name, create a new tool and deprecate the old one.

---

## Tool Conventions

### Naming

- **snake_case** with a server prefix: `kafka_list_topics`, `kafka_get_cluster_info`
- **verb-noun pattern**: `list_topics`, `get_cluster_info`, `describe_topic`, `consume_messages`
- Server prefixes: `kafka_`, `elasticsearch_`, `capella_`, `konnect_`, `ksql_`

### Input/Output Schema

- All input parameters use Zod schemas with `.describe()` on every field
- Shared parameters (topic name, group ID, filters) are defined once in `tools/shared/parameters.ts`
- Output is always `{ content: [{ type: "text", text: string }], isError?: boolean }`
- Use `ResponseBuilder.success(data)` and `ResponseBuilder.error(message)` for consistent formatting

### Error Handling

Tools must never throw unhandled exceptions. The `wrapHandler` function catches errors and returns them as MCP error responses:

```typescript
// wrapHandler catches and normalizes errors automatically
const mcpError = normalizeError(error);
return ResponseBuilder.error(mcpError.message);
```

If you need custom error handling within an operation, return a descriptive error message rather than throwing:

```typescript
if (!topic) {
  return ResponseBuilder.error("Topic name is required for this operation");
}
```

### Read-Only vs Write Operations

Feature gates control which operations are available at runtime:

| Gate | Environment Variable | Tools Controlled |
|------|---------------------|------------------|
| Write | `KAFKA_ALLOW_WRITES=true` | `kafka_produce_message`, `kafka_create_topic`, `kafka_alter_topic_config` |
| Destructive | `KAFKA_ALLOW_DESTRUCTIVE=true` | `kafka_delete_topic`, `kafka_reset_consumer_group_offsets` |
| Schema Registry | `SCHEMA_REGISTRY_ENABLED=true` | All `kafka_*_schema*` tools |
| ksqlDB | `KSQL_ENABLED=true` | All `ksql_*` tools |

The `wrapHandler` function in `tools/wrap.ts` checks these gates before executing any handler. Tools in the gate sets are rejected with an informative error message when the gate is closed.

---

## Server-Specific Notes

### Elasticsearch

Tools receive a `deployment` parameter for multi-deployment awareness. The environment variable `ELASTIC_DEPLOYMENTS=prod,staging` controls which deployments are available, with per-deployment URL and auth configured via uppercase suffixed vars (`ELASTIC_PROD_URL`, `ELASTIC_STAGING_URL`).

```yaml
# Tool YAML references deployment context
tool_mapping:
  mcp_server: elastic
  mcp_patterns:
    - "elasticsearch_*"
```

### Kafka

Kafka tools behave differently based on the configured provider (`KAFKA_PROVIDER=local|msk|confluent`). MSK uses IAM authentication, Confluent uses API key/secret, and local uses plain connections. Feature gates must be checked in tests:

```typescript
// Verify write tools are gated
const response = await wrappedHandler({ topic: "test", messages: [] });
if (!config.kafka.allowWrites) {
  expect(response.isError).toBe(true);
  expect(response.content[0].text).toContain("disabled");
}
```

### Konnect

Kong Konnect tools may trigger elicitation gates for dangerous operations (plugin changes, route deletions). The `annotations.requires_confirmation` field in tool YAML marks tools that need user confirmation before execution.

---

## Cross-References

- [Monorepo Structure](./monorepo-structure.md) -- package layout for MCP servers
- [Testing Strategy](./testing.md) -- MCP tool validation patterns
- [Environment Variables](../configuration/environment-variables.md) -- feature gate configuration
- [MCP Server Configuration](../configuration/mcp-server-configuration.md) -- server-specific settings

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial version |
