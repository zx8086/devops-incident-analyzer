# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-datasource DevOps incident analysis agent. A LangGraph supervisor orchestrates 5 specialist sub-agents (elastic-agent, kafka-agent, capella-agent, konnect-agent, gitlab-agent) that query existing MCP servers (210+ tools total) to correlate incidents across Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, and GitLab. Bun workspace monorepo with gitagent declarative agent definitions (YAML/Markdown) bridged to LangGraph TypeScript.

## Current State

Fully implemented monorepo with 10 packages, 5 MCP servers, a 14-node LangGraph pipeline (SIO-681 added `correlationFetch` + `enforceCorrelationsAggregate` between aggregate and checkConfidence; SIO-764 added `extractFindings` after aggregate), gitagent declarative agent definitions, and a SvelteKit frontend. All MCP servers use a unified bootstrap (`createMcpApplication` from `@devops-agent/shared`) with standardized logging, 3 transport modes (stdio/http/agentcore), and action-driven tool selection replacing regex filtering. GitLab MCP uses a proxy pattern (forwarding to GitLab's native `/api/v4/mcp` endpoint) plus custom code-analysis tools. The `devops-incident-analyzer-setup-guide.md` is the original architecture blueprint (historical reference).

## Architecture

### Monorepo Structure

```
agents/                    Gitagent YAML/Markdown definitions
  incident-analyzer/       Orchestrator: agent.yaml, SOUL.md, RULES.md, tools/, skills/
    agents/                Sub-agents: elastic-agent/, kafka-agent/, capella-agent/, konnect-agent/, gitlab-agent/
packages/
  gitagent-bridge/         YAML-to-LangGraph adapter (manifest loading, tool mapping, prompt construction)
  agent/                   LangGraph supervisor + 14-node pipeline (incl. SIO-681 correlation enforcement, SIO-764 findings extraction)
  mcp-server-elastic/      Elasticsearch MCP server (multi-deployment, 69 tools)
  mcp-server-kafka/        Kafka MCP server (local/MSK/Confluent, 15-55 tools gated: kafka-core + SR + ksqlDB + Connect + REST Proxy)
  mcp-server-couchbase/    Couchbase Capella MCP server (query analysis, playbooks, 24+ tools)
  mcp-server-konnect/      Kong Konnect MCP server (API gateway management, 67+ tools)
  mcp-server-gitlab/       GitLab MCP server (proxy + code analysis, 21+ tools)
  shared/                  Cross-package types, Zod schemas, unified bootstrap, AgentCore proxy
  checkpointer/            LangGraph state persistence (memory + bun:sqlite)
  observability/           OpenTelemetry + LangSmith, Pino logging
apps/
  web/                     SvelteKit frontend (Svelte 5 runes, Tailwind, SSE streaming)
```

### Agent Pipeline (14-node LangGraph StateGraph)

```
START -> classify -> {simple: responder -> followUp -> END, complex: normalize}
  -> [selectRunbooks] -> entityExtractor -> fan-out [elastic, kafka, capella, konnect, gitlab]
  -> align -> aggregate -> extractFindings -> {enforceCorrelationsRouter}
  -> [correlationFetch ->] enforceCorrelationsAggregate
  -> checkConfidence -> validate -> proposeMitigation -> followUp -> END
```

The `enforceCorrelationsRouter` (SIO-681) sits between `aggregate` and `checkConfidence`; it dispatches `correlationFetch` Sends for any unsatisfied correlation rule (e.g. kafka-significant-lag must have a matching elastic-agent finding), then `enforceCorrelationsAggregate` re-evaluates rules and caps `confidenceCap` at 0.6 when rules remain degraded. See `docs/architecture/agent-pipeline.md` for the full diagram and rule list. SIO-764 added the `extractFindings` node immediately after `aggregate`; it reads each sub-agent's `toolOutputs[]` and derives per-domain typed findings (`kafkaFindings`) onto the `DataSourceResult` for the rule engine to consume.

### Sub-Agents (named by MCP server)

| Agent | MCP Port | Config Pattern |
|-------|----------|----------------|
| elastic-agent | :9080 | Multi-deployment: `ELASTIC_DEPLOYMENTS=prod,staging` per-deployment URL/auth |
| kafka-agent | :9081 | Provider: `KAFKA_PROVIDER=local\|msk\|confluent`, feature gates for writes |
| capella-agent | :9082 | Single cluster: `CB_HOSTNAME`, `CB_USERNAME`, `CB_PASSWORD` |
| konnect-agent | :9083 | Token + region: `KONNECT_ACCESS_TOKEN`, `KONNECT_REGION=us\|eu\|au\|me\|in` |
| gitlab-agent | :9084 | Token + instance: `GITLAB_PERSONAL_ACCESS_TOKEN`, `GITLAB_INSTANCE_URL` |

Agent connects to MCP servers via `MultiServerMCPClient` from `@langchain/mcp-adapters`. Sub-agents use action-driven tool selection (declared in tool YAML files) to filter 210+ MCP tools down to 5-25 per invocation, preventing context overflow.

### Frontend

SvelteKit with Svelte 5 runes, Tailwind CSS (Tommy Hilfiger brand palette), SSE streaming. 9 components: ChatMessage, ChatInput, Icon, MarkdownRenderer, StreamingProgress, CompletedProgress, FeedbackBar, FollowUpSuggestions, DataSourceSelector.

## Commands

```bash
bun install                                            # Install all workspace deps
bun run dev                                            # All services
bun run --filter @devops-agent/web dev                 # SvelteKit frontend (port 5173)
bun run typecheck                                      # TypeScript check all packages
bun run lint                                           # Biome check
bun run lint:fix                                       # Biome auto-fix
bun run test                                           # All packages
bun run --filter '@devops-agent/gitagent-bridge' test  # Single package
bun run yaml:check                                     # Validate agent YAML definitions
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
- **TypeScript strict mode, never use `any`** (biome enforces `noExplicitAny: "error"` since SIO-673)
  - Forbidden: `: any`, `as any`, `Function`, `Record<string, any>`, `jest.MockedFunction<any>`, `z.ZodSchema<any>`
  - Use instead:
    - Tool handler args -> `z.infer<typeof validator>` or `unknown` with `typeof` guards
    - MCP extra param -> `RequestHandlerExtra<ServerRequest, ServerNotification>` from `@modelcontextprotocol/sdk/shared/protocol.js`
    - Opaque payload fields -> `unknown` (narrow at use site)
    - Generic helpers -> `<T>(x: T): T` to preserve caller types end-to-end
    - Builder-pattern Zod helpers -> `z.ZodTypeAny` for the local `let field` accumulator
    - ES SDK responses -> `estypes.<Response>` from `@elastic/elasticsearch` (intersect with `& { extraField? }` if SDK lags runtime)
    - Test mocks -> `Partial<Client>` with the terminal `as unknown as Client` cast, or `ReturnType<typeof mock>` for individual methods
  - `biome-ignore lint/suspicious/noExplicitAny` requires a one-line ticket reference (e.g. `// biome-ignore: SIO-672 - bulk helper expects strict BulkAction`)

### Comments
File headers: single-line relative path only: `// src/services/pricing.ts`

ALWAYS REMOVE: multi-line file header JSDoc, JSDoc restating names, obvious `@returns`, section separators.

ALWAYS KEEP: Zod `.describe()` calls, business logic "why" comments, ticket references (`SIO-XXX`), non-obvious algorithm explanations.

### Servers
- Elastic MCP: 9080 | Kafka MCP: 9081 | Couchbase MCP: 9082 | Konnect MCP: 9083 | GitLab MCP: 9084 | AWS MCP: 9085 | Web: 5173
- Check ports before starting: `lsof -i :<port>`
- Kill background processes after testing

### Testing
- Run `bun run typecheck`, `bun run lint`, and relevant `bun test` after every change
- Always validate MCP tool changes by running the tool, not just typechecking
- Search for existing implementations before creating new files
