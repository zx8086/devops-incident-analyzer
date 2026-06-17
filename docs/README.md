# Documentation Index

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-06-17

Project-specific documentation for the DevOps Incident Analyzer monorepo. This index covers architecture, configuration, deployment, development, and operations for a LangGraph supervisor agent that orchestrates seven MCP server sub-agents (Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, GitLab, Atlassian, AWS) to correlate DevOps incidents across 210+ tools, plus a peer **elastic-iac** GitOps proposer agent (an 8th MCP server) for Elastic Cloud infrastructure changes.

---

## Quick Navigation

| Need to... | Go to... |
|------------|----------|
| Set up from scratch | [Getting Started](development/getting-started.md) |
| Understand architecture | [System Overview](architecture/system-overview.md) |
| Understand agent pipeline | [Agent Pipeline](architecture/agent-pipeline.md) |
| Know what agents persist to memory | [Agent Memory](architecture/agent-memory.md) |
| Use the Elastic IaC (GitOps proposer) agent | [Elastic IaC GitOps Proposer](architecture/elastic-iac-proposer.md) |
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
| [Agent Pipeline](architecture/agent-pipeline.md) | LangGraph 20-node StateGraph: classify, normalize, selectRunbooks, entityExtractor, awsEstateRouter, query (fan-out), align, aggregate, extractFindings, enforceCorrelations, checkConfidence, validate, mitigation split (investigate/monitor/escalate + aggregate), followUp, detectTopicShift |
| [Agent Memory](architecture/agent-memory.md) | Live-memory tier (SIO-938): what each agent saves to Couchbase Agent Memory and when — dailylog breadcrumbs as TTL'd conversational messages, key decisions as durable facts, semantic recall at bootstrap, queue-flush at teardown; user-per-agent / thread-per-session mapping |
| [Gitagent Bridge](architecture/gitagent-bridge.md) | YAML-to-LangGraph adapter: manifest loading, model factory, skill and tool resolution |
| [MCP Integration](architecture/mcp-integration.md) | 8 MCP server connections (7 datasource + elastic-iac), tool scoping, health monitoring, trace propagation |
| [Elastic IaC GitOps Proposer](architecture/elastic-iac-proposer.md) | The natural-language change agent (peer to the incident-analyzer): 24-node GitOps proposer, `elastic-iac-mcp` (:9086), HITL plan-review, JSON-edit-via-GitLab-API; config-edit workflows (version-upgrade / tier-resize / ilm-rollout / topology / slo / alerting / dataview / cluster-default / space / security / fleet-integration / dashboard) plus drift, synthetics-drift, and Fleet-upgrade CI sub-flows. Agent proposes, CI + human dispose. |

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
| [Adding MCP Tools](development/adding-mcp-tools.md) | Step-by-step process for adding tools to any of the seven MCP servers |
| [Testing](development/testing.md) | Unit, integration, and MCP tool testing strategies |
| [Action Tool Maps](development/action-tool-maps.md) | Action-driven tool selection: YAML maps, fallback chain, troubleshooting |
| [Authoring Skills and Runbooks](development/authoring-skills-and-runbooks.md) | How to author orchestrator skills and knowledge-base runbooks, with tool-name footgun guidance |
| [Frontend](development/frontend.md) | SvelteKit app, Svelte 5 runes, SSE streaming, component reference |

### Operations

| Document | Description |
|----------|-------------|
| [Observability](operations/observability.md) | Pino structured logging, OpenTelemetry tracing, LangSmith integration |
| [Troubleshooting](operations/troubleshooting.md) | Common issues, diagnostic commands, and resolution steps |
| [OAuth Seeding](operations/oauth-seeding.md) | One-time OAuth token seeding for Atlassian and GitLab |

### Runbooks

| Document | Description |
|----------|-------------|
| [AWS Estate Onboarding](runbooks/aws-estate-onboarding.md) | Step-by-step process for adding a new AWS account (estate) to the multi-estate AWS MCP runtime |

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
| 2026-04-10 | Added Authoring Skills and Runbooks guide; fixed stale runbook/knowledge coverage in gitagent-bridge and agent-pipeline |
| 2026-04-23 | Added Atlassian MCP server (6th datasource) to all architecture, config, deployment, and development docs |
| 2026-05-28 | docs drift sweep: AWS MCP (7th datasource) for multi-estate added across architecture, configuration, deployment; expanded elastic cloud/billing tool catalog; corrected pipeline node count (14→20); indexed `runbooks/aws-estate-onboarding.md` |
| 2026-06-02 | Documented the Elastic IaC agent (peer maker agent): design spec under `superpowers/specs/`, `elastic-iac-mcp` (:9086) in MCP-server config + environment variables, the maker graph in agent-pipeline, and the port + peer-agent note in system-overview |
| 2026-06-03 | Added canonical [Elastic IaC GitOps Proposer](architecture/elastic-iac-proposer.md) doc reflecting the SIO-870..880 re-architecture (Terraform maker → 12-node GitOps proposer; version-upgrade / tier-resize / ilm-rollout). Replaced the stale 9-node summary in agent-pipeline.md; repointed the README links from the original design spec. Noted the post-merge apply-tracking gap (SIO-881). |
| 2026-06-17 | docs sync for the SIO-911..932 elastic-iac expansion: nine config-edit proposers (slo / alerting / dataview / cluster-default / space / security / fleet-integration / topology / dashboard), Fleet-upgrade sub-flow (preview/gate/apply with `applied`/`dispatched`/`failed` outcomes), conversational follow-ups + per-outcome chip, ILM nested shape + copy-from-reference + multi-file MR. Brought the root README into sync (6→7 datasources, 13→20 pipeline nodes, added AWS + elastic-iac MCP rows); refreshed monorepo-structure package list (added knowledge-graph / memory-pr / skillflow / mcp-server-elastic-iac); proposer graph 12→24 nodes. |
