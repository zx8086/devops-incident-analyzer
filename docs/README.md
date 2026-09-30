# Documentation Index

> **Targets:** Bun 1.4.2+ | LangGraph | TypeScript 5.x | MCP SDK 1.30.0
> **Last updated:** 2026-09-30

Project-specific documentation for the DevOps Incident Analyzer monorepo. This index covers architecture, configuration, deployment, development, and operations for a LangGraph supervisor agent that orchestrates seven MCP server sub-agents (Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, GitLab, Atlassian, AWS) to correlate DevOps incidents across 210+ tools, plus three peer agents resolved through the same registry: the **elastic-iac** GitOps proposer for Elastic Cloud infrastructure changes (its own MCP server, :9086), the **landing-zone-terraform** evidence and review agent for the PVH AWS Landing Zone (SIO-1867, its own MCP server, :9088), and the **pi-fleet-console** agent (SIO-1655) that queries the live pi-coms account spokes.

---

## Quick Navigation

| Need to... | Go to... |
|------------|----------|
| Set up from scratch | [Getting Started](development/getting-started.md) |
| Bump or adopt a Claude model | [Model Upgrade Checklist](development/model-upgrade-checklist.md) |
| Understand architecture | [System Overview](architecture/system-overview.md) |
| Map the agent concepts (Wiki, Memory, SkillsFlow, Knowledge Tree, Hooks, SOD, Shared Context) | [Agent Concepts](architecture/agent-concepts.md) |
| Understand agent pipeline | [Agent Pipeline](architecture/agent-pipeline.md) |
| Resolve loose services to canonical per-datasource IDs | [Resolve Identifiers](architecture/resolve-identifiers.md) |
| Know what agents persist to memory | [Agent Memory](architecture/agent-memory.md) |
| Understand the knowledge graph | [Knowledge Graph](architecture/knowledge-graph.md) |
| [pi-coms](../packages/pi-coms/docs/README.md) | pi-coms hub, spoke extension, monitor and fleet deployment (package-local docs; moved into the monorepo by SIO-1654, hub wire types in `packages/pi-coms/contracts/`) |
| [pi-fleet gitagent feasibility](architecture/pi-fleet-gitagent-feasibility.md) | Feasibility report (2026-09-06) for onboarding the pi-coms hub, spoke agents and console onto the gitagent definition and release layer: gitagent owns definition, versioning and tagged release (`agents/pi-fleet/`, Pi package export, `pi-fleet-v*` release job); execution stays Pi + coms-net on the spokes and the hub stays the transport. One codebase: pi-coms moves in as `packages/pi-coms` (SIO-1654) before Phase 1. Phased plan SIO-1635 / SIO-1654 / SIO-1649 / SIO-1653 / SIO-1650 / SIO-1652 / SIO-1651. |
| [pi-fleet pane](architecture/pi-fleet-pane.md) | SIO-1650: the web app pane that lists live pi-coms spokes per environment hub and addresses one directly next to the incident chat; routes, budgets, principal and the data-only reply rule |
| [fleet inbox enrichment](architecture/fleet-inbox-enrichment.md) | SIO-1652: the `fetchFleetInbox` node that reads the pi-coms estate and `ops` inboxes for the incident window into a typed digest; placement before `aggregate`, attribution rules, the structured-only prompt rule and the Fleet inbox card |
| [pi-fleet console graph](architecture/pi-fleet-third-graph.md) | SIO-1655: the in-process third agent that asks several account spokes one question and synthesizes their replies; the separate console persona, the five hub tools, and the untrusted-reply boundary (the only path where a hub reply reaches a model) |
| Implement a knowledge graph in your own agent | [Knowledge Graph Guide](../guides/knowledge-graph-guide.md) |
| Use the Elastic IaC (GitOps proposer) agent | [Elastic IaC GitOps Proposer](architecture/elastic-iac-proposer.md) |
| Use the PVH Landing Zone Terraform agent | [Landing Zone Terraform Agent](architecture/landing-zone-terraform-agent.md) |
| Operate or recover the Landing Zone agent | [Landing Zone Agent Runbook](operations/landing-zone-agent-runbook.md) |
| Ask the live fleet a question across accounts | [pi-fleet console graph](architecture/pi-fleet-third-graph.md) |
| Add or modify MCP tools | [Adding MCP Tools](development/adding-mcp-tools.md) |
| Understand action-driven tool filtering | [Action Tool Maps](development/action-tool-maps.md) |
| See what a sub-agent's prompt, tool belt and loop guards contain | [Sub-Agent Context Assembly](architecture/sub-agent-context-assembly.md) |
| Review, approve or promote what the agents learned | [Agent Memory: learning loop and promotion PR](architecture/agent-memory.md) |
| Understand the pi verify and investigate cards | [pi-coms verification](architecture/pi-coms-verification.md) |
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
| [Agent Pipeline](architecture/agent-pipeline.md) | LangGraph 32-node StateGraph (22 base + 4 gated KG + 6 gated HIL-learning): classify, normalize, selectRunbooks, entityExtractor, awsEstateRouter, resolveIdentifiers, query (fan-out), align, fetchFleetInbox, aggregate, extractFindings, enforceCorrelations, checkConfidence, validate, mitigation split (investigate/monitor/escalate + aggregate), followUp, detectTopicShift, + the HIL learning lane (learnFetchTicket -> ... -> applyLearnings) |
| [Resolve Identifiers](architecture/resolve-identifiers.md) | The deterministic `resolveIdentifiers` pre-fan-out node (SIO-1084): resolves the loose incident service to canonical per-datasource identifiers via per-datasource probes + KG-seeded candidates (R7, SIO-1101), so sub-agents query the right keys |
| [Agent Memory](architecture/agent-memory.md) | Live-memory tier (SIO-938): what each agent saves to Couchbase Agent Memory and when — dailylog breadcrumbs as TTL'd conversational messages, key decisions as durable facts, semantic recall (rel_score-ranked) at bootstrap, queue-flush at teardown; service-side embeddings, sync-write freshness, created_at conflict resolution, health/503 resilience; user-per-agent / thread-per-session mapping |
| [Gitagent Bridge](architecture/gitagent-bridge.md) | YAML-to-LangGraph adapter: manifest loading, model factory, skill and tool resolution |
| [MCP Integration](architecture/mcp-integration.md) | 10 MCP server connections (7 datasource + elastic-iac + landing-zone-iac + the in-process knowledge-graph), tool scoping, health monitoring, trace propagation |
| [Sub-Agent Context Assembly](architecture/sub-agent-context-assembly.md) | What a sub-agent prompt contains and deliberately excludes (SIO-1444), the tools bound outside the 25-tool belt (evidence index, sandboxed execution), the in-loop context controls, and the loop guards and forced write-up |
| [pi-coms verification](architecture/pi-coms-verification.md) | SIO-1635: the `verify-with-pi` and `investigate-with-pi` action cards, hub selection per estate, and the structured verdict |
| [Elastic IaC GitOps Proposer](architecture/elastic-iac-proposer.md) | The natural-language change agent (peer to the incident-analyzer): 38-node GitOps proposer, `elastic-iac-mcp` (:9086), HITL plan-review, JSON-edit-via-GitLab-API; 17 config-edit workflows (version-upgrade / tier-resize / ilm-rollout / ilm-delete / topology / slo / alerting / dataview / cluster-default-edit / cluster-default-delete / cluster-settings-edit / space / security / fleet-integration / dashboard / index-template-create / ingest-pipeline-create / ingest-pipeline-edit) plus drift, synthetics-drift, and Fleet-upgrade CI sub-flows, with verbatim-prompt capture, knowledge-graph + agent-memory enrichment on the plan-review card. Agent proposes, CI + human dispose. |
| [PVH Landing Zone Terraform Agent](architecture/landing-zone-terraform-agent.md) | Separate evidence-first graph for PVH repository routing, standards reconciliation, risk gates, topology projection, Agent Memory, historical GitLab learning, and optional human-reviewed GitOps proposals. |
| [Knowledge Graph](architecture/knowledge-graph.md) | Optional embedded entity+correlation graph (lbug/LadybugDB): store + three-layer IaC schema (incl. the `Prompt` node), the Landing Zone change-history and topology schema, the in-process MCP server (:9087) with curated `kg_*` and `kg_lz_*` tools + read-only Cypher, the record/enrich pipeline nodes, gating, and the lbug exclusive-lock / teardown gotchas |
| [Memory Model Mapping](architecture/memory-model-mapping.md) | How gitagent's file and git-native memory lines up with the Couchbase Agent Memory `user -> session -> block` hierarchy |
| [Kafka Provider Factory](architecture/kafka-provider-factory.md) | The single-interface pattern behind `KAFKA_PROVIDER`: local Kafka, AWS MSK and Confluent Cloud from one codebase, written to be portable to another repo |

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
| [AgentCore + MSK (unauthenticated)](deployment/agentcore-msk-no-auth.md) | Deploying the Kafka MCP server to AgentCore against an MSK cluster without authentication; the default path (`MSK_AUTH_MODE=none`) |
| [AgentCore + MSK (IAM auth)](deployment/agentcore-msk-setup.md) | The same deployment against an IAM-authenticated MSK cluster in a private VPC (SASL/OAUTHBEARER) |
| [Kafka MCP to AgentCore: SigV4](deployment/kafka-agentcore-sigv4.md) | Network topology and the local SigV4 proxy that signs the AgentCore invoke request |

### Development

| Document | Description |
|----------|-------------|
| [Getting Started](development/getting-started.md) | Prerequisites, initial setup, first run, and development workflow |
| [Monorepo Structure](development/monorepo-structure.md) | Package map, dependency graph, workspace configuration |
| [Adding MCP Tools](development/adding-mcp-tools.md) | Step-by-step process for adding tools to any of the seven MCP servers |
| [Testing](development/testing.md) | Unit, integration, and MCP tool testing strategies |
| [Model Upgrade Checklist](development/model-upgrade-checklist.md) | Pre-merge gates for changing a model in any agent.yaml: conformance probe, capability declaration, fallback-chain verification, acceptance eval |
| [Action Tool Maps](development/action-tool-maps.md) | Action-driven tool selection: YAML maps, fallback chain, troubleshooting |
| [Authoring Skills and Runbooks](development/authoring-skills-and-runbooks.md) | How to author orchestrator skills and knowledge-base runbooks, with tool-name footgun guidance |
| [Frontend](development/frontend.md) | SvelteKit app, Svelte 5 runes, SSE streaming, component reference |

### Operations

| Document | Description |
|----------|-------------|
| [Observability](operations/observability.md) | Pino structured logging, OpenTelemetry tracing, LangSmith integration |
| [Troubleshooting](operations/troubleshooting.md) | Common issues, diagnostic commands, and resolution steps |
| [OAuth Seeding](operations/oauth-seeding.md) | One-time OAuth token seeding for Atlassian and GitLab |
| [Landing Zone Agent Runbook](operations/landing-zone-agent-runbook.md) | Safe bring-up, capability checks, write-mode enablement, historical import, privacy-safe telemetry, troubleshooting, and rollback. |
| [Estate Watch: Periodic AWS Self-Check Strategy](operations/aws-periodic-self-check-strategy.md) | Operating doctrine for a read-only agent that verifies an AWS account on a schedule. The pi-coms adaptation is [Estate Watch](../packages/pi-coms/docs/architecture/estate-watch.md) |

### Runbooks

| Document | Description |
|----------|-------------|
| [AWS Estate Onboarding](runbooks/aws-estate-onboarding.md) | Step-by-step process for adding a new AWS account (estate) to the multi-estate AWS MCP runtime |
| [MCP AgentCore Image Deployment](runbooks/mcp-agentcore-image-deployment.md) | Deploying a new container image to the Kafka/AWS AgentCore runtimes: build, inspect, ECR push, config-preserving update, toolCount-canary verification, VPC networkModeConfig gotcha, rollback |
| [MCP Tool Audit](runbooks/mcp-tool-audit-runbook.md) | Datasource-agnostic procedure for auditing an MCP server's tools against its upstream API (schema-vs-docs, action-map reachability, read-only coherence, structured error envelopes) |
| [MCP Steering Audit](runbooks/mcp-steering-audit-runbook.md) | Datasource-agnostic procedure for auditing a sub-agent's steering (false-absence, pagination-truncation, and tool-selection gaps) via live verification |
| [Fleet Agent Binary Upgrade](runbooks/fleet-agent-binary-upgrade.md) | Rolling a new Elastic Agent binary across a deployment's Fleet-enrolled agents through the elastic-iac agent, with a log of every apply run. (Elastic Fleet, not the pi-coms fleet.) |

### Reference

| Document | Description |
|----------|-------------|
| [DevOpsAgentReadOnly IAM](reference/devops-agent-readonly-iam.md) | The trust policy and both permissions policies of the read-only role deployed to every monitored AWS estate |
| [Agent Memory API Reference](reference/agent-memory-api-reference.md) | Vendored from the Agent Memory service's OpenAPI spec (`reference/agent-memory-openapi.json`); do not edit by hand |
| [Model Conformance Probes](reference/model-probes/claude-sonnet-5.md) | One committed `bun run model:probe` report per model in `reference/model-probes/` (SIO-1224); every declared model capability must be backed by one |
| [Successful elastic-iac Prompts](reference/successful-iac-prompts.md) | Real prompts that produced an applied elastic-iac change |
| [Drift Report Contract](elastic-iac-drift-report-contract.md) | The `drift-report.json` data contract between the IaC repository's drift-check pipeline and this agent |
| [Code Review Bake-off](code-review-bakeoff.md) | Closed record of the Greptile and CodeRabbit evaluation. Not a log to append to |

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
| 2026-07-19 | docs sync for the SIO-1039..1161 window. Corrected the incident node count to the verified grep (**23 → 31**: 21 base + 4 gated KG incl. `recordBindings` + **6 gated HIL-learning nodes**) across README, [agent-pipeline](architecture/agent-pipeline.md), [system-overview](architecture/system-overview.md) (reconciled its two conflicting 22/23 figures), and [knowledge-graph](architecture/knowledge-graph.md). Documented the **HIL learning lane** (learn-from-ticket, root-cause correction, PR-gated draft runbook, curated memory SIO-1134, Jira follow-up comments SIO-1145) in agent-pipeline + agent-memory (W11). Refreshed tool counts: elastic ~93 → **112** with `EC_API_KEY` (96 cluster incl. 9 ML anomaly-detection SIO-1148 + 16 cloud/billing; the prior "77/86 cluster + 16" cluster figures were undercounts, corrected via a live `registerAllTools` count), couchbase 24+ → **~37** (official Couchbase tools, SIO-1107), AWS +CloudWatch Metrics Insights + network-path EC2 tracing (SIO-1161/1120). Frontend 9 → **30** components (create-ticket SIO-1124/1139, HIL cards), 6 → **7** datasources. Added missing env vars (`HIL_LEARNING_ENABLED`, `RESOLVE_IDENTIFIERS_*`, `KG_BINDINGS_*`) to [environment-variables](configuration/environment-variables.md) and `HIL_LEARNING_ENABLED` to `.env.example`. Linked the previously-orphaned [resolve-identifiers](architecture/resolve-identifiers.md); added ports 9086/9087 to [troubleshooting](operations/troubleshooting.md). |
| 2026-06-30 | docs sync for the SIO-933..1024 window (SIO-1025). Added a dedicated [Knowledge Graph](architecture/knowledge-graph.md) deep-dive (lbug store + three-layer schema, the in-process MCP server :9087 + curated `kg_*` / read-only Cypher, the 5 record/enrich nodes, gating, lbug lock/teardown gotchas) and the `mcp-server-knowledge-graph` package; extended [agent-memory.md](architecture/agent-memory.md) with a full scenario catalog (IaC-change / fleet-upgrade / skill-learning writes + recalls, dedup, lifecycle reconciliation, block-id logging) and the new env vars; added the corresponding fact rows to [memory-model-mapping.md](architecture/memory-model-mapping.md). Corrected node counts to verified greps (incident 20/22-with-KG; elastic-iac 24→29) and the IaC workflow list (12→16: cluster-default-delete, cluster-settings-edit, index-template-create, ingest-pipeline-create/edit). Refreshed the root README (KG MCP server :9087, node counts, memory pointer) and the new `KNOWLEDGE_GRAPH_*` / `KG_MCP_ALLOW_CYPHER` / `SKILL_LEARNING_ENABLED` / `IAC_PROPOSAL_FACT_TTL_SECONDS` env vars. |
| 2026-07-09 | docs sync for the SIO-1030..1038 window (SIO-1039). SIO-1030 focus-scoped finding cards (`matchesFocus()`); SIO-1031 grounded "IAM gap" phrasing (blockers must cite an observed auth error); SIO-1032 named-host / raw-selector / expected-count fleet upgrade; SIO-1037 new `ilm-delete` workflow (config-edit 16→17); SIO-1038 verbatim-prompt capture — the always-edged `recordIacPrompt` node, the KG `Prompt` node + `PROMPTED_IN` edge, and the `LIVE_MEMORY_RAW_PROMPTS_ENABLED` env var. Corrected node counts to verified greps: incident 22→**23** (`recordRootCause`, pre-existing drift since SIO-1026); elastic-iac 29→**30** (`recordIacPrompt`). |
| 2026-07-26 | Added the [Model Upgrade Checklist](development/model-upgrade-checklist.md) (SIO-1224) after the SIO-1213 Sonnet 5 / Opus 4.8 bump caused six production failures in one day. Ten pre-merge gates built on the new `bun run model:probe` conformance probe, whose committed reports live in `reference/model-probes/`. |
| 2026-08-08 | docs sync for the SIO-1162..1459 window. **MCP SDK modernization wave** (SIO-1410..1443): documented the unified SDK 1.30.0 baseline, the build-forbidden `server.tool()` sugar / `registerTool` + `ToolAnnotations` idiom, `outputSchema`/`structuredContent` (SIO-1422/1437), the `bootstrap-lifecycle.ts` seam (SIO-1423), and the couchbase SDK v2 dual-era pilot (SIO-1424/1443) in [mcp-integration](architecture/mcp-integration.md) and [adding-mcp-tools](development/adding-mcp-tools.md). **Tool-count corrections** to live recounts: elastic **112 -> 117** (cluster 96 -> 101, SIO-1391 ES\|QL/async-search), kafka **15-55 -> 11-61**, couchbase **~37 -> ~39**. **Eval/testing harness** (SIO-1378..1458): rewrote [testing](development/testing.md) to cover the tier-1..4 audit CLIs, the isolated single-agent probe, sound-freeze record/replay, MCP tool-call SQLite counters, and mcp-tool-eval. **Frontend** (SIO-1204/1215/1457/1459): component count **30 -> 34**, added `NetworkTopologyCard`/`ApplicationTopologyCard` + their SIO-1459 accessible text view, `MlAnomalyExplainerCard`, `ConfidenceBadge`, and the `subagent_progress`/`application_topology` SSE events to [frontend](development/frontend.md). **OKF runbooks** (SIO-1282..1434): documented per-datasource runbook bundles, `tools:` frontmatter, lifecycle-aware selection, and OKF bundle roots in [authoring-skills-and-runbooks](development/authoring-skills-and-runbooks.md). Documented the **declarative schedules layer** (SIO-1358) and the **SIO-1357 incident-closure learning workflow**. Corrected the elastic-iac proposer to **31 nodes** (was 30). Added five env vars (`RESOLVE_IDENTIFIERS_PRESETS_ENABLED`, `MCP_TOOL_METRICS_DB_PATH`, `EVAL_FIXTURE_MODE`, `EVAL_SUB_AGENT_MODEL_OVERRIDE`, `SUB_AGENT_MANIFEST_MODEL_ENABLED`) and fixed the wrong `kg-topology-sweep` default (`enabled: true` -> `false`). Indexed the two MCP audit runbooks. Merged as `3fbd7a71` ([#647](https://github.com/zx8086/devops-incident-analyzer/pull/647)). |
| 2026-09-06 | Added [pi-fleet gitagent feasibility](architecture/pi-fleet-gitagent-feasibility.md): read-only survey of both repos and the gitagent spec; verdict that gitagent can own definition, versioning and release of the pi-coms spoke and console personas but not their execution; four-phase plan with Linear issues SIO-1649, SIO-1650, SIO-1652 (fleet inbox enrichment node), SIO-1653 (manifest-driven fleet deploy across the nine target accounts, one hub per environment), SIO-1654 (pi-coms moves into this monorepo, user decision: one codebase) and SIO-1651, plus a Phase 0 comment on SIO-1635. |
| 2026-09-06 | pi-coms imported as `packages/pi-coms` (SIO-1654): package-local docs indexed, root `justfile`, CI deploy checks, bundle staged from the subtree |
| 2026-09-06 | pi-fleet Phase 1 (SIO-1649): `agents/pi-fleet` console and `aws-spoke` personas, gitagent bridge persona exporter and semver version gate, `agent-release.yml` on `pi-fleet-v*` tags, fleet bundle carries `vendor/pi-fleet/` |
| 2026-09-06 | pi-fleet Phase 1b (SIO-1653): `deploy/fleet.yaml` manifest, `just fleet` CLI (preflight, tokens, render, backend-init, plan, apply, publish, rollout, status, deploy), agent module adopt mode, nine generated roots, S3 state backend |
| 2026-09-06 | pi-fleet Phase 2a (SIO-1650): `PiFleetPane` next to the incident chat, `/api/pi/agents`, `/api/pi/messages`, `/api/pi/mailbox`, sliced await with browser re-polling, `PI_COMS_PANE_*` variables, pi-coms client exported from the agent barrel |
| 2026-09-06 | pi-fleet Phase 2b (SIO-1652): `fetchFleetInbox` node (32 nodes, 22 base), `fleetInboxDigest` sidecar and `fleet_inbox` SSE event, `FleetInboxCard`, `PI_COMS_INBOX_*` variables |
| 2026-09-06 | pi-fleet Phase 3 (SIO-1651): the `pi-handoff` workflow registering the skillflow `graph` and `agent` step handlers (their first production wiring), a detached post-turn trigger, and verdicts recorded as structured fields only |
| 2026-09-06 | pi-fleet Phase 2c (SIO-1655): the `graphFor(agentName)` registry replacing the two-agent assumption ([#697](https://github.com/zx8086/devops-incident-analyzer/pull/697)), then the **pi-fleet-console** third graph ([#698](https://github.com/zx8086/devops-incident-analyzer/pull/698)) -- separate in-process persona `agents/pi-fleet-console/`, five hub tools, and `wrapUntrusted`, the only path where a hub reply reaches a model. Added [pi-fleet console graph](architecture/pi-fleet-third-graph.md). |
| 2026-09-06 | pi-coms capability flags default ON with kill-switch semantics and move into `PiComsCapabilitiesSchema` ([#699](https://github.com/zx8086/devops-incident-analyzer/pull/699)); availability still follows a configured hub. Corrected the stale `31-node` pipeline figure here and the `PI_COMS_INBOX_ENABLED` gate wording in system-overview. |
| 2026-09-30 | docs sync for the SIO-1635..1896 window (SIO-1897), 393 commits reviewed against the code. **Fourth agent:** `landing-zone-terraform` (SIO-1867, 31-node graph, `landing-zone-iac-mcp` on :9088) added to system-overview, monorepo-structure, mcp-integration, mcp-server-configuration, frontend, troubleshooting and local-development; MCP connections 8 -> **10**. **Verified counts:** elastic-iac proposer 31 -> **38** nodes (the Renovate on-demand sub-flow, SIO-1471, documented for the first time), frontend 34 -> **42** components, 20 workspace packages, 72 actions across the seven tool YAMLs, couchbase 43 tools. **New reference material:** the ordered tool-budget cut and the Jev action selector in [action-tool-maps](development/action-tool-maps.md) (SIO-1781, 1839, 1862, 1767); loop guards, forced write-up, the AWS absence proof, the evidence index threshold and rolling cache points in [sub-agent-context-assembly](architecture/sub-agent-context-assembly.md) (SIO-1268, 1773, 1775, 1779, 1783, 1791); the promotion PR, thumbs feedback and per-thread recall in [agent-memory](architecture/agent-memory.md) (SIO-1888, 1890, 1896); `reflect:analyze` in [authoring-skills-and-runbooks](development/authoring-skills-and-runbooks.md) (SIO-1834, 1893); the Landing Zone schema and 11 `kg_lz_*` tools in [knowledge-graph](architecture/knowledge-graph.md); Archify diagrams, the API route table, the surface vocabulary and the learning review pane in [frontend](development/frontend.md) (SIO-1808..1812, 1876..1879, 1891); the couchbase read-only gate and Search tools, the Atlassian custom tools and the GitLab proxy caps in [mcp-integration](architecture/mcp-integration.md) (SIO-1109, 1802, 1806, 1813, 1822, 1823, 1844, 1854, 1863). **Corrected contradictions:** the fleet pane lists production hubs only (SIO-1696); `fetchFleetInbox` walks the incident window with a cursor and reads three monitor kinds (SIO-1825..1828); a `runbooks-konnect` category exists (SIO-1870); the Couchbase connection variables are `COUCHBASE_URL` / `COUCHBASE_USERNAME` / `COUCHBASE_PASSWORD` / `COUCHBASE_BUCKET`, not `CB_*`. **Environment variables:** a code-vs-docs sweep added about 110 variables to [environment-variables](configuration/environment-variables.md), including a pi-coms integration section. **Index:** added a Reference section and the sixteen docs this index did not link. The pi-coms package docs were synced in the same change (state checkpoint and restore, churn classification, email fan-out, `stored` mailbox status, schema-checked replies; see [pi-coms](../packages/pi-coms/docs/README.md)). |
