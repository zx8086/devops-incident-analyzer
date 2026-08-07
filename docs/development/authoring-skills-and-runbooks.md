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
| Prompt presence | Only when listed in the manifest | **Selected, not always-on** -- see below |
| Who decides when it applies | The pipeline node whose purpose maps to the skill | The LLM pattern-matches incident signals against prose |
| Maintenance cost | Changes to a skill require care -- they shape the agent's procedure | Drop-in authoring; new runbook is live on next agent load |

**Prompt presence is per-agent, and neither agent is "always on" any more.** This row said
"Every registered entry, always on" until SIO-1285; that had been wrong for incident-analyzer
since SIO-640 and is now wrong for elastic-iac too:

- **incident-analyzer** (SIO-640): runbooks are lazy. A catalog projection costs ~280 bytes
  per runbook always-on (summary capped at 200 chars), and only the `selectRunbooks` node's
  max-3 picks get their full ~6 KB body. Configured by `runbook_selection` in
  `knowledge/index.yaml`; non-runbook categories are unaffected.
- **elastic-iac** (SIO-1285): knowledge is selected by *category*, keyed on the classifier's
  `intent`, via the `knowledge_selection` block in `knowledge/index.yaml`. A `converse` turn
  carries ~154 KB where an unfiltered build carried ~486 KB.

In both cases **presence of the config block is the feature gate** -- remove it and the
agent returns to loading everything. Adding a file to a registered category still makes it
live on the next agent load, but it is no longer free: it enlarges every prompt that selects
that category. Check the byte cost before adding a large file.

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

The loader reads the entire file, strips an optional YAML frontmatter block (everything between the first `---` pair at the top), and appends the body to the orchestrator's system prompt under a `## Skill: <name>` heading. See `packages/gitagent-bridge/src/skill-loader.ts:29` for the exact regex.

#### The agentskills.io spec contract (SIO-1347, enforced)

Every SKILL.md in the repo -- under `agents/**` and `.agents/skills/` -- must satisfy the [agentskills.io specification](https://agentskills.io/specification) frontmatter contract:

- `name` (required): max 64 chars, lowercase alphanumeric segments joined by single hyphens, and it **must equal the skill's directory name**.
- `description` (required): 1-1024 chars, non-empty. Describe both what the skill does and when to use it -- the description is the skill's line in the `## Skills` catalog that precedes the bodies (`skill-loader.ts:49`), so it is what the model uses to decide the skill is relevant.
- Optional spec fields: `license`, `compatibility`, `metadata`, `allowed-tools`.

On top of the spec, this repo allows a documented set of extension fields (kept top-level by the SIO-1347 minimal-alignment decision): `inputs`/`outputs` (elastic-iac skill contracts), the learner-managed fields (`confidence`, `task_category`, `learned_from`, `learned_at`, `usage_count`, `success_count`, `failure_count`, `negative_examples` -- written by the promotion paths, do not hand-author them; see `docs/superpowers/specs/2026-06-26-skill-promotion-and-confidence-design.md`), and `version`/`category` (`.agents/skills` operator skills). Any other top-level key fails the build. To add a new extension field, update `SKILL_EXTENSION_FIELDS` in `packages/gitagent-bridge/src/skill-spec-validator.ts` in the same PR that introduces the first skill using it.

Enforcement is `packages/gitagent-bridge/src/skill-spec-compliance.test.ts` (one test per SKILL.md, run by `bun test`); `bun run yaml:check` is yamllint over `.yaml` files and cannot see Markdown frontmatter. The runtime loader stays tolerant (`parseSkillFrontmatter` degrades to a minimal record instead of failing agent load) -- the test suite, not the runtime, is the gate. The authoritative runtime field list is `SkillFrontmatterSchema` in `packages/gitagent-bridge/src/types.ts:301-323` (all optional, `.passthrough()`); the spec validator is deliberately stricter.

This gate also covers learn-lane skill-promotion PRs (SIO-1346): a generated SKILL.md that reaches `agents/` must pass. If such a PR's CI goes red on this suite (say, the proposal had no recoverable description), that is the two-gate flow working -- the reviewer completes the draft before merging. `packages/agent/src/learn/skill-pr.test.ts` asserts the generator template itself stays spec-compliant.

Note on outcome tracking: since SIO-1347 every hand-authored skill carries frontmatter, so `recordSkillOutcome` gates on a learning marker (`usage_count`/`learned_from`) rather than on a frontmatter block existing (`packages/agent/src/skill-outcome.ts`). Hand-authored skills are never mutated at runtime; only promoted skills are tracked when `SKILL_OUTCOME_TRACKING_ENABLED` is on.

A minimal compliant skill:

```markdown
---
name: my-new-skill
description: One sentence on what this does, one on when the model should reach for it.
---

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

Follow the style of the existing orchestrator skills (`normalize-incident`, `aggregate-findings`, `propose-mitigation`) for tone, headings, and verbosity. For a frontmatter-bearing example, see `mcp-tool-audit`, or any sub-agent skill such as `agents/incident-analyzer/agents/capella-agent/skills/slow-query-triage`.

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
bun run --filter '@devops-agent/gitagent-bridge' test   # spec gate: skill-spec-compliance.test.ts
```

No dedicated unit test is needed for skill content -- but if your skill encodes a non-trivial output shape, add an agent-level integration test that verifies the orchestrator produces that shape.

---

## Authoring a Runbook

### Step 1: Drop the file in place

Runbooks live under `agents/incident-analyzer/knowledge/runbooks/<datasource>/`, one
subfolder per datasource (plus `cross-datasource/` for correlation/audit runbooks that
span sources). Pick the subfolder matching your runbook's primary datasource; if none
fits, use `cross-datasource/`. Placing the file in the right subfolder is the only
registration step for an EXISTING datasource -- there is no per-file manifest entry:

```text
agents/incident-analyzer/knowledge/
  index.yaml
  runbooks/
    kafka/
      kafka-consumer-lag.md
    elastic/
      high-error-rate.md
    couchbase/
      database-slow-queries.md
    aws/
      my-new-pattern.md      <-- your new runbook, if AWS-specific
```

The loader walks every `.md` file (excluding `.gitkeep`) in each directory registered under
`knowledge/index.yaml`. Each `runbooks/<datasource>/` subfolder is its own registered
category (`runbooks-aws`, `runbooks-kafka`, ...; any category name that is exactly
`runbooks` or prefixed `runbooks-` is treated as a runbook category, see
`isRunbookCategory()`). Adding a runbook to an EXISTING subfolder needs no `index.yaml`
change; a runbook for a brand-new datasource needs a new `runbooks-<datasource>` entry
added to `categories:` first (see `agents/incident-analyzer/knowledge/index.yaml`).

Two things that surprise people here:

- **The walk is not recursive.** `loadKnowledge` reads only the `.md` files sitting *directly*
  under a category's `path`; subdirectories are invisible to it. That is load-bearing, not
  incidental -- it is how `knowledge/_archive/eu-b2b-ilm/` stays out of the prompt while
  remaining in git, and it is also why the per-datasource runbook layout needs one
  registered category per subfolder rather than a single `runbooks` category pointing at
  the whole tree. Nesting a file one level down without a matching category is the crude
  way to exclude it.
- **Pickup is not free.** A new file enlarges every prompt that selects its category (see the
  prompt-presence note above). For a large file, prefer a category the relevant intent does
  not select, or leave it unregistered and reference it from a runbook by path.

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

Runbooks are pure prose read by the LLM. There is no schema enforcement on their structure beyond "it must be valid Markdown." (OKF frontmatter -- `type`, `title`, `status`, `triggers`, `generated`, `stale_after` -- is validated separately; see the OKF design spec.)

#### Conventions worth stealing (SIO-1347, guidance only)

Distilled from the highest-rated public incident runbook skills; none of these are validator-enforced, all of them make a runbook better under 3 AM conditions:

- **Quick checklist at the top**: a short numbered checklist directly under the H1 mirroring the section order, so a responder can track progress under stress without re-reading prose.
- **Freshness is visible**: OKF frontmatter already carries `generated.at` and optional `stale_after` -- set them honestly and re-verify a runbook after every incident where it was used. A runbook that references retired tools or old cluster names is worse than none.
- **Per-step failure handling**: every drill-down step should say what to do when the tool call itself fails or returns empty, not only what a successful result means. An empty result is evidence, not an error to skip past (see the absence-vs-error handling in the sub-agent RULES files).
- **Comms cadence**: when a runbook reaches escalation, point at the status-update template in the propose-mitigation skill rather than inventing a new format -- one template, filled from cited findings, updated on a stated cadence.

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

**As of, this binding is enforced statically by `bun test`.**

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

Scenario: you want the orchestrator to emit a post-incident blameless summary after the validate node runs. (This one exists now -- `agents/incident-analyzer/skills/incident-postmortem/` is the SIO-1347 worked example of everything below.)

1. Create `agents/incident-analyzer/skills/write-postmortem/SKILL.md` with spec frontmatter (`name` matching the directory, a what-plus-when `description`) and a `Purpose / Procedure / Output Format / Edge Cases` structure.
2. Add `write-postmortem` to `agent.yaml:skills:`.
3. `bun run yaml:check && bun run typecheck && bun run lint && bun run --filter '@devops-agent/gitagent-bridge' test`.
4. Wire the new skill into the appropriate pipeline node in `packages/agent/src/graph.ts` if it needs an explicit call site (many skills are implicitly applied by the LLM based on the prompt content; new skills that need a dedicated node are an architectural change).
5. Run an end-to-end smoke query and verify the postmortem section appears in the final response.

## End-to-End: Adding a Runbook

Scenario: a new failure pattern where Konnect upstream timeouts correlate with Kafka producer throttling.

1. No `runbooks-konnect` category exists yet (Konnect has zero runbooks today), so first
   add one to `agents/incident-analyzer/knowledge/index.yaml`:
   ```yaml
   runbooks-konnect:
     path: runbooks/konnect/
     description: Kong Konnect operational runbooks
   ```
2. Create `agents/incident-analyzer/knowledge/runbooks/konnect/konnect-upstream-timeout.md`.
3. Write "When to use", "Identification", "Drill-down", "Cross-datasource correlation", and "Remediation hints" sections. Reference real tool names -- double-check against `agents/incident-analyzer/tools/*.yaml`.
4. `bun run yaml:check && bun run typecheck && bun run lint`.
5. Submit an incident query matching the new pattern and verify the aggregator's correlation block cites the runbook.

If the datasource already has a `runbooks-<datasource>` category (e.g. adding another
AWS runbook), skip step 1 -- drop the file directly into the existing subfolder.

---

## Sub-Agent Runbooks (advanced)

Sub-agents (e.g., `kafka-agent`, `capella-agent`) can have their own `knowledge/runbooks/` directories with deep, datasource-specific runbooks that are NOT shared with the orchestrator. This is supported by the existing `loadAgent()` and `buildSubAgentPrompt()` code paths with zero additional configuration -- drop a `knowledge/index.yaml` and one or more `runbooks/*.md` files into `agents/incident-analyzer/agents/<sub-agent-name>/knowledge/` and the sub-agent sees them in its system prompt automatically.

Sub-agent runbooks are subject to a **strict authority rule**: a sub-agent runbook may only cite tool names that exist in the intersection of (the parent agent's tool facades) AND (the sub-agent's declared `tools:` list from its `agent.yaml`). A `kafka-agent` runbook citing `elasticsearch_search` fails validation because the kafka sub-agent cannot actually call elasticsearch tools at runtime.

The extension of the runbook tool-name validator enforces this rule statically. See `docs/superpowers/specs/2026-04-10-scoped-subagent-runbooks-design.md` for the full policy: when to author a sub-agent runbook, relationship to orchestrator runbooks (independent, duplication allowed, no cross-referencing), directory structure, and the authoring conventions.

**No sub-agent runbooks exist in this repository today.** The capability is documented and validated; seeding is deferred until a concrete need emerges.

---

## Related

- [Gitagent Bridge](../architecture/gitagent-bridge.md) -- skill and knowledge loader internals
- [Agent Pipeline](../architecture/agent-pipeline.md) -- which pipeline node applies which skill
- [Adding MCP Tools](adding-mcp-tools.md) -- the other side of the tool-name binding
- [CLAUDE.md](../../CLAUDE.md) -- project-wide rules (no emojis, Linear issue conventions)
