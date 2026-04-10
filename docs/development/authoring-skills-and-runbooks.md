# Authoring Skills and Runbooks

> **Targets:** Gitagent 0.1 | Bun 1.3.9+ | DevOps Incident Analyzer orchestrator
> **Last updated:** 2026-04-10

The incident analyzer's orchestrator agent reasons with two kinds of Markdown content that are loaded into its system prompt at startup: **skills** (multi-step procedures the agent follows) and **knowledge entries** (reference material the agent consults, of which **runbooks** are the most common). This guide explains when to author each, the file conventions, the activation flow, and the known footguns.

---

## Skill vs. Runbook: Decision Tree

```
Are you describing a procedure the agent should perform at a specific
pipeline stage (normalize, aggregate, validate/mitigate)?
  |
  +-- Yes --> Author a SKILL
  |
  +-- No, I am describing a recognizable incident pattern
  |          (with drill-down steps, correlation hints, tool references)
  |          --> Author a RUNBOOK
  |
  +-- No, I am describing infrastructure topology, service dependencies,
             SLO thresholds, or other static reference data
             --> Author a knowledge entry under a non-runbook category
                 (systems-map, slo-policies, or a new category)
```

| Dimension | Skill | Runbook (and other knowledge) |
|---|---|---|
| File location | `agents/incident-analyzer/skills/<name>/SKILL.md` | `agents/incident-analyzer/knowledge/<category>/<file>.md` |
| Activation | Named explicitly in `agent.yaml:skills:` | Auto-discovered via `knowledge/index.yaml` category path |
| Prompt presence | Only when listed in the manifest | Every registered entry, always on |
| Who decides when it applies | The pipeline node whose purpose maps to the skill | The LLM pattern-matches incident signals against prose |
| Maintenance cost | Changes to a skill require care -- they shape the agent's procedure | Drop-in authoring; new runbook is live on next agent load |

---

## Authoring a Skill

### Step 1: Create the skill directory

Skills live one-per-directory under the root agent's `skills/` folder:

```
agents/incident-analyzer/skills/
  normalize-incident/
    SKILL.md
  aggregate-findings/
    SKILL.md
  propose-mitigation/
    SKILL.md
  my-new-skill/
    SKILL.md    <-- your new skill
```

The directory name **is** the skill name. It must be unique and match exactly what you will list in `agent.yaml`.

### Step 2: Write SKILL.md

The loader reads the entire file, strips an optional YAML frontmatter block (everything between the first `---` pair at the top), and appends the body to the orchestrator's system prompt under a `## Skill: <name>` heading. See `packages/gitagent-bridge/src/skill-loader.ts:42` for the exact regex.

None of the three production skills currently use frontmatter. Frontmatter is optional -- include it only if you want to record metadata for humans reading the file directly. A plain Markdown body is the norm:

```markdown
# Skill: My New Skill

## Purpose
One or two sentences stating the procedure's goal.

## Procedure
1. Step one
2. Step two
3. Step three

## Output Format
Describe the expected output shape in prose or pseudo-YAML. The LLM will
try to produce output matching this shape when the skill is invoked.

## Edge Cases
- Behavior when a required field is missing
- Behavior under conflicting signals
```

Follow the style of the three existing skills (`normalize-incident`, `aggregate-findings`, `propose-mitigation`) for tone, headings, and verbosity.

### Step 3: Activate the skill

Open `agents/incident-analyzer/agent.yaml` and add the skill's directory name to the `skills:` list:

```yaml
skills:
  - normalize-incident
  - aggregate-findings
  - propose-mitigation
  - my-new-skill    # <-- add here
```

If you skip this step, the skill file sits on disk but never enters the prompt. Only listed skills are loaded -- see `manifest-loader.ts:47-56`.

### Step 4: Validate

```bash
bun run yaml:check    # validates agent.yaml
bun run typecheck     # ensures the bridge still loads cleanly
bun run lint          # catches Markdown/formatting issues
```

No dedicated unit test is needed for skill content -- but if your skill encodes a non-trivial output shape, add an agent-level integration test that verifies the orchestrator produces that shape.

---

## Authoring a Runbook

### Step 1: Drop the file in place

Runbooks live under `agents/incident-analyzer/knowledge/runbooks/`. There is no registration step beyond placing the file:

```
agents/incident-analyzer/knowledge/
  index.yaml
  runbooks/
    kafka-consumer-lag.md
    high-error-rate.md
    database-slow-queries.md
    my-new-pattern.md      <-- your new runbook
```

The loader walks every `.md` file (excluding `.gitkeep`) in each directory registered under `knowledge/index.yaml`. As long as `runbooks/` is listed in the index (it already is), any new file is picked up on the next agent load.

### Step 2: Write the runbook

Follow the conventions of the three existing runbooks:

```markdown
# Runbook: <Short Pattern Name>

## When to use this runbook
Bulleted list of the observable signals that match this pattern
(error shape, metric threshold, alert kind).

## Identification
Specific MCP tool calls to confirm the diagnosis. Reference tools by
their exact MCP tool name (see the footgun section below).

## Drill-down steps
Numbered investigation steps. Each step should name a tool or query and
explain what its output means.

## Cross-datasource correlation
How findings in this datasource should be compared against other
datasources (e.g., Kafka lag + Couchbase write failures = downstream
consumer stuck on DB).

## Remediation hints
Read-only suggestions only. Never embed write operations. HITL or
escalation guidance if appropriate.
```

Runbooks are pure prose read by the LLM. There is no schema enforcement on their structure beyond "it must be valid Markdown."

### Step 3: Validate

Same commands as skills:

```bash
bun run yaml:check
bun run typecheck
bun run lint
```

Run a smoke query end-to-end with an incident that should match your new runbook, and verify the aggregator references it in its correlation block.

---

## The Tool-Name Footgun (now enforced)

Runbooks reference MCP tool names directly in prose (for example, `capella_get_longest_running_queries` or `kafka_get_consumer_group_lag`). These names correspond to entries in `agents/incident-analyzer/tools/*.yaml` `action_tool_map` blocks, which in turn correspond to the real tool names exposed by each MCP server.

**As of SIO-641, this binding is enforced statically by `bun test`.**

The validator lives at `packages/gitagent-bridge/src/runbook-validator.test.ts`. It runs on every `bun test` invocation and fails if any runbook cites a tool name that is not present in the union of `action_tool_map` entries across the agent's `tools/*.yaml` files. It also fails if the prose backticks and the `## All Tools Used Are Read-Only` tail section disagree within a single runbook.

**Authoring rules enforced by the validator:**

1. Every tool name cited in prose (wrapped in single backticks, lowercase snake_case with at least one underscore) must exist in some `action_tool_map` entry in the agent's tool YAMLs.
2. Every runbook must have a `## All Tools Used Are Read-Only` section at the bottom.
3. The tail section must be a comma-separated list matching every tool name cited in prose. Extras in either direction fail the validator.
4. The ordering constraint: if you need to cite a new tool in a runbook, add it to an `action_tool_map` entry first, then reference it in the runbook. Runbook-first authoring is not supported.

**There is no escape hatch.** No inline exemption markers, no allowlist config. If the validator fails on a tool name, either the citation is wrong or the action map is wrong -- fix one or the other.

**Failure output format:**

```
Runbook: /path/to/runbook.md

Missing from action_tool_map (N): <line:name lines>
Cited in prose but missing from "All Tools Used Are Read-Only" tail section (N): <lines>
Listed in tail section but not cited in prose (N): <lines>
Structural errors (N): <error names>

Fix:
  - For each "Missing" entry: verify the tool name, or add it to an action_tool_map.
  - For each "prose only" entry: add the name to the tail section.
  - For each "tail only" entry: either cite it in prose or remove it from the tail.
```

---

## End-to-End: Adding a Skill

Scenario: you want the orchestrator to emit a post-incident blameless summary after the validate node runs.

1. Create `agents/incident-analyzer/skills/write-postmortem/SKILL.md` with a `Purpose / Procedure / Output Format / Edge Cases` structure.
2. Add `write-postmortem` to `agent.yaml:skills:`.
3. `bun run yaml:check && bun run typecheck && bun run lint`.
4. Wire the new skill into the appropriate pipeline node in `packages/agent/src/graph.ts` if it needs an explicit call site (many skills are implicitly applied by the LLM based on the prompt content; new skills that need a dedicated node are an architectural change).
5. Run an end-to-end smoke query and verify the postmortem section appears in the final response.

## End-to-End: Adding a Runbook

Scenario: a new failure pattern where Konnect upstream timeouts correlate with Kafka producer throttling.

1. Create `agents/incident-analyzer/knowledge/runbooks/konnect-upstream-timeout.md`.
2. Write "When to use", "Identification", "Drill-down", "Cross-datasource correlation", and "Remediation hints" sections. Reference real tool names -- double-check against `agents/incident-analyzer/tools/*.yaml`.
3. No manifest update needed -- `runbooks/` is already registered in `knowledge/index.yaml`.
4. `bun run yaml:check && bun run typecheck && bun run lint`.
5. Submit an incident query matching the new pattern and verify the aggregator's correlation block cites the runbook.

---

## Sub-Agent Runbooks (advanced)

Sub-agents (e.g., `kafka-agent`, `capella-agent`) can have their own `knowledge/runbooks/` directories with deep, datasource-specific runbooks that are NOT shared with the orchestrator. This is supported by the existing `loadAgent()` and `buildSubAgentPrompt()` code paths with zero additional configuration -- drop a `knowledge/index.yaml` and one or more `runbooks/*.md` files into `agents/incident-analyzer/agents/<sub-agent-name>/knowledge/` and the sub-agent sees them in its system prompt automatically.

Sub-agent runbooks are subject to a **strict authority rule**: a sub-agent runbook may only cite tool names that exist in the intersection of (the parent agent's tool facades) AND (the sub-agent's declared `tools:` list from its `agent.yaml`). A `kafka-agent` runbook citing `elasticsearch_search` fails validation because the kafka sub-agent cannot actually call elasticsearch tools at runtime.

The SIO-642 extension of the runbook tool-name validator (SIO-641) enforces this rule statically. See `docs/superpowers/specs/2026-04-10-scoped-subagent-runbooks-design.md` for the full policy: when to author a sub-agent runbook, relationship to orchestrator runbooks (independent, duplication allowed, no cross-referencing), directory structure, and the authoring conventions.

**No sub-agent runbooks exist in this repository today.** The capability is documented and validated; seeding is deferred until a concrete need emerges.

---

## Related

- [Gitagent Bridge](../architecture/gitagent-bridge.md) -- skill and knowledge loader internals
- [Agent Pipeline](../architecture/agent-pipeline.md) -- which pipeline node applies which skill
- [Adding MCP Tools](adding-mcp-tools.md) -- the other side of the tool-name binding
- [CLAUDE.md](../../CLAUDE.md) -- project-wide rules (no emojis, Linear issue conventions)
