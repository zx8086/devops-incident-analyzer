# Documentation Index

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-04-23

Project-specific documentation for the DevOps Incident Analyzer monorepo. This index covers architecture, configuration, deployment, development, and operations for a LangGraph supervisor agent that orchestrates six MCP server sub-agents (Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, GitLab, Atlassian) to correlate DevOps incidents across 210+ tools.

---

## Quick Navigation

| Need to... | Go to... |
|------------|----------|
| Set up from scratch | [Getting Started](development/getting-started.md) |
| Understand architecture | [System Overview](architecture/system-overview.md) |
| Understand agent pipeline | [Agent Pipeline](architecture/agent-pipeline.md) |
| Add or modify MCP tools | [Adding MCP Tools](development/adding-mcp-tools.md) |
| Understand action-driven tool filtering | [Action Tool Maps](development/action-tool-maps.md) |
| Configure environment variables | [Environment Variables](configuration/environment-variables.md) |
| Run locally | [Local Development](deployment/local-development.md) |
| Deploy to AgentCore | [AgentCore Deployment](deployment/agentcore-deployment.md) |
| Understand the gitagent system | [Gitagent Bridge](architecture/gitagent-bridge.md) |
| Set up logging and tracing | [Observability](operations/observability.md) |
| Diagnose a problem | [Troubleshooting](operations/troubleshooting.md) |
| Understand monorepo layout | [Monorepo Structure](development/monorepo-structure.md) |
| Author skills and runbooks | [Authoring Skills and Runbooks](development/authoring-skills-and-runbooks.md) |
| Run tests | [Testing](development/testing.md) |

---

## By Category

### Architecture

| Document | Description |
|----------|-------------|
| [System Overview](architecture/system-overview.md) | High-level architecture, data flow, and component relationships |
| [Agent Pipeline](architecture/agent-pipeline.md) | LangGraph 13-node StateGraph: classify, normalize, selectRunbooks, extract, query, align, aggregate, enforceCorrelations (SIO-681), validate, proposeMitigation, followUp |
| [Gitagent Bridge](architecture/gitagent-bridge.md) | YAML-to-LangGraph adapter: manifest loading, model factory, skill and tool resolution |
| [MCP Integration](architecture/mcp-integration.md) | 6 MCP server connections, tool scoping, health monitoring, trace propagation |

### Configuration

| Document | Description |
|----------|-------------|
| [Environment Variables](configuration/environment-variables.md) | All environment variables across packages with defaults and descriptions |
| [MCP Server Configuration](configuration/mcp-server-configuration.md) | Per-server transport, port, provider, and feature gate settings |

### Deployment

| Document | Description |
|----------|-------------|
| [Local Development](deployment/local-development.md) | Docker Compose setup, port mapping, hot reload configuration |
| [AgentCore Deployment](deployment/agentcore-deployment.md) | AWS Bedrock AgentCore packaging, IAM policies, gateway targets |
| [Docker Reference](deployment/docker-reference.md) | Dockerfile patterns, multi-stage builds, security practices |

### Development

| Document | Description |
|----------|-------------|
| [Getting Started](development/getting-started.md) | Prerequisites, initial setup, first run, and development workflow |
| [Monorepo Structure](development/monorepo-structure.md) | Package map, dependency graph, workspace configuration |
| [Adding MCP Tools](development/adding-mcp-tools.md) | Step-by-step process for adding tools to any of the six MCP servers |
| [Testing](development/testing.md) | Unit, integration, and MCP tool testing strategies |
| [Action Tool Maps](development/action-tool-maps.md) | Action-driven tool selection: YAML maps, fallback chain, troubleshooting |
| [Authoring Skills and Runbooks](development/authoring-skills-and-runbooks.md) | How to author orchestrator skills and knowledge-base runbooks, with tool-name footgun guidance |
| [Frontend](development/frontend.md) | SvelteKit app, Svelte 5 runes, SSE streaming, component reference |

### Operations

| Document | Description |
|----------|-------------|
| [Observability](operations/observability.md) | Pino structured logging, OpenTelemetry tracing, LangSmith integration |
| [Troubleshooting](operations/troubleshooting.md) | Common issues, diagnostic commands, and resolution steps |

---

## Related

| Resource | Description |
|----------|-------------|
| [README.md](../README.md) | Project overview, quick start, and repository introduction |
| [CLAUDE.md](../CLAUDE.md) | AI assistant instructions, architecture blueprint, and project conventions |
| [.env.example](../.env.example) | Template for all required environment variables |
| [agents/incident-analyzer/](../agents/incident-analyzer/) | Gitagent YAML definitions, SOUL.md, RULES.md, sub-agent manifests |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial documentation index created with Phase 1 foundation structure |
| 2026-04-09 | Added Action Tool Maps development guide |
| 2026-04-10 | SIO-639: Added Authoring Skills and Runbooks guide; fixed stale runbook/knowledge coverage in gitagent-bridge and agent-pipeline |
| 2026-04-23 | Added Atlassian MCP server (6th datasource) to all architecture, config, deployment, and development docs |
