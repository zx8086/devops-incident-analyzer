# DevOps Incident Analyzer

Multi-datasource incident analysis agent powered by LangGraph and 7 datasource MCP servers. A supervisor orchestrates specialist sub-agents that query Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, GitLab, Atlassian (Jira/Confluence), and AWS in parallel, then correlates findings into actionable incident reports.

The repo also ships a second top-level agent, **elastic-iac** -- a GitOps proposer for Elastic Cloud infrastructure changes (served by an 8th MCP server on port 9086). Selected by the UI agent toggle, it answers "change it" requests by editing deployment/policy JSON and opening a GitLab merge request; CI plans and humans merge/apply (agent proposes, GitOps disposes). See [docs/architecture/elastic-iac-proposer.md](docs/architecture/elastic-iac-proposer.md).

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
[elastic]  [kafka]  [capella]  [konnect]  [gitlab]  [atlassian]  [aws]
    |         |         |          |         |          |          |
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

See [docs/architecture/agent-pipeline.md](docs/architecture/agent-pipeline.md) for the full 20-node StateGraph (22 with the knowledge graph enabled) including retry loops, conditional edges, the SIO-828 AWS estate router, and the SIO-681 cross-agent correlation enforcement detour. The separate 24-node elastic-iac proposer graph is documented in [docs/architecture/elastic-iac-proposer.md](docs/architecture/elastic-iac-proposer.md).

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

Open http://localhost:5173. For all eight MCP servers see [docs/deployment/local-development.md](docs/deployment/local-development.md).

## Project Structure

```
agents/                          Gitagent declarative definitions (YAML/Markdown)
  incident-analyzer/
    agent.yaml                   Orchestrator: model, tools, skills, sub-agents, compliance
    SOUL.md / RULES.md           Identity and hard constraints
    agents/                      7 sub-agents: elastic, kafka, capella, konnect, gitlab, atlassian, aws
    tools/                       MCP tool schemas with dynamic prompt templates
    skills/                      Procedural knowledge (normalize, aggregate, mitigate)
  elastic-iac/                   Second agent: GitOps proposer for Elastic Cloud infra changes

packages/
  gitagent-bridge/               YAML-to-LangGraph adapter
  agent/                         LangGraph 20-node pipeline (+2 gated knowledge-graph nodes) plus a separate 24-node elastic-iac proposer graph
  shared/                        Cross-package types and Zod schemas
  checkpointer/                  State persistence (memory / bun:sqlite)
  observability/                 Pino logging, OpenTelemetry, LangSmith
  knowledge-graph/               Optional entity + correlation graph (SIO-850, off by default)
  memory-pr/                     PR-based human-in-the-loop for durable agent learnings (SIO-849)
  skillflow/                     Declarative workflow (DAG) loader + executor (SIO-848)
  mcp-server-elastic/            Elasticsearch MCP (multi-deployment)
  mcp-server-kafka/              Kafka MCP (local/MSK/Confluent)
  mcp-server-couchbase/          Couchbase Capella MCP (query analysis)
  mcp-server-konnect/            Kong Konnect MCP (API gateway)
  mcp-server-gitlab/             GitLab MCP (proxy + code analysis)
  mcp-server-atlassian/          Atlassian MCP (Jira/Confluence proxy)
  mcp-server-aws/                AWS MCP (multi-estate via cross-account AssumeRole)
  mcp-server-elastic-iac/        Elastic IaC MCP (GitOps proposer tools, port 9086)

apps/
  web/                           SvelteKit frontend (Svelte 5, Tailwind, SSE streaming)
```

## MCP Servers

| Server | Port | Tools | Config |
|--------|------|-------|--------|
| Elasticsearch | 9080 | ~93 (77 cluster + 16 conditional cloud/billing on `EC_API_KEY`) | `ES_URL`, `ES_API_KEY`, multi-deployment via `ELASTIC_DEPLOYMENTS` |
| Kafka | 9081 | 15-55 (15 base + up to 40 gated: SR + ksqlDB + Connect + REST Proxy) | `KAFKA_PROVIDER` (local/msk/confluent), `KAFKA_BROKERS` |
| Couchbase Capella | 9082 | 24+ | `COUCHBASE_URL`, `COUCHBASE_USERNAME`, `COUCHBASE_PASSWORD` |
| Kong Konnect | 9083 | 67+ | `KONNECT_ACCESS_TOKEN`, `KONNECT_REGION` |
| GitLab | 9084 | 21+ (proxy + code analysis) | `GITLAB_PERSONAL_ACCESS_TOKEN`, `GITLAB_INSTANCE_URL` |
| Atlassian | 9085 (OAuth :9185) | proxy + custom | `ATLASSIAN_SITE_NAME`, `ATLASSIAN_UPSTREAM_MCP_URL`, `ATLASSIAN_READ_ONLY` |
| AWS | 3001 (SigV4 proxy) | multi-estate read-only (CloudWatch, EC2, ECS, Lambda, RDS, S3, X-Ray) | `AWS_MCP_URL`, `AWS_ESTATES`, `AWS_DEFAULT_ESTATE` |
| Elastic IaC | 9086 | GitOps proposer tools (terraform/git/gitlab/elastic-cloud) | `ELASTIC_IAC_MCP_URL`, `ELASTIC_IAC_GITLAB_TOKEN` |

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
- `ELASTIC_MCP_URL`, `KAFKA_MCP_URL`, `COUCHBASE_MCP_URL`, `KONNECT_MCP_URL`, `GITLAB_MCP_URL`, `ATLASSIAN_MCP_URL`, `AWS_MCP_URL` -- MCP server URLs for the agent
- `ATLASSIAN_UPSTREAM_MCP_URL` -- upstream Atlassian Cloud Rovo endpoint (the local proxy forwards to it); `ATLASSIAN_SITE_NAME` -- your Atlassian Cloud site
- `AWS_ESTATES`, `AWS_DEFAULT_ESTATE` -- multi-estate AWS config (cross-account AssumeRole)
- `ELASTIC_IAC_MCP_URL`, `ELASTIC_IAC_GITLAB_TOKEN` -- elastic-iac agent: IaC MCP server URL and the GitLab token used to open merge requests

See [docs/configuration/environment-variables.md](docs/configuration/environment-variables.md) for the full AWS estate and elastic-iac configuration.

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
