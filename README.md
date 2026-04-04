# DevOps Incident Analyzer

Multi-datasource incident analysis agent powered by LangGraph and 4 MCP servers. A supervisor orchestrates specialist sub-agents that query Elasticsearch, Kafka, Couchbase Capella, and Kong Konnect in parallel, then correlates findings into actionable incident reports.

## Architecture

```
User Query
    |
[classify] -> simple: respond directly
    |          complex:
[entityExtractor] -> extract services, time windows, datasources
    |
[supervisor] -> fan-out via Send API
    |
[elastic-agent]  [kafka-agent]  [capella-agent]  [konnect-agent]
  69 tools         15 tools       30 tools         78 tools
    |                |               |                |
[align] -> check cross-datasource consistency, retry if gaps
    |
[aggregate] -> correlate timeline, causal chains, confidence score
    |
[validate] -> anti-hallucination check
    |
Incident Report
```

## Quick Start

```bash
# Install dependencies
bun install

# Copy and fill in environment variables
cp .env.example .env

# Start MCP servers (separate terminals)
MCP_TRANSPORT=sse MCP_PORT=9080 bun packages/mcp-server-elastic/src/index.ts
MCP_TRANSPORT=http MCP_PORT=9081 bun packages/mcp-server-kafka/src/index.ts

# Start the web frontend + agent
bun run --filter @devops-agent/web dev
```

Open http://localhost:5173

## Project Structure

```
agents/                          Gitagent declarative definitions (YAML/Markdown)
  incident-analyzer/
    agent.yaml                   Orchestrator: model, tools, skills, sub-agents, compliance
    SOUL.md / RULES.md           Identity and hard constraints
    agents/                      4 sub-agents: elastic, kafka, capella, konnect
    tools/                       MCP tool schemas with dynamic prompt templates
    skills/                      Procedural knowledge (normalize, aggregate, mitigate)

packages/
  gitagent-bridge/               YAML-to-LangGraph adapter
  agent/                         LangGraph 8-node pipeline
  shared/                        Cross-package types and Zod schemas
  checkpointer/                  State persistence (memory / bun:sqlite)
  observability/                 Pino logging
  mcp-server-elastic/            Elasticsearch MCP (69 tools, multi-deployment)
  mcp-server-kafka/              Kafka MCP (15 tools, local/MSK/Confluent)
  mcp-server-couchbase/          Couchbase Capella MCP (30 tools, query analysis)
  mcp-server-konnect/            Kong Konnect MCP (78 tools, API gateway)

apps/
  web/                           SvelteKit frontend (Svelte 5, Tailwind, SSE streaming)
```

## MCP Servers

| Server | Port | Tools | Config |
|--------|------|-------|--------|
| Elasticsearch | 9080 | 69 | `ES_URL`, `ES_API_KEY`, multi-deployment via `ELASTIC_DEPLOYMENTS` |
| Kafka | 9081 | 15 | `KAFKA_PROVIDER` (local/msk/confluent), `KAFKA_BROKERS` |
| Couchbase Capella | stdio | 30 | `COUCHBASE_URL`, `COUCHBASE_USERNAME`, `COUCHBASE_PASSWORD` |
| Kong Konnect | stdio | 78 | `KONNECT_ACCESS_TOKEN`, `KONNECT_REGION` |

## Commands

```bash
bun install                     # Install all workspace dependencies
bun run test                    # Run all tests
bun run typecheck               # TypeScript check all packages
bun run lint                    # Biome lint check
bun run lint:fix                # Biome auto-fix

# Run specific package tests
bun test packages/gitagent-bridge/src/index.test.ts
bun test packages/agent/src/validation.test.ts
```

## Environment Variables

See [.env.example](.env.example) for the full list. Minimum required:

- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` -- Bedrock LLM access
- `ES_URL`, `ES_API_KEY` -- Elasticsearch connection
- `ELASTIC_MCP_URL`, `KAFKA_MCP_URL` -- MCP server URLs for the agent

## Documentation

| Need to... | Go to... |
|------------|----------|
| Full documentation index | [docs/README.md](docs/README.md) |
| Understand the architecture | [System Overview](docs/architecture/system-overview.md) |
| Set up the project | [Getting Started](docs/development/getting-started.md) |
| Deploy to AgentCore | [AgentCore Deployment](docs/deployment/agentcore-deployment.md) |
| Add or modify MCP tools | [Adding MCP Tools](docs/development/adding-mcp-tools.md) |

## Tech Stack

- **Runtime**: Bun
- **Agent**: LangGraph TypeScript with AWS Bedrock (Claude Sonnet/Haiku)
- **Frontend**: SvelteKit, Svelte 5 runes, Tailwind CSS v4
- **MCP**: Model Context Protocol SDK for tool integration
- **Validation**: Zod
- **Linting**: Biome
- **Tracing**: LangSmith
