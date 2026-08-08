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
- **Model factory / registry** -- resolving model names through `MODEL_REGISTRY` to a Bedrock id plus that model's declared capability record; the temperature-generation oracle, manifest coverage across all nine `agent.yaml` files, and probe-report provenance (SIO-1223)
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

The LangGraph agent package tests cover the 31-node pipeline (incl. correlation enforcement, typed findings, AWS estate router, resolveIdentifiers, mitigation branch split, gated KG and HIL-learning nodes). Because tests should not require running MCP servers, MCP dependencies are mocked.

- **Graph compilation** -- StateGraph builds and compiles without error
- **Node functions** -- classify, entityExtractor, supervise, align, aggregate, validate
- **State annotations** -- `AgentState` field defaults and reducers
- **MCP integration** -- mocked `getToolsForDataSource` returns fake tools per datasource
- **Validation** -- validator retry logic, alignment checking, route decisions
- **Attachment processing** -- file attachment metadata handling

```typescript
// Example: agent/src/index.test.ts -- mocking MCP bridge
const VALID_DATASOURCES = new Set(["elastic", "kafka", "couchbase", "konnect", "gitlab", "atlassian", "aws"]);
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

Biome rules enforce: import ordering, no unused variables, consistent formatting, and no `any` types. As of, `noExplicitAny` is set to **error** (not warn) in `biome.json`, so `: any`, `as any`, `Record<string, any>`, etc. fail CI. The typed-alternatives table in `CLAUDE.md` (under "TypeScript strict mode, never use `any`") lists the canonical replacements (`z.infer`, `RequestHandlerExtra`, `unknown` with narrowing, `estypes.<Response>`, etc.); a `biome-ignore lint/suspicious/noExplicitAny` comment requires a one-line ticket reference.

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

## Evals & quality harness

The eval layer lives at `packages/agent/src/eval/` with the canonical, always-current reference at **`packages/agent/src/eval/README.md`** (run/cost/feedback-key detail, historical run logs). This section is the map; the README is the manual. All evals are on-demand (none in CI). Runtime evals that call Bedrock or live MCP need AWS Bedrock creds; the static/semantic checks (`eval:spec-audit`) need none. The LLM-judge and LangSmith-backed evals additionally need `OPENAI_API_KEY`, `LANGSMITH_API_KEY` + `LANGSMITH_PROJECT`, and the `langsmith` CLI on PATH (for `*upload*` scripts).

The npm scripts live in `packages/agent/package.json`; the day-to-day ones are **mirrored into the root `package.json`** (SIO-1458) so `bun run eval:*` works from the repo root:

| Script | What it does |
|--------|--------------|
| `eval:agent` | End-to-end LangSmith `final_response` regression for the full 31-node incident graph (5 incident-shaped queries x evaluators: `datasources_covered`, `confidence_threshold`, `response_quality` LLM judge). `eval:precheck` sanity-checks infra first; `eval:upload-dataset` (re)uploads the dataset. |
| `eval:incident-replay` | Live-replay incident eval (SIO-1371/1372/1374/1378). Adds the tier-3 trajectory-grounded evaluators `runbook_selection_vs_usage` (deterministic) and `citation_grounding` (LLM judge) from SIO-1442. `--ticket DEVOPS-XXXX` (SIO-1454) scopes the run to a single dataset example. |
| `eval:mcp-tool` | MCP tool-call correctness eval (SIO-1398): a LangSmith set auditing whether each datasource's tools are called correctly and return usable data. `--datasource <id>` scopes it. |
| `eval:tool-probe` | Direct per-tool health probe -- calls each MCP tool and reports which return data vs. error. This is the tool-**health** measure; `eval:mcp-tool` only observes tools the agent chose to call. |
| `eval:spec-audit` | Tier-1 static/semantic OKF spec audit (SIO-1440): grades the spec layer (agent.yaml + SOUL.md + RULES.md + `knowledge/`) for frontmatter validity, orphaned knowledge, RULES-vs-SOUL contradictions. |
| `eval:single-agent-probe` | Tier-2 isolated single-agent probe (SIO-1441): runs one sub-agent against real MCP with **no `buildGraph`, no mocks**, driven by `PROBE_DATASOURCE` / `PROBE_SCENARIO`. |
| `model:probe` | Model-conformance probe (SIO-1224), not a graph eval -- verifies a model's capability assumptions; committed reports live in [`docs/reference/model-probes/`](../reference/model-probes/). See the [Model Upgrade Checklist](./model-upgrade-checklist.md). |

**OKF spec-audit tiers (SIO-1440/1441/1442/1444).** Four tiers grade the spec layer rather than the graph's answers: tier 1 = `eval:spec-audit` (static/semantic), tier 2 = `eval:single-agent-probe` (isolated live probe), tier 3 = the two trajectory evaluators inside `eval:incident-replay`, tier 4 = static checks in tier-1's CLI plus `bun test` (`okf-spec-audit.test.ts`).

**Sound-freeze record/replay (SIO-1379).** `EVAL_FIXTURE_MODE` freezes eval inputs at the **output** level, not the tool level: `record` runs live and appends the turn's agent outputs + an MCP tool-call audit trail to a fixture; `replay-outputs` re-grades that frozen behavior with **no live systems touched** (skips the MCP precheck), so judge-only iterations cost pennies. Tool-level replay is deliberately absent (the README explains why). See [`EVAL_FIXTURE_MODE`](../configuration/environment-variables.md).

**MCP tool-call counters (SIO-1400/1402).** Setting [`MCP_TOOL_METRICS_DB_PATH`](../configuration/environment-variables.md) makes every MCP server append per-server/per-tool lifetime call + failure counts to a shared SQLite file, with a failure-class breakdown (`bad-input` / `unstructured` / `unknown-tool`). It is soft-failing and never breaks a tool call -- it is production telemetry, not a test, but it is the data source the `eval:mcp-tool` audit cross-checks against.

---

## Cross-References

- [Getting Started](./getting-started.md) -- initial setup and first run
- [Monorepo Structure](./monorepo-structure.md) -- package layout and workspace config
- [Adding MCP Tools](./adding-mcp-tools.md) -- tool-specific testing guidance
- [Observability](../operations/observability.md) -- where eval traces land in LangSmith

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial version |
| 2026-05-09 | Added Agent Eval section (/682) |
| 2026-08-08 | SIO-1378..1458 sync: rewrote the "Agent Eval" section into "Evals & quality harness" -- documented the full script table (`eval:agent` / `eval:incident-replay` / `eval:mcp-tool` / `eval:tool-probe` / `eval:spec-audit` / `eval:single-agent-probe` / `model:probe`, mirrored into root `package.json` via SIO-1458), the four OKF spec-audit tiers (SIO-1440/1441/1442/1444), sound-freeze `EVAL_FIXTURE_MODE` record/replay (SIO-1379), the `--ticket` scoping (SIO-1454), and the MCP tool-call SQLite counters (SIO-1400/1402). |
