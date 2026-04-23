# DevOps Incident Analyzer

Multi-datasource incident analysis agent powered by LangGraph and 6 MCP servers. A supervisor orchestrates specialist sub-agents that query Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, GitLab, and Atlassian (Jira/Confluence) in parallel, then correlates findings into actionable incident reports.

## Architecture

```
User Query
    |
[classify] -> simple: responder -> followUp -> END
    |          complex:
[normalize] -> [selectRunbooks] -> [entityExtractor]
    |
[supervisor] -> fan-out via Send API
    |
[elastic]  [kafka]  [capella]  [konnect]  [gitlab]  [atlassian]
    |         |         |          |         |          |
[align] -> check cross-datasource consistency, retry if gaps
    |
[aggregate] -> correlate timeline, causal chains, confidence score
    |
[checkConfidence] -> gate on minimum confidence threshold
    |
[validate] -> anti-hallucination check, retry aggregate on fail
    |
[proposeMitigation] -> actionable remediation steps
    |
[followUp] -> suggested next questions
    |
Incident Report
```

See [docs/architecture/agent-pipeline.md](docs/architecture/agent-pipeline.md) for the full 12-node StateGraph including retry loops and conditional edges.

## Quick Start

```bash
# Install dependencies
bun install

# Copy and fill in environment variables
cp .env.example .env

# Start MCP servers (separate terminals) -- minimal example
MCP_TRANSPORT=sse MCP_PORT=9080 bun packages/mcp-server-elastic/src/index.ts
MCP_TRANSPORT=http MCP_PORT=9081 bun packages/mcp-server-kafka/src/index.ts

# Start the web frontend + agent
bun run --filter @devops-agent/web dev
```

Open http://localhost:5173. For all six MCP servers see [docs/deployment/local-development.md](docs/deployment/local-development.md).

## Project Structure

```
agents/                          Gitagent declarative definitions (YAML/Markdown)
  incident-analyzer/
    agent.yaml                   Orchestrator: model, tools, skills, sub-agents, compliance
    SOUL.md / RULES.md           Identity and hard constraints
    agents/                      6 sub-agents: elastic, kafka, capella, konnect, gitlab, atlassian
    tools/                       MCP tool schemas with dynamic prompt templates
    skills/                      Procedural knowledge (normalize, aggregate, mitigate)

packages/
  gitagent-bridge/               YAML-to-LangGraph adapter
  agent/                         LangGraph 12-node pipeline
  shared/                        Cross-package types and Zod schemas
  checkpointer/                  State persistence (memory / bun:sqlite)
  observability/                 Pino logging, OpenTelemetry, LangSmith
  mcp-server-elastic/            Elasticsearch MCP (multi-deployment)
  mcp-server-kafka/              Kafka MCP (local/MSK/Confluent)
  mcp-server-couchbase/          Couchbase Capella MCP (query analysis)
  mcp-server-konnect/            Kong Konnect MCP (API gateway)
  mcp-server-gitlab/             GitLab MCP (proxy + code analysis)
  mcp-server-atlassian/          Atlassian MCP (Jira/Confluence proxy)

apps/
  web/                           SvelteKit frontend (Svelte 5, Tailwind, SSE streaming)
```

## MCP Servers

| Server | Port | Tools | Config |
|--------|------|-------|--------|
| Elasticsearch | 9080 | ~78 | `ES_URL`, `ES_API_KEY`, multi-deployment via `ELASTIC_DEPLOYMENTS` |
| Kafka | 9081 | 15 base + 15 optional (schema/ksql) | `KAFKA_PROVIDER` (local/msk/confluent), `KAFKA_BROKERS` |
| Couchbase Capella | 9082 | ~15 | `COUCHBASE_URL`, `COUCHBASE_USERNAME`, `COUCHBASE_PASSWORD` |
| Kong Konnect | 9083 | 15 enhanced + proxy | `KONNECT_ACCESS_TOKEN`, `KONNECT_REGION` |
| GitLab | 9084 | proxy + 5-8 custom | `GITLAB_PERSONAL_ACCESS_TOKEN`, `GITLAB_INSTANCE_URL` |
| Atlassian | 9085 (OAuth :9185) | proxy + custom | `ATLASSIAN_SITE_NAME`, `ATLASSIAN_MCP_URL`, `ATLASSIAN_READ_ONLY` |

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
- `ELASTIC_MCP_URL`, `KAFKA_MCP_URL`, `COUCHBASE_MCP_URL`, `KONNECT_MCP_URL`, `GITLAB_MCP_URL`, `ATLASSIAN_MCP_URL_LOCAL` -- MCP server URLs for the agent
- `ATLASSIAN_MCP_URL` -- upstream Atlassian Cloud endpoint; `ATLASSIAN_SITE_NAME` -- your Atlassian Cloud site

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
