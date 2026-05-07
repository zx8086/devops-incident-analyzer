# Testing Strategy

> **Targets:** Bun 1.3.9+ | TypeScript 5.x
> **Last updated:** 2026-04-04

Test organization, patterns, and execution across the DevOps Incident Analyzer monorepo. All tests use the Bun test runner (`bun:test`) with `describe`/`test`/`expect` and run alongside TypeScript type checking and Biome linting as quality gates.

---

## Running Tests

### Full Suite

```bash
bun run test                                         # All packages (workspace-wide)
bun run typecheck                                    # TypeScript strict checks
bun run lint                                         # Biome lint + format check
bun run lint:fix                                     # Biome auto-fix
bun run yaml:check                                   # Validate gitagent YAML definitions
```

### Single Package

```bash
bun run --filter @devops-agent/gitagent-bridge test  # gitagent-bridge only
bun run --filter @devops-agent/agent test            # agent only
bun run --filter @devops-agent/shared test           # shared only
bun run --filter @devops-agent/mcp-server-kafka test # Kafka MCP server only
```

### Single File

```bash
bun test packages/gitagent-bridge/src/index.test.ts
bun test packages/shared/src/tracing/__tests__/langsmith.test.ts
bun test packages/agent/src/validation.test.ts
```

### Watch Mode

```bash
bun test --watch packages/shared/src/tracing/
```

---

## Test Organization

### Unit Tests

Unit tests are co-located with their source files using the `*.test.ts` naming convention. This keeps tests close to the code they verify and makes it easy to find coverage gaps.

```
packages/
  gitagent-bridge/src/
    index.ts
    index.test.ts                 # Co-located unit tests
  agent/src/
    index.ts
    index.test.ts
    validation.test.ts
    mcp-integration.test.ts
    attachment-processor.test.ts
```

### Integration Tests

Integration tests that span multiple modules or require setup/teardown live in `__tests__/` directories adjacent to the modules they exercise.

```
packages/
  shared/src/
    __tests__/
      bootstrap.test.ts           # Tests createMcpApplication lifecycle
      logger-ecs.test.ts          # Tests ECS-formatted log output
    tracing/__tests__/
      langsmith.test.ts           # Tests LangSmith initialization
      session.test.ts             # Tests AsyncLocalStorage session context
      client-detect.test.ts       # Tests client detection heuristics
  mcp-server-kafka/src/
    config/__tests__/
      transport-config.test.ts    # Tests Zod config parsing
    transport/__tests__/
      http.test.ts                # Tests HTTP transport creation
      middleware.test.ts          # Tests health/CORS middleware
      factory.test.ts             # Tests transport factory routing
      agentcore.test.ts           # Tests AgentCore transport mode
```

---

## Package-Specific Testing

### gitagent-bridge

The bridge package converts YAML agent definitions into LangGraph-compatible structures. Tests cover:

- **YAML parsing** -- loading `agent.yaml`, `SOUL.md`, `RULES.md` from the agents directory
- **Zod validation** -- manifest schema validation, tool schema alignment
- **Manifest loading** -- recursive sub-agent loading (elastic-agent, kafka-agent, capella-agent, konnect-agent)
- **Model factory** -- resolving model names to `claude-sonnet-4-6`, Bedrock config resolution
- **Tool prompt building** -- dynamic variable substitution in `prompt_template` fields
- **Related tools map** -- workflow chaining hints from `related_tools` YAML
- **Facade map** -- `tool_mapping` to MCP server pattern matching

```typescript
// Example: gitagent-bridge/src/index.test.ts
describe("manifest-loader", () => {
  test("loads root agent with all fields", () => {
    const agent = loadAgent(AGENTS_DIR);
    expect(agent.manifest.name).toBe("incident-analyzer");
    expect(agent.manifest.version).toBe("0.1.0");
    expect(agent.tools.length).toBe(6);
    expect(agent.skills.size).toBe(3);
  });
});
```

### agent

The LangGraph agent package tests cover the 12-node pipeline. Because tests should not require running MCP servers, MCP dependencies are mocked.

- **Graph compilation** -- StateGraph builds and compiles without error
- **Node functions** -- classify, entityExtractor, supervise, align, aggregate, validate
- **State annotations** -- `AgentState` field defaults and reducers
- **MCP integration** -- mocked `getToolsForDataSource` returns fake tools per datasource
- **Validation** -- validator retry logic, alignment checking, route decisions
- **Attachment processing** -- file attachment metadata handling

```typescript
// Example: agent/src/index.test.ts -- mocking MCP bridge
const VALID_DATASOURCES = new Set(["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian"]);
mock.module("./mcp-bridge.ts", () => ({
  getToolsForDataSource: (id: string) =>
    VALID_DATASOURCES.has(id) ? [{ name: `${id}_tool` }] : [],
}));
```

### shared

The shared package provides cross-cutting utilities. Tests cover:

- **Bootstrap** -- `createMcpApplication` lifecycle (init, transport, shutdown, signal handlers)
- **Logger** -- ECS-formatted output, sensitive data redaction, `formatLogLine` output
- **Tracing** -- LangSmith initialization, idempotency, environment variable propagation
- **Session context** -- `AsyncLocalStorage`-based session tracking, `createSessionContext`
- **Client detection** -- transport-based and user-agent-based client identification

```typescript
// Example: shared/src/tracing/__tests__/langsmith.test.ts
describe("LangSmith Tracing Initialization", () => {
  afterEach(() => {
    resetTracing();
    delete process.env.LANGSMITH_TRACING;
  });

  test("tracing enables with env var and API key", () => {
    process.env.LANGSMITH_TRACING = "true";
    initializeTracing({ apiKey: "test-key" });
    expect(isTracingActive()).toBe(true);
  });
});
```

### MCP Servers

MCP server tests follow the principle: **run the tool, not just typecheck**. Tests validate that the MCP protocol contract is met end-to-end.

- **Config loading** -- Zod schema parsing from environment variables
- **Transport factory** -- correct transport mode selection (stdio, http, both, agentcore)
- **Tool validation** -- calling `server.tool()` registrations and verifying response shape
- **Feature gates** -- write/destructive tools blocked when `KAFKA_ALLOW_WRITES=false`
- **Health middleware** -- `/health` and `/ping` endpoints return expected responses

```typescript
// Example: mcp-server-kafka config test
describe("transport-config", () => {
  test("parses valid config from env vars", () => {
    const config = parseConfig();
    expect(config.kafka.provider).toBe("local");
    expect(config.transport.mode).toBe("http");
  });
});
```

---

## Testing Patterns

### Bun Test Runner

All tests use the Bun built-in test runner. No external test framework is needed.

```typescript
import { afterEach, describe, expect, mock, test } from "bun:test";

describe("feature-name", () => {
  afterEach(() => {
    // cleanup
  });

  test("does expected behavior", () => {
    expect(result).toBe(expected);
  });
});
```

### MCP Tool Validation Pattern

When testing MCP tools, always invoke the tool through the MCP server interface rather than calling the operation function directly. This validates the full chain: parameter parsing, feature gate checks, tracing, error normalization.

```typescript
// Preferred: test through wrapHandler
const response = await wrappedHandler({ topic: "test-topic" });
expect(response.content[0].type).toBe("text");
expect(response.isError).toBeFalsy();

// Avoid: testing the raw operation function
// const result = await listTopics(service, args);  // skips gates + tracing
```

### When to Mock vs Use Live Backends

| Scenario | Approach |
|----------|----------|
| Unit tests for graph nodes | Mock MCP bridge, mock LLM calls |
| Config parsing tests | No mocks needed -- pure Zod validation |
| Transport tests | Mock `McpServer`, test HTTP layer |
| Tool registration tests | Mock `KafkaService`, verify `server.tool()` calls |
| End-to-end integration | Requires live MCP servers (CI only) |

### Environment Cleanup

Tests that modify `process.env` must restore original values in `afterEach`. The shared tracing tests demonstrate this pattern by deleting all LangSmith-related env vars after each test.

---

## Type Checking as Test Gate

TypeScript strict mode is enforced across all packages. Always run typecheck before committing:

```bash
bun run typecheck
```

Type checking catches:

- Missing or incorrect parameter types on MCP tool handlers
- State shape mismatches in LangGraph annotations
- Import path errors across workspace packages
- Svelte 5 rune type violations in frontend components

### Biome as Quality Gate

Biome enforces consistent formatting and catches lint issues:

```bash
bun run lint          # Check only
bun run lint:fix      # Auto-fix
```

Biome rules enforce: import ordering, no unused variables, consistent formatting, and no `any` types. As of SIO-673, `noExplicitAny` is set to **error** (not warn) in `biome.json`, so `: any`, `as any`, `Record<string, any>`, etc. fail CI. The typed-alternatives table in `CLAUDE.md` (under "TypeScript strict mode, never use `any`") lists the canonical replacements (`z.infer`, `RequestHandlerExtra`, `unknown` with narrowing, `estypes.<Response>`, etc.); a `biome-ignore lint/suspicious/noExplicitAny` comment requires a one-line ticket reference.

---

## YAML Validation

Gitagent YAML definitions (agent manifests, tool definitions, skill prompts) are validated with:

```bash
bun run yaml:check
```

This runs `yamllint` against the `agents/` directory. The gitagent-bridge test suite also validates that all YAML files parse correctly and conform to the expected schema:

```typescript
test("loads all 6 tool definitions", () => {
  const agent = loadAgent(AGENTS_DIR);
  expect(agent.tools.length).toBe(6);
  const toolNames = agent.tools.map((t) => t.name);
  expect(toolNames).toContain("elastic-search-logs");
  expect(toolNames).toContain("kafka-introspect");
});
```

---

## Cross-References

- [Getting Started](./getting-started.md) -- initial setup and first run
- [Monorepo Structure](./monorepo-structure.md) -- package layout and workspace config
- [Adding MCP Tools](./adding-mcp-tools.md) -- tool-specific testing guidance

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial version |
