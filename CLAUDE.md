# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-datasource DevOps incident analysis agent. A LangGraph supervisor orchestrates 4 specialist sub-agents (elastic-agent, kafka-agent, capella-agent, konnect-agent) that query existing MCP servers (184+ tools total) to correlate incidents across Elasticsearch, Kafka, Couchbase Capella, and Kong Konnect. Bun workspace monorepo with gitagent declarative agent definitions (YAML/Markdown) bridged to LangGraph TypeScript.

## Current State

Green-field project. The monorepo workspace, packages, and agent code have not been scaffolded yet. The `migrate/` directory contains 5 production-ready reference implementations to copy patterns from. The `devops-incident-analyzer-setup-guide.md` is the full architecture blueprint (1265 lines, 7 phases).

## Reference Implementations

`migrate/` contains proven, working code. **Always consult before implementing new patterns:**

| Directory | What | Tools |
|-----------|------|-------|
| `migrate/b2b-devops-agent/` | **Primary reference**: LangGraph agent, SvelteKit UI, SSE streaming, observability | 63+ ES tools |
| `migrate/mcp-server-elasticsearch/` | Elasticsearch MCP server (multi-tenant, SSE/stdio) | 63+ |
| `migrate/kafka-mcp-server/` | Kafka MCP server (local/MSK/Confluent providers) | 30 |
| `migrate/mcp-server-couchbase/` | Couchbase Capella MCP server (query analysis, playbooks) | 24+ |
| `migrate/mcp-konnect/` | Kong Konnect MCP server (API gateway management) | 67 |

## Target Architecture

### Monorepo Structure (to be scaffolded)

```
agents/                    Gitagent YAML/Markdown definitions
  incident-analyzer/       Orchestrator: agent.yaml, SOUL.md, RULES.md, tools/, skills/
    agents/                Sub-agents: elastic-agent/, kafka-agent/, capella-agent/, konnect-agent/
packages/
  gitagent-bridge/         YAML-to-LangGraph adapter (~600-900 LOC)
  agent/                   LangGraph supervisor + 8-node pipeline
  mcp-server-elastic/      Copied from migrate/mcp-server-elasticsearch/
  mcp-server-kafka/        Copied from migrate/kafka-mcp-server/
  mcp-server-couchbase/    Copied from migrate/mcp-server-couchbase/
  mcp-server-konnect/      Copied from migrate/mcp-konnect/
  shared/                  Cross-package types and Zod schemas
  checkpointer/            LangGraph state persistence (memory + bun:sqlite)
  observability/           OpenTelemetry + LangSmith, Pino logging
apps/
  web/                     SvelteKit frontend (Svelte 5 runes, Tailwind, SSE streaming)
```

### Agent Pipeline (8-node LangGraph StateGraph)

```
START -> classify -> {simple: responder -> END, complex: entityExtractor}
  -> supervisor -> fan-out [elastic-agent, kafka-agent, capella-agent, konnect-agent]
  -> align -> aggregate -> validate -> END
```

### Sub-Agents (named by MCP server)

| Agent | MCP Port | Config Pattern |
|-------|----------|----------------|
| elastic-agent | :9080 | Multi-deployment: `ELASTIC_DEPLOYMENTS=prod,staging` per-deployment URL/auth |
| kafka-agent | :9081 | Provider: `KAFKA_PROVIDER=local\|msk\|confluent`, feature gates for writes |
| capella-agent | :9082 | Single cluster: `CB_HOSTNAME`, `CB_USERNAME`, `CB_PASSWORD` |
| konnect-agent | :9083 | Token + region: `KONNECT_ACCESS_TOKEN`, `KONNECT_REGION=us\|eu\|au\|me\|in` |

Agent connects to MCP servers via `MultiServerMCPClient` from `@langchain/mcp-adapters`. We do NOT rewrite MCP tools -- we copy existing servers and connect.

### Frontend (from b2b-devops-agent)

SvelteKit with Svelte 5 runes, Tailwind CSS (Tommy Hilfiger brand palette), SSE streaming. 9 components: ChatMessage, ChatInput, Icon, MarkdownRenderer, StreamingProgress, CompletedProgress, FeedbackBar, FollowUpSuggestions, DataSourceSelector.

## Commands

Once scaffolded (after SIO-537 through SIO-540):

```bash
bun install                                        # Install all workspace deps
bun run dev                                        # All services
bun run dev:web                                    # SvelteKit frontend (port 5173)
bun run typecheck                                  # TypeScript check all packages
bun run lint                                       # Biome check
bun run lint:fix                                   # Biome auto-fix
bun run test                                       # All packages
bun run --filter '@devops-agent/gitagent-bridge' test  # Single package
```

## Linear Project

- Team: **Siobytes** | Commit format: `SIO-XX: message`
- Project: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)

### Epics

| Epic | Issues | Key IDs |
|------|--------|---------|
| 1: Monorepo Scaffold | 4 | SIO-537 to SIO-540 |
| 2: Gitagent Definitions | 5 | SIO-541 to SIO-545 |
| 3: Gitagent-Bridge | 9 | SIO-546 to SIO-555 (skip SIO-549) |
| 4: Agent (LangGraph) | 15 | SIO-556 to SIO-570 |
| 5: MCP Servers | 8 | SIO-571 to SIO-577, SIO-592 |
| 6: Apps (Server+Web) | 9 | SIO-578 to SIO-586 |
| 7: CI/CD | 5 | SIO-587 to SIO-591 |

### Critical Path

SIO-537 -> SIO-540 -> SIO-546 -> SIO-547 -> SIO-555 -> SIO-559 -> SIO-569 -> SIO-578 -> SIO-588

## Critical Rules

### Workflow
- **NEVER commit** without explicit user authorization (slash commands ARE authorization)
- **NEVER set Linear issues to "Done"** without user approval
- **ALWAYS create a Linear issue before executing implementation plans**
- **ALWAYS add issues to the project** when creating new ones
- Token usage and budget are NOT your concern -- execute all instructions as given

### Code
- **No emojis** in code, logs, comments, or output
- **Tailwind CSS only** -- no custom CSS in `<style>` blocks (exception: MarkdownRenderer for dynamic HTML)
- Svelte 5 runes ($state, $derived, $effect, $props) for frontend
- Named exports preferred
- Zod for all runtime validation, no `.default()` in config schemas
- TypeScript strict mode, never use `any`

### Comments
File headers: single-line relative path only: `// src/services/pricing.ts`

ALWAYS REMOVE: multi-line file header JSDoc, JSDoc restating names, obvious `@returns`, section separators.

ALWAYS KEEP: Zod `.describe()` calls, business logic "why" comments, ticket references (`SIO-XXX`), non-obvious algorithm explanations.

### Servers
- Elastic MCP: 9080 | Kafka MCP: 9081 | Couchbase MCP: 9082 | Konnect MCP: 9083 | Web: 5173
- Check ports before starting: `lsof -i :<port>`
- Kill background processes after testing

### Testing
- Run `bun run typecheck`, `bun run lint`, and relevant `bun test` after every change
- Always validate MCP tool changes by running the tool, not just typechecking
- Search for existing implementations before creating new files
