# Agent Concepts

> **Audience:** engineers working in this repo. **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x

This is the concept map for the agent architecture. It defines the seven core ideas the agents are built from, says where each one lives in code, and links to the authoritative deep-dive doc where one exists. Four of the seven are explained in full here (they have no standalone doc); three point to their dedicated doc. A related, optional capability — the **Knowledge Graph** — is wired in through the lifecycle's `warm_knowledge_graph` step (§6) and has its own deep-dive ([knowledge-graph.md](knowledge-graph.md)); it is listed in the table below for discoverability.

The repo implements the **gitagent.sh (Open GAP) memory + agent standard**: agents are declarative definitions (`agents/`) compiled by the bridge (`packages/gitagent-bridge/`) into a LangGraph runtime (`packages/agent/`). The concepts below are the layers of that standard.

## The seven concepts at a glance

| Concept | One line | Where it lives | Deep-dive doc |
|---|---|---|---|
| **GitAgent definitions** | Declarative YAML+Markdown agent definitions compiled to a runtime | `agents/`, `packages/gitagent-bridge/` | [gitagent-bridge.md](gitagent-bridge.md) |
| **LLM Wiki** | Compiled persistent knowledge base the agent consults and updates | `agents/<agent>/memory/wiki/` | this doc (§ below) + [agent-memory.md](agent-memory.md) |
| **Live Agent Memory** | Durable cross-session memory (recall at start, append at boundaries) | `memory-writer.ts`, `memory-backend.ts` | [agent-memory.md](agent-memory.md) |
| **SkillsFlow** | Declarative DAG workflows chaining skills/agents/tools deterministically | `packages/skillflow/`, `gitagent-bridge/src/workflow.ts` | this doc (§ below) |
| **Knowledge Tree** | Disk-based, always-on reference knowledge indexed by `knowledge/index.yaml` | `agents/<agent>/knowledge/` | this doc (§ below) |
| **Knowledge Graph** | Optional embedded entity+correlation graph (lbug); record/enrich nodes + an in-process MCP server (:9087) | `packages/knowledge-graph/`, `packages/mcp-server-knowledge-graph/` | [knowledge-graph.md](knowledge-graph.md) |
| **Agent Lifecycle / Hooks** | Per-session bootstrap + teardown steps (recall, warm, flush) | `packages/agent/src/lifecycle.ts`, `hooks/hooks.yaml` | this doc (§ below) |
| **Segregation of Duties (SOD)** | Maker/checker boundary: the agent proposes, CI + humans dispose | `agents/elastic-iac/DUTIES.md`, compliance layer | [DUTIES.md](../../agents/elastic-iac/DUTIES.md) + [gitagent-bridge.md](gitagent-bridge.md) |
| **Shared Context & Skills** | Monorepo root context/skills/tools merged into every agent | `agents/shared/`, `gitagent-bridge/src/shared-merge.ts` | this doc (§ below) |

How they compose at runtime: the **bridge** loads a **GitAgent definition**, merges **Shared Context & Skills**, attaches the **Knowledge Tree** and **LLM Wiki**, and produces a system prompt; the **lifecycle hooks** recall **Live Memory** at session start and flush it at the end; a request either runs the LangGraph pipeline directly or a **SkillsFlow** workflow orchestrates skills/tools across it; the **SOD** boundary constrains what any of it may actually do.

---

## 1. GitAgent definitions

The two-layer system: a declarative layer (`agents/<agent>/` — `agent.yaml`, `SOUL.md`, `RULES.md`, `tools/*.yaml`, `skills/`, `compliance/`, `knowledge/`) compiled by `packages/gitagent-bridge/` into system prompts, Bedrock model configs, tool prompts, and compliance metadata for the `packages/agent/` LangGraph runtime. The runtime never reads definition files directly — it always goes through the bridge.

**Authoritative doc:** [gitagent-bridge.md](gitagent-bridge.md) (comprehensive — directory layout, every bridge module, modification workflows). The remaining sections here cover the pieces that doc does not treat as first-class concepts.

---

## 2. LLM Wiki — persistent knowledge base

A **compiled, durable knowledge base** the agent reads before acting and updates after. Distinct from the Knowledge Tree (curated, hand-authored reference; see §5) and from Live Memory (raw recall; see §3): the wiki is the agent's *synthesized* understanding — `[[page]]`-linked notes built up over sessions.

- **On disk:** `agents/<agent>/memory/wiki/{index,log}.md` + `pages/`. The incident-analyzer bootstrap consults `memory/wiki/index.md` before live datasource queries; the elastic-iac bootstrap follows `[[page]]` links from the index for turn context.
- **In the prompt:** loaded by the `load_wiki_index` lifecycle step (§6) and inlined via `wikiSectionFor()` in `packages/agent/src/prompt-context.ts`.
- **Updates:** wiki deltas are staged into the same review PR as durable decisions — never auto-committed (the SOD/HITL gate, §7). When `LIVE_MEMORY_BACKEND=agent-memory`, wiki pages map conceptually to durable **facts** in Couchbase Agent Memory.

The wiki/runtime split (`memory/wiki/` vs `memory/runtime/`) and its mapping to the Agent Memory service are covered in [agent-memory.md](agent-memory.md) and [memory-model-mapping.md](memory-model-mapping.md).

---

## 3. Live Agent Memory

Durable, cross-session knowledge the agent **recalls at session start and appends to at safe boundaries** — distinct from the LangGraph checkpointer (transient per-thread graph state, discarded after resume). Single writer `packages/agent/src/memory-writer.ts`; swappable backend (`file` default | `agent-memory`) selected in `memory-backend.ts`.

**Authoritative doc:** [agent-memory.md](agent-memory.md) — the Couchbase Agent Memory service model, identity mapping, block types (dailylog messages vs key-decision facts), semantic recall, write freshness, and resilience. Read that for anything memory-related.

---

## 4. SkillsFlow

Deterministic multi-step orchestration that chains **skills, agents, tools, nodes, or whole graphs** as a DAG — for when a task is a fixed pipeline (NL request → validate → draft → pre-check → open MR) rather than free-form LLM reasoning. Package: `@devops-agent/skillflow` (SIO-848 / EPIC 4). Parser/dialect bridge: `packages/gitagent-bridge/src/workflow.ts`.

### Workflow shape

A workflow is `{ name, version, description, triggers?, steps[], error_handling? }`. Each **step** sets exactly one *kind* — `skill | agent | tool | node | graph` (enforced by a Zod `.superRefine` in `workflow.ts`) — plus optional `depends_on`, `with` (templated inputs), `outputs`, and per-step `error_handling`.

### Ordering: topological DAG

`topoSort()` (`packages/skillflow/src/dag.ts`) runs Kahn's algorithm over `depends_on`: it validates every dependency exists (`UnknownDependencyError`), seeds the queue with zero-indegree steps in declared order, and throws `WorkflowCycleError` if any steps remain unordered (a cycle). The result is a deterministic order where every dependency runs before its dependents.

### Templating: `${{ }}`

Steps interpolate upstream results with `${{ ... }}` tokens, resolved at invocation time by `packages/skillflow/src/template.ts`:

- `${{ steps.<step>.outputs.<name> }}` — an output a completed step declared
- `${{ trigger.<key> }}` — a field from the trigger payload

Resolution is **strict** — an unknown step, a step that hasn't run, or an undeclared output throws `TemplateError` rather than substituting an empty string.

### Execution and error handling

`runWorkflow()` (`packages/skillflow/src/executor.ts`) runs the sorted steps, threading each step's outputs into the context so later `${{ }}` references resolve. Failure handling is two-tier:

- **Per-step `error_handling`:** `fail` (default — propagate), `continue` (record and keep going), or `retry` (with `retry.attempts` + `retry.backoff_ms`).
- **Workflow `error_handling`:** `fail_fast` (default — stop on first intolerable failure) or `best_effort` (tolerate any step failure).

The executor does **not** implement what a step *does* — it dispatches to injected `StepHandlers` (`skill`/`agent`/`tool`/`node`/`graph`), supplied by the agent package (`packages/skillflow/src/resolvers.ts`). Each step runs inside a `skillflow.step.<name>` trace span.

### Two dialects

The bridge accepts two YAML shapes (`parseWorkflowFile` in `workflow.ts`):

- **Canonical** — `steps` is an array of step objects (validated by `WorkflowSchema`).
- **GAP SkillsFlow** — `steps` is a *map* (`{ stepName: {...} }`); validated by `SkillFlowSchema` and converted to the canonical form by `skillFlowToWorkflowDef()`. The conversion is lossy: `conditions` fold into the step `prompt` as notes, and non-string inputs are JSON-stringified.

Example (GAP dialect, `agents/elastic-iac/workflows/tier-resize.yaml`): `validate → guard → draft → precheck → mr → notify`, each `depends_on` the previous, with `${{ steps.draft.outputs.branch }}` style wiring and a final `error_handling: { on_failure: comment_on_mr_if_exists, notify_user: true }`.

---

## 5. Knowledge Tree

The **always-on reference knowledge** for an agent: hand-authored Markdown indexed by `agents/<agent>/knowledge/index.yaml` (SIO-953). Unlike skills (named, selectively loaded procedures) and the LLM Wiki (synthesized, updated), the Knowledge Tree is curated, read-only, and present in *every* prompt.

### index.yaml structure

`index.yaml` declares `{ name, description, version, categories, runbook_selection? }`. Each **category** maps a name to a `path` (relative to `knowledge/`) and a description:

```yaml
name: incident-analyzer-knowledge
version: 0.1.0
categories:
  runbooks:    { path: runbooks/,    description: Operational runbooks for common incident patterns }
  systems-map: { path: systems-map/, description: Service dependency maps and topology }
  slo-policies:{ path: slo-policies/, description: SLO/SLA definitions and thresholds }
runbook_selection:        # SIO-640: severity-keyed fallback when the LLM router fails
  fallback_by_severity:
    critical: [kafka-consumer-lag.md, high-error-rate.md, database-slow-queries.md]
    low: []
```

### Loading

`loadKnowledge()` (`packages/gitagent-bridge/src/manifest-loader.ts`) reads `index.yaml`, validates against `KnowledgeIndexSchema`, then walks each category's `path` loading every `*.md` file **directly** under it (no subdirectory recursion). Files in the `runbooks` category get their optional YAML frontmatter parsed (`triggers`: severity/services/metrics) via `parseRunbookFrontmatter()`; other categories load verbatim. When `index.yaml` is absent (GAP agents), it falls back to auto-discovering the manifest's `knowledge:` list.

`runbook_selection` (SIO-640) is validated at load time — every filename it names must exist under the runbooks path, or the load throws. It feeds the incident-analyzer's lazy `selectRunbooks` node; the IaC graph has no such node, so elastic-iac omits it.

### Into the prompt

`buildKnowledgeSection()` (`skill-loader.ts`) renders the entries as a `## Knowledge Base` block (one `###` per category, one `####` per file). It is appended **unconditionally** in `buildSystemPrompt()` — contrast skills, which are gated on the `activeSkills` set. That unconditional vs. gated distinction is exactly the Knowledge-Tree-vs-Skills line.

---

## 6. Agent Lifecycle with Hooks

Each session (keyed by `threadId`) runs an ordered **bootstrap** phase at the start and a **teardown** phase at the end. Steps are a **closed enum** (no arbitrary shell) declared in `agents/<agent>/hooks/hooks.yaml`; the runner lives in `packages/agent/src/lifecycle.ts`; human-readable intent lives in the sibling `bootstrap.md` / `teardown.md`.

### Steps (closed enums)

```yaml
# agents/incident-analyzer/hooks/hooks.yaml
bootstrap:
  instructions_file: bootstrap.md
  steps: [load_live_memory, load_wiki_index, warm_knowledge_graph, emit_session_start]
teardown:
  instructions_file: teardown.md
  steps: [flush_daily_log, checkpoint_key_decisions, open_memory_pr]
```

`BootstrapStep` = `load_live_memory | load_wiki_index | warm_knowledge_graph | emit_session_start`; `TeardownStep` = `flush_daily_log | checkpoint_key_decisions | open_memory_pr | close_knowledge_graph`. elastic-iac declares the memory subset (no `open_memory_pr` — it has no memory-pr tree). The runner resolves hooks for the **invoked** agent via `getAgentByName(ctx.agentName)`, so each agent runs its own steps under its own memory identity.

### Registration seams

`lifecycle.ts` never imports the optional backends directly — they wire in through registration seams, each a no-op until its feature flag is set:

- `registerGraphWarmer` — `warm_knowledge_graph` opens + `init()`s the embedded graph (SIO-850/SIO-954)
- `registerMemoryRecaller` / `registerMemoryFlusher` — semantic recall on bootstrap, queue-drain + `endSession()` on teardown (SIO-938)
- `registerMemoryPrOpener` — `open_memory_pr` promotes durable decisions via a HITL PR (SIO-849)
- `registerPostTurnFlusher` — per-turn flush, separate from teardown (SIO-942)

They are installed once at module load in `apps/web/src/lib/server/agent.ts` (`installGraphWarmer()`, `installAgentMemory()`, `installMemoryPromotion()`), and `runBootstrap` / `runTeardown` are invoked per session from there. **Every step is best-effort** — a failure logs a warning and continues; a cold graph or unhealthy memory service never blocks the investigation.

### Adding a hook step

1. Add the enum value to `BootstrapStepSchema` / `TeardownStepSchema` (`packages/gitagent-bridge/src/hooks.ts`).
2. Add the `case` to `runBootstrapStep` / `runTeardownStep` (`packages/agent/src/lifecycle.ts`).
3. List the step in the agent's `hooks/hooks.yaml`.
4. If it needs external wiring, add a `register…` seam and `install…` it in `apps/web/src/lib/server/agent.ts`.

This lifecycle is the spine that ties Live Memory, the Wiki, and the Knowledge Graph together — see [agent-memory.md](agent-memory.md) for the memory steps and [knowledge-graph.md](knowledge-graph.md) for what `warm_knowledge_graph` opens.

---

## 7. Segregation of Duties (SOD)

The **maker/checker boundary**: the agent *proposes*, CI and humans *dispose*. Most explicit for elastic-iac, whose entire purpose is to author infrastructure changes it is not allowed to apply.

**Authoritative doc:** [`agents/elastic-iac/DUTIES.md`](../../agents/elastic-iac/DUTIES.md) — the permitted/forbidden action table (read, branch, write diff, open MR, comment *vs.* approve/merge, trigger pipeline, push to main, edit secrets), MR-title format, and the "post link → write context → stop" handoff protocol.

SOD is enforced in **three layers**, not just prose:

1. **Definition** — `RULES.md` / `DUTIES.md` constrain the agent's behavior in-prompt; the compliance layer (`agents/<agent>/compliance/allowed-actions.yaml`, compiled by `gitagent-bridge/src/compliance.ts`) attaches risk tier + allowed actions as LangSmith metadata.
2. **Graph** — the elastic-iac maker graph never applies; every mutating step is gated and `reviewPlan` is a human interrupt (see [elastic-iac-proposer.md](elastic-iac-proposer.md)).
3. **Permission** — the GitLab service account holds Developer (not Maintainer) role, so it *cannot* merge or push to protected `main` even if asked.

The incident-analyzer enforces a simpler SOD — read-only — through its compliance config and MCP feature gates, rather than a DUTIES.md.

---

## 8. Shared Context & Skills via Monorepo

Two distinct kinds of sharing — definition-level (across agents) and package-level (across the codebase).

### Definition-level: `agents/shared/` (SIO-843 / EPIC 5)

Anything under `agents/shared/` (`context.md`, `skills/`, `tools/`) is merged into **every** loaded agent by `mergeShared()` (`packages/gitagent-bridge/src/shared-merge.ts`). The contract is **"root is shared, leaf overrides"**:

- **Shared context** → a `## Shared Context` section in every agent's system prompt.
- **Shared skills** → **gap-fill only**: a shared skill loads only if the agent has no local skill of that name (local wins; the shadowed name is recorded).
- **Shared tools** → appended unless a local tool already has that name (local override by name).

The merge happens in `manifest-loader.ts` at load time, so `buildSystemPrompt()` simply emits SOUL → Shared Context → RULES → local skills → shared skills (gaps) → Knowledge Base.

### Sub-agent inheritance

Sub-agents (`elastic-agent`, `kafka-agent`, …) don't copy the parent's tools — they're resolved live from the connected MCP servers at invocation (`getToolsForDataSource()` in `sub-agent.ts`), then filtered by action-keyword matching. Each sub-agent's prompt is built from its own SOUL/RULES + shared context + shared skills via `buildSubAgentPrompt()`. Sub-agents **may** carry their own scoped `knowledge/` directory (drop an `index.yaml` + `runbooks/*.md` under `agents/incident-analyzer/agents/<sub-agent>/knowledge/`); such runbooks may only cite tools in the intersection of the parent's facades and the sub-agent's declared `tools:` (validator-enforced). None exist today.

### Package-level: the monorepo

Cross-cutting packages are workspace dependencies of everything: `shared` (types, Zod schemas, `createMcpApplication` bootstrap, the Agent Memory REST client), `observability` (Pino + OpenTelemetry + LangSmith), `checkpointer`, and `gitagent-bridge`. All eight MCP servers depend on `shared`; `agent` depends on `gitagent-bridge` + `checkpointer` + `observability` + `shared`; `web` depends on `agent`. The dependency graph and package map are in [monorepo-structure.md](../development/monorepo-structure.md).

---

## Where to go next

- Authoring the declarative layer: [gitagent-bridge.md](gitagent-bridge.md), [authoring-skills-and-runbooks.md](../development/authoring-skills-and-runbooks.md)
- Memory deep-dive: [agent-memory.md](agent-memory.md), [memory-model-mapping.md](memory-model-mapping.md)
- The runtime pipeline: [agent-pipeline.md](agent-pipeline.md), [system-overview.md](system-overview.md)
- The elastic-iac maker agent (SkillsFlow + SOD in practice): [elastic-iac-proposer.md](elastic-iac-proposer.md)
