# Scoped Sub-Agent Runbooks - Design Spec

> **Status:** Draft for review
> **Date:** 2026-04-10
> **Author:** Simon Owusu (with Claude Opus 4.6)
> **Related:** SIO-639 (Phase 1 docs), SIO-640 (Phase 2A lazy runbook selection), SIO-641 (Phase 2B tool-name validator); this is Phase 2 brainstorm C
> **Supersedes:** none

## Context

The four sub-agents in this project (`elastic-agent`, `kafka-agent`, `capella-agent`, `konnect-agent`) are minimal: each has only `agent.yaml` and `SOUL.md`, plus a facade tool declaration (`tools: [kafka-introspect]`, etc.). Today, only the orchestrator has runbooks. Sub-agents see **zero** runbooks at runtime — not their own (they have none) and not the orchestrator's either. Runbooks live in each agent's own `LoadedAgent.knowledge` field, and `buildSubAgentPrompt()` passes only the sub-agent's own `LoadedAgent` to `buildSystemPrompt()`. The orchestrator's runbooks stay within the orchestrator's prompt; they are not inherited by sub-agents.

The question this brainstorm answers: **should sub-agents be able to have their own runbooks, and if so, how?**

The surprising finding that reframes the answer: **the infrastructure for sub-agent runbooks already exists today, with zero code changes needed.**

- `loadAgent()` at `packages/gitagent-bridge/src/manifest-loader.ts:29` recurses into sub-agents via line 64 (`subAgents.set(subAgentName, loadAgent(subAgentDir))`).
- The recursion calls `loadKnowledge()` at line 69 for every agent, including sub-agents.
- Every sub-agent's `LoadedAgent` has a populated `knowledge: KnowledgeEntry[]` field (empty today because no sub-agent has a `knowledge/` directory, but wired).
- `buildSubAgentPrompt(agentName)` in `packages/agent/src/prompt-context.ts:48-53` calls `buildSystemPrompt(subAgent)`.
- `buildSystemPrompt()` at `packages/gitagent-bridge/src/skill-loader.ts:49-51` appends `agent.knowledge` to the prompt whenever non-empty.
- `packages/agent/src/sub-agent.ts:153` uses `buildSubAgentPrompt()` to build the sub-agent's system prompt at runtime.

Drop `knowledge/index.yaml` + `knowledge/runbooks/*.md` into any sub-agent directory today and the sub-agent's system prompt includes those runbooks automatically. No code changes required.

This changes the shape of this brainstorm entirely. It is not a feature build; it is an **editorial policy** that documents the existing capability, enforces guardrails via a brainstorm B validator extension, and cross-references brainstorm A so the lazy selector stays correctly scoped.

## Goals

1. Document the authoring policy for sub-agent runbooks: when to write one, where it lives, what the authoring conventions are, and what the authority rule is.
2. Extend the brainstorm B validator (SIO-641) to recurse into sub-agent runbook directories and apply the correct authority rule (intersection of parent tool facades and the sub-agent's declared `tools:` list).
3. Add a cross-reference note to the brainstorm A spec (SIO-640) clarifying that `selectRunbooks` operates on orchestrator runbooks only. Sub-agent runbooks are a separate mechanism.
4. Update the SIO-639 authoring guide with a pointer to this spec.
5. Do all of the above without seeding any sub-agent runbook content. The capability is documented; nobody is forced to use it.
6. Do all of the above without touching `loadAgent()`, `loadKnowledge()`, `buildSystemPrompt()`, `buildSubAgentPrompt()`, `sub-agent.ts`, or any other runtime code.

## Success Criteria

Measurable at merge time:

1. The spec file exists, committed, and has been reviewed.
2. The validator extension passes `bun test` on a branch that has no sub-agent runbooks (current state): the new `describe("real sub-agent runbook bindings")` block is present but emits zero test cases, and the existing orchestrator-level tests continue to pass.
3. The validator extension's unit tests for `buildSubAgentAuthority` and `collectSubAgentFixtures` all pass (9 cases per the Testing section).
4. A synthetic sub-agent runbook created in a scratch directory under `/tmp` via the same test infrastructure used in SIO-641 causes the validator to emit one passing test case, confirming the production walk works end-to-end.
5. The brainstorm A spec contains a cross-reference paragraph clarifying selector scope.
6. The SIO-639 authoring guide contains a pointer to this spec.
7. Zero sub-agent runbook files exist in `agents/incident-analyzer/agents/*/knowledge/` after this work lands.

## Non-Goals

- **Writing actual sub-agent runbook content.** No `agents/incident-analyzer/agents/*/knowledge/` directories are created as part of this work. Seeding is deferred until a real need emerges.
- **Modifying `loadAgent()` or any loader code in `packages/gitagent-bridge/`.** Sub-agent runbook loading is already supported.
- **Modifying `buildSubAgentPrompt()`, `buildSystemPrompt()`, or any prompt assembly code.** Sub-agent runbook prompt injection is already supported.
- **Modifying brainstorm A's selector** (`selectRunbooks` node, `selectedRunbooks` state field, aggregator filter). The selector stays orchestrator-scoped.
- **Modifying brainstorm A's tri-state state field, config schema, or router prompt.** None of it is affected by sub-agent runbooks.
- **Changing the facade pattern.** Sub-agents still declare `tools: [facade_name]` referencing parent-level tool YAMLs. No sub-agent gets its own `tools/` directory.
- **Cross-agent runbook references or linking.** Each runbook is self-contained. No `see also` links, no shared files.
- **Schema enforcement of the `## All Tools Used Are Read-Only` tail section convention for sub-agent runbooks.** The brainstorm B validator already enforces this for all runbooks including sub-agent ones after this extension lands.
- **Performance testing.** At current scale (zero sub-agent runbooks) there is nothing to measure.

## Architecture

### Existing infrastructure (no changes)

The load and prompt-assembly pipeline already handles sub-agent runbooks end-to-end. Documenting the path for reference:

```
loadAgent("agents/incident-analyzer")
  |-- reads orchestrator agent.yaml
  |-- reads orchestrator SOUL.md, RULES.md
  |-- reads orchestrator tools/*.yaml -> ToolDefinition[]
  |-- reads orchestrator skills/*/SKILL.md -> Map<name, content>
  |-- loadKnowledge("agents/incident-analyzer")
  |     `-- reads knowledge/index.yaml
  |     `-- walks each category dir, reads .md files
  |     `-- returns KnowledgeEntry[] with entries from runbooks/, systems-map/, slo-policies/
  `-- recurses into each sub-agent declared in manifest.agents:
        loadAgent("agents/incident-analyzer/agents/kafka-agent")
          |-- reads kafka-agent agent.yaml
          |-- reads kafka-agent SOUL.md
          |-- skips kafka-agent tools/*.yaml (no tools/ directory; isDirectory() returns false)
          |-- skips kafka-agent skills/*/SKILL.md (no skills/ directory)
          |-- loadKnowledge("agents/incident-analyzer/agents/kafka-agent")
          |     `-- returns [] today (no knowledge/index.yaml)
          |     `-- would return entries from knowledge/runbooks/*.md if the dir existed
          `-- returns LoadedAgent with knowledge: KnowledgeEntry[] (empty today)
```

Runtime assembly:

```
sub-agent.ts:153
  queryDataSource(state)
    -> const systemPrompt = buildSubAgentPrompt(agentName)
                              -> buildSystemPrompt(subAgent: LoadedAgent)
                                   -> appends subAgent.soul
                                   -> appends subAgent.rules (empty for current sub-agents)
                                   -> appends each active skill (empty for current sub-agents)
                                   -> appends buildKnowledgeSection(subAgent.knowledge)
                                        -> emits ## Knowledge Base > ### Runbooks > #### <filename>
                                           sections for each runbook
                                   -> returns the joined prompt
```

The only thing missing today is the content: no sub-agent has a populated `knowledge/runbooks/` directory. Create one and everything downstream works.

### What this spec adds

**Deliverable 1 — Policy documentation (this spec).** Declares the authoring rules and the authority rule, captured in the Authoring Policy and Authority Rule sections below.

**Deliverable 2 — Brainstorm B validator extension.** A follow-up amendment to `packages/gitagent-bridge/src/runbook-validator.test.ts` that:

- Extends the walk to recurse into `agents/*/agents/*/knowledge/runbooks/`.
- Adds a new helper `buildSubAgentAuthority(parentTools, subAgentFacadeNames)` that filters the parent's tools by the sub-agent's facade list and delegates to the existing `buildAuthority()`.
- Adds a new conditional `describe("real sub-agent runbook bindings")` block that emits one test per sub-agent runbook if any exist. Emits zero tests today.

**Deliverable 3 — Cross-reference notes.** Small edits to two existing files:

- Brainstorm A spec (`docs/superpowers/specs/2026-04-10-lazy-runbook-selection-design.md`): one paragraph clarifying selector scope.
- SIO-639 authoring guide (`docs/development/authoring-skills-and-runbooks.md`): one paragraph pointing to this spec.

## Authoring Policy

### When to author a sub-agent runbook

**Author one when:**

- A failure pattern requires deep, datasource-specific investigation steps inappropriate for a cross-datasource orchestrator runbook. Example: a Kafka rebalance loop diagnosis walking through consumer heartbeat timing, `session.timeout.ms`, and `group.initial.rebalance.delay.ms`.
- The sub-agent's tool surface is large and the LLM needs narrower guidance within the scope of a single invocation.
- A runbook would duplicate 80%+ of its content across sub-agents if authored at the orchestrator level; split it per datasource.

**Do not author one when:**

- The motivation is "consistency with other sub-agents." Each sub-agent decides independently.
- The orchestrator runbook is getting long. Long runbooks usually need editorial pruning, not a split.
- You want to test the capability. Unused runbooks burn prompt tokens.
- The need is speculative. Write when the need is concrete.

### Relationship to orchestrator runbooks

Sub-agent runbooks are **independent** of orchestrator runbooks. The same incident pattern can have coverage at both levels. The orchestrator runbook's perspective is cross-datasource correlation ("consumer lag + database slow queries = downstream bottleneck"). The sub-agent runbook's perspective is within-datasource deep-dive ("when lag grows on a specific partition, check offset commit timing, inspect `max.poll.interval.ms`"). Different audiences, different goals, different content.

Duplication is allowed. No `see also` links. No cross-references. No shared files. Each runbook stands alone.

### Directory structure when authoring the first sub-agent runbook

```
agents/incident-analyzer/agents/kafka-agent/
  agent.yaml                               # unchanged
  SOUL.md                                  # unchanged
  knowledge/                               # NEW
    index.yaml                             # NEW
    runbooks/                              # NEW
      kafka-rebalance-loop.md              # NEW (the actual runbook)
```

The `knowledge/index.yaml` follows the same schema as the orchestrator's:

```yaml
name: kafka-agent-knowledge
description: Deep-dive Kafka-specific runbooks for the kafka sub-agent
version: 0.1.0

categories:
  runbooks:
    path: runbooks/
    description: Kafka-specific operational runbooks
```

No `runbook_selection` block. Sub-agents do not opt into brainstorm A's lazy selection — see Interaction with Brainstorm A below.

### File conventions

Sub-agent runbooks follow the same conventions as the existing three orchestrator runbooks, enforced by the brainstorm B validator:

- Filename: kebab-case description ending in `.md`, e.g., `kafka-rebalance-loop.md`
- H1 heading with runbook name
- Prose sections for symptoms, investigation steps, escalation, recovery
- Inline tool names wrapped in single backticks: `` `kafka_describe_consumer_group` ``
- Mandatory tail section `## All Tools Used Are Read-Only` with comma-separated list of every tool cited in prose
- Fenced code blocks are allowed and are skipped by the validator

Authors do not learn a new convention. The only extra rule is the authority rule below.

## Authority Rule

A sub-agent runbook may only cite tool names that exist in the **intersection** of:

1. The parent agent's `action_tool_map` union (the global authority the brainstorm B validator uses for orchestrator runbooks), AND
2. The `action_tool_map` entries for the specific facades the sub-agent declared in its `agent.yaml:tools:` list.

Concrete example for `agents/incident-analyzer/agents/kafka-agent/agent.yaml` declaring `tools: [kafka-introspect]`:

- The parent's `agents/incident-analyzer/tools/` directory has `kafka-introspect.yaml`, `elastic-logs.yaml`, `couchbase-health.yaml`, `konnect-gateway.yaml`.
- Only `kafka-introspect.yaml` is in the kafka-agent's facade list.
- The sub-agent's runbook authority is the union of every tool name in `kafka-introspect.yaml`'s `action_tool_map` entries.
- A kafka-agent runbook citing `kafka_list_consumer_groups` → passes validation.
- A kafka-agent runbook citing `elasticsearch_search` → **fails validation**. The kafka sub-agent cannot call elasticsearch tools at runtime regardless of what a runbook says.

The rule is enforced by the validator extension, not by policy alone.

### Implementation of the intersection rule

The validator extension adds a helper in `packages/gitagent-bridge/src/runbook-validator.test.ts`:

```typescript
function buildSubAgentAuthority(
    parentTools: ToolDefinition[],
    subAgentFacadeNames: string[],
): Set<string> {
    const facadeSet = new Set(subAgentFacadeNames);
    const relevantTools = parentTools.filter((t) => facadeSet.has(t.name));
    return buildAuthority(relevantTools);
}
```

Delegates to the existing `buildAuthority(ToolDefinition[])` from SIO-641 after filtering. No change to `buildAuthority()`. No change to the validator's existing orchestrator-level tests.

## Interaction with Brainstorms A and B

### Brainstorm A (SIO-640): orchestrator-scoped

`selectRunbooks` operates on the orchestrator's `knowledge/runbooks/` only. Sub-agent runbooks are NEVER passed to the selector. Sub-agent runbooks behave like today's orchestrator runbooks behaved before brainstorm A — always-on reference material within the sub-agent's own prompt, no per-request selection, no filtering.

Consequences:
- Brainstorm A's `selectedRunbooks` state field and aggregator filter are unaffected.
- Sub-agent runbook authors do not configure `runbook_selection` in their `knowledge/index.yaml`.
- If a sub-agent accumulates many runbooks and they become noisy (the problem brainstorm A solves for the orchestrator), the solution is a separate brainstorm, not an extension of brainstorm A.

A one-paragraph cross-reference note is added to the brainstorm A spec making this scope explicit. No code or schema changes to SIO-640.

### Brainstorm B (SIO-641): extended to recurse

This spec's validator extension is a **follow-up amendment** to SIO-641, not a change to SIO-641's current scope. Rationale: SIO-641's plan is already committed with a self-contained TDD sequence. Amending that plan mid-flight risks breaking the step sequence. A new Linear issue for this spec's implementation keeps each change reviewable.

The extension:

- Extends `collectAgents()` (or adds a sibling `collectSubAgentFixtures()`) to walk sub-agent directories.
- Adds `buildSubAgentAuthority()` per above.
- Adds a conditional `describe("real sub-agent runbook bindings")` block that emits one test per sub-agent runbook if any exist.
- Emits zero sub-agent test cases today (no sub-agent runbooks exist).
- Picks up new sub-agent runbooks automatically via the directory walk the first time a file is created.

## Data Shapes

No new types in `loadAgent()` output. The existing `LoadedAgent.knowledge` and `LoadedAgent.subAgents.get(name).knowledge` are sufficient.

New local types in the validator test file (follow-up amendment to SIO-641):

```typescript
interface SubAgentFixture {
    parentName: string;              // directory basename of the parent agent, e.g. "incident-analyzer"
    subAgentName: string;             // directory basename of the sub-agent, e.g. "kafka-agent"
    parentTools: ToolDefinition[];    // from parent LoadedAgent.tools
    subAgent: LoadedAgent;            // from parentLoadedAgent.subAgents.get(subAgentName)
    runbookPaths: string[];           // absolute paths to sub-agent runbooks
}
```

Names are directory basenames (the folder name under `agents/`), not manifest names. This matches how SIO-641's existing `AgentFixture.name` is populated. The `subAgent.manifest.tools` field (a `string[]` of facade names declared in the sub-agent's `agent.yaml`) is what `buildSubAgentAuthority()` intersects against `parentTools`.

The `SubAgentFixture` type lives only in the validator test file, same pattern as the existing `AgentFixture` in SIO-641.

## Testing

### Unit tests for the validator extension (synthetic inline fixtures)

| Group | Test |
|---|---|
| `buildSubAgentAuthority` | facade in sub-agent list + tool in action_tool_map → included |
| | facade in sub-agent list + tool NOT in that facade's action_tool_map → excluded |
| | facade NOT in sub-agent list → entire facade's tools excluded |
| | sub-agent declares empty `tools:` list → authority is empty set |
| | sub-agent declares unknown facade name → silently skipped, no crash, authority contains only recognized facades |
| `collectSubAgentFixtures` | parent with sub-agents that have `knowledge/runbooks/` → fixtures emitted, one per runbook |
| | parent with sub-agents but no `knowledge/` → no sub-agent fixtures |
| | parent without `agents/` subdirectory → no sub-agent fixtures |
| | sub-agent's `knowledge/runbooks/` exists but is empty (.gitkeep only) → no sub-agent fixtures |
| | nested sub-agent (sub-sub-agent) → not supported, not tested |

### Production validation block

```typescript
describe("real sub-agent runbook bindings", () => {
    const subAgentFixtures = collectSubAgentFixtures(PRODUCTION_FIXTURES);
    for (const fixture of subAgentFixtures) {
        describe(`${fixture.parentName} > ${fixture.subAgentName}`, () => {
            const authority = buildSubAgentAuthority(
                fixture.parentTools,
                fixture.subAgent.manifest.tools ?? [],
            );

            for (const runbookPath of fixture.runbookPaths) {
                const basename = runbookPath.split("/").pop() ?? runbookPath;
                test(`${basename} is clean`, () => {
                    const content = readFileSync(runbookPath, "utf-8");
                    const report = validateRunbook(runbookPath, content, authority);
                    if (!isClean(report)) {
                        throw new Error("\n" + formatReport(report));
                    }
                });
            }
        });
    }
});
```

Emits zero tests today. The `describe("real sub-agent runbook bindings")` block is present and valid — `bun:test` allows empty describe blocks without warnings — but contains no nested `describe` or `test` calls because `collectSubAgentFixtures()` returns an empty array. The first sub-agent runbook created by any future author automatically adds a test case via this loop, with no boilerplate.

### What we do NOT test

- **Brainstorm A selector with sub-agent runbooks.** No code path connects them. No test is meaningful.
- **Runtime prompt assembly for sub-agents.** `buildSubAgentPrompt()` → `buildSystemPrompt()` → `agent.knowledge` is existing code from SIO-639's `skill-loader.ts`. Not our bug surface.
- **Performance.** Zero runbooks today. Nothing to measure.
- **Nested sub-agents** (sub-sub-agents). Not a pattern in this project; not supported by the walk.
- **Sub-agents with their own `tools/` directories.** Not a pattern in this project. If a future sub-agent adopts this, the intersection rule still applies to the parent's tools and the sub-agent's own tools are ignored. Deliberate preservation of the facade pattern. Not tested because the hypothetical doesn't exist.

## Rollout

1. Land this spec.
2. Write the implementation plan via `superpowers:writing-plans`.
3. Create Linear issue (Phase 2C) with implementation steps. The issue depends on SIO-641 (brainstorm B) merging first.
4. Implement the validator extension in a single commit or small series, following the plan.
5. Add the cross-reference paragraphs to the SIO-640 spec and SIO-639 authoring guide in the same PR as the validator extension.
6. Merge. On next `bun test`, the validator runs with the new sub-agent walk. Zero new tests emitted (no sub-agent runbooks exist). No behavior change for anything else.
7. When a future author creates the first sub-agent runbook, they follow the authoring policy documented here. The validator picks it up automatically on the next `bun test`.

## Open Questions

None at spec time.

## Appendix: Alternatives Considered

**Modifying `loadAgent()` to build a per-sub-agent runbook catalog.** Rejected. `loadAgent()` already produces a complete `LoadedAgent` for each sub-agent, including `knowledge: KnowledgeEntry[]`. The validator can filter that field to the runbooks category on its own. No loader change needed.

**Sub-agents get a copy of the orchestrator's runbooks by default.** Rejected. Forces all sub-agents to carry cross-datasource content that's irrelevant to their scope. Burns prompt tokens for material the sub-agent can't act on. Wrong default.

**Sub-agent runbooks are pointers to orchestrator runbooks with sub-agent-specific appendices.** Rejected. Introduces a new citation convention (the pointer syntax), couples two files that are currently independent, and makes the validator more complex for a marginal DRY win. The "independent, no coupling" policy is simpler and handles the duplication problem by accepting that some duplication is fine when perspectives differ.

**Only one runbook per incident pattern allowed, either at orchestrator or sub-agent level but not both.** Rejected. Forces a false binary on patterns that benefit from coverage at multiple levels. Some incidents genuinely need both a cross-datasource correlation view and a within-datasource deep-dive view.

**Extend brainstorm A's selector to operate per-agent.** Rejected. Doubles LLM hops for the selector (one call per sub-agent). Breaks brainstorm A's aggregator-only-consumer design. Adds complexity for a problem no sub-agent has today (there are zero sub-agent runbooks).

**Extend brainstorm A's selector to pick across a flat global catalog including sub-agent runbooks.** Rejected. Requires the aggregator filter to know which runbook was chosen from which agent, which means runbook content needs to be passed across the orchestrator-sub-agent boundary at prompt-build time. Conflates two mechanisms that are cleaner when kept separate.

**Validator uses parent's full authority set for sub-agent runbooks.** Rejected. Would pass runbooks that cite tools the sub-agent cannot actually invoke at runtime, defeating the purpose of validation. The intersection rule enforces semantic correctness.

**Each sub-agent has its own `tools/` directory with local tool YAMLs.** Rejected. Breaks the current facade pattern where sub-agents reference parent-level tools by name. Would require changes to `loadAgent()`, `sub-agent.ts`, and runtime tool resolution. Pattern overhaul for a problem the current pattern handles correctly.

**Seed sub-agent runbook content as part of this spec's implementation.** Rejected. Speculative content burns prompt tokens without a concrete use case. The capability is documented; seeding is deferred until a real need emerges. YAGNI.

**Write the validator extension inside SIO-641's existing plan rather than as a follow-up amendment.** Rejected. SIO-641's scope is self-contained (the top-level orchestrator validator with its own TDD sequence). Mixing this extension into SIO-641 would combine two independent improvements in one PR, making each harder to review. A separate Linear issue keeps each change reviewable and preserves the option to land either one without the other.
