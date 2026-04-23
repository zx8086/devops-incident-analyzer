# Getting Started

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-04-23

Onboarding guide for the DevOps Incident Analyzer monorepo. Covers prerequisites, initial setup, first run, running tests, and the development workflow. Follow these steps to get a working local environment with all six MCP servers and the SvelteKit frontend.

---

## Prerequisites

### Required Software

| Software | Minimum Version | Verify Command |
|----------|----------------|----------------|
| Bun | 1.3.9+ | `bun --version` |
| Docker | 24.0+ | `docker --version` |
| Docker Compose | 2.20+ | `docker compose version` |
| Git | 2.40+ | `git --version` |

Install Bun if not already present:

```bash
curl -fsSL https://bun.sh/install | bash
```

### Required Accounts and Credentials

The agent connects to six external data sources and uses AWS Bedrock for LLM inference. You need credentials for each service your development work touches. Not all credentials are required for every task -- if you are only working on the Kafka MCP server, you only need Kafka broker access and AWS Bedrock credentials.

| Service | What You Need | Who Provides It |
|---------|---------------|-----------------|
| AWS Bedrock | IAM access for `eu-west-1` region, model access for Claude | Platform team |
| Elasticsearch | Deployment URL + API key (per deployment: prod, staging) | Observability team |
| Kafka | Broker endpoints (local, MSK, or Confluent) | Data platform team |
| Couchbase Capella | Cluster hostname, username, password | Database team |
| Kong Konnect | Access token, region (us, eu, au, me, in) | API platform team |
| GitLab | Personal access token with `api` scope, instance URL | Source control team |
| Atlassian | Jira/Confluence site name + user account for OAuth consent | IT / platform team |
| LangSmith | API key, project name | Siobytes team lead |

---

## Initial Setup

Clone the repository and install all workspace dependencies:

```bash
git clone git@github.com:siobytes/devops-incident-analyzer.git
cd devops-incident-analyzer
bun install
```

Copy the environment template and fill in your credentials:

```bash
cp .env.example .env
```

Open `.env` in your editor and fill in the required values. Each variable has a comment explaining its purpose. At minimum, you need:

- `AWS_REGION` and Bedrock model configuration
- Credentials for at least one MCP server (Elasticsearch, Kafka, Couchbase, Konnect, GitLab, or Atlassian)
- `LANGSMITH_API_KEY` if you want trace observability

Verify the setup compiles and passes lint:

```bash
bun run typecheck
bun run lint
```

Both commands should complete with zero errors. If `typecheck` fails, confirm you are running Bun 1.3.9+ and that `bun install` completed without errors.

---

## First Run

### Start MCP Servers

Each MCP server runs as an independent process. Open six terminal windows (or use a terminal multiplexer) and start each server:

```bash
# Terminal 1: Elasticsearch MCP (port 9080)
MCP_TRANSPORT=sse MCP_PORT=9080 bun packages/mcp-server-elastic/src/index.ts

# Terminal 2: Kafka MCP (port 9081)
MCP_TRANSPORT=http MCP_PORT=9081 bun packages/mcp-server-kafka/src/index.ts

# Terminal 3: Couchbase MCP (port 9082)
MCP_TRANSPORT=http MCP_PORT=9082 bun packages/mcp-server-couchbase/src/index.ts

# Terminal 4: Konnect MCP (port 9083)
MCP_TRANSPORT=http MCP_PORT=9083 bun packages/mcp-server-konnect/src/index.ts

# Terminal 5: GitLab MCP (port 9084)
MCP_TRANSPORT=http MCP_PORT=9084 bun packages/mcp-server-gitlab/src/index.ts

# Terminal 6: Atlassian MCP (port 9085; OAuth callback on 9185)
MCP_TRANSPORT=http MCP_PORT=9085 bun packages/mcp-server-atlassian/src/index.ts
```

Each server logs its transport type, port, and tool count on startup. Verify you see output similar to:

```bash
[mcp-server-elastic] Transport: sse | Port: 9080 | Tools: 78
```

If a port is already in use, check for existing processes:

```bash
lsof -i :9080
```

### Start the Web Frontend

In a seventh terminal, start the SvelteKit development server:

```bash
bun run --filter @devops-agent/web dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser. The chat interface loads with the DataSourceSelector component. Select one or more data sources and submit a query to verify end-to-end connectivity.

### Alternative: Docker Compose

For a single-command startup of all services:

```bash
docker-compose up
```

This starts all six MCP servers and the web frontend with the port mappings defined in `docker-compose.yml`. See [Local Development](../deployment/local-development.md) for Docker Compose configuration details.

---

## Running Tests

Run the full test suite across all packages:

```bash
bun run test
```

Run TypeScript type checking across the workspace:

```bash
bun run typecheck
```

Run Biome linting:

```bash
bun run lint
```

Auto-fix lint issues:

```bash
bun run lint:fix
```

Run tests for a single package:

```bash
bun run --filter @devops-agent/gitagent-bridge test
```

Run a single test file:

```bash
bun test packages/gitagent-bridge/src/index.test.ts
```

---

## Development Workflow

### Branch and Commit Conventions

All work is tracked in Linear under the Siobytes team. The commit message format is:

```bash
SIO-XX: descriptive message
```

Where `SIO-XX` is the Linear issue identifier. Branch from `main` for all feature work:

```bash
git checkout main
git pull origin main
git checkout -b your-name/sio-xxx-short-description
```

### Pre-Commit Checks

Before committing, run all three checks:

```bash
bun run typecheck && bun run lint && bun run test
```

All three must pass. The CI pipeline runs the same checks and blocks merge on failure.

### Pull Request Flow

1. Push your branch to the remote
2. Open a pull request against `main`
3. Ensure CI checks pass (typecheck, lint, test)
4. Request review from the Siobytes team
5. Merge after approval

---

## Where to Go Next

- [Monorepo Structure](monorepo-structure.md) -- understand the package layout and dependency graph
- [Agent Pipeline](../architecture/agent-pipeline.md) -- learn how the 12-node LangGraph pipeline processes incidents
- [Adding MCP Tools](adding-mcp-tools.md) -- add or modify tools on any of the six MCP servers
- [Local Development](../deployment/local-development.md) -- Docker Compose configuration and hot reload setup

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial getting started guide created |
| 2026-04-23 | Added GitLab and Atlassian MCP servers to prerequisites, credentials table, and startup commands (6 servers total) |
