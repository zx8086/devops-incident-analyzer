# System Overview

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-04-23

The DevOps Incident Analyzer is a multi-datasource investigation agent that correlates production signals across Elasticsearch logs, Kafka event streams, Couchbase Capella datastores, Kong Konnect API gateway metrics, GitLab CI/CD pipelines, and Atlassian (Jira/Confluence) ticket and runbook metadata. A LangGraph supervisor orchestrates six specialist sub-agents, each backed by a dedicated Model Context Protocol (MCP) server, to gather evidence and synthesize actionable incident reports with confidence scores.

---

## System Purpose

DevOps teams troubleshooting production incidents face a common problem: evidence is scattered across multiple observability platforms and data stores. Engineers jump between Elasticsearch for logs, Kafka for event pipelines, Couchbase for application state, Kong Konnect for API gateway metrics, GitLab for recent code changes and CI/CD pipeline status, and Atlassian (Jira/Confluence) for tickets and runbooks -- manually correlating timestamps and building a mental model of causality.

The Incident Analyzer automates this correlation. Given a natural language query like "why is the checkout service returning 500s?", it:

1. Classifies the query complexity and extracts relevant entities (services, time windows, datasources)
2. Dispatches parallel sub-agents to query each relevant datasource via MCP tool calls
3. Aligns results across datasources, retrying any that failed transiently
4. Aggregates findings into a correlated timeline with causal analysis
5. Validates the report against source data to catch hallucinations
6. Generates follow-up suggestions for deeper investigation

The agent is strictly read-only. It observes production systems but never mutates them. Write operations (Kafka produce, index deletion, gateway modification) are explicitly prohibited at the compliance layer.

---

## High-Level Architecture

```
+------------------+
|   SvelteKit UI   |  Port 5173
|  (Svelte 5, SSE) |
+--------+---------+
         |
         | SSE stream
         v
+--------+---------+
| Agent Orchestrator|  LangGraph StateGraph
| (classify, align, |
|  aggregate, etc.) |
+--------+---------+
         |
         | Send API (parallel fan-out)
         v
+--------+---------+---------+---------+---------+---------+
|        |         |         |         |         |         |
| elastic| kafka   | capella | konnect | gitlab  |atlassian|
| -agent | -agent  | -agent  | -agent  | -agent  | -agent  |
|        |         |         |         |         |         |
+---+----+---+-----+---+-----+---+----+---+-----+---+-----+
    |        |          |         |         |         |
    v        v          v         v         v         v
+------+ +------+ +--------+ +--------+ +--------+ +---------+
| ES   | | Kafka| | Capella| | Konnect| | GitLab | |Atlassian|
| MCP  | | MCP  | | MCP    | | MCP    | | MCP    | | MCP     |
| :9080| | :9081| | :9082  | | :9083  | | :9084  | | :9085   |
| ~78  | | 15+15| | ~15    | | 15+prx | | proxy+ | | proxy+  |
| tools| | opt  | | tools  | | tools  | | custom | | custom  |
+------+ +------+ +--------+ +--------+ +--------+ +---------+
    |        |          |         |         |         |
    v        v          v         v         v         v
+------+ +------+ +--------+ +--------+ +--------+ +---------+
| Elas-| |Kafka | |Couchbase| | Kong  | | GitLab | | Jira /  |
| tic- | |Clust-| |Capella  | |Konnect| | API +  | | Conflu- |
| search| |ers  | |Cluster  | | API   | | Repos  | | ence    |
+------+ +------+ +--------+ +--------+ +--------+ +---------+
```

Tool counts are dynamic -- they reflect connected MCP tools at runtime. Proxy-based servers (GitLab, Atlassian) discover tools from the remote native MCP endpoint at startup, so totals vary. The agent targets 210+ tools end-to-end when all servers are connected.

---

## Key Design Decisions

### Declarative Agent Definitions (Gitagent)

Agent behavior is defined in YAML and Markdown files under `agents/incident-analyzer/`, separate from the TypeScript runtime. The `gitagent-bridge` package compiles these definitions into system prompts, model configurations, and compliance metadata consumed by the LangGraph agent at startup.

This separation means agent personality (SOUL.md), constraints (RULES.md), skill procedures (skills/), and tool schemas (tools/*.yaml) can be reviewed, versioned, and modified without touching runtime code. The bridge also enables CI-time drift detection between gitagent tool definitions and actual MCP server tools.

### Supervisor Fan-Out Pattern

The supervisor does not execute sub-agents sequentially. It uses LangGraph's `Send` API to dispatch parallel executions of the `queryDataSource` node, one per target datasource. Each Send carries its own `currentDataSource` state, which scopes the sub-agent's MCP tool access to a single server.

This fan-out pattern provides natural parallelism: all six datasource queries run concurrently, and the alignment node waits for all results before proceeding. If a datasource server is unavailable, only that sub-agent fails -- the others complete independently.

### MCP as Tool Integration Layer

Rather than implementing direct API clients for each datasource, the agent connects to existing MCP servers via `@langchain/mcp-adapters` `MultiServerMCPClient`. Each MCP server exposes a set of tools over Streamable HTTP transport. The agent treats these tools as black boxes -- it never reimplements tool logic.

This architecture means tool updates happen in the MCP server packages without touching the agent code. New tools automatically become available after server restart. The gitagent tool mapping layer (tool_mapping with mcp_patterns) provides a facade that groups related MCP tools under human-readable names.

### Read-Only Analysis

The agent is designed exclusively for investigation, not remediation. This constraint is enforced at multiple levels:

- **Compliance config:** `agents/incident-analyzer/compliance/allowed-actions.yaml` lists permitted read operations and explicitly prohibits writes
- **MCP server config:** write/destructive tools are disabled via feature gates (e.g., Kafka `KAFKA_ENABLE_WRITE_OPERATIONS=false`)
- **RULES.md:** hard rule -- "Must Never write to any production system"
- **Escalation triggers:** actions classified as `mutate_production` require human approval

### Bun Workspace Monorepo

The project uses Bun workspaces to manage all packages, apps, and agent definitions in a single repository. This provides:

- Single `bun install` for all dependencies across packages
- Workspace-internal package references (`@devops-agent/shared`, `@devops-agent/observability`, etc.) resolved without publishing
- Shared Biome and TypeScript configuration at the root
- Unified `bun run typecheck` and `bun run lint` across all packages
- Catalog-based dependency version management to prevent version drift

Each MCP server is an independent deployable package with its own entry point, configuration, and test suite, while sharing core infrastructure (logging, telemetry, bootstrap, types) through the `shared` and `observability` packages.

---

## Component Summary

| Component | Package | Responsibility |
|-----------|---------|---------------|
| Agent Orchestrator | `packages/agent` | 12-node LangGraph StateGraph: classify, normalize, selectRunbooks, extract, fan-out, align, aggregate, checkConfidence, validate, proposeMitigation, followUp |
| Gitagent Bridge | `packages/gitagent-bridge` | Compiles YAML/Markdown agent definitions into runtime config (prompts, models, compliance) |
| Shared Library | `packages/shared` | Cross-package types, Zod schemas, bootstrap function, telemetry, logging |
| Checkpointer | `packages/checkpointer` | LangGraph state persistence (memory or bun:sqlite) |
| Observability | `packages/observability` | Pino logger factory, OpenTelemetry span helpers, request-scoped child loggers |
| Elasticsearch MCP | `packages/mcp-server-elastic` | ~78 tools for cluster health, index management, search, snapshots, mappings |
| Kafka MCP | `packages/mcp-server-kafka` | 15 base tools + 15 optional (schema registry + ksqlDB) for cluster info, topic management, consumer groups, message consumption |
| Couchbase MCP | `packages/mcp-server-couchbase` | ~15 tools for cluster health, bucket management, N1QL queries, index analysis, playbooks |
| Konnect MCP | `packages/mcp-server-konnect` | 15 enhanced tools + proxy surface for services, routes, plugins, consumers, upstreams, analytics |
| GitLab MCP | `packages/mcp-server-gitlab` | Proxy + 5-8 custom tools for CI/CD pipelines, merge requests, code analysis, issues |
| Atlassian MCP | `packages/mcp-server-atlassian` | Proxy + custom tools for Jira issues, Confluence pages, projects, and ticket metadata |
| Web Frontend | `apps/web` | SvelteKit app with SSE streaming, 9 components, Tailwind CSS |
| Agent Definitions | `agents/incident-analyzer` | YAML/Markdown: SOUL.md, RULES.md, agent.yaml, tools/*.yaml, skills/*.md, compliance/ |

### Package Dependency Graph

```
agents/incident-analyzer/
    (read at runtime by gitagent-bridge)

packages/shared
    +-- (no internal deps, provides types, schemas, bootstrap, telemetry)

packages/observability
    +-- @devops-agent/shared

packages/checkpointer
    +-- (memory + bun:sqlite providers)

packages/gitagent-bridge
    +-- (reads agents/ directory, exports LoadedAgent + helpers)

packages/agent
    +-- @devops-agent/shared
    +-- @devops-agent/observability
    +-- @devops-agent/checkpointer
    +-- @devops-agent/gitagent-bridge
    +-- @langchain/langgraph
    +-- @langchain/aws
    +-- @langchain/mcp-adapters

packages/mcp-server-elastic
    +-- @devops-agent/shared
    +-- @devops-agent/observability

packages/mcp-server-kafka
    +-- @devops-agent/shared
    +-- @devops-agent/observability

packages/mcp-server-couchbase
    +-- @devops-agent/shared
    +-- @devops-agent/observability

packages/mcp-server-konnect
    +-- @devops-agent/shared
    +-- @devops-agent/observability

packages/mcp-server-gitlab
    +-- @devops-agent/shared
    +-- @devops-agent/observability
    +-- @modelcontextprotocol/sdk (proxy client)

packages/mcp-server-atlassian
    +-- @devops-agent/shared
    +-- @devops-agent/observability
    +-- @modelcontextprotocol/sdk (proxy client)

apps/web
    +-- @devops-agent/agent (server-side)
    +-- SvelteKit, Tailwind CSS v4
```

The `shared` package is the foundation -- it provides the `createMcpApplication()` bootstrap function, Zod schemas, Pino logger factory, OpenTelemetry initialization, and cross-package TypeScript types. Every MCP server and the agent package depend on it.

---

## Data Flow

```
+-------+
| START |
+---+---+
    |
    v
+----------+
| classify |-------> queryComplexity === "simple"
+----+-----+                    |
     |                          v
     | (complex)          +-----------+     +----------+
     v                    | responder |---->| followUp |---> END
+-----------+             +-----------+     +----------+
| normalize |
+-----+-----+
      |
      v (if runbook_selection enabled)
+----------------+
| selectRunbooks |
+-------+--------+
        |
        v
+----------------+
| entityExtractor|
+-------+--------+
        |
        v
+------------+
| supervisor |
| (fan-out)  |
+-+--+--+--+-+--+
  |  |  |  |  |  |
  v  v  v  v  v  v
elastic kafka capella konnect gitlab atlassian
-agent  -agent -agent  -agent  -agent -agent
  |  |  |  |  |  |
  +--+--+--+--+--+
        |
        v
+-------+------+
|    align     | <--------+
+-------+------+          |
        |                 |
        v                 |
+-------+------+          |
|  aggregate   | ---------+ (via routeAfterAlignment)
+-------+------+
        |
        v
+-----------+------+
| checkConfidence  |
+-------+----------+
        |
        v
+-------+------+
|   validate   | <--------+
+-------+------+          |
        |                 |
        | pass            | fail && retryCount < 2
        v                 |
+------------------+      |
| proposeMitigation| -----+ (retries go back to aggregate)
+-------+----------+
        |
        v
+-------+------+
|   followUp   |
+-------+------+
        |
        v
    +-------+
    |  END  |
    +-------+
```

1. **classify** -- Routes query as simple (greetings, help) or complex (infrastructure investigation). Uses regex patterns first, falls back to LLM.
2. **normalize** -- Extracts a structured `NormalizedIncident` (severity, time window, affected services, metrics) from the user's query for downstream nodes.
3. **selectRunbooks** (optional, SIO-640) -- Picks 0-2 runbooks from the catalog via trigger grammar pre-filter then LLM selection. Enabled when `knowledge/index.yaml` has a `runbook_selection` block.
4. **responder** -- Handles simple queries from general knowledge without querying datasources.
5. **entityExtractor** -- Extracts services, time windows, severity, and target datasources from the query.
6. **supervisor** -- Creates `Send` messages for parallel sub-agent dispatch. Validates agent names, checks MCP tool availability, skips datasources with no connected tools.
7. **queryDataSource** -- Runs a ReAct agent with datasource-scoped MCP tools. Uses Claude Haiku for fast tool calling.
8. **align** -- Checks that all targeted datasources returned results. Retries missing or transiently-failed datasources (max 2 alignment retries). Non-retryable errors (auth, session) are skipped.
9. **aggregate** -- Correlates findings into a unified incident report with timeline, confidence score, and per-datasource attribution.
10. **checkConfidence** -- HITL gate: escalates to human approval when confidence < 0.6, errors are detected, or a production mutation is attempted.
11. **validate** -- Anti-hallucination check. Verifies answer length, datasource references, and timestamp authenticity. Failed validation retries aggregation (max 2 retries).
12. **proposeMitigation** -- Generates actionable mitigation steps based on the validated incident report.
13. **followUp** -- Generates 3-4 follow-up question suggestions based on the response context.

---

## Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Bun 1.3.9+ | Fast TypeScript execution, built-in test runner, native .env loading, workspace support |
| Agent Framework | LangGraph TypeScript | StateGraph with typed annotations, Send API for fan-out, conditional edges, checkpointing |
| LLM Provider | AWS Bedrock | Enterprise-grade access to Claude models with IAM authentication, no API key management |
| LLM Models | Claude Sonnet 4.6 (orchestrator), Claude Haiku 4.5 (sub-agents) | Sonnet for reasoning-heavy nodes, Haiku for fast tool-calling sub-agents |
| Tool Protocol | Model Context Protocol (MCP) | Standardized tool interface, language-agnostic, transport-flexible, ecosystem support |
| Frontend | SvelteKit 2.0, Svelte 5 runes, Tailwind CSS v4 | Reactive UI with SSE streaming, runes for fine-grained reactivity, utility-first styling |
| Validation | Zod | Runtime type validation for configs, API payloads, LLM structured outputs |
| Logging | Pino | Structured JSON logging, child loggers for request scoping, log-level filtering |
| Tracing | OpenTelemetry + LangSmith | OTEL for cross-service traces, LangSmith for agent-specific observability and feedback |
| Linting | Biome | Fast linting and formatting, replaces ESLint + Prettier |
| Transport | Streamable HTTP | MCP server transport for agent-to-server communication, supports health endpoints |

---

## Port Assignments

| Service | Port | Protocol |
|---------|------|----------|
| SvelteKit Frontend | 5173 | HTTP |
| Elasticsearch MCP Server | 9080 | Streamable HTTP (MCP) |
| Kafka MCP Server | 9081 | Streamable HTTP (MCP) |
| Couchbase Capella MCP Server | 9082 | Streamable HTTP (MCP) |
| Kong Konnect MCP Server | 9083 | Streamable HTTP (MCP) |
| GitLab MCP Server | 9084 | Streamable HTTP (MCP) |
| Atlassian MCP Server | 9085 | Streamable HTTP (MCP) |
| Atlassian OAuth Callback | 9185 | HTTP (OAuth 2.0 redirect) |

Each MCP server exposes two HTTP endpoints:
- `POST /mcp` -- MCP protocol messages (tool calls, tool results)
- `GET /health` -- health check for the agent's periodic polling

---

## Security Boundaries

The system enforces several security boundaries:

- **Network isolation:** MCP servers are internal services, not exposed to the internet. The SvelteKit frontend is the only user-facing endpoint.
- **Read-only enforcement:** write operations are disabled at both the MCP server configuration level (feature gates) and the agent compliance level (allowed-actions.yaml).
- **PII redaction:** the compliance layer specifies `pii_handling: redact` for all agents, applied to data in transit.
- **Audit logging:** all prompts, responses, tool calls, decision pathways, and model versions are logged to LangSmith with immutable, structured JSON logs and 1-year retention.
- **Conditional HITL:** human-in-the-loop escalation triggers when confidence < 0.6, when errors are detected, or when a production mutation is attempted.
- **Kill switch:** the compliance config includes `kill_switch: true` for immediate agent shutdown.
- **IAM authentication:** AWS Bedrock LLM access uses IAM roles, not API keys. No secrets are stored in the codebase.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial document created from codebase analysis |
| 2026-04-13 | Added GitLab as 5th datasource/MCP server, updated pipeline from 8 to 12 nodes (normalize, selectRunbooks, checkConfidence, proposeMitigation) |
| 2026-04-23 | Added Atlassian (Jira/Confluence) as 6th datasource/MCP server (port 9085, OAuth callback 9185) |
