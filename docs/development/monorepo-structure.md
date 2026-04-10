# Monorepo Structure

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-04-04

Package map and dependency graph for the DevOps Incident Analyzer Bun workspace monorepo. This document covers the workspace layout, package relationships, and configuration. The monorepo contains 9 packages, 1 app, and a set of declarative agent definitions that the gitagent-bridge package compiles into LangGraph nodes at runtime.

---

## Workspace Layout

```
devops-incident-analyzer/
  agents/
    incident-analyzer/           Orchestrator agent definition
      agent.yaml                 Manifest: model, tools, skills, sub-agents
      SOUL.md                    Agent personality and reasoning style
      RULES.md                   Behavioral constraints and guardrails
      agents/                    Sub-agent definitions
        elastic-agent/
          agent.yaml
          SOUL.md
        kafka-agent/
          agent.yaml
          SOUL.md
        capella-agent/
          agent.yaml
          SOUL.md
        konnect-agent/
          agent.yaml
          SOUL.md
      tools/                     Tool definitions (YAML)
      skills/                    Skill definitions (Markdown)
      compliance/                Compliance rules and audit templates
      knowledge/                 Domain knowledge documents
      workflows/                 Multi-step workflow definitions
    shared/                      Shared agent resources
  packages/
    shared/                      Cross-package types, Zod schemas, MCP bootstrap
    observability/               Pino logger, OpenTelemetry, LangSmith tracing
    checkpointer/                LangGraph state persistence (memory + bun:sqlite)
    gitagent-bridge/             YAML-to-LangGraph adapter
    agent/                       LangGraph supervisor and 8-node pipeline
    mcp-server-elastic/          Elasticsearch MCP server (69 tools)
    mcp-server-kafka/            Kafka MCP server (15 tools)
    mcp-server-couchbase/        Couchbase Capella MCP server (30 tools)
    mcp-server-konnect/          Kong Konnect MCP server (78 tools)
  apps/
    web/                         SvelteKit frontend
  docs/
    architecture/                System design, agent pipeline, gitagent bridge
    configuration/               Environment variables, MCP server configuration
    deployment/                  Local development, AgentCore, container builds
    development/                 Getting started, monorepo structure, testing
    operations/                  Observability, troubleshooting
  scripts/
    agentcore/                   AWS Bedrock AgentCore deployment scripts
  migrate/                       Reference implementations (read-only)
  biome.json                     Biome linter and formatter configuration
  bunfig.toml                    Bun runtime configuration
  docker-compose.yml             Local multi-service orchestration
  Dockerfile.agentcore           AgentCore container build
  package.json                   Workspace root with catalogs
  tsconfig.base.json             Shared TypeScript compiler options
  tsconfig.json                  Root TypeScript project references
  .env.example                   Environment variable template
```

---

## Package Dependency Graph

The diagram shows how packages depend on each other. Arrows point from consumer to dependency.

```
+---------------------+
|  @devops-agent/web  |
|  (SvelteKit app)    |
+----------+----------+
           |
           v
+---------------------+
| @devops-agent/agent |
| (LangGraph pipeline)|
+----------+----------+
           |
     +-----+-----+------------------+------------------+
     |           |                  |                  |
     v           v                  v                  v
+---------+ +-----------+ +---------------+ +---------+
| gitagent| | check-    | | observability | | shared  |
| -bridge | | pointer   | |               | |         |
+---------+ +-----------+ +---------------+ +---------+
     |                          |                  ^
     v                          |                  |
[agents/ YAML]                  +------------------+
                                       |
+-----------------------+              |
| mcp-server-elastic ---+--------------+
| mcp-server-kafka -----+
| mcp-server-couchbase -+
| mcp-server-konnect ---+
+-----------------------+
```

Key relationships:

- **web** depends on **agent** for the LangGraph pipeline and SSE streaming
- **agent** depends on **gitagent-bridge** (YAML manifest loading), **checkpointer** (state persistence), **observability** (tracing and logging), and **shared** (types and schemas)
- **gitagent-bridge** reads from the `agents/` directory at runtime
- All four MCP servers depend on **shared** for the `createMcpApplication` bootstrap, transport abstractions, logger factory, and telemetry initialization
- MCP servers are independent of each other and of the **agent** package -- the agent connects to them over the network via `@langchain/mcp-adapters`

---

## Package Reference

### @devops-agent/shared

Cross-package foundation. Every other package in the workspace depends on this.

| Export | Purpose |
|--------|---------|
| `createMcpApplication` | MCP server bootstrap: config validation, transport setup, tool registration |
| Transport abstractions | SSE, HTTP (Streamable HTTP), stdio, and AgentCore transport factories |
| Logger factory | Pino-based structured logger with ECS formatting |
| Telemetry init | OpenTelemetry SDK bootstrap for spans and metrics |
| Zod schemas | Shared configuration schemas, MCP transport config, common types |
| TypeScript types | `McpServerConfig`, `TransportType`, `ToolDefinition`, incident state types |

Source: `packages/shared/src/`

---

### @devops-agent/observability

Centralized observability stack. Wraps Pino, OpenTelemetry, and LangSmith into a unified interface.

| Component | Purpose |
|-----------|---------|
| Pino logger | Structured JSON logging with ECS field mapping |
| OpenTelemetry SDK | Distributed tracing with automatic span propagation |
| LangSmith integration | LLM call tracing, token usage tracking, feedback collection |
| Trace context | Correlation IDs across MCP server calls and agent nodes |

Source: `packages/observability/src/`

---

### @devops-agent/checkpointer

LangGraph state persistence with two backends. The agent pipeline uses checkpoints to resume interrupted conversations and maintain conversation history.

| Backend | Use Case |
|---------|----------|
| Memory | Development and testing, no persistence across restarts |
| bun:sqlite | Production, persists state to disk via Bun built-in SQLite |

Source: `packages/checkpointer/src/`

---

### @devops-agent/gitagent-bridge

YAML-to-LangGraph adapter. Reads declarative agent definitions from `agents/` and compiles them into LangGraph-compatible nodes, tools, and configuration.

| Module | Responsibility |
|--------|----------------|
| Manifest loader | Parses `agent.yaml` files, resolves sub-agent references |
| Model factory | Creates LLM client instances from YAML model declarations |
| Skill loader | Reads Markdown skill files, converts to system prompt fragments |
| Tool prompt | Generates tool descriptions and usage instructions from YAML |
| Compliance | Applies RULES.md constraints as runtime guardrails |
| Tool schema | Converts YAML tool definitions to Zod-validated tool schemas |

Source: `packages/gitagent-bridge/src/`

---

### @devops-agent/agent

LangGraph supervisor with an 8-node StateGraph pipeline. This is the core orchestration package that processes incident queries.

| Node | Responsibility |
|------|----------------|
| `classify` | Determines if the query is simple (single-source) or complex (multi-source) |
| `entityExtractor` | Extracts entities: service names, time ranges, error codes, cluster IDs |
| `supervisor` | Plans which sub-agents to invoke based on extracted entities |
| `queryDataSource` | Fan-out: dispatches queries to selected MCP server sub-agents in parallel |
| `align` | Aligns timelines and correlates events across data sources |
| `aggregate` | Merges sub-agent responses into a unified incident narrative |
| `validate` | Checks response completeness, flags gaps, suggests follow-ups |
| `followUp` | Generates contextual follow-up questions for the user |

Pipeline flow:

```
START -> classify -> [simple: followUp -> END]
                  -> [complex: entityExtractor -> supervisor -> queryDataSource
                     -> align -> aggregate -> validate -> followUp -> END]
```

The agent connects to MCP servers via `MultiServerMCPClient` from `@langchain/mcp-adapters`. It does not import MCP server code directly.

Source: `packages/agent/src/`

---

### @devops-agent/mcp-server-elastic

Elasticsearch MCP server with 69 tools for querying and managing Elasticsearch deployments.

| Capability | Details |
|------------|---------|
| Tools | 69 tools: index management, search, aggregations, cluster health, templates, ILM |
| Multi-deployment | `ELASTIC_DEPLOYMENTS=prod,staging` with per-deployment URL and API key |
| Transports | SSE, HTTP (Streamable HTTP), stdio, AgentCore |
| Port | 9080 (default) |

Source: `packages/mcp-server-elastic/src/`

---

### @devops-agent/mcp-server-kafka

Kafka MCP server with 15 tools for topic management, consumer group inspection, and message operations.

| Capability | Details |
|------------|---------|
| Tools | 15 tools: topic listing, consumer groups, offsets, message produce/consume |
| Providers | `KAFKA_PROVIDER=local\|msk\|confluent` -- pluggable broker backends |
| Feature gates | Write operations (produce, create topic) gated behind `KAFKA_ENABLE_WRITES` |
| Transports | SSE, HTTP (Streamable HTTP), stdio, AgentCore |
| Port | 9081 (default) |

Source: `packages/mcp-server-kafka/src/`

---

### @devops-agent/mcp-server-couchbase

Couchbase Capella MCP server with 30 tools for cluster management, query analysis, and operational playbooks.

| Capability | Details |
|------------|---------|
| Tools | 30 tools: N1QL query, index management, bucket operations, playbooks |
| Configuration | Single cluster: `CB_HOSTNAME`, `CB_USERNAME`, `CB_PASSWORD` |
| Transports | SSE, HTTP (Streamable HTTP), stdio, AgentCore |
| Port | 9082 (default) |

Source: `packages/mcp-server-couchbase/src/`

---

### @devops-agent/mcp-server-konnect

Kong Konnect MCP server with 78 tools for API gateway management across regions.

| Capability | Details |
|------------|---------|
| Tools | 78 tools: services, routes, plugins, consumers, upstreams, certificates |
| Configuration | `KONNECT_ACCESS_TOKEN`, `KONNECT_REGION=us\|eu\|au\|me\|in` |
| Transports | SSE, HTTP (Streamable HTTP), stdio, AgentCore |
| Port | 9083 (default) |

Source: `packages/mcp-server-konnect/src/`

---

## App Reference

### @devops-agent/web

SvelteKit 2.0 frontend with Svelte 5 runes, Tailwind CSS v4, and Server-Sent Events (SSE) streaming for real-time agent responses.

| Aspect | Details |
|--------|---------|
| Framework | SvelteKit 2.0 with Svelte 5 runes ($state, $derived, $effect, $props) |
| Styling | Tailwind CSS v4 with Tommy Hilfiger brand palette |
| Streaming | SSE for real-time agent response streaming |
| Build tool | Vite 6 |
| Port | 5173 (development) |

The frontend contains 9 components:

| Component | Purpose |
|-----------|---------|
| `ChatMessage` | Renders individual agent and user messages |
| `ChatInput` | Text input with submit handling |
| `Icon` | SVG icon library |
| `MarkdownRenderer` | Renders Markdown in agent responses (exception: uses `<style>` block for dynamic HTML) |
| `StreamingProgress` | Real-time progress indicator during agent processing |
| `CompletedProgress` | Summary of completed agent pipeline stages |
| `FeedbackBar` | User feedback collection (thumbs up/down, comments) |
| `FollowUpSuggestions` | Clickable follow-up questions generated by the validate node |
| `DataSourceSelector` | Multi-select for Elasticsearch, Kafka, Couchbase, Konnect |

Source: `apps/web/src/`

---

## Gitagent Definitions

### agents/incident-analyzer/

Declarative agent definitions that the gitagent-bridge package compiles into LangGraph configuration at runtime. The orchestrator agent and four sub-agents are defined here.

```
agents/incident-analyzer/
  agent.yaml             Orchestrator manifest: model, tools, skills, sub-agents
  SOUL.md                Agent personality: DevOps incident analyst persona
  RULES.md               Behavioral constraints: no destructive actions, cite sources
  agents/
    elastic-agent/       Elasticsearch specialist
      agent.yaml         Tools: 69 ES tools via MCP port 9080
      SOUL.md            Persona: log and metric analysis expert
    kafka-agent/         Kafka specialist
      agent.yaml         Tools: 15 Kafka tools via MCP port 9081
      SOUL.md            Persona: event streaming and consumer group analyst
    capella-agent/       Couchbase Capella specialist
      agent.yaml         Tools: 30 Capella tools via MCP port 9082
      SOUL.md            Persona: document database and query optimization expert
    konnect-agent/       Kong Konnect specialist
      agent.yaml         Tools: 78 Konnect tools via MCP port 9083
      SOUL.md            Persona: API gateway configuration and traffic analyst
  tools/                 Shared tool definitions (YAML)
  skills/                Multi-step skill definitions (Markdown)
  compliance/            Compliance rules and audit templates
  knowledge/             Domain knowledge: runbooks, architecture docs
  workflows/             Multi-step workflow definitions
```

The gitagent-bridge reads these files at startup and produces:

- LangGraph node configurations for each sub-agent
- System prompts assembled from SOUL.md + RULES.md + skill files
- Tool schemas validated against the connected MCP server tool lists
- Compliance guardrails injected as pre/post-processing steps

---

## Bun Workspace Configuration

The root `package.json` defines the workspace structure and dependency catalogs.

### Workspace Packages

```json
{
  "workspaces": {
    "packages": ["packages/*", "apps/*"]
  }
}
```

All directories under `packages/` and `apps/` are automatically registered as workspace members.

### Dependency Catalogs

Catalogs pin shared dependency versions across the workspace. Individual packages reference catalog entries instead of specifying versions directly.

**Default catalog** -- runtime dependencies shared across packages:

| Dependency | Version | Used By |
|------------|---------|---------|
| `@langchain/langgraph` | ^1.2.2 | agent |
| `@langchain/langgraph-checkpoint` | ^1.0.0 | checkpointer |
| `@langchain/mcp-adapters` | ^1.1.3 | agent |
| `@langchain/aws` | ^0.1.0 | agent |
| `@langchain/core` | ^1.1.31 | agent, gitagent-bridge |
| `@modelcontextprotocol/sdk` | ^1.27.1 | shared, all MCP servers |
| `zod` | ^3.24.0 | all packages |
| `yaml` | ^2.6.0 | gitagent-bridge |
| `pino` | ^9.0.0 | shared, observability |
| `marked` | ^15.0.0 | web |
| `highlight.js` | ^11.10.0 | web |
| `langsmith` | ^0.5.8 | observability |

**Dev catalog** -- development tooling:

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@biomejs/biome` | ^2.4.6 | Linting and formatting |
| `@types/bun` | ^1.3.10 | Bun type definitions |
| `bun-types` | ^1.3.10 | Bun runtime types |
| `typescript` | ^5.9.3 | TypeScript compiler |

**Svelte catalog** -- frontend framework:

| Dependency | Version | Purpose |
|------------|---------|---------|
| `svelte` | ^5.0.0 | Svelte 5 with runes |
| `@sveltejs/kit` | ^2.0.0 | SvelteKit framework |
| `@sveltejs/adapter-auto` | ^4.0.0 | Deployment adapter |
| `@sveltejs/vite-plugin-svelte` | ^5.0.0 | Vite integration |
| `vite` | ^6.0.0 | Build tool |

### Root Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `bun run --filter '*' dev` | Start all services in development mode |
| `test` | `bun run --filter '*' test` | Run tests across all packages |
| `typecheck` | `bun run --filter '*' typecheck` | TypeScript checking across all packages |
| `lint` | `biome check .` | Biome lint check |
| `lint:fix` | `biome check --write .` | Biome auto-fix |
| `yaml:check` | `yamllint -d relaxed agents/ .yamllint.yml` | Validate agent YAML definitions |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial monorepo structure document created |
