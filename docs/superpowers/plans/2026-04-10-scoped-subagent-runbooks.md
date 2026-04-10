# Scoped Sub-Agent Runbooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the brainstorm B runbook validator (from SIO-641) with sub-agent recursion, add the intersection-authority helper, add 9 unit tests and a conditional production describe block, and add two cross-reference paragraphs in the SIO-640 spec and SIO-639 authoring guide.

**Architecture:** Amends a single file created by SIO-641's implementation (`packages/gitagent-bridge/src/runbook-validator.test.ts`) plus two documentation files. No runtime code changes anywhere. No new packages, no new types on `LoadedAgent`, no new config schemas. The extension reuses `loadAgent()`'s existing sub-agent recursion (parent's `LoadedAgent.subAgents` Map is already populated at load time).

**Tech Stack:** Bun 1.3.9+, TypeScript 5.x strict, `bun:test` with `describe`/`test`/`expect`, `node:fs` (already imported by the SIO-641 test file), `loadAgent()` and `ToolDefinition` and `LoadedAgent` from `@devops-agent/gitagent-bridge`.

**Source spec:** `docs/superpowers/specs/2026-04-10-scoped-subagent-runbooks-design.md` — read first for full policy and rationale.

**Linear issue:** SIO-642

---

## Hard Prerequisite: SIO-641 Must Be Implemented First

This plan amends `packages/gitagent-bridge/src/runbook-validator.test.ts`, a file that is **created by SIO-641's implementation plan**, not by this one. The SIO-641 spec and plan are committed on the branch, but the actual implementation (which produces the file) is separate work.

**Before starting Task 1 of this plan:**

1. Verify SIO-641 has been implemented and the file exists.
2. If it does not exist, stop. Implement SIO-641 first per its own plan at `docs/superpowers/plans/2026-04-10-runbook-tool-binding-validator.md`, then return to this plan.
3. If SIO-641 is merged to main but this branch hasn't picked it up, rebase or merge appropriately before continuing.

Task 0 below performs the verification explicitly and halts if the prerequisite is missing.

---

## Spec Deviations

One deviation from the spec:

1. **`collectSubAgentFixtures()` walks `parent.subAgents: Map<string, LoadedAgent>` from the already-loaded parent, not the filesystem.** The spec described the helper as walking `agents/*/agents/*/knowledge/runbooks/` on disk. In practice, `loadAgent()` has already recursed into sub-agents and populated `LoadedAgent.subAgents`, so the parent's `AgentFixture` (from SIO-641's `collectAgents()`) already has every sub-agent's `LoadedAgent` in memory. The helper iterates that map and produces one `SubAgentFixture` per sub-agent that has non-empty `knowledge: KnowledgeEntry[]` with runbook category entries. This is simpler, DRY with SIO-641's pattern, and avoids a second filesystem walk.

   Concretely: `collectSubAgentFixtures()` does NOT call `readdirSync`. It iterates `parent.agent.subAgents.entries()` and filters by `subAgent.knowledge.some(e => e.category === "runbooks")`. For each surviving sub-agent, it extracts `.md` filenames from `subAgent.knowledge` (already loaded) and reconstructs the absolute paths via `join(parentAgentDir, "agents", subAgentName, "knowledge", "runbooks", filename)`.

   Trade-off: the helper needs `parentAgentDir` for path reconstruction, but the `AgentFixture` from SIO-641 already carries `agentDir` (see the plan for Task 1 of SIO-641 which defined `AgentFixture` with an `agent: LoadedAgent` but not `agentDir`). If the shipped SIO-641 `AgentFixture` does not include `agentDir`, Task 1 of THIS plan adds it — see below.

All other spec details are implemented as written.

---

## File Structure

**Modify:**
- `packages/gitagent-bridge/src/runbook-validator.test.ts` — add `SubAgentFixture` type, `buildSubAgentAuthority()` and `collectSubAgentFixtures()` helpers, 9 unit tests, conditional production describe block
- `docs/superpowers/specs/2026-04-10-lazy-runbook-selection-design.md` — one cross-reference paragraph
- `docs/development/authoring-skills-and-runbooks.md` — one paragraph pointing to the brainstorm C spec

**Create:** Nothing

**Do not modify:**
- Any `.ts` file in `packages/gitagent-bridge/src/` other than `runbook-validator.test.ts`
- Any `.ts` file in `packages/agent/src/`
- Any `agent.yaml`, `knowledge/index.yaml`, or runbook file
- Any `tools/*.yaml` file
- `manifest-loader.ts`, `skill-loader.ts`, `prompt-context.ts`, `sub-agent.ts`, `buildSystemPrompt`, `buildSubAgentPrompt`, `loadAgent`, or any runtime code

---

## Task 0: Verify SIO-641 is implemented

**Goal:** Hard-fail before any code changes if the prerequisite file is missing.

**Files:** None

- [ ] **Step 1: Verify the validator file exists**

Run: `ls packages/gitagent-bridge/src/runbook-validator.test.ts 2>&1`
Expected: the file path is printed (no error).

If the file does not exist: **STOP.** SIO-641 has not been implemented yet. Do not proceed with this plan. Implement SIO-641 first per `docs/superpowers/plans/2026-04-10-runbook-tool-binding-validator.md`, then return here.

- [ ] **Step 2: Verify SIO-641's test suite passes**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: all tests pass (37 extractor unit tests + 3 production tests = 40 tests per the SIO-641 plan).

If tests fail: SIO-641 is in an incomplete state. Stop and fix SIO-641 before continuing.

- [ ] **Step 3: Verify the `AgentFixture` type exists with expected shape**

Run: `grep -A 5 "interface AgentFixture" packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: output shows the `AgentFixture` interface with at least `name: string`, `agent: LoadedAgent`, and `runbookPaths: string[]` fields.

- [ ] **Step 4: Check whether `AgentFixture` already carries `agentDir`**

Run: `grep -E "agentDir|parentDir" packages/gitagent-bridge/src/runbook-validator.test.ts | head -5`
Expected: either `agentDir: string` appears in the `AgentFixture` definition, OR the field is absent.

Record the result:
- **If `agentDir` is present:** Task 1 below is a no-op (skip its implementation step, just mark it complete).
- **If `agentDir` is absent:** Task 1 adds it.

- [ ] **Step 5: No commit**

Verification only.

---

## Task 1: Add `agentDir` to `AgentFixture` (conditional)

**Goal:** Ensure the existing `AgentFixture` interface carries an absolute path to the agent directory, so `collectSubAgentFixtures()` can reconstruct sub-agent runbook paths without re-walking the filesystem.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

**If Task 0 Step 4 showed `agentDir` is already present:** Skip this task entirely. Mark all steps complete without running them.

**If `agentDir` is absent:**

- [ ] **Step 1: Read the current `AgentFixture` definition**

Run: `grep -n "interface AgentFixture" packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: a single match with a line number.

- [ ] **Step 2: Add `agentDir` to the interface**

Find the `AgentFixture` interface and add the new field:

```typescript
interface AgentFixture {
    name: string;              // e.g. "incident-analyzer"
    agentDir: string;          // absolute path to agents/<name>/
    agent: LoadedAgent;        // parsed via loadAgent()
    runbookPaths: string[];    // absolute paths to each .md in knowledge/runbooks/
}
```

- [ ] **Step 3: Update `collectAgents()` to populate `agentDir`**

Find the `collectAgents` function and add `agentDir: agentDir` (or equivalently `agentDir`) to the fixture object it pushes. The variable `agentDir` is already in scope inside the function per SIO-641's plan Step 3 of Task 7.

Example of the change:

```typescript
// Before:
fixtures.push({ name: entry, agent, runbookPaths });

// After:
fixtures.push({ name: entry, agentDir, agent, runbookPaths });
```

- [ ] **Step 4: Run the existing test suite**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: all 40 tests still pass. The `agentDir` addition is additive and does not break existing assertions.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-642: Add agentDir field to AgentFixture

Carries the absolute path to each agent's directory so sub-agent
runbook path reconstruction in collectSubAgentFixtures() can avoid
a second filesystem walk. Additive change; existing tests unaffected.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `SubAgentFixture` type and `buildSubAgentAuthority` helper with TDD

**Goal:** Add the new type and the authority-intersection helper. Test the helper against synthetic fixtures covering all 5 cases from the spec.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Add the `SubAgentFixture` type definition**

Find the existing `AgentFixture` interface in `runbook-validator.test.ts` and add this new interface immediately after it:

```typescript
interface SubAgentFixture {
    parentName: string;              // directory basename of the parent, e.g. "incident-analyzer"
    subAgentName: string;             // directory basename of the sub-agent, e.g. "kafka-agent"
    parentTools: ToolDefinition[];    // from parent LoadedAgent.tools
    subAgent: LoadedAgent;            // from parent LoadedAgent.subAgents.get(subAgentName)
    runbookPaths: string[];           // absolute paths to sub-agent runbooks
}
```

- [ ] **Step 2: Add a stub for `buildSubAgentAuthority`**

Find where `buildAuthority()` is defined in the file and add the new helper immediately after it:

```typescript
function buildSubAgentAuthority(
    parentTools: ToolDefinition[],
    subAgentFacadeNames: string[],
): Set<string> {
    // Task 2: implemented in Step 5
    return new Set();
}
```

- [ ] **Step 3: Write the failing tests for `buildSubAgentAuthority`**

Find the existing `describe("buildAuthority", () => {...})` block and add a new describe block immediately after it:

```typescript
describe("buildSubAgentAuthority", () => {
    const makeTool = (name: string, actionMap: Record<string, string[]>): ToolDefinition =>
        ({
            name,
            description: "test",
            input_schema: { type: "object", properties: {} },
            tool_mapping: {
                mcp_server: name,
                mcp_patterns: [`${name}_*`],
                action_tool_map: actionMap,
            },
        }) as ToolDefinition;

    const parentTools: ToolDefinition[] = [
        makeTool("kafka-introspect", {
            consumer_lag: ["kafka_list_consumer_groups", "kafka_get_consumer_group_lag"],
            topic_info: ["kafka_list_topics", "kafka_describe_topic"],
        }),
        makeTool("elastic-logs", {
            search: ["elasticsearch_search", "elasticsearch_count_documents"],
        }),
        makeTool("couchbase-health", {
            vitals: ["capella_get_system_vitals"],
        }),
    ];

    test("facade in sub-agent list + tool in action_tool_map -> included", () => {
        const authority = buildSubAgentAuthority(parentTools, ["kafka-introspect"]);
        expect(authority.has("kafka_list_consumer_groups")).toBe(true);
        expect(authority.has("kafka_get_consumer_group_lag")).toBe(true);
        expect(authority.has("kafka_list_topics")).toBe(true);
        expect(authority.has("kafka_describe_topic")).toBe(true);
    });

    test("facade NOT in sub-agent list -> entire facade's tools excluded", () => {
        const authority = buildSubAgentAuthority(parentTools, ["kafka-introspect"]);
        expect(authority.has("elasticsearch_search")).toBe(false);
        expect(authority.has("elasticsearch_count_documents")).toBe(false);
        expect(authority.has("capella_get_system_vitals")).toBe(false);
    });

    test("multiple facades in list -> union of their tools", () => {
        const authority = buildSubAgentAuthority(parentTools, ["kafka-introspect", "elastic-logs"]);
        expect(authority.has("kafka_list_consumer_groups")).toBe(true);
        expect(authority.has("elasticsearch_search")).toBe(true);
        expect(authority.has("capella_get_system_vitals")).toBe(false);
        expect(authority.size).toBe(6); // 4 kafka + 2 elastic
    });

    test("empty facade list -> empty authority set", () => {
        const authority = buildSubAgentAuthority(parentTools, []);
        expect(authority.size).toBe(0);
    });

    test("unknown facade name -> silently skipped, authority contains only recognized facades", () => {
        const authority = buildSubAgentAuthority(parentTools, ["kafka-introspect", "bogus-facade"]);
        expect(authority.has("kafka_list_consumer_groups")).toBe(true);
        expect(authority.size).toBe(4); // only the 4 kafka tools; bogus-facade silently ignored
    });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "buildSubAgentAuthority"`
Expected: FAIL (5 failures). The stub returns an empty set, so all "has(...)" assertions fail.

- [ ] **Step 5: Implement `buildSubAgentAuthority`**

Replace the stub with:

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

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "buildSubAgentAuthority"`
Expected: 5 pass, 0 fail.

- [ ] **Step 7: Run the full validator test file to check for regressions**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: 45 tests pass (40 from SIO-641 + 5 new).

- [ ] **Step 8: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-642: Add buildSubAgentAuthority helper with 5 unit tests

Filters parent tools by the sub-agent's declared facade list, then
delegates to the existing buildAuthority() from SIO-641. Unknown
facade names are silently skipped. Empty facade list produces empty
authority set. 5 tests cover: single facade, multi-facade union,
facade exclusion, empty list, unknown facade.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `collectSubAgentFixtures` helper with TDD

**Goal:** Walk each `AgentFixture.agent.subAgents` map and produce one `SubAgentFixture` per sub-agent that has non-empty runbook knowledge entries. Reconstruct absolute paths using the parent's `agentDir`.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Add a stub for `collectSubAgentFixtures`**

Find the existing `collectAgents()` function in the file and add the new helper immediately after it:

```typescript
function collectSubAgentFixtures(parentFixtures: AgentFixture[]): SubAgentFixture[] {
    // Task 3: implemented in Step 4
    return [];
}
```

- [ ] **Step 2: Write the failing tests**

Find the existing `describe("collectAgents", () => {...})` block and add a new describe block immediately after it:

```typescript
describe("collectSubAgentFixtures", () => {
    function makeParentFixture(overrides: {
        subAgents?: Map<string, LoadedAgent>;
        agentDir?: string;
    } = {}): AgentFixture {
        return {
            name: "test-parent",
            agentDir: overrides.agentDir ?? "/fake/parent",
            agent: {
                manifest: { name: "test-parent" } as any,
                soul: "",
                rules: "",
                tools: [],
                skills: new Map(),
                subAgents: overrides.subAgents ?? new Map(),
                knowledge: [],
            } as unknown as LoadedAgent,
            runbookPaths: [],
        };
    }

    function makeSubAgent(facades: string[], knowledge: Array<{ category: string; filename: string; content: string }>): LoadedAgent {
        return {
            manifest: { name: "sub", tools: facades } as any,
            soul: "",
            rules: "",
            tools: [],
            skills: new Map(),
            subAgents: new Map(),
            knowledge,
        } as unknown as LoadedAgent;
    }

    test("parent with sub-agent that has runbook knowledge -> fixture emitted", () => {
        const subAgents = new Map<string, LoadedAgent>();
        subAgents.set(
            "kafka-agent",
            makeSubAgent(["kafka-introspect"], [
                { category: "runbooks", filename: "kafka-rebalance.md", content: "# Test" },
            ]),
        );
        const parent = makeParentFixture({ subAgents, agentDir: "/fake/parent" });
        const fixtures = collectSubAgentFixtures([parent]);
        expect(fixtures).toHaveLength(1);
        expect(fixtures[0].parentName).toBe("test-parent");
        expect(fixtures[0].subAgentName).toBe("kafka-agent");
        expect(fixtures[0].runbookPaths).toHaveLength(1);
        expect(fixtures[0].runbookPaths[0]).toBe(
            "/fake/parent/agents/kafka-agent/knowledge/runbooks/kafka-rebalance.md",
        );
    });

    test("parent with sub-agents but no knowledge -> no fixtures", () => {
        const subAgents = new Map<string, LoadedAgent>();
        subAgents.set("kafka-agent", makeSubAgent(["kafka-introspect"], []));
        const parent = makeParentFixture({ subAgents });
        expect(collectSubAgentFixtures([parent])).toHaveLength(0);
    });

    test("parent with sub-agent that has non-runbook knowledge only -> no fixture", () => {
        const subAgents = new Map<string, LoadedAgent>();
        subAgents.set(
            "kafka-agent",
            makeSubAgent(["kafka-introspect"], [
                { category: "systems-map", filename: "topology.md", content: "# Topology" },
            ]),
        );
        const parent = makeParentFixture({ subAgents });
        expect(collectSubAgentFixtures([parent])).toHaveLength(0);
    });

    test("parent without sub-agents -> no fixtures", () => {
        const parent = makeParentFixture();
        expect(collectSubAgentFixtures([parent])).toHaveLength(0);
    });

    test("parent with multiple sub-agents, some with runbooks -> fixtures for only those with runbooks", () => {
        const subAgents = new Map<string, LoadedAgent>();
        subAgents.set("elastic-agent", makeSubAgent(["elastic-logs"], []));
        subAgents.set(
            "kafka-agent",
            makeSubAgent(["kafka-introspect"], [
                { category: "runbooks", filename: "rb1.md", content: "# RB1" },
                { category: "runbooks", filename: "rb2.md", content: "# RB2" },
            ]),
        );
        subAgents.set("capella-agent", makeSubAgent(["couchbase-health"], []));
        const parent = makeParentFixture({ subAgents, agentDir: "/p" });
        const fixtures = collectSubAgentFixtures([parent]);
        expect(fixtures).toHaveLength(1);
        expect(fixtures[0].subAgentName).toBe("kafka-agent");
        expect(fixtures[0].runbookPaths).toHaveLength(2);
        expect(fixtures[0].runbookPaths.sort()).toEqual([
            "/p/agents/kafka-agent/knowledge/runbooks/rb1.md",
            "/p/agents/kafka-agent/knowledge/runbooks/rb2.md",
        ]);
    });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "collectSubAgentFixtures"`
Expected: FAIL (5 failures). The stub returns an empty array.

- [ ] **Step 4: Implement `collectSubAgentFixtures`**

Replace the stub with:

```typescript
function collectSubAgentFixtures(parentFixtures: AgentFixture[]): SubAgentFixture[] {
    const fixtures: SubAgentFixture[] = [];

    for (const parent of parentFixtures) {
        for (const [subAgentName, subAgent] of parent.agent.subAgents) {
            // Extract runbook entries from the already-loaded knowledge
            const runbookEntries = subAgent.knowledge.filter((e) => e.category === "runbooks");
            if (runbookEntries.length === 0) continue;

            // Reconstruct absolute paths for each runbook file
            const runbookPaths = runbookEntries.map((entry) =>
                join(parent.agentDir, "agents", subAgentName, "knowledge", "runbooks", entry.filename),
            );

            fixtures.push({
                parentName: parent.name,
                subAgentName,
                parentTools: parent.agent.tools,
                subAgent,
                runbookPaths,
            });
        }
    }

    return fixtures;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "collectSubAgentFixtures"`
Expected: 5 pass, 0 fail.

- [ ] **Step 6: Run the full validator test file to check for regressions**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: 50 tests pass (45 from Task 2 + 5 new).

- [ ] **Step 7: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-642: Add collectSubAgentFixtures helper with 5 unit tests

Walks the already-loaded parent.subAgents Map instead of re-walking
the filesystem. Filters sub-agents to those with non-empty runbook
knowledge entries. Reconstructs absolute runbook paths from each
parent's agentDir. 5 tests cover: happy path, no knowledge, non-
runbook knowledge only, no sub-agents, multi-sub-agent filtering.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add the conditional production describe block

**Goal:** Emit one test per sub-agent runbook when any sub-agent has runbook knowledge. Emits zero tests today.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Add the production describe block**

Find the existing `describe("real agent runbook bindings", () => {...})` block (added in SIO-641's Task 8). Add a new describe block immediately after it:

```typescript
// ============================================================================
// Production validation - real sub-agent runbooks (SIO-642)
// ============================================================================

const SUB_AGENT_FIXTURES = collectSubAgentFixtures(PRODUCTION_FIXTURES);

describe("real sub-agent runbook bindings", () => {
    for (const fixture of SUB_AGENT_FIXTURES) {
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

- [ ] **Step 2: Run the test file**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: 50 tests pass. The new `describe("real sub-agent runbook bindings")` block exists but emits zero test cases because `SUB_AGENT_FIXTURES` is empty (no sub-agent has a `knowledge/` directory today).

Verify this explicitly: run the test with verbose output to confirm the block is present:

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts --reporter=verbose 2>&1 | grep "real sub-agent" || echo "block not visible in output"`
Expected: either the describe block name appears in the verbose output, or "block not visible" (depending on how bun:test reports empty blocks — both outcomes are acceptable because the test suite still passes).

- [ ] **Step 3: Manual end-to-end verification with a synthetic sub-agent runbook**

This step proves the walk works end-to-end without committing any sub-agent runbook content. Create the minimal structure temporarily:

```bash
mkdir -p agents/incident-analyzer/agents/kafka-agent/knowledge/runbooks
cat > agents/incident-analyzer/agents/kafka-agent/knowledge/index.yaml << 'EOF'
name: kafka-agent-knowledge
description: Deep-dive Kafka runbooks
version: 0.1.0

categories:
  runbooks:
    path: runbooks/
    description: Kafka-specific operational runbooks
EOF
cat > agents/incident-analyzer/agents/kafka-agent/knowledge/runbooks/test-rebalance.md << 'EOF'
# Test: Kafka Rebalance Loop

## Investigation
Use `kafka_list_consumer_groups` to enumerate groups. Use `kafka_describe_consumer_group` to inspect state.

## All Tools Used Are Read-Only
kafka_list_consumer_groups, kafka_describe_consumer_group
EOF
```

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: 51 tests pass. The new test `test-rebalance.md is clean` under `real sub-agent runbook bindings > incident-analyzer > kafka-agent` appears and passes.

Inspect the verbose output to confirm the test ran:

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts --reporter=verbose 2>&1 | grep "test-rebalance"`
Expected: the test name appears in the output with a pass indicator.

- [ ] **Step 4: Verify the walk catches a bad citation**

Edit the synthetic runbook to cite a tool not in the kafka-introspect facade:

```bash
cat > agents/incident-analyzer/agents/kafka-agent/knowledge/runbooks/test-rebalance.md << 'EOF'
# Test: Kafka Rebalance Loop

## Investigation
Use `kafka_list_consumer_groups` and also `elasticsearch_search` for logs.

## All Tools Used Are Read-Only
kafka_list_consumer_groups, elasticsearch_search
EOF
```

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "test-rebalance"`
Expected: **FAIL.** The failure message should contain:
- `Missing from action_tool_map (2):` (both `elasticsearch_search` occurrences — one from prose, one from tail)
- `line 4: elasticsearch_search` and `line 7: elasticsearch_search`

The kafka-agent's facade list is `[kafka-introspect]`, so `elasticsearch_search` is not in the sub-agent's authority intersection even though it exists in the parent's full authority set.

If the test does not fail with this message, the validator extension has a bug. Debug and fix before continuing.

- [ ] **Step 5: Revert the synthetic content**

```bash
rm -rf agents/incident-analyzer/agents/kafka-agent/knowledge
```

Run: `git status`
Expected: no changes to `agents/incident-analyzer/agents/kafka-agent/` — only the `packages/gitagent-bridge/src/runbook-validator.test.ts` change from this task plus any previous staged work.

- [ ] **Step 6: Final test run on clean state**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: 50 tests pass. No sub-agent runbook tests appear because `SUB_AGENT_FIXTURES` is empty again.

- [ ] **Step 7: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-642: Add conditional production describe block for sub-agents

Emits one test per sub-agent runbook when any sub-agent has
knowledge/runbooks/ entries. Emits zero tests today because no
sub-agent has a knowledge/ directory. Verified end-to-end with a
synthetic kafka-agent runbook: the walk discovers it, validates
against the intersection authority (kafka-introspect only), and
correctly fails when the runbook cites elasticsearch_search.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add cross-reference paragraph to the SIO-640 spec

**Goal:** Add one paragraph to the brainstorm A spec clarifying that `selectRunbooks` operates on orchestrator runbooks only.

**Files:**
- Modify: `docs/superpowers/specs/2026-04-10-lazy-runbook-selection-design.md`

- [ ] **Step 1: Locate the insertion point**

Run: `grep -n "Non-Goals" docs/superpowers/specs/2026-04-10-lazy-runbook-selection-design.md`
Expected: a line number for the `## Non-Goals` heading.

- [ ] **Step 2: Add the cross-reference under Non-Goals**

Find the `## Non-Goals` section (around line 22-30 per the SIO-640 spec). The section is a bullet list. Add a new bullet to the end of the list:

```markdown
- **Sub-agent runbooks.** The `selectRunbooks` node operates on the orchestrator's `knowledge/runbooks/` only. Sub-agent runbooks (a capability documented by SIO-642) are NEVER passed to the selector. Sub-agent runbooks behave as always-on reference material within each sub-agent's own system prompt, a separate mechanism from the orchestrator's lazy selection. See `docs/superpowers/specs/2026-04-10-scoped-subagent-runbooks-design.md` for the full policy.
```

The exact text above is the cross-reference paragraph. Place it as the last bullet in the Non-Goals list.

- [ ] **Step 3: Verify the link path resolves**

Run: `ls docs/superpowers/specs/2026-04-10-scoped-subagent-runbooks-design.md`
Expected: the file exists (this is the SIO-642 spec committed earlier in this work stream).

- [ ] **Step 4: Run lint**

Run: `bun run lint 2>&1 | grep -i error | head -10`
Expected: no new errors attributable to this change. (Biome doesn't lint markdown, so this is a sanity check only.)

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-04-10-lazy-runbook-selection-design.md
git commit -m "SIO-642: Add cross-reference in SIO-640 spec for selector scope

One bullet added under the brainstorm A spec's Non-Goals section
clarifying that selectRunbooks operates on orchestrator runbooks
only. Sub-agent runbooks are a separate mechanism documented in
SIO-642.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Add cross-reference paragraph to the SIO-639 authoring guide

**Goal:** Add one paragraph to the authoring guide pointing to the brainstorm C spec.

**Files:**
- Modify: `docs/development/authoring-skills-and-runbooks.md`

- [ ] **Step 1: Locate the insertion point**

Run: `grep -n "^## " docs/development/authoring-skills-and-runbooks.md`
Expected: a list of section headings. Identify the section about authoring runbooks (the section title from SIO-639 is something like "Authoring a Runbook" — verify the exact name).

- [ ] **Step 2: Add a new subsection at the bottom of the file**

Append to `docs/development/authoring-skills-and-runbooks.md` (before the `## Related` section if one exists, otherwise at the very end):

```markdown
## Sub-Agent Runbooks (advanced)

Sub-agents (e.g., `kafka-agent`, `capella-agent`) can have their own `knowledge/runbooks/` directories with deep, datasource-specific runbooks that are NOT shared with the orchestrator. This is supported by the existing `loadAgent()` and `buildSubAgentPrompt()` code paths with zero additional configuration — drop a `knowledge/index.yaml` and one or more `runbooks/*.md` files into `agents/incident-analyzer/agents/<sub-agent-name>/knowledge/` and the sub-agent sees them in its system prompt automatically.

Sub-agent runbooks are subject to a **strict authority rule**: a sub-agent runbook may only cite tool names that exist in the intersection of (the parent agent's tool facades) AND (the sub-agent's declared `tools:` list from its `agent.yaml`). A `kafka-agent` runbook citing `elasticsearch_search` fails validation because the kafka sub-agent cannot actually call elasticsearch tools at runtime.

The SIO-642 extension of the runbook tool-name validator (SIO-641) enforces this rule statically. See `docs/superpowers/specs/2026-04-10-scoped-subagent-runbooks-design.md` for the full policy: when to author a sub-agent runbook, relationship to orchestrator runbooks (independent, duplication allowed, no cross-referencing), directory structure, and the authoring conventions.

**No sub-agent runbooks exist in this repository today.** The capability is documented and validated; seeding is deferred until a concrete need emerges.
```

- [ ] **Step 3: Verify the link path resolves**

Run: `ls docs/superpowers/specs/2026-04-10-scoped-subagent-runbooks-design.md`
Expected: the file exists.

- [ ] **Step 4: Run lint**

Run: `bun run lint 2>&1 | grep -i error | head -10`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add docs/development/authoring-skills-and-runbooks.md
git commit -m "SIO-642: Add sub-agent runbooks section to authoring guide

New 'Sub-Agent Runbooks (advanced)' subsection explaining the
capability, the directory structure, and the strict authority rule
(intersection of parent facades and sub-agent tools: list). Points
to the full SIO-642 spec. Notes that no sub-agent runbooks exist
today; seeding is deferred until a concrete need.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full workspace verification

**Goal:** One final gate before PR creation. Verify the entire workspace is healthy.

**Files:** None

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: all tests pass across all packages, including the 50 total tests in `packages/gitagent-bridge/src/runbook-validator.test.ts` (40 from SIO-641 + 5 from Task 2 + 5 from Task 3).

- [ ] **Step 2: Full workspace typecheck**

Run: `bun run typecheck`
Expected: clean across all packages.

- [ ] **Step 3: Full workspace lint**

Run: `bun run lint`
Expected: no new Biome warnings attributable to this change.

- [ ] **Step 4: YAML check**

Run: `bun run yaml:check`
Expected: clean. (No YAML was touched, so this is a sanity check.)

- [ ] **Step 5: Verify file change scope**

Run: `git diff --name-only $(git merge-base HEAD main)...HEAD`
Expected: exactly three modified files:
- `packages/gitagent-bridge/src/runbook-validator.test.ts`
- `docs/superpowers/specs/2026-04-10-lazy-runbook-selection-design.md`
- `docs/development/authoring-skills-and-runbooks.md`

If additional files appear, investigate before proceeding.

- [ ] **Step 6: No commit**

Verification only. If any step fails, stop and fix before proceeding to Task 8.

---

## Task 8: PR prep

**Goal:** Push and create the PR.

- [ ] **Step 1: Push the branch**

Run: `git push origin simonowusupvh/sio-621-standardize-mcp-server-structure-across-all-4-packages`
Expected: push succeeds.

(Note: this work stacks on the SIO-621 branch alongside all other Phase 1 and Phase 2 work per the user's chosen strategy. If you prefer a separate branch, branch off SIO-621 at the start of Task 1 before running the validator extension.)

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "SIO-642: Scoped sub-agent runbooks (Phase 2C)" --body "$(cat <<'EOF'
## Summary

- Extends the SIO-641 validator with `buildSubAgentAuthority()` and `collectSubAgentFixtures()`
- Adds a conditional production describe block that emits one test per sub-agent runbook
- 10 new unit tests (5 for each helper)
- Zero runtime code changes; zero sub-agent runbook content seeded
- Cross-reference paragraph added to the SIO-640 spec clarifying selector scope
- New subsection added to the SIO-639 authoring guide documenting sub-agent runbook capability

## Key insight

Sub-agent runbooks already work today without any loader or prompt-assembly code changes. `loadAgent()` recurses into sub-agents, `loadKnowledge()` runs per-agent, and `buildSubAgentPrompt()` passes each sub-agent's own `LoadedAgent.knowledge` through `buildSystemPrompt()` which appends it to the prompt. This issue is therefore policy + validator extension + cross-references, not a feature build.

## Test plan

- [x] `bun test` all green (40 from SIO-641 + 10 new = 50 tests in runbook-validator.test.ts)
- [x] `bun run typecheck` clean
- [x] `bun run lint` clean
- [x] Manual: synthetic sub-agent runbook in `/tmp`-style scratch directory confirms the walk discovers it, validates against the intersection authority, and correctly fails when the runbook cites a non-facade tool (see Task 4 steps 3-5 in the plan)

Design spec: `docs/superpowers/specs/2026-04-10-scoped-subagent-runbooks-design.md`
Implementation plan: `docs/superpowers/plans/2026-04-10-scoped-subagent-runbooks.md`
Linear issue: SIO-642

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Link the commits to SIO-642**

Open https://linear.app/siobytes/issue/SIO-642 and attach the commit URLs from Tasks 1-6 and the PR URL.

---

## Self-Review

Fresh read of the plan against the spec.

**1. Spec coverage — every spec requirement has a task:**

| Spec section | Covered by |
|---|---|
| Architecture: no loader/prompt code changes | Enforced via "Do not modify" in File Structure |
| Deliverable 1: Policy documentation (the spec file) | Already committed; no task needed |
| Deliverable 2: Validator extension with `buildSubAgentAuthority()` | Task 2 |
| Deliverable 2: Validator extension with `collectSubAgentFixtures()` | Task 3 |
| Deliverable 2: Conditional production describe block | Task 4 |
| Deliverable 3: Cross-reference paragraph in SIO-640 spec | Task 5 |
| Deliverable 3: Cross-reference paragraph in SIO-639 authoring guide | Task 6 |
| Authority rule: intersection of parent facades and sub-agent tools | Task 2 implementation + Task 4 manual verification |
| Strict failure on non-facade tool citations | Task 4 Step 4 (synthetic bad citation test) |
| Zero content seeding | Task 4 Step 5 (revert) + Task 7 Step 5 (file scope check) |
| Opt-in per sub-agent, no default | Enforced by policy; validator only emits tests for sub-agents with runbook knowledge entries (Task 3 implementation) |
| Brainstorm A selector stays orchestrator-scoped | Task 5 (cross-reference paragraph) |
| Independent runbooks (no coupling) | Policy-only; nothing to implement |

All spec requirements have a task. The one deviation (helper walks already-loaded `subAgents` Map instead of the filesystem) is documented in the Spec Deviations section.

**2. Placeholder scan:** Every code block is complete. Every step has exact commands and expected output. No "TODO", "TBD", "handle edge cases", or "similar to Task N" language. Task 1 is explicitly conditional on Task 0's finding about `agentDir`.

**3. Type consistency:**

- `SubAgentFixture` — declared Task 2, used in Task 3 `collectSubAgentFixtures` return type, used in Task 4 production describe block. Consistent across all tasks.
- `buildSubAgentAuthority(parentTools: ToolDefinition[], subAgentFacadeNames: string[]): Set<string>` — declared Task 2, called Task 4 with `fixture.parentTools` and `fixture.subAgent.manifest.tools ?? []`. Type-consistent.
- `collectSubAgentFixtures(parentFixtures: AgentFixture[]): SubAgentFixture[]` — declared Task 3, called Task 4 with `PRODUCTION_FIXTURES` (from SIO-641). Type-consistent.
- `AgentFixture.agentDir` — added in Task 1 (conditionally), consumed in Task 3 path reconstruction. Conditional but consistent: if Task 1 is skipped (agentDir already exists), the same field is used from the shipped SIO-641 version.

**4. One known risk:** Task 1's conditional behavior depends on what SIO-641's implementer actually shipped. If SIO-641 was implemented differently from its plan (e.g., `AgentFixture` named differently, or fields in a different order), Task 1's grep commands won't find what they expect. The plan handles this by explicitly halting in Task 0 Step 3 if the interface shape doesn't match, giving the implementer a chance to manually adapt.

**5. One note on Task 4:** The manual verification steps create real files under `agents/incident-analyzer/agents/kafka-agent/knowledge/` and then delete them. This is the only place in the plan that modifies production directory structure, and it's reverted within the same task. Task 7 Step 5 explicitly checks that no sub-agent files remain as a safety net.

**6. Scope:** 9 tasks total (Tasks 0-8). Task 0 is verification of the prerequisite. Task 1 is conditional. Tasks 2-6 are the actual implementation. Tasks 7-8 are verification and PR. Each task produces a working, committable checkpoint.

Self-review complete. No inline fixes needed.
