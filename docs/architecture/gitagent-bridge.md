# Gitagent Bridge Architecture

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-04-04

The gitagent bridge is a two-layer system that separates agent behavior definitions (YAML and Markdown files versioned in `agents/`) from the LangGraph TypeScript runtime (`packages/agent/`). The bridge package (`packages/gitagent-bridge/`) compiles declarative agent definitions into system prompts, Bedrock model configurations, tool prompt templates, related-tool workflow hints, compliance metadata, and CI-time schema validation results.

---

## Overview

### The Two-Layer System

```
+-------------------------------+
|  agents/incident-analyzer/    |   Declarative Layer
|                               |   (YAML + Markdown)
|  agent.yaml                   |   - Identity, model, compliance
|  SOUL.md                      |   - Personality, values
|  RULES.md                     |   - Hard constraints
|  tools/*.yaml                 |   - Tool schemas, prompts
|  skills/*/SKILL.md            |   - Procedural knowledge
|  compliance/                  |   - Risk, allowed actions
|  agents/elastic-agent/        |   - Sub-agent definitions
|  agents/kafka-agent/          |
|  agents/capella-agent/        |
|  agents/konnect-agent/        |
|  agents/gitlab-agent/         |
|  agents/atlassian-agent/      |
+---------------+---------------+
                |
                | loadAgent() parses + validates
                v
+-------------------------------+
|  packages/gitagent-bridge/    |   Compiler / Adapter
|                               |
|  manifest-loader.ts           |   - YAML -> Zod-validated types
|  model-factory.ts             |   - agent.yaml -> BedrockModelConfig
|  skill-loader.ts              |   - SOUL + RULES + SKILLs -> prompt
|  tool-prompt.ts               |   - Template resolution
|  related-tools.ts             |   - Workflow chaining hints
|  compliance.ts                |   - Config -> LangSmith metadata
|  tool-schema.ts               |   - CI drift detection
|  tool-mapping.ts              |   - Facade -> MCP tool mapping
+---------------+---------------+
                |
                | Imports: loadAgent, buildSystemPrompt,
                | resolveBedrockConfig, etc.
                v
+-------------------------------+
|  packages/agent/              |   LangGraph Runtime
|                               |
|  llm.ts                       |   - Creates ChatBedrockConverse
|  prompt-context.ts            |   - Builds orchestrator/sub-agent
|  graph.ts                     |     system prompts from bridge
|  supervisor.ts                |
|  sub-agent.ts                 |
+-------------------------------+
```

The declarative layer can be reviewed and modified by non-developers (agent designers, compliance reviewers). The bridge ensures that changes to YAML/Markdown files are validated against Zod schemas before reaching the runtime. The runtime never reads agent definition files directly -- it always goes through the bridge.

---

## Agent Definition Structure

### Directory Layout

```
agents/
  incident-analyzer/
    agent.yaml                          # Root manifest: model, skills, tools, sub-agents, compliance
    SOUL.md                             # Identity, communication style, values, domain expertise
    RULES.md                            # Hard constraints: must always, must never, output format
    tools/
      elastic-logs.yaml                 # Elasticsearch log search facade
      kafka-introspect.yaml             # Kafka cluster/topic/consumer facade
      couchbase-health.yaml             # Couchbase cluster/bucket/query facade
      konnect-gateway.yaml              # Kong Konnect routes/services/plugins facade
      notify-slack.yaml                 # Slack notification (requires confirmation)
      create-ticket.yaml                # Ticket creation (requires confirmation)
    skills/
      normalize-incident/
        SKILL.md                        # Procedure: raw alert -> structured incident object
      aggregate-findings/
        SKILL.md                        # Procedure: multi-datasource correlation
      propose-mitigation/
        SKILL.md                        # Procedure: safe remediation suggestions
    knowledge/
      index.yaml                        # Knowledge base category registry
      runbooks/
        kafka-consumer-lag.md           # Playbook: stalled/lagging Kafka consumers
        high-error-rate.md              # Playbook: 5xx spikes on Kong Konnect
        database-slow-queries.md        # Playbook: slow N1QL queries on Capella
      systems-map/
        service-dependencies.md         # 4-plane infrastructure dependency graph
      slo-policies/
        api-latency-slo.md              # Tiered latency/error-budget definitions
    compliance/
      risk-assessment.md                # Medium risk classification with justification
      allowed-actions.yaml              # Permitted read ops, prohibited write ops
    workflows/
      incident-triage.yaml              # Triage workflow definition
    agents/
      elastic-agent/
        agent.yaml                      # Sub-agent: Haiku model, low risk, elastic-logs tool
        SOUL.md                         # Elasticsearch specialist identity
      kafka-agent/
        agent.yaml                      # Sub-agent: Haiku model, low risk, kafka-introspect tool
        SOUL.md                         # Kafka specialist identity
      capella-agent/
        agent.yaml                      # Sub-agent: Haiku model, low risk, couchbase-health tool
        SOUL.md                         # Couchbase Capella specialist identity
      konnect-agent/
        agent.yaml                      # Sub-agent: Haiku model, low risk, konnect-gateway tool
        SOUL.md                         # Kong Konnect specialist identity
```

### agent.yaml Specification

The root manifest is validated by `AgentManifestSchema` (Zod). All sub-agent manifests use the same schema.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec_version` | `string` | No | Schema version for forward compatibility (current: `"0.1.0"`) |
| `name` | `string` | Yes | Agent identifier, lowercase with hyphens (`^[a-z][a-z0-9-]*$`) |
| `version` | `string` | Yes | Semantic version string |
| `description` | `string` | Yes | Human-readable purpose statement |
| `model` | `ModelConfig` | No | LLM configuration: preferred model, fallbacks, temperature, max_tokens |
| `runtime` | `RuntimeConfig` | No | Execution limits: `max_turns`, `timeout` (seconds) |
| `skills` | `string[]` | No | Skill names to load from `skills/<name>/SKILL.md` |
| `tools` | `string[]` | No | Tool definition names to load from `tools/<name>.yaml` |
| `agents` | `Record<string, SubAgentRef>` | No | Sub-agent references with delegation mode (`auto`, `explicit`, `router`) |
| `delegation` | `{mode, router?}` | No | How the orchestrator delegates to sub-agents. Mode: `auto`, `explicit`, `router` |
| `compliance` | `ComplianceConfig` | No | Risk tier, supervision policy, recordkeeping, data governance |
| `tags` | `string[]` | No | Metadata tags for filtering and categorization |

**Model configuration example (orchestrator):**
```yaml
model:
  preferred: claude-sonnet-4-6
  fallback:
    - claude-haiku-4-5
  constraints:
    temperature: 0.2
    max_tokens: 4096
```

**Model configuration example (sub-agent):**
```yaml
model:
  preferred: claude-haiku-4-5
  constraints:
    temperature: 0.1
    max_tokens: 2048
```

### SOUL.md (Identity)

The SOUL.md file defines the agent's personality, communication style, action bias, values, domain expertise, and collaboration approach. It is injected as the first section of the system prompt.

The root orchestrator's SOUL.md establishes:
- **Core Identity:** multi-datasource incident analysis orchestrator
- **Communication Style:** structured, evidence-driven, tables for comparisons
- **Action Bias:** act first, clarify only when genuinely ambiguous. Default to all clusters, last 1 hour, all datasources, production
- **Values:** evidence over assumptions, read-only, transparency, escalation over guessing, correlation over isolation
- **Domain Expertise:** Kubernetes, Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, incident correlation, SLO assessment

Each sub-agent has its own SOUL.md focused on its datasource specialty.

### RULES.md (Constraints)

Hard rules that the agent must follow. These are injected after the SOUL in the system prompt.

**Must Always:**
- Base conclusions on tool output data
- Include timestamps and metric values
- Cite which datasource each finding came from
- Escalate when confidence < 0.6
- Report tool failures transparently
- Format timestamps in ISO 8601

**Must Never:**
- Write to any production system
- Fabricate data not in tool outputs
- Skip a sub-agent query when the workflow requires it
- Provide destructive remediation steps
- Suppress errors from the report

**Output Constraints:**
- Markdown tables for cross-datasource comparisons
- No emojis
- Confidence score (0.0-1.0) with every report
- Separate findings from recommendations

### tools/*.yaml (Tool Definitions)

Each YAML file defines a tool facade that maps to one or more MCP server tools. The schema is validated by `ToolDefinitionSchema`.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Tool identifier |
| `description` | `string` | Base description (used when no prompt_template) |
| `version` | `string` | Optional version |
| `input_schema` | `object` | JSON Schema for tool input parameters |
| `output_schema` | `object` | Optional JSON Schema for expected output |
| `annotations` | `object` | `requires_confirmation`, `read_only`, `cost` (low/medium/high) |
| `prompt_template` | `string` | Dynamic description with Handlebars-style conditionals |
| `related_tools` | `string[]` | Workflow chaining hints shown after tool execution |
| `tool_mapping` | `{mcp_server, mcp_patterns}` | Maps this facade to actual MCP tool names via patterns |

**tool_mapping example:**
```yaml
tool_mapping:
  mcp_server: elastic
  mcp_patterns:
    - "elasticsearch_*"
```

This maps the `elastic-logs` facade to all MCP tools whose names start with `elasticsearch_`.

### skills/*/SKILL.md (Procedural Knowledge)

Skills are multi-step procedures that teach the agent how to perform complex reasoning tasks. They are loaded from `skills/<name>/SKILL.md` and appended to the system prompt as `## Skill: <name>` sections. A skill is only loaded if its name is listed in the root `agent.yaml` under `skills:` -- skills are **named and explicitly activated**.

The incident analyzer defines three skills:
- **normalize-incident:** Transform raw alerts into structured incident objects with severity, time window, affected services, and datasource targets
- **aggregate-findings:** Correlate findings across multiple datasources into a unified report
- **propose-mitigation:** Generate safe, read-only remediation suggestions

### knowledge/ (Reference Knowledge)

The `knowledge/` directory contains reference material the agent can consult opportunistically when matching incident signals against known patterns. Unlike skills, knowledge entries are **bulk-loaded and always-on**: every file in every registered category is appended to the orchestrator's system prompt for the life of each request.

`knowledge/index.yaml` declares categories and their paths. The incident analyzer registers three:
- **runbooks/** -- Operational playbooks for common incident patterns (`kafka-consumer-lag.md`, `high-error-rate.md`, `database-slow-queries.md`). Each runbook describes identification steps, drill-down queries, and cross-datasource correlation, and references MCP tool names directly in prose.
- **systems-map/** -- Service dependency graphs and topology (`service-dependencies.md`). Helps the agent reason about upstream/downstream blast radius.
- **slo-policies/** -- SLO/SLA definitions and thresholds (`api-latency-slo.md`). Tier definitions, error budgets, and latency targets.

**Skill vs knowledge at a glance:**

| Dimension | Skill | Knowledge (runbook, etc.) |
|---|---|---|
| What it is | Procedure the agent performs | Reference material the agent consults |
| Activation | Named in `agent.yaml:skills:` | Dropped into `knowledge/<category>/`, picked up via `index.yaml` |
| Prompt presence | Only the listed skills | All entries in all registered categories |
| Who decides when it applies | Pipeline node (e.g. `normalize` implies `normalize-incident`) | LLM pattern-matches signals against prose |
| Tool-name binding | None | Runbooks reference MCP tools by name -- **not enforced at load time**, rename a tool and runbook prose silently rots |

The tool-name convention is a footgun worth restating: if a runbook cites `capella_get_longest_running_queries` and someone renames the underlying MCP tool, nothing breaks at load time, `bun run yaml:check` does not catch it, and the LLM will cite a dead tool at runtime. The convention is enforced by code review and authorial discipline, not by the loader.

### compliance/ (Risk and Governance)

Two files define the compliance posture:

**risk-assessment.md** -- Classifies the agent as Medium Risk with justification (read-only analysis, no writes, HITL for remediations, audit logging, PII redaction).

**allowed-actions.yaml** -- Explicit allowlist of permitted operations and a blocklist of prohibited operations:
- Allowed: read_logs, read_consumer_groups, read_cluster_health, read_api_analytics, run_n1ql_query (SELECT only), notify_slack (with confirmation), create_ticket (with confirmation)
- Prohibited: write_to_database, produce_kafka_message, delete_index, modify_api_gateway, restart_service, scale_deployment, modify_kubernetes_resources

---

## Bridge Package Components

### manifest-loader.ts

**Purpose:** Recursively loads an agent definition directory into a typed `LoadedAgent` structure.

**`loadAgent(agentDir: string): LoadedAgent`** reads:
1. `agent.yaml` -- parsed with the `yaml` package and validated against `AgentManifestSchema`
2. `SOUL.md` and `RULES.md` -- loaded as raw strings (optional, empty string if missing)
3. `tools/*.yaml` -- each file parsed and validated against `ToolDefinitionSchema`
4. `skills/<name>/SKILL.md` -- loaded for each skill listed in `manifest.skills`
5. `agents/<name>/` -- recursively calls `loadAgent()` for each sub-agent listed in `manifest.agents`
6. `knowledge/` -- delegated to `loadKnowledge()` (see below)

**`loadKnowledge(agentDir: string): KnowledgeEntry[]`** reads reference material registered in `knowledge/index.yaml`. For each category declared there (`runbooks`, `systems-map`, `slo-policies`, ...), it walks the category's `path` directory and loads every `.md` file (excluding `.gitkeep`) into a `KnowledgeEntry` tagged with its category name. Non-empty contents only. If `index.yaml` is missing or fails `KnowledgeIndexSchema` validation, the loader returns an empty array -- knowledge is strictly additive and never blocks agent loading.

**Return type:**
```typescript
interface KnowledgeEntry {
    category: string;    // e.g. "runbooks", "systems-map", "slo-policies"
    filename: string;    // e.g. "kafka-consumer-lag.md"
    content: string;     // trimmed file body
}

interface LoadedAgent {
    manifest: AgentManifest;
    soul: string;
    rules: string;
    tools: ToolDefinition[];
    skills: Map<string, string>;
    subAgents: Map<string, LoadedAgent>;
    knowledge: KnowledgeEntry[];
}
```

### model-factory.ts

**Purpose:** Translates gitagent model identifiers into AWS Bedrock model IDs and configuration.

**`resolveBedrockConfig(modelConfig): BedrockModelConfig`** maps friendly names to Bedrock ARNs:

| Gitagent Name | Bedrock Model ID |
|---------------|-----------------|
| `claude-sonnet-4-6` | `eu.anthropic.claude-sonnet-4-6` |
| `claude-haiku-4-5` | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `claude-opus-4-6` | `eu.anthropic.claude-opus-4-6` |

Region defaults to `eu-west-1` (overridable via `AWS_REGION` env var). Temperature and max tokens come from the manifest's `model.constraints`, with caller-provided defaults as fallback.

**`getRecursionLimit(maxTurns): number`** converts the manifest's `runtime.max_turns` into a LangGraph recursion limit (maxTurns * 2, default 50).

### skill-loader.ts

**Purpose:** Assembles the system prompt from SOUL.md, RULES.md, skill content, and knowledge base entries.

**`buildSystemPrompt(agent, activeSkills?): string`** concatenates:
1. SOUL.md content (trimmed)
2. RULES.md content (trimmed)
3. Each active skill's SKILL.md content (with YAML frontmatter stripped), prefixed with `## Skill: <name>`
4. Knowledge base section (if `agent.knowledge` is non-empty), built by `buildKnowledgeSection()`

Sections are joined with `\n\n---\n\n` separators. If `activeSkills` is not provided, all skills in the agent's skills map are included.

**`buildKnowledgeSection(knowledge): string`** groups `KnowledgeEntry[]` by category and emits a `## Knowledge Base` block. Each category becomes a `### <Title-Case-Category>` heading (e.g. `runbooks` -> `### Runbooks`), and each entry within a category becomes a `#### <filename>` block followed by the entry's content. Every runbook, systems-map document, and SLO policy file is **always-on**: the entire knowledge base sits in the orchestrator's system prompt for the life of every request. There is no per-request filtering.

The practical consequence: the LLM pattern-matches incident signals against runbook prose during the `aggregate` and `validate` nodes. Runbooks are not dispatched, selected, or indexed -- they are reference material the model reads opportunistically.

### tool-prompt.ts

**Purpose:** Resolves dynamic tool descriptions from Handlebars-style templates.

**`buildToolPrompt(toolDef, context): string`** processes the tool's `prompt_template` by:
1. Resolving `{{#if datasources}}...{{/if}}` blocks with datasource list
2. Resolving `{{#if compliance_tier}}...{{/if}}` blocks with compliance tier
3. Resolving `{{#if active_skills}}...{{/if}}` blocks with active skill names
4. Replacing custom variables `{{key}}` from `context.customVariables`
5. Collapsing excess whitespace

If no `prompt_template` exists, returns the plain `description` field.

**`buildContextFromAgent(agent): ToolPromptContext`** extracts context from a loaded agent: tool names as datasources, compliance tier, skill names, delegation mode.

**`buildAllToolPrompts(agent, overrides?): Map<string, string>`** builds resolved prompts for all tools in one call.

### related-tools.ts

**Purpose:** Extracts and applies workflow chaining hints from tool definitions.

**`buildRelatedToolsMap(agent): Map<string, string[]>`** collects all `related_tools` arrays from the agent's tool definitions.

**`withRelatedTools(response, toolName, map): response & { relatedTools? }`** enriches a tool response with related tool suggestions if available.

Example related tools for `elastic-logs`:
- "Use kafka-consumer-lag to check if log spikes correlate with Kafka backpressure"
- "Use couchbase-cluster-health to verify database health during the same time window"
- "Use konnect-api-requests to check if API gateway errors correlate with log patterns"

### compliance.ts

**Purpose:** Converts compliance configuration into LangSmith metadata and approval checks.

**`complianceToMetadata(compliance): Record<string, string>`** produces metadata keys:
- `compliance_risk_tier` -- the risk tier (low, standard, medium, high, critical)
- `compliance_audit_logging` -- whether audit logging is enabled
- `compliance_retention_period` -- log retention period (e.g., "1y")
- `compliance_immutable_logs` -- whether logs are immutable
- `compliance_hitl` -- human-in-the-loop mode
- `compliance_pii_handling` -- PII handling policy
- `compliance_data_classification` -- data classification level

**`requiresApproval(toolName, compliance): boolean`** checks if a tool invocation needs human approval based on escalation triggers.

### tool-schema.ts

**Purpose:** CI-time drift detection between gitagent tool definitions and actual MCP server tools.

**`validateToolSchemas(gitagentTools, mcpToolNames): ToolValidationResult`** operates in two modes:

1. **Facade mapping mode** (when `tool_mapping` fields are present): Resolves each facade's `mcp_patterns` against the MCP tool name list. Reports facades with zero matched MCP tools as `missing`, and MCP tools not covered by any facade as `extra`.
2. **Direct name mode** (backward compatibility): Compares gitagent tool names directly against MCP tool names.

Returns `{ valid, missing, extra, unmappedFacades, facadeMap }`.

### tool-mapping.ts

**Purpose:** Resolves glob-style patterns in `tool_mapping.mcp_patterns` to actual MCP tool names.

**`matchesPattern(pattern, toolName): boolean`** supports exact match and single-wildcard glob (e.g., `elasticsearch_*` matches `elasticsearch_search`, `elasticsearch_cluster_health`).

**`buildFacadeMap(tools, mcpToolNames): FacadeMap`** builds bidirectional mappings:
- `facadeToMcp` -- Map from facade name to array of matched MCP tool names
- `mcpToFacade` -- Map from MCP tool name to its owning facade name

**`getUncoveredTools(facadeMap, mcpToolNames): string[]`** returns MCP tools not mapped to any facade.

---

## How the Runtime Consumes Bridge Output

The `packages/agent/` package imports from the bridge at two key points:

**1. LLM creation (`llm.ts`):**
```
loadAgent(agentsDir) --> agent.manifest.model --> resolveBedrockConfig() --> ChatBedrockConverse
```

The root agent is loaded once and cached. The orchestrator uses the root manifest's model config (Sonnet). Lightweight roles (classifier, entityExtractor) use the sub-agent's model config (Haiku) for speed.

**2. System prompt construction (`prompt-context.ts`):**
```
loadAgent(agentsDir) --> buildSystemPrompt(agent) --> orchestrator system prompt
loadAgent(agentsDir) --> agent.subAgents.get(name) --> buildSystemPrompt(subAgent) --> sub-agent prompt
```

Each sub-agent gets its own system prompt built from its SOUL.md and RULES.md. The orchestrator gets the root agent's full prompt (SOUL + RULES + all active skills).

---

## Adding or Modifying Agent Definitions

**To add a new skill:**

1. Create `agents/incident-analyzer/skills/<skill-name>/SKILL.md` with the procedure
2. Add the skill name to `skills:` in `agents/incident-analyzer/agent.yaml`
3. Run `bun run typecheck` -- the bridge will load and validate the new skill
4. The skill is automatically included in the orchestrator's system prompt

**To add a new tool facade:**

1. Create `agents/incident-analyzer/tools/<tool-name>.yaml` with schema, prompt_template, related_tools, and tool_mapping
2. Add the tool name to `tools:` in `agents/incident-analyzer/agent.yaml`
3. Run `bun test --filter gitagent-bridge` to validate schema compatibility
4. If the tool maps to a new MCP server, add the server to the sub-agent definitions

**To modify agent personality or rules:**

1. Edit `SOUL.md` or `RULES.md` in the relevant agent directory
2. Changes take effect on next agent startup (the bridge re-reads files)
3. No code changes required

**To add a new sub-agent:**

1. Create `agents/incident-analyzer/agents/<agent-name>/` with `agent.yaml` and `SOUL.md`
2. Add the agent to the `agents:` section of the root `agent.yaml`
3. Add the datasource ID mapping in `packages/agent/src/supervisor.ts` (`AGENT_NAMES`) and `packages/agent/src/mcp-bridge.ts` (`serverMap`)
4. Add the MCP server URL env var to the `McpClientConfig` interface

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial document created from codebase analysis |
