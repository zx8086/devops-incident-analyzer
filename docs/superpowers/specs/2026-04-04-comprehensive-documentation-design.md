# Comprehensive Project Documentation

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-04-04
> **Conventions:** See [documentation-guide.md](../../../guides/documentation-guide.md)

Design spec for comprehensive project-specific documentation following the two-tier system prescribed by the documentation guide. Creates 16 documents + 1 index under `docs/`, decomposes the existing 1265-line setup guide, migrates the AgentCore deployment doc, and links everything from the project README.

---

## Context

The DevOps Incident Analyzer monorepo has outgrown its single README + setup guide. The team needs structured, navigable documentation for onboarding, development, deployment, and operations. The existing `devops-incident-analyzer-setup-guide.md` (1265 lines) is a linear implementation blueprint that mixes architecture, code samples, and phase-by-phase instructions -- useful during initial build but hard to reference day-to-day.

**What exists today:**
- `README.md` -- concise project overview (113 lines)
- `devops-incident-analyzer-setup-guide.md` -- monolithic architecture blueprint (1265 lines)
- `docs/agentbedrockcore/AGENTCORE-DEPLOYMENT.md` -- AWS AgentCore deployment guide
- `docs/superpowers/specs/` -- one design spec
- `guides/` -- 18 reusable programming guides (project-agnostic)

**What's missing:**
- Per-topic reference docs (architecture, config, deployment, operations)
- Navigation index (`docs/README.md`)
- Cross-references between project docs and reusable guides
- Frontend development guide
- Troubleshooting runbook

---

## Audience

Internal Siobytes team developers. Assumes familiarity with the tech stack (Bun, LangGraph, MCP, SvelteKit). Documentation should be reference-oriented (look up what you need) rather than tutorial-oriented (read cover to cover).

---

## Document Inventory

### File Tree

```
docs/
  README.md                              # Navigation index

  architecture/
    system-overview.md                   # Big picture: purpose, decisions, data flow
    agent-pipeline.md                    # 8-node LangGraph graph: nodes, state, routing
    gitagent-bridge.md                   # YAML/MD definitions -> LangGraph adapter
    mcp-integration.md                   # 4 MCP server connections, health, traces

  configuration/
    environment-variables.md             # All env vars grouped by service
    mcp-server-configuration.md          # 4-pillar config pattern per server

  deployment/
    local-development.md                 # Docker Compose + bare-metal setup
    agentcore-deployment.md              # AWS Bedrock AgentCore (migrated)
    docker-reference.md                  # Dockerfile patterns, multi-stage builds

  development/
    getting-started.md                   # Onboarding: zero to running system
    monorepo-structure.md                # Package map, dependency graph
    testing.md                           # Test strategy, patterns, running tests
    adding-mcp-tools.md                  # Step-by-step tool creation
    frontend.md                          # SvelteKit app, components, SSE, Tailwind

  operations/
    observability.md                     # Pino logging, OpenTelemetry, LangSmith
    troubleshooting.md                   # Symptom-based problem resolution
```

16 documents + 1 index. Total estimated: ~4000-5000 lines.

---

## Per-Document Specifications

### docs/README.md -- Documentation Index (~150 lines)

**Purpose:** Single entry point. Task-oriented quick navigation table, then category catalog, then programming guides index.

**Sections:**
- Quick Navigation (task-oriented table, 12 rows)
- By Category (Architecture, Configuration, Deployment, Development, Operations)
- Programming Guides (links to all 18 `guides/` files, grouped by topic)
- Related Documentation (README.md, CLAUDE.md, .env.example, agents/)
- Changelog

---

### docs/architecture/system-overview.md (~300 lines)

**Purpose:** First document a new team member reads. What the system does, how pieces connect, key design decisions.

**Sections:**
- System Purpose
- High-Level Architecture (ASCII box-and-arrow diagram)
- Key Design Decisions (gitagent, supervisor fan-out, MCP as tool layer, read-only constraint)
- Component Summary (table: component, package, responsibility)
- Data Flow (ASCII diagram: query -> classification -> fan-out -> alignment -> aggregation -> validation)
- Technology Stack (table: layer, technology, rationale)

**Cross-references:** `langgraph-workflow-guide.md`, `mcp-server-guide.md`, `ai-engineering.md`

---

### docs/architecture/agent-pipeline.md (~400 lines)

**Purpose:** Deep reference for the 8-node LangGraph StateGraph.

**Sections:**
- Pipeline Overview (ASCII flow diagram)
- State Annotation (AgentState fields table: field, type, reducer, purpose)
- Node Reference (one H3 per node: classify, entityExtractor, supervisor, queryDataSource, align, aggregate, validate, followUp)
- Routing Logic (simple vs complex, alignment retry, validation retry)
- Sub-Agent Dispatch (Send API, AGENT_NAMES mapping, tool scoping)
- Model Selection (per-role model table)

**Source files:** `packages/agent/src/graph.ts`, `state.ts`, `supervisor.ts`, `validator.ts`, `aggregator.ts`, `alignment.ts`

**Cross-references:** `langgraph-workflow-guide.md`, `ai-engineering.md`

---

### docs/architecture/gitagent-bridge.md (~350 lines)

**Purpose:** Documents the declarative agent definition system and the bridge that compiles it.

**Sections:**
- Overview: The Two-Layer System (agents/ = definitions, bridge/ = adapter, agent/ = runtime)
- Agent Definition Structure (directory layout, agent.yaml spec, SOUL.md, RULES.md, tools/*.yaml, skills/*.md, compliance/)
- Bridge Package Components (manifest-loader, model-factory, skill-loader, tool-prompt, related-tools, compliance, tool-schema)
- How the Runtime Consumes Bridge Output
- Adding or Modifying Agent Definitions (step-by-step)

**Source files:** `agents/incident-analyzer/agent.yaml`, all files in `packages/gitagent-bridge/src/`

**Cross-references:** `ai-engineering.md`, `4-pillar-configuration-guide.md`

---

### docs/architecture/mcp-integration.md (~350 lines)

**Purpose:** How the agent connects to 4 MCP servers.

**Sections:**
- Architecture (ASCII diagram: Agent -> MultiServerMCPClient -> 4 servers)
- Connection Model (MultiServerMCPClient config, independent connections, Streamable HTTP)
- Tool Scoping (server-to-datasource mapping table, getToolsForDataSource routing)
- Health Monitoring (periodic polling, automatic reconnection, graceful degradation)
- Trace Propagation (W3C Traceparent injection, cross-service correlation)
- MCP Server Summary (one H3 per server: purpose, tool categories, key config, transport)
- Dynamic Tool Prompts (gitagent-driven descriptions, related tools)

**Source files:** `packages/agent/src/mcp-bridge.ts`, each server's `server.ts`

**Cross-references:** `mcp-server-guide.md`, `bun-otel-guide.md`

---

### docs/configuration/environment-variables.md (~250 lines)

**Purpose:** Single reference for every environment variable. Grouped by service.

**Sections:**
- Overview (configuration source, naming convention)
- AWS (Bedrock LLM Access) -- table
- LangSmith (Tracing) -- table
- Elasticsearch MCP Server (multi-deployment pattern) -- table
- Kafka MCP Server (provider selection, feature gates) -- table
- Couchbase Capella MCP Server -- table
- Kong Konnect MCP Server -- table
- Agent Configuration -- table
- MCP Server URLs -- table
- Server Configuration -- table

**Cross-references:** `4-pillar-configuration-guide.md`, `bun-runtime-guide.md`

---

### docs/configuration/mcp-server-configuration.md (~300 lines)

**Purpose:** Deep dive into the 4-pillar config pattern as implemented in each server.

**Sections:**
- Configuration Pattern (defaults.ts -> envMapping.ts -> schemas.ts -> loader.ts)
- Per-server H2 sections: Elasticsearch, Kafka, Couchbase, Konnect (config schema, authentication, tool registration)
- Transport Configuration (HTTP vs SSE vs stdio vs AgentCore)

**Source files:** `packages/mcp-server-*/src/config/`

**Cross-references:** `4-pillar-configuration-guide.md`, `mcp-server-guide.md`

---

### docs/deployment/local-development.md (~250 lines)

**Purpose:** Running the full stack locally.

**Sections:**
- Prerequisites (Bun, Docker, credentials)
- Option 1: Docker Compose (start, ports table, logs, stop)
- Option 2: Bare-Metal (individual server commands, web frontend)
- Port Assignments (table: service, local, Docker, AgentCore)
- Common Startup Issues (port conflicts, MCP failures, credential errors)

**Cross-references:** `bun-docker-security-guide.md`, `bun-runtime-guide.md`

---

### docs/deployment/agentcore-deployment.md (~350 lines)

**Purpose:** Migrated from `docs/agentbedrockcore/AGENTCORE-DEPLOYMENT.md`. AWS Bedrock AgentCore deployment.

**Sections:**
- Overview (what AgentCore Runtime expects)
- Architecture (ASCII: microVM -> entrypoint -> /ping + /mcp -> McpServer -> tools)
- Parameterized Dockerfile (MCP_SERVER_PACKAGE arg, multi-stage, security)
- AgentCore Entrypoint Contract (GET /ping, POST /mcp, port 8000)
- Deployment Steps (build, ECR push, create runtime, register gateway)
- IAM Policies (MSK, Elasticsearch, CloudWatch)
- Deployment Scripts (reference to scripts/agentcore/)
- Testing Locally (docker run)

**Cross-references:** `bun-docker-security-guide.md`, `bun-kubernetes-guide.md`

---

### docs/deployment/docker-reference.md (~180 lines)

**Purpose:** Dockerfile patterns across the project.

**Sections:**
- Build Strategy (multi-stage: deps -> runtime, base image)
- Local Development Images (per-service table)
- AgentCore Production Image (parameterized build, commands for all 4 servers)
- Security Practices (non-root user, dumb-init, health checks)

**Cross-references:** `bun-docker-security-guide.md`

---

### docs/development/getting-started.md (~250 lines)

**Purpose:** Onboarding document. Zero to running system.

**Sections:**
- Prerequisites (software, accounts/credentials)
- Initial Setup (clone, install, configure .env, verify typecheck + lint)
- First Run (start MCP servers, start web, send first query with expected output)
- Run Tests (all, single package, watch mode, type checking)
- Development Workflow (Linear SIO-XX format, branch strategy, pre-commit checks)
- Where to Go Next (pointers to monorepo-structure, agent-pipeline, adding-mcp-tools)

**Cross-references:** `bun-runtime-guide.md`, `bun-testing-guide.md`

---

### docs/development/monorepo-structure.md (~300 lines)

**Purpose:** Detailed map of every workspace package and app.

**Sections:**
- Workspace Layout (ASCII tree)
- Package Dependency Graph (ASCII diagram)
- Package Reference (one H3 per package: shared, observability, checkpointer, gitagent-bridge, agent, 4 MCP servers)
- App Reference (web: SvelteKit)
- Gitagent Definitions (agents/ structure)
- Bun Workspace Configuration (catalogs, scripts)

**Cross-references:** `bun-runtime-guide.md`

---

### docs/development/testing.md (~250 lines)

**Purpose:** Testing strategy and patterns.

**Sections:**
- Running Tests (all, single package, watch mode)
- Test Organization (unit: co-located, integration: __tests__/)
- Package-Specific Testing (gitagent-bridge, agent, shared, MCP servers)
- Testing Patterns (Bun test runner, MCP tool validation, mocking vs live)
- Type Checking as a Test Gate

**Cross-references:** `bun-testing-guide.md`

---

### docs/development/adding-mcp-tools.md (~250 lines)

**Purpose:** Most common dev task: adding a tool to an MCP server.

**Sections:**
- Tool Registration Flow (ASCII: tool file -> server registration -> agent discovery)
- Step-by-Step: Add a New Tool (7 steps: create operation, register, add gitagent YAML, prompt template, related tools, test, validate schema)
- Modifying Existing Tools
- Tool Conventions (naming, schema, error handling, feature gates)
- Server-Specific Notes (Elasticsearch multi-deployment, Kafka providers, Konnect elicitation)

**Cross-references:** `mcp-server-guide.md`

---

### docs/development/frontend.md (~300 lines)

**Purpose:** SvelteKit frontend development guide.

**Sections:**
- App Overview (SvelteKit 2.0, routes, SSR/CSR, server hooks)
- Component Architecture (9 components with responsibility table)
- State Management (Svelte 5 runes: $state, $derived, $effect, $props)
- SSE Streaming Integration (agent -> server hooks -> EventSource -> components)
- Tailwind CSS v4 (Tommy Hilfiger brand palette, utility-first, no custom CSS)
- Stores and Composables
- Adding New Components (step-by-step)

**Source files:** `apps/web/src/`

**Cross-references:** `svelte-5-guide.md`, `ui-ux-style-guide.md`

---

### docs/operations/observability.md (~300 lines)

**Purpose:** Monitoring the running system.

**Sections:**
- Logging Architecture (createMcpLogger, child loggers, log levels, structured JSON, redaction)
- OpenTelemetry Tracing (initOtel, traceSpan, cross-service propagation)
- LangSmith Integration (agent traces, per-server projects, compliance metadata, feedback)
- Agent Pipeline Tracing (node spans, request ID, tool call tracking)
- Monitoring Endpoints (/health, /ping, MCP server health polling)

**Source files:** `packages/shared/src/logger.ts`, `packages/observability/src/`, `packages/shared/src/telemetry/`, `packages/shared/src/tracing/`

**Cross-references:** `bun-logging-guide.md`, `bun-otel-guide.md`, `bun-profiling-guide.md`

---

### docs/operations/troubleshooting.md (~250 lines)

**Purpose:** Symptom-based problem resolution.

**Sections:**
- MCP Server Issues (fails to start, no tools, health check fails, timeout)
- Agent Issues (no results, validation loop, always simple, sub-agent skipped)
- Frontend Issues (SSE drops, blank response, CORS)
- Configuration Issues (env not loaded, Zod error, multi-deployment not recognized)
- AWS / AgentCore Issues (Bedrock access denied, /ping fails, IAM insufficient)
- Debugging Techniques (log parsing, LangSmith tracing, MCP tool isolation, port conflicts)

**Cross-references:** `bun-logging-guide.md`, `bun-otel-guide.md`

---

## Setup Guide Decomposition Map

| Setup Guide Lines | Content | Target Document |
|---|---|---|
| 1-36 | Oracle Agent Spec analysis | `architecture/system-overview.md` |
| 38-177 | Project structure tree | `development/monorepo-structure.md` |
| 182-258 | Phase 1: scaffold | `development/getting-started.md` |
| 260-498 | Phase 2: gitagent definitions | `architecture/gitagent-bridge.md` |
| 498-1039 | Phase 3: gitagent-bridge code | `architecture/gitagent-bridge.md` |
| 1041-1081 | Phase 4: agent adaptation | `architecture/agent-pipeline.md` |
| 1082-1155 | Phase 5: MCP wiring | `architecture/mcp-integration.md` + `development/adding-mcp-tools.md` |
| 1157-1165 | Phase 6: shared/checkpointer/observability/apps | `development/monorepo-structure.md` + `operations/observability.md` |
| 1169-1193 | Phase 7: CI validation | `development/testing.md` |
| 1197-1228 | Carry-over/new tables | `architecture/system-overview.md` + `architecture/agent-pipeline.md` |
| 1230-1265 | Build order timeline | Not migrated (one-time implementation plan) |

The root-level `devops-incident-analyzer-setup-guide.md` is retained as a historical reference after decomposition.

---

## AgentCore Migration

`docs/agentbedrockcore/AGENTCORE-DEPLOYMENT.md` content migrates to `docs/deployment/agentcore-deployment.md`. Supporting files in `docs/agentbedrockcore/` (TypeScript entrypoints, shell scripts, Dockerfile snippets, IAM JSON) are referenced by path from the new doc -- canonical copies live at:
- `Dockerfile.agentcore` (project root)
- `scripts/agentcore/` (deployment scripts)
- `packages/shared/src/transport/agentcore.ts` (entrypoint)

After migration, `docs/agentbedrockcore/` can be archived or deleted.

---

## README.md Integration

A new `## Documentation` section is added to the project `README.md` after "Environment Variables" and before "Tech Stack":

```markdown
## Documentation

| Need to... | Go to... |
|------------|----------|
| Full documentation index | [docs/README.md](docs/README.md) |
| Understand the architecture | [System Overview](docs/architecture/system-overview.md) |
| Set up the project | [Getting Started](docs/development/getting-started.md) |
| Deploy to AgentCore | [AgentCore Deployment](docs/deployment/agentcore-deployment.md) |
| Programming guides | [guides/](guides/) (18 reusable guides) |
```

---

## Cross-Reference Map

| docs/ Document | guides/ Cross-References |
|---|---|
| `architecture/system-overview.md` | `langgraph-workflow-guide.md`, `mcp-server-guide.md`, `ai-engineering.md` |
| `architecture/agent-pipeline.md` | `langgraph-workflow-guide.md`, `ai-engineering.md` |
| `architecture/gitagent-bridge.md` | `ai-engineering.md`, `4-pillar-configuration-guide.md` |
| `architecture/mcp-integration.md` | `mcp-server-guide.md`, `bun-otel-guide.md` |
| `configuration/environment-variables.md` | `4-pillar-configuration-guide.md`, `bun-runtime-guide.md` |
| `configuration/mcp-server-configuration.md` | `4-pillar-configuration-guide.md`, `mcp-server-guide.md` |
| `deployment/local-development.md` | `bun-docker-security-guide.md`, `bun-runtime-guide.md` |
| `deployment/agentcore-deployment.md` | `bun-docker-security-guide.md`, `bun-kubernetes-guide.md` |
| `deployment/docker-reference.md` | `bun-docker-security-guide.md` |
| `development/getting-started.md` | `bun-runtime-guide.md`, `bun-testing-guide.md` |
| `development/monorepo-structure.md` | `bun-runtime-guide.md` |
| `development/testing.md` | `bun-testing-guide.md` |
| `development/adding-mcp-tools.md` | `mcp-server-guide.md` |
| `development/frontend.md` | `svelte-5-guide.md`, `ui-ux-style-guide.md` |
| `operations/observability.md` | `bun-logging-guide.md`, `bun-otel-guide.md`, `bun-profiling-guide.md` |
| `operations/troubleshooting.md` | `bun-logging-guide.md`, `bun-otel-guide.md` |

Each cross-reference uses the blockquote callout format:

```markdown
> For a project-agnostic reference, see the [LangGraph Workflow Guide](../../guides/langgraph-workflow-guide.md).
```

---

## Implementation Phasing

1. **Foundation:** `docs/README.md`, `getting-started.md`, `monorepo-structure.md`
2. **Architecture:** `system-overview.md`, `agent-pipeline.md`, `gitagent-bridge.md`, `mcp-integration.md`
3. **Config + Deploy:** `environment-variables.md`, `mcp-server-configuration.md`, `local-development.md`, `agentcore-deployment.md`, `docker-reference.md`
4. **Dev + Ops:** `testing.md`, `adding-mcp-tools.md`, `frontend.md`, `observability.md`, `troubleshooting.md`
5. **Integration:** Update root `README.md`, archive `docs/agentbedrockcore/`

---

## Conventions (from documentation-guide.md)

All documents follow:
- ASCII diagrams only (no Mermaid, no images)
- No emojis anywhere
- Metadata block: targets, last updated, conventions link
- H1 title only (one per file), H2 major sections, H3 subsections, H4 rare, H5+ never
- `---` separators between H2 sections
- Code blocks with language tags
- Correct/Incorrect annotation markers with reasons
- Table of Contents for docs >500 lines
- Changelog as final section
- Cross-references: `docs/` -> `guides/` via relative paths (allowed), `guides/` -> `docs/` never

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial design spec created |
