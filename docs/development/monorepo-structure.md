# Monorepo Structure

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-09-30

Package map and dependency graph for the DevOps Incident Analyzer Bun workspace monorepo. This document covers the workspace layout, package relationships, and configuration. The monorepo contains 20 workspace packages (5 core, 10 MCP servers, including the in-process `mcp-server-knowledge-graph`, and 5 supporting packages: knowledge-graph, memory-pr, skillflow, tools-verify, pi-coms), 1 app, and a set of declarative agent definitions that the gitagent-bridge package compiles into LangGraph nodes at runtime (or, for the pi-fleet personas, exports as a Pi package).

---

## Workspace Layout

```
devops-incident-analyzer/
  agents/
    incident-analyzer/           Orchestrator agent definition
      agent.yaml                 Manifest: model, tools, skills, sub-agents
      SOUL.md                    Agent personality and reasoning style
      RULES.md                   Behavioral constraints and guardrails
      agents/                    Sub-agent definitions
        elastic-agent/
          agent.yaml
          SOUL.md
        kafka-agent/
          agent.yaml
          SOUL.md
        capella-agent/
          agent.yaml
          SOUL.md
        konnect-agent/
          agent.yaml
          SOUL.md
        gitlab-agent/
          agent.yaml
          SOUL.md
        atlassian-agent/
          agent.yaml
          SOUL.md
        aws-agent/
          agent.yaml
          SOUL.md
      tools/                     Tool definitions (YAML)
      skills/                    Skill definitions (Markdown)
      compliance/                Compliance rules and audit templates
      knowledge/                 Domain knowledge documents (runbooks per datasource)
      workflows/                 Multi-step workflow definitions
      hooks/                     Lifecycle hooks (hooks.yaml: bootstrap and teardown steps)
      memory/                    File-backed live memory (runtime/ and wiki/)
    elastic-iac/                 Elastic IaC GitOps proposer agent (own skills, tools, knowledge, hooks, memory, workflows)
    landing-zone-terraform/      PVH Landing Zone Terraform agent (own skills, tools, knowledge, hooks, memory, workflows)
    pi-fleet-console/            In-process fleet console persona run by the pi-fleet graph (SIO-1655)
    pi-fleet/                    Console persona plus agents/aws-spoke/, exported as a Pi package into the fleet bundle (SIO-1649); never dispatched in-process
    shared/                      Shared agent resources (context, skills)
  packages/
    shared/                      Cross-package types, Zod schemas, MCP bootstrap
    observability/               Pino logger, OpenTelemetry, LangSmith tracing
    checkpointer/                LangGraph state persistence (memory + bun:sqlite)
    gitagent-bridge/             YAML-to-LangGraph adapter
    agent/                       LangGraph supervisor and 32-node pipeline (22 base + 4 gated KG + 6 gated HIL-learning nodes). The 22 base nodes include correlation enforcement, typed findings, the AWS estate router, resolveIdentifiers, fetchFleetInbox, and the mitigation branch split; the 6 HIL-learning nodes (learnFetchTicket..applyLearnings) form the learn-from-ticket lane. Plus three separate graphs: the 38-node elastic-iac proposer (src/iac/), the 31-node Landing Zone graph (src/landing-zone/) and the pi-fleet console (src/pi-fleet/)
    knowledge-graph/             Embedded entity + correlation knowledge graph (lbug/LadybugDB; SIO-850/954/965; gated on KNOWLEDGE_GRAPH_ENABLED). See architecture/knowledge-graph.md
    mcp-server-knowledge-graph/  In-process Knowledge Graph MCP server (:9087, SIO-967): curated kg_* tools + read-only Cypher over the embedded graph
    memory-pr/                   PR-based human-in-the-loop for durable agent learnings (SIO-849); opens the promotion PR for an approved learning candidate (SIO-1896)
    skillflow/                   Declarative workflow (DAG) loader + executor (SIO-848)
    tools-verify/                Static checks over tool definitions, run by `bun run tools:verify`
    pi-coms/                     pi-coms hub, Pi spoke extension, fleet monitor, Terraform and deploy scripts (SIO-1654); own docs index under packages/pi-coms/docs/
    mcp-server-elastic/          Elasticsearch MCP server (117 tools: 101 cluster incl. 9 ML anomaly-detection + 4 ES|QL/async-search + 16 conditional cloud/billing on EC_API_KEY)
    mcp-server-kafka/            Kafka MCP server (11-61 tools gated: kafka-core + SR + ksqlDB + Connect + REST Proxy)
    mcp-server-couchbase/        Couchbase Capella MCP server (~43 tools: official Couchbase tools, SIO-1107)
    mcp-server-konnect/          Kong Konnect MCP server (15 enhanced + proxy)
    mcp-server-gitlab/           GitLab MCP server (proxy + 5-8 custom code analysis tools)
    mcp-server-atlassian/        Atlassian MCP server (Jira + Confluence Rovo OAuth 2.1 proxy + incident filters)
    mcp-server-aws/              AWS MCP server (~40 read-only tools across CloudWatch, EC2, ECS, Lambda, RDS, S3, X-Ray + multi-estate via cross-account AssumeRole)
    mcp-server-elastic-iac/      Elastic IaC MCP server (GitOps proposer tools for terraform/git/gitlab/elastic-cloud, port 9086)
    mcp-server-landing-zone-iac/ Landing Zone IaC MCP server (14 lz_* tools: 10 bounded reads + 4 governed proposal tools behind write mode, port 9088; SIO-1867)
  apps/
    web/                         SvelteKit frontend
  docs/
    architecture/                System design, agent pipeline, gitagent bridge
    configuration/               Environment variables, MCP server configuration
    deployment/                  Local development, AgentCore, container builds
    development/                 Getting started, monorepo structure, testing
    operations/                  Observability, troubleshooting
  scripts/
    agentcore/                   AWS Bedrock AgentCore deployment scripts
  migrate/                       Reference implementations (read-only)
  biome.json                     Biome linter and formatter configuration
  bunfig.toml                    Bun runtime configuration
  docker-compose.yml             Local multi-service orchestration
  Dockerfile.agentcore           AgentCore container build
  package.json                   Workspace root with catalogs
  tsconfig.base.json             Shared TypeScript compiler options
  tsconfig.json                  Root TypeScript project references
  .env.example                   Environment variable template
```

---

## Package Dependency Graph

The diagram shows how packages depend on each other. Arrows point from consumer to dependency.

```
+---------------------+
|  @devops-agent/web  |
|  (SvelteKit app)    |
+----------+----------+
           |
           v
+---------------------+
| @devops-agent/agent |
| (LangGraph pipeline)|
+----------+----------+
           |
     +-----+-----+------------------+------------------+
     |           |                  |                  |
     v           v                  v                  v
+---------+ +-----------+ +---------------+ +---------+
| gitagent| | check-    | | observability | | shared  |
| -bridge | | pointer   | |               | |         |
+---------+ +-----------+ +---------------+ +---------+
     |                          |                  ^
     v                          |                  |
[agents/ YAML]                  +------------------+
                                       |
+-----------------------+              |
| mcp-server-elastic ---+--------------+
| mcp-server-kafka -----+
| mcp-server-couchbase -+
| mcp-server-konnect ---+
| mcp-server-gitlab ----+
| mcp-server-atlassian -+
+-----------------------+
```

Key relationships:

- **web** depends on **agent** for the LangGraph pipeline and SSE streaming
- **agent** depends on **gitagent-bridge** (YAML manifest loading), **checkpointer** (state persistence), **observability** (tracing and logging), and **shared** (types and schemas)
- **gitagent-bridge** reads from the `agents/` directory at runtime
- All ten MCP server packages depend on **shared** for the `createMcpApplication` bootstrap, transport abstractions, logger factory, and telemetry initialization
- MCP servers are independent of each other and of the **agent** package -- the agent connects to them over the network via `@langchain/mcp-adapters`

---

## Package Reference

### @devops-agent/shared

Cross-package foundation. Every other package in the workspace depends on this.

| Export | Purpose |
|--------|---------|
| `createMcpApplication` | MCP server bootstrap: config validation, transport setup, tool registration |
| Transport abstractions | SSE, HTTP (Streamable HTTP), stdio, and AgentCore transport factories |
| Logger factory | Pino-based structured logger with ECS formatting |
| Telemetry init | OpenTelemetry SDK bootstrap for spans and metrics |
| Zod schemas | Shared configuration schemas, MCP transport config, common types |
| TypeScript types | `McpServerConfig`, `TransportType`, `ToolDefinition`, incident state types |

Source: `packages/shared/src/`

---

### @devops-agent/observability

Centralized observability stack. Wraps Pino, OpenTelemetry, and LangSmith into a unified interface.

| Component | Purpose |
|-----------|---------|
| Pino logger | Structured JSON logging with ECS field mapping |
| OpenTelemetry SDK | Distributed tracing with automatic span propagation |
| LangSmith integration | LLM call tracing, token usage tracking, feedback collection |
| Trace context | Correlation IDs across MCP server calls and agent nodes |

Source: `packages/observability/src/`

---

### @devops-agent/checkpointer

LangGraph state persistence with two backends. The agent pipeline uses checkpoints to resume interrupted conversations and maintain conversation history.

| Backend | Use Case |
|---------|----------|
| Memory | Development and testing, no persistence across restarts |
| bun:sqlite | Production, persists state to disk via Bun built-in SQLite |

Source: `packages/checkpointer/src/`

---

### @devops-agent/gitagent-bridge

YAML-to-LangGraph adapter. Reads declarative agent definitions from `agents/` and compiles them into LangGraph-compatible nodes, tools, and configuration.

| Module | Responsibility |
|--------|----------------|
| Manifest loader | Parses `agent.yaml` files, resolves sub-agent references |
| Model factory | Creates LLM client instances from YAML model declarations |
| Skill loader | Reads Markdown skill files, converts to system prompt fragments |
| Tool prompt | Generates tool descriptions and usage instructions from YAML |
| Compliance | Applies RULES.md constraints as runtime guardrails |
| Tool schema | Converts YAML tool definitions to Zod-validated tool schemas |

Source: `packages/gitagent-bridge/src/`

---

### @devops-agent/agent

LangGraph supervisor with a 32-node StateGraph pipeline (22 base + 4 gated KG + 6 gated HIL-learning). This is the core orchestration package that processes incident queries. See [Agent Pipeline](../architecture/agent-pipeline.md) for the canonical reference; the table below is a summary.

| Node | Responsibility |
|------|----------------|
| `classify` | Determines if the query is simple (single-source) or complex (multi-source) |
| `normalize` | Extracts structured NormalizedIncident (severity, time window, affected services) |
| `selectRunbooks` | Optional: picks 0-2 runbooks from catalog via trigger grammar pre-filter then LLM |
| `entityExtractor` | Extracts entities: service names, time ranges, error codes, cluster IDs |
| `awsEstateRouter` | When AWS is targeted, expands a single AWS dispatch into one Send per configured estate (cross-account AssumeRole) |
| `queryDataSource` | Fan-out: dispatches queries to selected MCP server sub-agents (and per-estate AWS agents) in parallel |
| `align` | Aligns timelines and correlates events across data sources |
| `aggregate` | Merges sub-agent responses into a unified incident narrative |
| `extractFindings` | Derives per-domain typed findings from each sub-agent's `toolOutputs[]` |
| `correlationFetch` | Re-fans-out to a sub-agent when a correlation rule fires but its required sibling data is missing |
| `enforceCorrelationsAggregate` | Re-evaluates rules; on still-degraded rules, populates `degradedRules` and caps `confidenceCap` at 0.59 |
| `checkConfidence` | HITL gate: escalates to human when confidence < 0.6 or errors detected |
| `validate` | Checks response completeness, flags gaps, suggests follow-ups |
| `proposeInvestigate` / `proposeMonitor` / `proposeEscalate` | Mitigation branches: parallel strategy generation chosen by a router based on confidence + rule state |
| `aggregateMitigation` | Joins the three mitigation branches back onto the main path |
| `followUp` | Generates contextual follow-up questions for the user |
| `detectTopicShift` | On follow-up turns, decides whether to re-classify or carry context forward |

Pipeline flow:

```
START -> classify -> [simple: responder -> followUp -> END]
                  -> [complex: normalize -> [selectRunbooks] -> entityExtractor
                     -> [awsEstateRouter ->] queryDataSource -> align -> aggregate
                     -> extractFindings -> {enforceCorrelationsRouter}
                     -> [correlationFetch ->] enforceCorrelationsAggregate
                     -> checkConfidence -> validate
                     -> {proposeInvestigate | proposeMonitor | proposeEscalate}
                     -> aggregateMitigation -> followUp -> [detectTopicShift] -> END]
```

The agent connects to MCP servers via `MultiServerMCPClient` from `@langchain/mcp-adapters`. It does not import MCP server code directly.

Source: `packages/agent/src/`

---

### @devops-agent/mcp-server-elastic

Elasticsearch MCP server with 117 tools for querying and managing Elasticsearch deployments. The base set is 101 cluster tools (search, index, ILM, transforms, ML anomaly-detection, ES|QL + async search, etc.) and an additional 16 Elastic Cloud + Billing tools register only when `EC_API_KEY` is set (SIO-822–826).

| Capability | Details |
|------------|---------|
| Tools | 117 tools: 101 cluster (index management, search, aggregations, cluster health, templates, ILM, transforms, 9 ML anomaly-detection tools per SIO-1148, 4 ES\|QL/async-search per SIO-1391) + 16 conditional cloud/billing (`EC_API_KEY`) covering deployment audit, plan history, hardware-profile simulation with `rate_source_confidence`, and per-instance billing |
| Multi-deployment | `ELASTIC_DEPLOYMENTS=eu-cld,us-cld` with per-deployment URL and API key; cluster tools accept a per-call `deployment` arg |
| Transports | SSE, HTTP (Streamable HTTP), stdio, AgentCore |
| Port | 9080 (default) |

Source: `packages/mcp-server-elastic/src/`

---

### @devops-agent/mcp-server-kafka

Kafka MCP server with 11 base tools (up to 50 more gated on Schema Registry / ksqlDB / Connect / REST Proxy + write flags) for topic management, consumer group inspection, and message operations.

| Capability | Details |
|------------|---------|
| Tools | 11 base + up to 50 gated (8 schema-registry + 7 ksqlDB + Connect + REST Proxy + write/destructive): topic listing, consumer groups, offsets, message produce/consume; max 61 |
| Providers | `KAFKA_PROVIDER=local\|msk\|confluent` -- pluggable broker backends |
| Feature gates | Write operations (produce, create topic) gated behind `KAFKA_ENABLE_WRITES` |
| Transports | SSE, HTTP (Streamable HTTP), stdio, AgentCore |
| Port | 9081 (default) |

Source: `packages/mcp-server-kafka/src/`

---

### @devops-agent/mcp-server-couchbase

Couchbase Capella MCP server with ~43 tools for cluster management, query analysis, and operational playbooks (SIO-1107 adopted the official Couchbase tools).

| Capability | Details |
|------------|---------|
| Tools | ~43 tools: N1QL query, INFER schema, EXPLAIN, Index Advisor, covering-index detectors, bucket operations, playbooks |
| Configuration | Single cluster: `COUCHBASE_URL`, `COUCHBASE_USERNAME`, `COUCHBASE_PASSWORD` |
| Transports | SSE, HTTP (Streamable HTTP), stdio, AgentCore |
| Port | 9082 (default) |

Source: `packages/mcp-server-couchbase/src/`

---

### @devops-agent/mcp-server-konnect

Kong Konnect MCP server with 15 enhanced tools plus proxy surface for API gateway management across regions.

| Capability | Details |
|------------|---------|
| Tools | 15 enhanced + proxy surface: services, routes, plugins, consumers, upstreams, certificates |
| Configuration | `KONNECT_ACCESS_TOKEN`, `KONNECT_REGION=us\|eu\|au\|me\|in` |
| Transports | SSE, HTTP (Streamable HTTP), stdio, AgentCore |
| Port | 9083 (default) |

Source: `packages/mcp-server-konnect/src/`

---

### @devops-agent/mcp-server-gitlab

GitLab MCP server with proxy + 5-8 custom tools for CI/CD pipelines, merge requests, code analysis, and issue tracking. Uses a hybrid proxy + custom tool architecture.

| Capability | Details |
|------------|---------|
| Tools | Proxy (from GitLab native MCP) + 5-8 custom REST tools: issues, merge requests, pipelines, search, code analysis (blame, diff, file content, tree, commits) |
| Architecture | Proxy (forwards to GitLab `/api/v4/mcp`) + custom REST tools for code analysis |
| Configuration | `GITLAB_PERSONAL_ACCESS_TOKEN`, `GITLAB_INSTANCE_URL` |
| Transports | SSE, HTTP (Streamable HTTP), stdio, AgentCore |
| Port | 9084 (default) |

Source: `packages/mcp-server-gitlab/src/`

---

### @devops-agent/mcp-server-atlassian

Atlassian MCP server with proxy + custom tools for Jira issues, Confluence pages, and ticket metadata. Uses the same hybrid proxy + custom architecture as the GitLab MCP server.

| Capability | Details |
|------------|---------|
| Tools | Proxy (from Atlassian Cloud MCP) + custom: Jira issue search, project listing, Confluence page content, incident-project filtering |
| Architecture | Proxy (forwards to `https://mcp.atlassian.com/v1/mcp`) + custom tools for incident-specific filtering |
| Configuration | `ATLASSIAN_SITE_NAME`, `ATLASSIAN_MCP_URL` (upstream), `ATLASSIAN_OAUTH_CALLBACK_PORT`, `ATLASSIAN_READ_ONLY`, `ATLASSIAN_INCIDENT_PROJECTS` |
| Transports | HTTP (Streamable HTTP), stdio, AgentCore |
| Port | 9085 (default); OAuth callback on 9185 |

Source: `packages/mcp-server-atlassian/src/`

---

### @devops-agent/mcp-server-aws

Read-only AWS MCP server for the multi-estate incident fan-out. Every tool call carries a target `estate`, which the server resolves to a cross-account `AssumeRole` session; `aws_list_estates` enumerates the configured targets. It runs as an AgentCore runtime and the agent reaches it through a local SigV4-signing proxy on port 3001 (`AWS_MCP_URL`). Tool catalog and configuration: [MCP Server Configuration](../configuration/mcp-server-configuration.md); onboarding an account: [AWS Estate Onboarding](../runbooks/aws-estate-onboarding.md).

Source: `packages/mcp-server-aws/src/`

---

### @devops-agent/mcp-server-elastic-iac

MCP server behind the `elastic-iac` agent: terraform, git, GitLab and Elastic Cloud tools used to read cluster state, edit deployment and policy JSON, and open a merge request. Port 9086. It serves that agent only and is not part of the incident fan-out. See [Elastic IaC GitOps Proposer](../architecture/elastic-iac-proposer.md).

Source: `packages/mcp-server-elastic-iac/src/`

---

### @devops-agent/mcp-server-landing-zone-iac

MCP server behind the `landing-zone-terraform` agent (SIO-1867). Fourteen `lz_*` tools over the private Landing Zone GitLab repositories:

| Capability | Details |
|------------|---------|
| Read tools (10) | Repository catalog, bounded file reads, representative examples, open changes, historical merge requests, merge-request and pipeline reads, project deployments, pipeline plan, Terraform topology extraction |
| Governed write tools (4) | `lz_create_branch`, `lz_commit_allowed_files`, `lz_open_merge_request`, `lz_watch_pipeline`; registered only when write mode is enabled and validates (`config.write.enabled` in `src/server.ts`). No merge, apply, state or pipeline-trigger capability |
| Port | 9088 (`LANDING_ZONE_IAC_MCP_PORT`) |

See [Landing Zone Terraform Agent](../architecture/landing-zone-terraform-agent.md) and the [runbook](../operations/landing-zone-agent-runbook.md).

Source: `packages/mcp-server-landing-zone-iac/src/`

---

### @devops-agent/knowledge-graph

Embedded entity and correlation graph on lbug (LadybugDB), gated on `KNOWLEDGE_GRAPH_ENABLED`. Holds the store (`store.ts`), the single-file typed schema (`schema.ts`), readers and writers, migrations and the IaC seed. Embedded lbug takes an exclusive file lock, which is why its MCP server runs in-process. See [Knowledge Graph](../architecture/knowledge-graph.md).

Source: `packages/knowledge-graph/src/`

---

### @devops-agent/mcp-server-knowledge-graph

In-process MCP server (port 9087, mounted inside the web app) over the embedded graph: curated `kg_*` readers, the Landing Zone `kg_lz_*` readers, and a read-only-guarded `kg_run_cypher`.

Source: `packages/mcp-server-knowledge-graph/src/`

---

### @devops-agent/memory-pr

Turns approved learning into a pull request against the repository, so durable agent knowledge is reviewed like code (SIO-849). It scans the proposed content for secrets, fetches the base file, and opens the PR through the GitHub API. The learning review pane's approve action uses it to promote a candidate (SIO-1896). Every entry point returns `skipped` unless `MEMORY_PR_ENABLED` is set, the kill switch is off, and both `GITHUB_TOKEN` and `MEMORY_PR_REPO` are configured. See [Agent Memory](../architecture/agent-memory.md).

Source: `packages/memory-pr/src/`

---

### @devops-agent/skillflow

Declarative workflow layer (SIO-848): loads the `workflows/` YAML of an agent into a DAG (`dag.ts`), resolves step inputs from templates (`template.ts`, `resolvers.ts`), executes steps through registered handlers (`executor.ts`), and evaluates triggers and cron schedules (`triggers.ts`, `scheduler.ts`). See [Agent Concepts](../architecture/agent-concepts.md).

Source: `packages/skillflow/src/`

---

### @devops-agent/tools-verify

Static verification of tool definitions. No unit tests of its own; it is the check.

| Script | Checks |
|--------|--------|
| `bun run tools:verify` | Action-tool-map coverage (`verify-action-tool-map.ts`) and that no MCP server registers tools through the forbidden `server.tool()` sugar (`verify-no-sugar-registration.ts`) |
| `bun run tools:verify:drift` | Elastic tool registry drift (`verify-elastic-registry-drift.ts`) |

Source: `packages/tools-verify/src/`

---

### @devops-agent/pi-coms

The pi-coms hub, the Pi spoke extension, the fleet monitor, and the Terraform and deploy scripts for the AWS account spokes (imported as a subtree by SIO-1654, layout intact). It has its own documentation index at [packages/pi-coms/docs](../../packages/pi-coms/docs/README.md); read `deployment/deployment.md` there before any `just fleet` command. Its monitor dependencies live in a nested non-workspace `scripts/package.json` and must stay there.

Source: `packages/pi-coms/`

---

## App Reference

### @devops-agent/web

SvelteKit 2.0 frontend with Svelte 5 runes, Tailwind CSS v4, and Server-Sent Events (SSE) streaming for real-time agent responses.

| Aspect | Details |
|--------|---------|
| Framework | SvelteKit 2.0 with Svelte 5 runes ($state, $derived, $effect, $props) |
| Styling | Tailwind CSS v4 with Tommy Hilfiger brand palette |
| Streaming | SSE for real-time agent response streaming |
| Build tool | Vite 6 |
| Port | 5173 (development) |

The frontend contains 42 components (`ls apps/web/src/lib/components/*.svelte`). The full component families, the API route table and the stores are in [Frontend](frontend.md). The nine that make up the chat shell:

| Component | Purpose |
|-----------|---------|
| `ChatMessage` | Renders individual agent and user messages |
| `ChatInput` | Text input with submit handling |
| `Icon` | SVG icon library |
| `MarkdownRenderer` | Renders Markdown in agent responses (exception: uses `<style>` block for dynamic HTML) |
| `StreamingProgress` | Real-time progress indicator during agent processing |
| `CompletedProgress` | Summary of completed agent pipeline stages |
| `FeedbackBar` | User feedback collection (thumbs up/down, comments) |
| `FollowUpSuggestions` | Clickable follow-up questions generated by the validate node |
| `DataSourceSelector` | Multi-select for Elasticsearch, Kafka, Couchbase, Konnect, GitLab, Atlassian |

Source: `apps/web/src/`

---

## Gitagent Definitions

### agents/incident-analyzer/

Declarative agent definitions that the gitagent-bridge package compiles into LangGraph configuration at runtime. The orchestrator agent and seven sub-agents are defined here.

```
agents/incident-analyzer/
  agent.yaml             Orchestrator manifest: model, tools, skills, sub-agents
  SOUL.md                Agent personality: DevOps incident analyst persona
  RULES.md               Behavioral constraints: no destructive actions, cite sources
  agents/
    elastic-agent/       Elasticsearch specialist
      agent.yaml         Tools: 117 ES tools via MCP port 9080 (101 cluster incl. 9 ML anomaly-detection + 4 ES|QL/async-search + 16 conditional cloud/billing on EC_API_KEY)
      SOUL.md            Persona: log and metric analysis expert
    kafka-agent/         Kafka specialist
      agent.yaml         Tools: 11-61 Kafka tools via MCP port 9081 (11 base + up to 50 gated SR + ksqlDB + Connect + REST Proxy)
      SOUL.md            Persona: event streaming and consumer group analyst
    capella-agent/       Couchbase Capella specialist
      agent.yaml         Tools: ~43 Capella tools via MCP port 9082 (SIO-1107 official Couchbase tools)
      SOUL.md            Persona: document database and query optimization expert
    konnect-agent/       Kong Konnect specialist
      agent.yaml         Tools: 15 enhanced + proxy Konnect tools via MCP port 9083
      SOUL.md            Persona: API gateway configuration and traffic analyst
    gitlab-agent/        GitLab specialist
      agent.yaml         Tools: proxy + 5-8 custom GitLab tools via MCP port 9084
      SOUL.md            Persona: CI/CD pipeline and code change analyst
    atlassian-agent/     Atlassian (Jira/Confluence) specialist
      agent.yaml         Tools: proxy + custom Atlassian tools via MCP port 9085
      SOUL.md            Persona: incident ticket and runbook-page analyst
    aws-agent/           AWS specialist (multi-estate)
      agent.yaml         Tools: ~40 read-only AWS tools + aws_list_estates via AWS_MCP_URL (port 3001 SigV4 proxy in dev; AgentCore runtime in prod)
      SOUL.md            Persona: cloud infrastructure and cross-account audit analyst
  tools/                 Shared tool definitions (YAML)
  skills/                Multi-step skill definitions (Markdown)
  compliance/            Compliance rules and audit templates
  knowledge/             Domain knowledge: runbooks, architecture docs
  workflows/             Multi-step workflow definitions
```

The gitagent-bridge reads these files at startup and produces:

- LangGraph node configurations for each sub-agent
- System prompts assembled from SOUL.md + RULES.md + skill files
- Tool schemas validated against the connected MCP server tool lists
- Compliance guardrails injected as pre/post-processing steps

---

## Bun Workspace Configuration

The root `package.json` defines the workspace structure and dependency catalogs.

### Workspace Packages

```json
{
  "workspaces": {
    "packages": ["packages/*", "apps/*"]
  }
}
```

All directories under `packages/` and `apps/` are automatically registered as workspace members.

### Dependency Catalogs

Catalogs pin shared dependency versions across the workspace. Individual packages reference catalog entries instead of specifying versions directly.

**Default catalog** -- runtime dependencies shared across packages:

| Dependency | Version | Used By |
|------------|---------|---------|
| `@langchain/langgraph` | ^1.2.2 | agent |
| `@langchain/langgraph-checkpoint` | ^1.0.0 | checkpointer |
| `@langchain/mcp-adapters` | ^1.1.3 | agent |
| `@langchain/aws` | ^0.1.0 | agent |
| `@langchain/core` | ^1.1.31 | agent, gitagent-bridge |
| `@modelcontextprotocol/sdk` | ^1.30.0 (catalog + `1.30.0` override, SIO-1410) | shared, all MCP servers |
| `zod` | ^3.24.0 | all packages |
| `yaml` | ^2.6.0 | gitagent-bridge |
| `pino` | ^9.0.0 | shared, observability |
| `marked` | ^15.0.0 | web |
| `highlight.js` | ^11.10.0 | web |
| `langsmith` | ^0.5.8 | observability |

**Dev catalog** -- development tooling:

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@biomejs/biome` | ^2.4.6 | Linting and formatting |
| `@types/bun` | ^1.3.10 | Bun type definitions |
| `bun-types` | ^1.3.10 | Bun runtime types |
| `typescript` | ^5.9.3 | TypeScript compiler |

**Svelte catalog** -- frontend framework:

| Dependency | Version | Purpose |
|------------|---------|---------|
| `svelte` | ^5.0.0 | Svelte 5 with runes |
| `@sveltejs/kit` | ^2.0.0 | SvelteKit framework |
| `@sveltejs/adapter-auto` | ^4.0.0 | Deployment adapter |
| `@sveltejs/vite-plugin-svelte` | ^5.0.0 | Vite integration |
| `vite` | ^6.0.0 | Build tool |

### Root Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `bun run --filter '*' dev` | Start all services in development mode |
| `test` | `bun run --filter '*' test` | Run tests across all packages |
| `typecheck` | `bun run --filter '*' typecheck` | TypeScript checking across all packages |
| `lint` | `biome check .` | Biome lint check |
| `lint:fix` | `biome check --write .` | Biome auto-fix |
| `yaml:check` | `yamllint -d relaxed agents/ .yamllint.yml` | Validate agent YAML definitions |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial monorepo structure document created |
| 2026-04-13 | Added mcp-server-gitlab (10th package), gitlab-agent (5th sub-agent), updated pipeline from 8 to 12 nodes |
| 2026-04-23 | Added mcp-server-atlassian (11th package) and atlassian-agent (6th sub-agent); updated all tool-count placeholders |
| 2026-09-30 | SIO-1897 docs sync (SIO-1635..1896 window): package count 17 -> **20** (added `mcp-server-landing-zone-iac` SIO-1867, `pi-coms` SIO-1654, `tools-verify`); layout gains `aws-agent`, the `hooks/` and `memory/` dirs, and the `elastic-iac`, `landing-zone-terraform`, `pi-fleet-console` and `pi-fleet` agent definitions; corrected the stale 31-node line to 32 and the elastic-iac proposer to 38; added Package Reference entries for the nine packages that had none; frontend 9 -> 42 components with a pointer to frontend.md. |
