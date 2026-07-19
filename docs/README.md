# Documentation Index

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-07-19

Project-specific documentation for the DevOps Incident Analyzer monorepo. This index covers architecture, configuration, deployment, development, and operations for a LangGraph supervisor agent that orchestrates seven MCP server sub-agents (Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, GitLab, Atlassian, AWS) to correlate DevOps incidents across 210+ tools, plus a peer **elastic-iac** GitOps proposer agent (an 8th MCP server) for Elastic Cloud infrastructure changes.

---

## Quick Navigation

| Need to... | Go to... |
|------------|----------|
| Set up from scratch | [Getting Started](development/getting-started.md) |
| Understand architecture | [System Overview](architecture/system-overview.md) |
| Map the agent concepts (Wiki, Memory, SkillsFlow, Knowledge Tree, Hooks, SOD, Shared Context) | [Agent Concepts](architecture/agent-concepts.md) |
| Understand agent pipeline | [Agent Pipeline](architecture/agent-pipeline.md) |
| Resolve loose services to canonical per-datasource IDs | [Resolve Identifiers](architecture/resolve-identifiers.md) |
| Know what agents persist to memory | [Agent Memory](architecture/agent-memory.md) |
| Understand the knowledge graph | [Knowledge Graph](architecture/knowledge-graph.md) |
| Implement a knowledge graph in your own agent | [Knowledge Graph Guide](../guides/knowledge-graph-guide.md) |
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
| [Agent Concepts](architecture/agent-concepts.md) | Concept map for the seven agent-architecture ideas — GitAgent definitions, LLM Wiki, Live Agent Memory, SkillsFlow (DAG workflows), Knowledge Tree, Agent Lifecycle/Hooks, Segregation of Duties, Shared Context & Skills — with code locations and links to each deep-dive doc |
| [Agent Pipeline](architecture/agent-pipeline.md) | LangGraph 31-node StateGraph (21 base + 4 gated KG + 6 gated HIL-learning): classify, normalize, selectRunbooks, entityExtractor, awsEstateRouter, resolveIdentifiers, query (fan-out), align, aggregate, extractFindings, enforceCorrelations, checkConfidence, validate, mitigation split (investigate/monitor/escalate + aggregate), followUp, detectTopicShift, + the HIL learning lane (learnFetchTicket -> ... -> applyLearnings) |
| [Resolve Identifiers](architecture/resolve-identifiers.md) | The deterministic `resolveIdentifiers` pre-fan-out node (SIO-1084): resolves the loose incident service to canonical per-datasource identifiers via per-datasource probes + KG-seeded candidates (R7, SIO-1101), so sub-agents query the right keys |
| [Agent Memory](architecture/agent-memory.md) | Live-memory tier (SIO-938): what each agent saves to Couchbase Agent Memory and when — dailylog breadcrumbs as TTL'd conversational messages, key decisions as durable facts, semantic recall (rel_score-ranked) at bootstrap, queue-flush at teardown; service-side embeddings, sync-write freshness, created_at conflict resolution, health/503 resilience; user-per-agent / thread-per-session mapping |
| [Gitagent Bridge](architecture/gitagent-bridge.md) | YAML-to-LangGraph adapter: manifest loading, model factory, skill and tool resolution |
| [MCP Integration](architecture/mcp-integration.md) | 8 MCP server connections (7 datasource + elastic-iac), tool scoping, health monitoring, trace propagation |
| [Elastic IaC GitOps Proposer](architecture/elastic-iac-proposer.md) | The natural-language change agent (peer to the incident-analyzer): 30-node GitOps proposer, `elastic-iac-mcp` (:9086), HITL plan-review, JSON-edit-via-GitLab-API; 17 config-edit workflows (version-upgrade / tier-resize / ilm-rollout / ilm-delete / topology / slo / alerting / dataview / cluster-default-edit / cluster-default-delete / cluster-settings-edit / space / security / fleet-integration / dashboard / index-template-create / ingest-pipeline-create / ingest-pipeline-edit) plus drift, synthetics-drift, and Fleet-upgrade CI sub-flows, with verbatim-prompt capture, knowledge-graph + agent-memory enrichment on the plan-review card. Agent proposes, CI + human dispose. |
| [Knowledge Graph](architecture/knowledge-graph.md) | Optional embedded entity+correlation graph (lbug/LadybugDB): store + three-layer IaC schema (incl. the `Prompt` node), the in-process MCP server (:9087) with curated `kg_*` tools + read-only Cypher, the 7 record/enrich pipeline nodes across both agents, gating, and the lbug exclusive-lock / teardown gotchas |

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
| [MCP AgentCore Image Deployment](runbooks/mcp-agentcore-image-deployment.md) | Deploying a new container image to the Kafka/AWS AgentCore runtimes: build, inspect, ECR push, config-preserving update, toolCount-canary verification, VPC networkModeConfig gotcha, rollback |

---

## Related

| Resource | Description |
|----------|-------------|
| [README.md](../README.md) | Project overview, quick start, and repository introduction |
| [CLAUDE.md](../CLAUDE.md) | AI assistant instructions, architecture blueprint, and project conventions |
| [.env.example](../.env.example) | Template for all required environment variables |
| [agents/incident-analyzer/](../agents/incident-analyzer/) | Gitagent YAML definitions, SOUL.md, RULES.md, sub-agent manifests |
| [guides/knowledge-graph-guide.md](../guides/knowledge-graph-guide.md) | Portable, technology-agnostic guide to implementing a driver-swappable knowledge-graph tier in any LangGraph/MCP agent (companion to the [architecture deep-dive](architecture/knowledge-graph.md)) |

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
| 2026-06-19 | Added [Agent Concepts](architecture/agent-concepts.md) — a concept-map landing page for the seven agent-architecture ideas (GitAgent, LLM Wiki, Live Memory, SkillsFlow, Knowledge Tree, Lifecycle/Hooks, SOD, Shared Context), with full inline coverage for the four that lacked a dedicated doc (SkillsFlow, Knowledge Tree, Hooks, Shared Context) and links to the rest. Extended [agent-memory.md](architecture/agent-memory.md) with a service-model section (user/session/block, semantic search, server-side embeddings, TTL/conflict resolution) describing the Couchbase Agent Memory service independent of our usage. |
| 2026-06-19 | docs cleanup: repaired pre-existing UTF-8 corruption from the 2026-05-28 "strip SIO refs" sweep (mangled `SIO-822–826` en-dashes / `U+FFFD` glyphs in mcp-integration, adding-mcp-tools, mcp-server-configuration, environment-variables, monorepo-structure) and fixed 5 stale in-repo `#anchor` links whose `-sio-NNN` suffix no longer matched the de-SIO'd heading slugs. Live docs tree verified: 0 broken file-links, 0 broken anchors, 0 invalid-UTF-8 files. |
| 2026-06-17 | docs sync for the SIO-911..932 elastic-iac expansion: nine config-edit proposers (slo / alerting / dataview / cluster-default / space / security / fleet-integration / topology / dashboard), Fleet-upgrade sub-flow (preview/gate/apply with `applied`/`dispatched`/`failed` outcomes), conversational follow-ups + per-outcome chip, ILM nested shape + copy-from-reference + multi-file MR. Brought the root README into sync (6→7 datasources, 13→20 pipeline nodes, added AWS + elastic-iac MCP rows); refreshed monorepo-structure package list (added knowledge-graph / memory-pr / skillflow / mcp-server-elastic-iac); proposer graph 12→24 nodes. |
| 2026-07-08 | Added the portable [Knowledge Graph Guide](../guides/knowledge-graph-guide.md) to the `guides/` collection — a technology-agnostic how-to for implementing a driver-swappable knowledge-graph tier (store seam, single-file typed schema, edge-gate idiom, enrichment vs. tool-loop, in-process MCP mount, read-only tool surface, Neo4j porting) in any LangGraph/MCP agent, with the in-repo KG as reference implementation. Indexed it in Quick Navigation and Related. |
| 2026-07-19 | Added [MCP AgentCore Image Deployment](runbooks/mcp-agentcore-image-deployment.md) runbook (converted from the SIO-710 deploy doc, extended after the SIO-1161 kafka v12 / aws v10 deploys): config-preserving update flow, toolCount canary, VPC `networkModeConfig` get/update asymmetry + old-CLI model gap, local-connector verification trap, rollback. |
| 2026-07-19 | docs sync for the SIO-1039..1161 window. Corrected the incident node count to the verified grep (**23 → 31**: 21 base + 4 gated KG incl. `recordBindings` + **6 gated HIL-learning nodes**) across README, [agent-pipeline](architecture/agent-pipeline.md), [system-overview](architecture/system-overview.md) (reconciled its two conflicting 22/23 figures), and [knowledge-graph](architecture/knowledge-graph.md). Documented the **HIL learning lane** (learn-from-ticket, root-cause correction, PR-gated draft runbook, curated memory SIO-1134, Jira follow-up comments SIO-1145) in agent-pipeline + agent-memory (W11). Refreshed tool counts: elastic ~93 → **~102** (+9 ML anomaly-detection, SIO-1148), couchbase 24+ → **~37** (official Couchbase tools, SIO-1107), AWS +CloudWatch Metrics Insights + network-path EC2 tracing (SIO-1161/1120). Frontend 9 → **30** components (create-ticket SIO-1124/1139, HIL cards), 6 → **7** datasources. Added missing env vars (`HIL_LEARNING_ENABLED`, `RESOLVE_IDENTIFIERS_*`, `KG_BINDINGS_*`) to [environment-variables](configuration/environment-variables.md) and `HIL_LEARNING_ENABLED` to `.env.example`. Linked the previously-orphaned [resolve-identifiers](architecture/resolve-identifiers.md); added ports 9086/9087 to [troubleshooting](operations/troubleshooting.md). |
| 2026-06-30 | docs sync for the SIO-933..1024 window (SIO-1025). Added a dedicated [Knowledge Graph](architecture/knowledge-graph.md) deep-dive (lbug store + three-layer schema, the in-process MCP server :9087 + curated `kg_*` / read-only Cypher, the 5 record/enrich nodes, gating, lbug lock/teardown gotchas) and the `mcp-server-knowledge-graph` package; extended [agent-memory.md](architecture/agent-memory.md) with a full scenario catalog (IaC-change / fleet-upgrade / skill-learning writes + recalls, dedup, lifecycle reconciliation, block-id logging) and the new env vars; added the corresponding fact rows to [memory-model-mapping.md](architecture/memory-model-mapping.md). Corrected node counts to verified greps (incident 20/22-with-KG; elastic-iac 24→29) and the IaC workflow list (12→16: cluster-default-delete, cluster-settings-edit, index-template-create, ingest-pipeline-create/edit). Refreshed the root README (KG MCP server :9087, node counts, memory pointer) and the new `KNOWLEDGE_GRAPH_*` / `KG_MCP_ALLOW_CYPHER` / `SKILL_LEARNING_ENABLED` / `IAC_PROPOSAL_FACT_TTL_SECONDS` env vars. |
| 2026-07-09 | docs sync for the SIO-1030..1038 window (SIO-1039). SIO-1030 focus-scoped finding cards (`matchesFocus()`); SIO-1031 grounded "IAM gap" phrasing (blockers must cite an observed auth error); SIO-1032 named-host / raw-selector / expected-count fleet upgrade; SIO-1037 new `ilm-delete` workflow (config-edit 16→17); SIO-1038 verbatim-prompt capture — the always-edged `recordIacPrompt` node, the KG `Prompt` node + `PROMPTED_IN` edge, and the `LIVE_MEMORY_RAW_PROMPTS_ENABLED` env var. Corrected node counts to verified greps: incident 22→**23** (`recordRootCause`, pre-existing drift since SIO-1026); elastic-iac 29→**30** (`recordIacPrompt`). |
