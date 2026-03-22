# DevOps Incident Analyzer — Setup Guide

**Gitagent patterns + LangGraph TypeScript + Bun workspace monorepo**

This guide converts the architecture from your GitAgent DevOps Setup document into a production LangGraph TypeScript agent, applying the "invest in the patterns, not the dependency" principle. It reuses proven patterns from the ES agent (supervisor fan-out, MCP bridging, tiered checkpointing, structured aggregation) while adding gitagent's directory conventions as the declarative layer.

---

## Oracle Agent Spec: where it fits and where it doesn't

Oracle's Open Agent Specification is the most mature agent definition standard. It has a Python SDK (`pyagentspec`), working LangGraph and AutoGen adapters, benchmark results across SimpleQA and BIRD-SQL, and AG-UI frontend integration via CopilotKit. However, for your stack, there are hard blockers.

### What Agent Spec does well

Agent Spec provides a JSON-based declarative language for defining agents, tools, LLM configurations, and structured workflows (Flows). Its LangGraph adapter loads Agent Spec JSON and transforms components into LangGraph primitives — agents become nodes, flows become StateGraphs with edges, tools map to LangChain tool interfaces. The adapter handles routing, conditional edges, and parallel execution. Oracle also built a tracing system (Agent Spec Tracing) that emits standardized events compatible with observability pipelines and AG-UI frontends.

The spec covers concepts directly relevant to your DevOps agent: agent composition (supervisor + specialist sub-agents), tool definitions with JSON Schema input/output, workflow steps with dependencies and conditions, and human-in-the-loop approval patterns.

### Why you can't use it directly

**The LangGraph adapter is Python-only.** There is no TypeScript SDK, no npm package, and no community TypeScript port. The `pyagentspec` library and all runtime adapters (`langgraphagentspecadapter`, `crewaiagentspecadapter`) require Python 3.10–3.13. The entire Agent Spec ecosystem — SDK, adapters, tracing, AG-UI integration — is Python-first with no announced TypeScript plans.

**This means Agent Spec cannot drive your Bun/TypeScript/LangGraph runtime.** You would need to either rewrite the Python SDK in TypeScript (massive effort, moving target) or run a Python sidecar that loads Agent Spec JSON and exposes it to your Bun process (adds operational complexity and defeats the purpose of a unified stack).

### What to cherry-pick from Agent Spec

Despite the language barrier, Agent Spec's design choices inform your own bridge layer:

- **JSON serialization of agent definitions** — Agent Spec uses JSON for portability. For your gitagent-bridge, YAML (which gitagent already uses for `agent.yaml`) is equally valid and more human-readable. Parse with the `yaml` npm package.
- **Component-type system** — Agent Spec types components (`LLMNode`, `ToolNode`, `AgentNode`, `FlowNode`) to validate connections at build time. Your bridge can use Zod schemas to validate `agent.yaml` fields before constructing LangGraph nodes.
- **Adapter pattern** — Agent Spec's adapters are thin translators that load a spec and produce framework-native constructs. Your `gitagent-bridge` package follows the exact same pattern: load `agent.yaml` → produce `ChatBedrockConverse` config + `StateGraph` nodes.
- **Tracing hooks** — Agent Spec Tracing emits `span_start`, `span_end`, `tool_call`, `llm_call` events. LangSmith already captures all of these automatically. Map gitagent's `compliance.recordkeeping` fields to LangSmith metadata tags.

**Bottom line: Oracle Agent Spec validates the architectural approach (declarative spec → runtime adapter → framework execution) but the implementation must be your own TypeScript bridge because the Python SDK is a non-starter for Bun.**

---

## Project structure

The new project combines your existing Bun workspace monorepo pattern with gitagent's directory conventions. The key insight: gitagent definitions live in `agents/` at the repo root, separate from but read by the LangGraph runtime in `packages/`.

```
devops-incident-analyzer/
├── package.json                     # Bun workspace root
├── bunfig.toml
├── tsconfig.base.json               # Shared TS config
├── biome.json                       # Shared linting
├── .env                             # MCP server URLs, API keys
├── .env.example
├── docker-compose.yml               # Local dev: agent + MCP servers
├── Dockerfile                       # Bun multi-stage build
│
├── agents/                          # ── GITAGENT DEFINITIONS ──
│   ├── incident-analyzer/           # Main orchestrator agent
│   │   ├── agent.yaml               # Model, tools, skills, compliance
│   │   ├── SOUL.md                  # Identity & reasoning philosophy
│   │   ├── RULES.md                 # Hard constraints (read-only, no infra writes)
│   │   ├── tools/                   # MCP tool schemas (YAML)
│   │   │   ├── elastic-logs.yaml
│   │   │   ├── kafka-introspect.yaml
│   │   │   ├── couchbase-health.yaml
│   │   │   ├── notify-slack.yaml
│   │   │   └── create-ticket.yaml
│   │   ├── skills/                  # SKILL.md procedural knowledge
│   │   │   ├── normalize-incident/
│   │   │   │   └── SKILL.md
│   │   │   ├── aggregate-findings/
│   │   │   │   └── SKILL.md
│   │   │   └── propose-mitigation/
│   │   │       └── SKILL.md
│   │   ├── workflows/               # Workflow definitions
│   │   │   └── incident-triage.yaml
│   │   ├── knowledge/               # Domain knowledge
│   │   │   ├── index.yaml
│   │   │   ├── runbooks/
│   │   │   ├── systems-map/
│   │   │   └── slo-policies/
│   │   ├── compliance/              # Regulatory/safety artifacts
│   │   │   ├── risk-assessment.md
│   │   │   └── allowed-actions.yaml
│   │   └── agents/                  # Sub-agent definitions
│   │       ├── logs-agent/
│   │       │   ├── agent.yaml
│   │       │   └── SOUL.md
│   │       ├── events-agent/
│   │       │   ├── agent.yaml
│   │       │   └── SOUL.md
│   │       └── datastore-agent/
│   │           ├── agent.yaml
│   │           └── SOUL.md
│   └── shared/
│       └── skills/                  # Skills shared across agents
│
├── packages/
│   ├── gitagent-bridge/             # YAML→LangGraph adapter (~500-800 LOC)
│   │   ├── package.json             #   @devops-agent/gitagent-bridge
│   │   └── src/
│   │       ├── index.ts             #   Public API
│   │       ├── manifest-loader.ts   #   Parse agent.yaml → typed config
│   │       ├── model-factory.ts     #   agent.yaml model → ChatBedrockConverse
│   │       ├── skill-loader.ts      #   SKILL.md → system prompt injection
│   │       ├── tool-schema.ts       #   tools/*.yaml → Zod validation schemas
│   │       ├── compliance.ts        #   compliance section → LangSmith metadata
│   │       └── types.ts             #   AgentManifest, ToolDefinition, etc.
│   │
│   ├── agent/                       # LangGraph orchestration (from ES agent)
│   │   ├── package.json             #   @devops-agent/agent
│   │   └── src/
│   │       ├── index.ts
│   │       ├── graph.ts             #   StateGraph: classify→route→fan-out→aggregate
│   │       ├── supervisor.ts        #   Routes to sub-agents based on incident type
│   │       ├── sub-agent.ts         #   Per-datasource query (reuse ES agent pattern)
│   │       ├── aggregator.ts        #   Correlates findings across data sources
│   │       ├── state.ts             #   AgentState annotation
│   │       ├── classifier.ts        #   Simple vs complex query classification
│   │       ├── responder.ts         #   Direct response for simple queries
│   │       ├── entity-extractor.ts  #   Extract incident entities (services, timeframes)
│   │       ├── llm.ts               #   LLM factory with per-role model selection
│   │       ├── model-config.ts      #   Role→model mapping (driven by agent.yaml)
│   │       ├── mcp-bridge.ts        #   MCP client setup per data source
│   │       ├── prompt-context.ts    #   System prompts (loaded from SOUL.md + SKILL.md)
│   │       ├── alignment.ts         #   Cross-datasource gap detection
│   │       ├── validator.ts         #   Anti-hallucination validation
│   │       └── tool-retry.ts        #   Retry with backoff for MCP calls
│   │
│   ├── mcp-server/                  # Multi-datasource MCP server
│   │   ├── package.json             #   @devops-agent/mcp-server
│   │   └── src/
│   │       ├── index.ts             #   MCP server entrypoint
│   │       ├── tools/
│   │       │   ├── elastic/         #   Elastic tools (log search, traces)
│   │       │   ├── kafka/           #   Kafka tools (topics, lag, DLQ)
│   │       │   └── couchbase/       #   Couchbase tools (health, stats, queries)
│   │       ├── clients/             #   Client pool per datasource
│   │       └── credentials/         #   getDataSource() from Bun.env
│   │
│   ├── shared/                      # Shared types across packages
│   │   ├── package.json             #   @devops-agent/shared
│   │   └── src/
│   │       ├── types.ts             #   DataSourceResult, ToolOutput, etc.
│   │       └── schemas.ts           #   Zod schemas
│   │
│   ├── checkpointer/                # Swappable persistence (from ES agent)
│   │   ├── package.json             #   @devops-agent/checkpointer
│   │   └── src/
│   │       ├── index.ts
│   │       ├── memory.ts            #   MemorySaver (day 1)
│   │       └── bun-sqlite.ts        #   Custom bun:sqlite (week 2+)
│   │
│   └── observability/               # Structured logging (from ES agent)
│       ├── package.json             #   @devops-agent/observability
│       └── src/
│           └── index.ts             #   getChildLogger, pino setup
│
├── apps/
│   ├── server/                      # Bun HTTP server
│   │   ├── package.json             #   @devops-agent/server
│   │   └── src/
│   │       ├── index.ts             #   Bun.serve() + SSE + webhook endpoints
│   │       └── routes/
│   │           ├── stream.ts        #   POST /api/agent/stream (SSE)
│   │           ├── webhook.ts       #   POST /api/incident/analyze (PagerDuty/Slack)
│   │           └── health.ts        #   GET /health
│   │
│   └── web/                         # Svelte 5 frontend
│       ├── package.json
│       ├── svelte.config.js
│       └── src/routes/
│           ├── +page.svelte         #   Chat UI / incident panel
│           └── api/agent/stream/
│               └── +server.ts       #   Proxy to apps/server
│
└── k8s/                             # Kubernetes deployment
    ├── deployment.yaml
    ├── rbac.yaml
    └── secrets.example.yaml
```

---

## Step-by-step setup instructions

### Phase 1: Scaffold the monorepo

```bash
# 1. Create repo and init Bun workspace
mkdir devops-incident-analyzer && cd devops-incident-analyzer
bun init -y

# 2. Configure workspace root package.json
cat > package.json << 'EOF'
{
  "name": "devops-incident-analyzer",
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "dev": "bun run --filter '*' dev",
    "test": "bun run --filter '*' test",
    "typecheck": "bun run --filter '*' typecheck",
    "lint": "biome check .",
    "lint:fix": "biome check --write ."
  },
  "catalogs": {
    "default": {
      "@langchain/langgraph": "^0.2.0",
      "@langchain/langgraph-checkpoint": "^0.0.13",
      "@langchain/mcp-adapters": "^0.1.0",
      "@langchain/aws": "^0.1.0",
      "@langchain/core": "^0.3.0",
      "zod": "^3.23.0",
      "yaml": "^2.6.0",
      "pino": "^9.0.0"
    },
    "dev": {
      "@biomejs/biome": "^1.9.0",
      "@types/bun": "latest",
      "bun-types": "latest",
      "typescript": "^5.7.0"
    }
  }
}
EOF

# 3. Create tsconfig.base.json (reuse from ES agent)
cat > tsconfig.base.json << 'EOF'
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "composite": true
  }
}
EOF

# 4. Create bunfig.toml
cat > bunfig.toml << 'EOF'
[install]
peer = false
EOF

# 5. Create biome.json
cat > biome.json << 'EOF'
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "formatter": { "enabled": true, "indentWidth": 2, "lineWidth": 120 }
}
EOF
```

### Phase 2: Create the gitagent agent definitions

This is the declarative layer — no TypeScript, pure YAML/Markdown. Changes here are reviewable in PRs by non-engineers.

```bash
# 1. Create the agent definition directories
mkdir -p agents/incident-analyzer/{tools,skills,workflows,knowledge/runbooks,knowledge/systems-map,knowledge/slo-policies,compliance,agents/{logs-agent,events-agent,datastore-agent}}
mkdir -p agents/shared/skills
```

**agents/incident-analyzer/agent.yaml:**
```yaml
spec_version: "0.1.0"
name: incident-analyzer
version: 0.1.0
description: >
  DevOps incident analysis orchestrator that correlates logs, events,
  and datastore health to help humans triage incidents safely.

model:
  preferred: claude-sonnet-4-6
  fallback:
    - claude-haiku-4-5
  constraints:
    temperature: 0.2
    max_tokens: 4096

runtime:
  max_turns: 50
  timeout: 300

skills:
  - normalize-incident
  - aggregate-findings
  - propose-mitigation

tools:
  - elastic-logs
  - kafka-introspect
  - couchbase-health
  - notify-slack
  - create-ticket

agents:
  logs-agent:
    delegation: auto
  events-agent:
    delegation: auto
  datastore-agent:
    delegation: auto

delegation:
  mode: router    # Supervisor decides which sub-agents to invoke

compliance:
  risk_tier: medium
  supervision:
    human_in_the_loop: conditional
    escalation_triggers:
      - action_type: mutate_production
      - confidence_below: 0.6
      - error_detected: true
    kill_switch: true
  recordkeeping:
    audit_logging: true
    log_format: structured_json
    retention_period: 1y
    log_contents:
      - prompts_and_responses
      - tool_calls
      - decision_pathways
      - model_version
      - timestamps
    immutable: true
  data_governance:
    pii_handling: redact
    data_classification: internal

tags:
  - devops
  - incident-analysis
  - observability
```

**agents/incident-analyzer/SOUL.md:**
```markdown
# Soul

## Core Identity
I am a DevOps incident analysis orchestrator. I coordinate specialist
sub-agents to gather evidence from Elastic logs, Kafka event streams,
and Couchbase datastores, then correlate findings into actionable
incident reports.

## Communication Style
Structured and evidence-driven. I present findings with specific
data points, timestamps, and metric values. I use tables for
cross-datasource comparisons. I never speculate without data.

## Values & Principles
- Evidence over assumptions: every claim backed by tool output
- Read-only analysis: I observe, I never mutate production systems
- Transparency in reasoning: I show my work and cite data sources
- Escalation over guessing: I flag uncertainty for human review

## Domain Expertise
- Kubernetes workload troubleshooting
- Elastic/ELK log analysis patterns
- Kafka consumer lag and dead-letter queue diagnosis
- Couchbase cluster health and performance analysis
- Incident correlation and root cause analysis

## Collaboration Style
I delegate specialist queries to sub-agents, aggregate their findings,
and synthesize a unified incident report. I ask clarifying questions
when the incident scope is ambiguous.
```

**agents/incident-analyzer/RULES.md:**
```markdown
# Rules

## Must Always
- Base every conclusion on data from tool outputs
- Include timestamps and metric values in reports
- Cite which data source (Elastic/Kafka/Couchbase) each finding came from
- Escalate when confidence is below 0.6
- Report tool failures transparently

## Must Never
- Write to any production system (database, Kafka, Kubernetes)
- Fabricate data or metrics not present in tool outputs
- Skip a sub-agent query when the workflow calls for it
- Provide remediation steps that involve destructive operations
- Access data outside the incident time window without explicit request

## Output Constraints
- Use markdown tables for multi-datasource comparisons
- Format timestamps in ISO 8601
- No emojis in output
- Keep table cells as plain text (no bold/italic formatting)
```

**agents/incident-analyzer/agents/logs-agent/agent.yaml:**
```yaml
spec_version: "0.1.0"
name: logs-agent
version: 0.1.0
description: Read-only Elastic log analysis specialist.

model:
  preferred: claude-haiku-4-5
  constraints:
    temperature: 0.1
    max_tokens: 2048

tools:
  - elastic-logs

compliance:
  risk_tier: low
  data_governance:
    pii_handling: redact
```

**agents/incident-analyzer/tools/elastic-logs.yaml:**
```yaml
name: elastic-search-logs
description: >
  Search Elasticsearch logs within a time window for a specific service.
  Returns matching log entries with timestamps, levels, and messages.
version: 1.0.0
input_schema:
  type: object
  properties:
    service_name:
      type: string
      description: Service name to filter logs by
    time_from:
      type: string
      format: date-time
      description: Start of time window (ISO 8601)
    time_to:
      type: string
      format: date-time
      description: End of time window (ISO 8601)
    level:
      type: string
      enum: [error, warn, info, debug]
      description: Minimum log level
    query:
      type: string
      description: Free-text search query
    max_results:
      type: integer
      default: 100
      description: Maximum number of log entries to return
  required: [service_name, time_from, time_to]
output_schema:
  type: object
  properties:
    logs:
      type: array
      items:
        type: object
        properties:
          timestamp: { type: string }
          level: { type: string }
          message: { type: string }
          service: { type: string }
    total_hits: { type: integer }
annotations:
  requires_confirmation: false
  read_only: true
  cost: low

# Dynamic prompt template — {{variables}} are resolved at runtime
# by the gitagent-bridge using agent context (available datasources,
# active skills, compliance tier, etc.)
prompt_template: >
  Search Elasticsearch logs within a time window for a specific service.
  Returns matching log entries with timestamps, levels, and messages.
  {{#if datasources}}Available data sources: {{datasources}}.{{/if}}
  {{#if compliance_tier}}Compliance tier: {{compliance_tier}} — all queries are logged.{{/if}}

# Workflow chaining hints — included in MCP tool responses for
# standalone/Claude Desktop use. Inside LangGraph, the graph topology
# handles sequencing, so these are informational only.
related_tools:
  - "Use kafka-consumer-lag to check if log spikes correlate with Kafka backpressure"
  - "Use couchbase-cluster-health to verify database health during the same time window"
  - "Use aggregate-findings skill to correlate logs with events and datastore metrics"
```

Create similar YAML files for `kafka-introspect.yaml` and `couchbase-health.yaml` following the same pattern, defining each tool's `input_schema` and `output_schema` to match your MCP server's actual tool interface.

### Phase 3: Build the gitagent-bridge package

This is the thin adapter (~500-800 lines) that reads gitagent definitions and produces LangGraph configuration objects. Start with the highest-ROI piece: `agent.yaml` → model config.

```bash
mkdir -p packages/gitagent-bridge/src
```

**packages/gitagent-bridge/package.json:**
```json
{
  "name": "@devops-agent/gitagent-bridge",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit"
  },
  "dependencies": {
    "yaml": "catalog:",
    "zod": "catalog:",
    "glob": "^11.0.0"
  },
  "devDependencies": {
    "@types/bun": "catalog:dev",
    "bun-types": "catalog:dev",
    "typescript": "catalog:dev"
  },
  "private": true
}
```

**packages/gitagent-bridge/src/types.ts:**
```typescript
// Typed representation of agent.yaml fields
import { z } from "zod";

export const ModelConfigSchema = z.object({
  preferred: z.string(),
  fallback: z.array(z.string()).optional(),
  constraints: z.object({
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().positive().optional(),
  }).optional(),
});

export const ComplianceSchema = z.object({
  risk_tier: z.enum(["low", "standard", "medium", "high", "critical"]),
  supervision: z.object({
    human_in_the_loop: z.enum(["always", "conditional", "advisory", "none"]).optional(),
    escalation_triggers: z.array(z.record(z.unknown())).optional(),
    kill_switch: z.boolean().optional(),
  }).optional(),
  recordkeeping: z.object({
    audit_logging: z.boolean().optional(),
    log_format: z.string().optional(),
    retention_period: z.string().optional(),
    log_contents: z.array(z.string()).optional(),
    immutable: z.boolean().optional(),
  }).optional(),
  data_governance: z.object({
    pii_handling: z.enum(["redact", "encrypt", "prohibit", "allow"]).optional(),
    data_classification: z.string().optional(),
  }).optional(),
});

export const RuntimeConfigSchema = z.object({
  max_turns: z.number().positive().optional(),
  timeout: z.number().positive().optional(),
});

export const SubAgentRefSchema = z.object({
  delegation: z.enum(["auto", "explicit", "router"]).optional(),
});

export const AgentManifestSchema = z.object({
  spec_version: z.string().optional(),
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string(),
  description: z.string(),
  model: ModelConfigSchema.optional(),
  runtime: RuntimeConfigSchema.optional(),
  skills: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  agents: z.record(SubAgentRefSchema).optional(),
  delegation: z.object({
    mode: z.enum(["auto", "explicit", "router"]),
    router: z.string().optional(),
  }).optional(),
  compliance: ComplianceSchema.optional(),
  tags: z.array(z.string()).optional(),
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ComplianceConfig = z.infer<typeof ComplianceSchema>;

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().optional(),
  input_schema: z.record(z.unknown()),
  output_schema: z.record(z.unknown()).optional(),
  annotations: z.object({
    requires_confirmation: z.boolean().optional(),
    read_only: z.boolean().optional(),
    cost: z.enum(["low", "medium", "high"]).optional(),
  }).optional(),
  // Dynamic prompt support (inspired by Kong Konnect MCP pattern)
  prompt_template: z.string().optional(),  // Template with {{variable}} placeholders
  related_tools: z.array(z.string()).optional(),  // Suggested next tools for workflow chaining
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
```

**packages/gitagent-bridge/src/manifest-loader.ts:**
```typescript
import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
import { join } from "path";
import {
  AgentManifestSchema,
  ToolDefinitionSchema,
  type AgentManifest,
  type ToolDefinition,
} from "./types.ts";

export interface LoadedAgent {
  manifest: AgentManifest;
  soul: string;
  rules: string;
  tools: ToolDefinition[];
  skills: Map<string, string>;     // skill name → SKILL.md content
  subAgents: Map<string, LoadedAgent>;
}

export function loadAgent(agentDir: string): LoadedAgent {
  // Load and validate agent.yaml
  const yamlContent = readFileSync(join(agentDir, "agent.yaml"), "utf-8");
  const rawManifest = parse(yamlContent);
  const manifest = AgentManifestSchema.parse(rawManifest);

  // Load identity files
  const soul = loadOptionalFile(join(agentDir, "SOUL.md"));
  const rules = loadOptionalFile(join(agentDir, "RULES.md"));

  // Load tool definitions
  const tools: ToolDefinition[] = [];
  const toolsDir = join(agentDir, "tools");
  if (existsSync(toolsDir)) {
    const toolFiles = Bun.glob("*.yaml").scanSync(toolsDir);
    for (const file of toolFiles) {
      const toolYaml = parse(readFileSync(join(toolsDir, file), "utf-8"));
      tools.push(ToolDefinitionSchema.parse(toolYaml));
    }
  }

  // Load skills (SKILL.md content for system prompt injection)
  const skills = new Map<string, string>();
  const skillsDir = join(agentDir, "skills");
  if (existsSync(skillsDir)) {
    for (const skillName of manifest.skills ?? []) {
      const skillPath = join(skillsDir, skillName, "SKILL.md");
      if (existsSync(skillPath)) {
        skills.set(skillName, readFileSync(skillPath, "utf-8"));
      }
    }
  }

  // Recursively load sub-agents
  const subAgents = new Map<string, LoadedAgent>();
  const agentsDir = join(agentDir, "agents");
  if (existsSync(agentsDir) && manifest.agents) {
    for (const subAgentName of Object.keys(manifest.agents)) {
      const subAgentDir = join(agentsDir, subAgentName);
      if (existsSync(join(subAgentDir, "agent.yaml"))) {
        subAgents.set(subAgentName, loadAgent(subAgentDir));
      }
    }
  }

  return { manifest, soul, rules, tools, skills, subAgents };
}

function loadOptionalFile(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}
```

**packages/gitagent-bridge/src/model-factory.ts:**
```typescript
import type { ModelConfig } from "./types.ts";

// Map gitagent model names → AWS Bedrock model IDs
const MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4-6":      "eu.anthropic.claude-sonnet-4-6",
  "claude-haiku-4-5":       "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-opus-4-6":        "eu.anthropic.claude-opus-4-6",
  // Add more as needed
};

export interface BedrockModelConfig {
  model: string;
  region: string;
  temperature: number;
  maxTokens: number;
}

export function resolveBedrockConfig(
  modelConfig: ModelConfig | undefined,
  defaults: { temperature?: number; maxTokens?: number } = {},
): BedrockModelConfig {
  const preferred = modelConfig?.preferred ?? "claude-sonnet-4-6";
  const bedrockId = MODEL_MAP[preferred];
  if (!bedrockId) {
    throw new Error(
      `Unknown model "${preferred}". Available: ${Object.keys(MODEL_MAP).join(", ")}`
    );
  }

  return {
    model: bedrockId,
    region: Bun.env.AWS_REGION ?? "eu-west-1",
    temperature: modelConfig?.constraints?.temperature ?? defaults.temperature ?? 0,
    maxTokens: modelConfig?.constraints?.max_tokens ?? defaults.maxTokens ?? 4096,
  };
}

export function getRecursionLimit(maxTurns?: number): number {
  return (maxTurns ?? 25) * 2; // Account for agent→tool round trips
}
```

**packages/gitagent-bridge/src/skill-loader.ts:**
```typescript
import type { LoadedAgent } from "./manifest-loader.ts";

/**
 * Build a system prompt by combining SOUL.md, RULES.md, and active SKILL.md files.
 * Skills are injected as sections in the system prompt when the agent needs them.
 */
export function buildSystemPrompt(agent: LoadedAgent, activeSkills?: string[]): string {
  const sections: string[] = [];

  // Core identity from SOUL.md
  if (agent.soul) {
    sections.push(agent.soul.trim());
  }

  // Hard constraints from RULES.md
  if (agent.rules) {
    sections.push(agent.rules.trim());
  }

  // Inject active skills as knowledge sections
  const skillsToLoad = activeSkills ?? [...agent.skills.keys()];
  for (const skillName of skillsToLoad) {
    const content = agent.skills.get(skillName);
    if (content) {
      // Strip YAML frontmatter from SKILL.md
      const bodyOnly = content.replace(/^---[\s\S]*?---\s*/m, "").trim();
      if (bodyOnly) {
        sections.push(`## Skill: ${skillName}\n\n${bodyOnly}`);
      }
    }
  }

  return sections.join("\n\n---\n\n");
}
```

**packages/gitagent-bridge/src/compliance.ts:**
```typescript
import type { ComplianceConfig } from "./types.ts";

/**
 * Convert gitagent compliance config to LangSmith trace metadata.
 * These tags are attached to every LangSmith trace for audit/compliance.
 */
export function complianceToMetadata(compliance?: ComplianceConfig): Record<string, string> {
  if (!compliance) return {};

  const metadata: Record<string, string> = {
    compliance_risk_tier: compliance.risk_tier,
  };

  if (compliance.recordkeeping?.audit_logging) {
    metadata.compliance_audit_logging = "true";
  }
  if (compliance.recordkeeping?.retention_period) {
    metadata.compliance_retention_period = compliance.recordkeeping.retention_period;
  }
  if (compliance.recordkeeping?.immutable) {
    metadata.compliance_immutable_logs = "true";
  }
  if (compliance.supervision?.human_in_the_loop) {
    metadata.compliance_hitl = compliance.supervision.human_in_the_loop;
  }
  if (compliance.data_governance?.pii_handling) {
    metadata.compliance_pii_handling = compliance.data_governance.pii_handling;
  }
  if (compliance.data_governance?.data_classification) {
    metadata.compliance_data_classification = compliance.data_governance.data_classification;
  }

  return metadata;
}

/**
 * Determine if a tool call requires human approval based on compliance config.
 */
export function requiresApproval(
  toolName: string,
  compliance?: ComplianceConfig,
): boolean {
  if (!compliance?.supervision) return false;
  if (compliance.supervision.human_in_the_loop === "always") return true;
  if (compliance.supervision.human_in_the_loop === "none") return false;

  // Check escalation triggers for action_type matches
  const triggers = compliance.supervision.escalation_triggers ?? [];
  return triggers.some(
    (t) => "action_type" in t && toolName.includes(String(t.action_type))
  );
}
```

**packages/gitagent-bridge/src/tool-schema.ts:**
```typescript
import type { ToolDefinition } from "./types.ts";

/**
 * Validate that MCP server tools/list output matches gitagent tool YAML definitions.
 * Run at startup or in CI to catch schema drift.
 */
export function validateToolSchemas(
  gitagentTools: ToolDefinition[],
  mcpToolNames: string[],
): { valid: boolean; missing: string[]; extra: string[] } {
  const expectedNames = new Set(gitagentTools.map((t) => t.name));
  const actualNames = new Set(mcpToolNames);

  const missing = [...expectedNames].filter((n) => !actualNames.has(n));
  const extra = [...actualNames].filter((n) => !expectedNames.has(n));

  return {
    valid: missing.length === 0,
    missing,
    extra,
  };
}
```

**packages/gitagent-bridge/src/tool-prompt.ts:**
```typescript
import type { LoadedAgent } from "./manifest-loader.ts";
import type { ToolDefinition, ComplianceConfig } from "./types.ts";

/**
 * Runtime context injected into dynamic tool prompts.
 * Populated at startup from agent.yaml, environment, and MCP server discovery.
 */
export interface ToolPromptContext {
  datasources?: string[];          // Available MCP data sources
  complianceTier?: string;         // From agent.yaml compliance.risk_tier
  activeSkills?: string[];         // Currently loaded skills
  agentRole?: string;              // "orchestrator" | "specialist"
  customVariables?: Record<string, string>;  // Extensible
}

/**
 * Build a dynamic MCP tool description from a gitagent tools/*.yaml definition.
 *
 * Pattern inspired by Kong Konnect MCP server's "dynamic prompt architecture"
 * where tool descriptions are functions, not static strings. Here, the YAML
 * `prompt_template` field acts as the template, and runtime context fills the
 * variables. Falls back to the static `description` field when no template exists.
 *
 * Usage in MCP server tool registration:
 *   server.tool(
 *     toolDef.name,
 *     buildToolPrompt(toolDef, context),  // Dynamic, not static
 *     schema,
 *     handler
 *   );
 */
export function buildToolPrompt(
  toolDef: ToolDefinition,
  context: ToolPromptContext = {},
): string {
  const template = toolDef.prompt_template;
  if (!template) return toolDef.description;

  let resolved = template;

  // Resolve {{datasources}} — comma-separated list of available data sources
  if (context.datasources?.length) {
    resolved = resolved.replace(
      /\{\{#if datasources\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_, inner) => inner.replace(/\{\{datasources\}\}/g, context.datasources!.join(", "))
    );
  } else {
    resolved = resolved.replace(/\{\{#if datasources\}\}[\s\S]*?\{\{\/if\}\}/g, "");
  }

  // Resolve {{compliance_tier}} — from agent.yaml compliance.risk_tier
  if (context.complianceTier) {
    resolved = resolved.replace(
      /\{\{#if compliance_tier\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_, inner) => inner.replace(/\{\{compliance_tier\}\}/g, context.complianceTier!)
    );
  } else {
    resolved = resolved.replace(/\{\{#if compliance_tier\}\}[\s\S]*?\{\{\/if\}\}/g, "");
  }

  // Resolve {{active_skills}}
  if (context.activeSkills?.length) {
    resolved = resolved.replace(
      /\{\{#if active_skills\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_, inner) => inner.replace(/\{\{active_skills\}\}/g, context.activeSkills!.join(", "))
    );
  } else {
    resolved = resolved.replace(/\{\{#if active_skills\}\}[\s\S]*?\{\{\/if\}\}/g, "");
  }

  // Resolve any remaining {{custom}} variables
  for (const [key, value] of Object.entries(context.customVariables ?? {})) {
    resolved = resolved.replaceAll(`{{${key}}}`, value);
  }

  // Clean up: collapse multiple spaces/newlines from removed conditionals
  return resolved.replace(/\n{3,}/g, "\n\n").replace(/  +/g, " ").trim();
}

/**
 * Build runtime ToolPromptContext from a loaded gitagent agent definition.
 * Called once at startup, cached for the lifetime of the MCP server process.
 */
export function buildContextFromAgent(agent: LoadedAgent): ToolPromptContext {
  return {
    datasources: agent.tools.map((t) => t.name),
    complianceTier: agent.manifest.compliance?.risk_tier,
    activeSkills: [...agent.skills.keys()],
    agentRole: agent.manifest.delegation?.mode ?? "auto",
  };
}

/**
 * Build all dynamic tool descriptions for an agent's tools.
 * Returns a Map<toolName, resolvedDescription> for use in MCP server registration.
 */
export function buildAllToolPrompts(
  agent: LoadedAgent,
  contextOverrides: Partial<ToolPromptContext> = {},
): Map<string, string> {
  const context = { ...buildContextFromAgent(agent), ...contextOverrides };
  const prompts = new Map<string, string>();

  for (const tool of agent.tools) {
    prompts.set(tool.name, buildToolPrompt(tool, context));
  }

  return prompts;
}
```

**packages/gitagent-bridge/src/related-tools.ts:**
```typescript
import type { ToolDefinition } from "./types.ts";
import type { LoadedAgent } from "./manifest-loader.ts";

/**
 * Extract relatedTools hints for a tool from its gitagent YAML definition.
 *
 * Pattern: Kong Konnect MCP server appends `relatedTools` arrays to every
 * tool response, guiding the LLM to the next logical action. In a LangGraph
 * agent this is redundant (the graph handles sequencing), but it's valuable
 * for two scenarios:
 *
 * 1. **Standalone MCP use** — When the MCP server is used directly with
 *    Claude Desktop or other MCP clients (no LangGraph orchestration).
 *    The hints guide Claude to the next tool call.
 *
 * 2. **Frontend UX** — The Svelte UI can render relatedTools as clickable
 *    "suggested next actions" buttons in the incident panel.
 */
export function getRelatedTools(toolDef: ToolDefinition): string[] {
  return toolDef.related_tools ?? [];
}

/**
 * Build a relatedTools map for all tools in an agent.
 * Used by the MCP server to append hints to every tool response.
 */
export function buildRelatedToolsMap(agent: LoadedAgent): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const tool of agent.tools) {
    const related = getRelatedTools(tool);
    if (related.length > 0) {
      map.set(tool.name, related);
    }
  }
  return map;
}

/**
 * Wrap an MCP tool response with relatedTools hints from gitagent YAML.
 * Drop-in decorator for MCP server operation functions.
 *
 * Usage:
 *   const result = await searchLogs(client, params);
 *   return withRelatedTools(result, "elastic-search-logs", relatedToolsMap);
 */
export function withRelatedTools<T extends Record<string, unknown>>(
  response: T,
  toolName: string,
  relatedToolsMap: Map<string, string[]>,
): T & { relatedTools?: string[] } {
  const related = relatedToolsMap.get(toolName);
  if (!related || related.length === 0) return response;
  return { ...response, relatedTools: related };
}
```

**packages/gitagent-bridge/src/index.ts:**
```typescript
export { loadAgent, type LoadedAgent } from "./manifest-loader.ts";
export { resolveBedrockConfig, getRecursionLimit, type BedrockModelConfig } from "./model-factory.ts";
export { buildSystemPrompt } from "./skill-loader.ts";
export { buildToolPrompt, buildAllToolPrompts, buildContextFromAgent, type ToolPromptContext } from "./tool-prompt.ts";
export { getRelatedTools, buildRelatedToolsMap, withRelatedTools } from "./related-tools.ts";
export { complianceToMetadata, requiresApproval } from "./compliance.ts";
export { validateToolSchemas } from "./tool-schema.ts";
export {
  AgentManifestSchema,
  ToolDefinitionSchema,
  type AgentManifest,
  type ToolDefinition,
  type ComplianceConfig,
} from "./types.ts";
```

### Phase 4: Adapt the agent package from the ES agent

Copy the `packages/agent/` structure from your ES agent. The key changes:

1. **`model-config.ts`** — Instead of hardcoded model IDs, load from `agent.yaml` via the bridge:

```typescript
// packages/agent/src/model-config.ts
import { loadAgent, resolveBedrockConfig } from "@devops-agent/gitagent-bridge";
import { join } from "path";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");
const rootAgent = loadAgent(AGENTS_DIR);

// Derive model profiles from agent.yaml instead of hardcoding
export const MODEL_IDS = {
  sonnet: resolveBedrockConfig(rootAgent.manifest.model).model,
  haiku: resolveBedrockConfig(
    rootAgent.subAgents.get("logs-agent")?.manifest.model
  ).model,
} as const;
```

2. **`prompt-context.ts`** — Load from SOUL.md + SKILL.md instead of inline strings:

```typescript
import { loadAgent, buildSystemPrompt } from "@devops-agent/gitagent-bridge";

const rootAgent = loadAgent(AGENTS_DIR);

export function buildSubAgentPrompt(agentName: string): string {
  const subAgent = rootAgent.subAgents.get(agentName);
  if (!subAgent) return buildSystemPrompt(rootAgent); // fallback to root
  return buildSystemPrompt(subAgent);
}
```

3. **`graph.ts`** — The graph structure stays identical to your ES agent. Replace "deployment" terminology with "data source" terminology, but the fan-out/aggregate pattern is the same.

4. **`supervisor.ts`** — Instead of routing to Elasticsearch deployments, route to data source sub-agents (logs, events, datastore). The `Send` API fan-out pattern is identical.

### Phase 5: Create the MCP server for multiple data sources

Your ES agent uses a single multi-tenant MCP server with a `deployment` parameter. The DevOps agent follows the same pattern but with a `datasource` parameter — and now wires in dynamic prompts and relatedTools from the gitagent-bridge.

**MCP server with dynamic prompts (single multi-datasource server):**

```typescript
// packages/mcp-server/src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  loadAgent,
  buildAllToolPrompts,
  buildRelatedToolsMap,
  withRelatedTools,
} from "@devops-agent/gitagent-bridge";
import { join } from "path";
import { z } from "zod";

// Load gitagent definitions at startup — cached for process lifetime
const agentDir = join(import.meta.dir, "../../../agents/incident-analyzer");
const agent = loadAgent(agentDir);

// Build dynamic prompts from tools/*.yaml prompt_template fields
const toolPrompts = buildAllToolPrompts(agent, {
  datasources: ["elastic", "kafka", "couchbase"],
});

// Build relatedTools map for response enrichment
const relatedToolsMap = buildRelatedToolsMap(agent);

const server = new McpServer({ name: "devops-incident-mcp", version: "0.1.0" });

// Tool registration uses dynamic prompt instead of static string
server.tool(
  "search_logs",
  toolPrompts.get("elastic-search-logs") ?? "Search Elasticsearch logs",
  {
    datasource: z.enum(["elastic"]).describe("Target data source"),
    service_name: z.string(),
    time_from: z.string(),
    time_to: z.string(),
  },
  async ({ datasource, ...params }) => {
    const client = clientPool.get(datasource);
    const result = await client.searchLogs(params);

    // Append relatedTools hints to response (for standalone MCP use)
    return withRelatedTools(result, "elastic-search-logs", relatedToolsMap);
  }
);
```

**Alternative: separate existing MCP servers** (as described in your docx), use `MultiServerMCPClient` to connect to all three:

```typescript
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

const mcpClient = new MultiServerMCPClient({
  "elastic-mcp": {
    transport: "sse",
    url: Bun.env.ELASTIC_MCP_URL + "/sse",
  },
  "kafka-mcp": {
    transport: "sse",
    url: Bun.env.KAFKA_MCP_URL + "/sse",
  },
  "couchbase-mcp": {
    transport: "sse",
    url: Bun.env.COUCHBASE_MCP_URL + "/sse",
  },
});
```

Note: when using separate existing MCP servers via `MultiServerMCPClient`, the dynamic prompts and relatedTools apply to your own MCP server only. The third-party servers (Elastic, Kafka, Couchbase MCP) have their own tool descriptions. You can still wrap their responses with `withRelatedTools()` in your LangGraph sub-agent layer if you want frontend hints.

### Phase 6: Wire up the existing patterns

These packages copy almost verbatim from your ES agent with minimal renaming:

- **`packages/shared/`** — Change `DeploymentResult` → `DataSourceResult`, `deploymentId` → `dataSourceId`
- **`packages/checkpointer/`** — Copy as-is (MemorySaver → bun:sqlite → Redis/Valkey)
- **`packages/observability/`** — Copy as-is (pino structured logging)
- **`apps/server/`** — Add a `/api/incident/analyze` webhook endpoint alongside the SSE stream endpoint
- **`apps/web/`** — Adapt the Svelte 5 chat UI; add an incident panel view alongside the chat

### Phase 7: CI validation

Add a CI step that validates gitagent definitions and checks tool schema alignment:

```yaml
# .gitlab-ci.yml (or .github/workflows/validate.yml)
validate-agent-definitions:
  script:
    - bun run packages/gitagent-bridge/scripts/validate.ts
```

```typescript
// packages/gitagent-bridge/scripts/validate.ts
import { loadAgent, validateToolSchemas } from "@devops-agent/gitagent-bridge";

const agent = loadAgent("agents/incident-analyzer");

// Validate all manifests parse correctly
console.log(`✓ Loaded agent: ${agent.manifest.name} v${agent.manifest.version}`);
console.log(`  Tools: ${agent.tools.length}`);
console.log(`  Skills: ${agent.skills.size}`);
console.log(`  Sub-agents: ${agent.subAgents.size}`);

for (const [name, sub] of agent.subAgents) {
  console.log(`  ✓ Sub-agent: ${name} (${sub.manifest.model?.preferred})`);
}
```

---

## What carries over from the ES agent (copy/adapt)

| ES Agent Component | DevOps Agent Equivalent | Changes |
|---|---|---|
| `state.ts` (AgentState) | Same pattern | Replace `deploymentResults` → `dataSourceResults`, `currentDeployment` → `currentDataSource` |
| `graph.ts` (StateGraph) | Same structure | Same node flow: classify → entityExtract → supervisor → fan-out → align → aggregate → validate |
| `supervisor.ts` (Send fan-out) | Same pattern | Route to `logs-agent`, `events-agent`, `datastore-agent` instead of ES deployments |
| `sub-agent.ts` (createReactAgent) | Same pattern | Each sub-agent gets MCP tools scoped to its data source |
| `aggregator.ts` (structured tables) | Same pattern | Extract metrics from Elastic/Kafka/Couchbase tool outputs instead of ES cluster metrics |
| `alignment.ts` (gap detection) | Same pattern | Detect when one data source returned data others didn't |
| `validator.ts` (anti-hallucination) | Same pattern | Adapt validation rules for DevOps-specific metrics |
| `classifier.ts` | Same pattern | Update patterns for incident-related queries |
| `tool-retry.ts` | Copy verbatim | Retry with backoff works for any MCP tool |
| `mcp-bridge.ts` | Adapt for multi-server | Use `MultiServerMCPClient` for 3 separate MCP servers |
| `llm.ts` + `model-config.ts` | Drive from agent.yaml | Load model config via gitagent-bridge instead of hardcoding |

---

## What's new (gitagent-specific additions)

| Component | Purpose | Effort |
|---|---|---|
| `packages/gitagent-bridge/` | YAML→LangGraph adapter | ~600-900 LOC, week 1 |
| `agents/` directory tree | Declarative agent definitions | Day 1 setup, ongoing PR-reviewed changes |
| `tools/*.yaml` schema files | MCP tool contract + prompt templates + relatedTools | Day 1, maintained alongside MCP server |
| `tool-prompt.ts` | Dynamic MCP tool descriptions from YAML templates | Week 1, ~100 LOC |
| `related-tools.ts` | Workflow chaining hints for standalone MCP + frontend UX | Week 1, ~60 LOC |
| `skills/*/SKILL.md` | Procedural knowledge (prompt injection) | Ongoing, reviewed by domain experts |
| SOUL.md + RULES.md | Agent identity/constraints | Day 1, rarely changes |
| CI validation step | Schema drift detection | Day 1, trivial |
| Compliance metadata | LangSmith trace tags from agent.yaml | Day 1, 50 LOC |

---

## Recommended build order

```
Week 1:
├── Scaffold monorepo + workspace config
├── Create agents/ directory with agent.yaml + SOUL.md + RULES.md
├── Build gitagent-bridge (manifest-loader + model-factory + skill-loader)
├── Build tool-prompt.ts (dynamic prompt templates) + related-tools.ts
├── Copy packages/checkpointer + packages/observability from ES agent
└── Verify: bun test passes on bridge package

Week 2:
├── Copy packages/agent from ES agent, adapt terminology
├── Wire model-config.ts to load from agent.yaml via bridge
├── Wire prompt-context.ts to load from SOUL.md + SKILL.md
├── Connect to your existing MCP servers (Elastic, Kafka, Couchbase)
└── Verify: agent graph compiles and can classify queries

Week 3:
├── Build apps/server with SSE + webhook endpoints
├── Wire dynamic prompts (buildAllToolPrompts) into MCP server tool registration
├── Wire relatedTools (withRelatedTools) into MCP tool responses
├── Add CI validation for agent definitions
├── Write tool YAML schemas + prompt_templates + related_tools for all MCP tools
├── Build compliance metadata injection
└── Verify: end-to-end incident triage works locally

Week 4:
├── Adapt apps/web from ES agent's Svelte frontend
├── Add incident-specific UI components
├── Dockerize and deploy to K8s
├── LangSmith tracing with compliance metadata
└── Verify: production-ready with observability
```
