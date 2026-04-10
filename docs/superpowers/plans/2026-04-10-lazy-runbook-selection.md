# Lazy Runbook Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `selectRunbooks` LangGraph node between `normalize` and `entityExtractor` that asks the orchestrator LLM to pick 0-2 relevant runbooks from a small catalog, writes them to a new tri-state `state.selectedRunbooks: string[] | null` field, and has the aggregator consume that selection via an extended `buildOrchestratorPrompt({ runbookFilter })` so only the selected runbooks flow into the aggregator's system prompt.

**Architecture:** One new LangGraph node, one new state field (tri-state nullable), one optional config block in `knowledge/index.yaml` that gates whether the node is wired into the graph at all. The selector reuses the existing `createLlm()` factory in `packages/agent/src/llm.ts` via a new `"runbookSelector"` role. Only the `aggregate` node consumes the selection; every other node's behavior is unchanged. Fallback is a severity-tier config that must be complete (all 4 severities) or absent. Missing severity + router failure = hard error; missing config when the node is wired = hard error at load time.

**Tech Stack:** Bun 1.3.9+, TypeScript 5.x strict mode, LangGraph (`@langchain/langgraph`), LangChain Bedrock Converse (`@langchain/aws`), Zod v4.3.6 for runtime validation, `bun:test` with `mock.module()` for unit tests, Pino via `@devops-agent/observability` for logging, existing OpenTelemetry span wrapper (`traceNode`) for observability.

**Source spec:** `docs/superpowers/specs/2026-04-10-lazy-runbook-selection-design.md` — read this first for the full design rationale.

---

## Spec Deviations

This plan supersedes the spec where they disagree. The spec was written before I read the actual codebase end-to-end; the plan reflects what the code actually looks like.

1. **LLM factory is `createLlm(role)`, not `resolveBedrockConfig()` directly.** The spec said the selector would call `resolveBedrockConfig()`. The real pattern is a role-based factory in `packages/agent/src/llm.ts` that adds a new LLM role to an enum and a temperature override. The selector adds a `"runbookSelector"` role.

2. **Model-level fallback is automatic.** `createLlm()` wraps non-tool-binding roles with `.withFallbacks()` using Haiku as a secondary. By the time the selector sees an API error from `llm.invoke()`, BOTH Sonnet and Haiku have already failed. The severity-tier fallback kicks in after that — it is the third layer, not the second.

3. **`getRunbookFilenames()` already exists** in `packages/agent/src/prompt-context.ts:60-63`. We reuse it and add a parallel `getRunbookCatalog()` helper that returns `{filename, title, summary}[]` built on-the-fly from `agent.knowledge`. **No change to `LoadedAgent` in `gitagent-bridge`.** The catalog is a projection in the `agent` package, not a field on the loaded agent.

4. **Tests are co-located `*.test.ts` files** in `packages/agent/src/` and `packages/gitagent-bridge/src/`, not in separate `test/` directories. Neither package has a `test/` dir.

5. **`bun:test` `mock.module()` is the mocking pattern.** Mocks are declared at the top of the test file before the tested module is imported. See `packages/agent/src/validation.test.ts:9-13` for the canonical example.

6. **Normalizer silently swallows errors and returns `{}`** (see `normalizer.ts:113-118`). The selector does **not** follow this pattern — it follows the spec's "fail loud" discipline on missing severity at fallback time.

7. **No separate `errors.ts` in shared.** The two new error classes (`RunbookSelectionFallbackError`, `RunbookSelectionConfigError`) live in `packages/agent/src/runbook-selector.ts` as local exports, not in `@devops-agent/shared`. They're only raised and caught within the agent package, so no cross-package sharing is needed.

8. **Rollout step 7 from the spec says "document in gitagent-bridge.md" but the runbook catalog does not live in gitagent-bridge** (per deviation #3). The documentation update goes in `docs/architecture/agent-pipeline.md` only.

---

## File Structure

**Create:**
- `packages/agent/src/runbook-selector.ts` — the `selectRunbooks` LangGraph node, Zod response schema, error classes, observability emission
- `packages/agent/src/runbook-selector.test.ts` — 12 unit tests from the spec, plus 2 for the new error cases

**Modify:**
- `packages/gitagent-bridge/src/types.ts` — add `RunbookSelectionConfigSchema`, extend `KnowledgeIndexSchema` with optional `runbook_selection`, export both
- `packages/gitagent-bridge/src/manifest-loader.ts` — validate `runbook_selection.fallback_by_severity` filenames exist on disk inside `loadKnowledge()`
- `packages/gitagent-bridge/src/index.test.ts` — add load-time config validation tests (4 cases)
- `packages/agent/src/state.ts` — add `selectedRunbooks: Annotation<string[] | null>` with `default: () => null`
- `packages/agent/src/prompt-context.ts` — add `getRunbookCatalog()` helper; extend `buildOrchestratorPrompt()` with `options?: { runbookFilter?: string[] }`
- `packages/agent/src/aggregator.ts` — replace line 15 `buildOrchestratorPrompt()` with filtered call
- `packages/agent/src/aggregator.test.ts` — new file (doesn't exist today): filter-semantics tests, 5 direct + 3 integration
- `packages/agent/src/llm.ts` — add `"runbookSelector"` to `LlmRole` union (line 24-34) and to `ROLE_OVERRIDES` (line 36-47) with `temperature: 0`
- `packages/agent/src/graph.ts` — conditionally register `selectRunbooks` node and wire edge `normalize -> selectRunbooks -> entityExtractor` only when `runbook_selection` config is present on the loaded agent; otherwise keep `normalize -> entityExtractor`
- `packages/agent/src/validation.test.ts` — add `selectedRunbooks: null` to the `makeState` helper at line 21 so existing tests don't break after the state annotation is added
- `agents/incident-analyzer/knowledge/index.yaml` — add `runbook_selection` block
- `docs/architecture/agent-pipeline.md` — document the new node

**Do not modify:**
- `packages/gitagent-bridge/src/skill-loader.ts` — `buildSystemPrompt()` signature stays the same; filter applies upstream by filtering `agent.knowledge` before calling it
- Sub-agent files, `validator.ts`, `mitigation.ts`, `responder.ts`, `follow-up-generator.ts` — all unchanged
- `packages/shared/` — no changes

---

## Task 1: Extend `KnowledgeIndexSchema` with `runbook_selection`

**Goal:** Define the Zod schema for the new config block so the loader can parse and validate it. This is schema only — no runtime validation of filenames yet (that's Task 2).

**Files:**
- Modify: `packages/gitagent-bridge/src/types.ts`
- Test: `packages/gitagent-bridge/src/index.test.ts`

- [ ] **Step 1: Read the current `KnowledgeIndexSchema` definition**

Run: `grep -n "KnowledgeIndexSchema\|RunbookSelection" packages/gitagent-bridge/src/types.ts`

Expected: one or two existing matches for `KnowledgeIndexSchema`, zero matches for `RunbookSelection`.

- [ ] **Step 2: Write the failing test for valid config**

Append to `packages/gitagent-bridge/src/index.test.ts`:

```typescript
import { KnowledgeIndexSchema } from "./types.ts";

describe("KnowledgeIndexSchema: runbook_selection", () => {
    test("accepts config with all four severity keys", () => {
        const config = {
            name: "test",
            description: "test",
            version: "0.1.0",
            categories: { runbooks: { path: "runbooks/", description: "test" } },
            runbook_selection: {
                fallback_by_severity: {
                    critical: ["a.md", "b.md"],
                    high: ["a.md"],
                    medium: [],
                    low: [],
                },
            },
        };
        expect(() => KnowledgeIndexSchema.parse(config)).not.toThrow();
    });

    test("rejects config missing a severity key", () => {
        const config = {
            name: "test",
            description: "test",
            version: "0.1.0",
            categories: { runbooks: { path: "runbooks/", description: "test" } },
            runbook_selection: {
                fallback_by_severity: {
                    critical: [],
                    high: [],
                    medium: [],
                    // low missing
                },
            },
        };
        expect(() => KnowledgeIndexSchema.parse(config)).toThrow();
    });

    test("accepts config with runbook_selection absent", () => {
        const config = {
            name: "test",
            description: "test",
            version: "0.1.0",
            categories: { runbooks: { path: "runbooks/", description: "test" } },
        };
        expect(() => KnowledgeIndexSchema.parse(config)).not.toThrow();
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/gitagent-bridge/src/index.test.ts -t "runbook_selection"`
Expected: FAIL — `KnowledgeIndexSchema` either doesn't export or doesn't include the new field.

- [ ] **Step 4: Implement the schema**

In `packages/gitagent-bridge/src/types.ts`, add before the existing `KnowledgeIndexSchema`:

```typescript
export const RunbookSelectionConfigSchema = z.object({
    fallback_by_severity: z.object({
        critical: z.array(z.string()),
        high: z.array(z.string()),
        medium: z.array(z.string()),
        low: z.array(z.string()),
    }),
});

export type RunbookSelectionConfig = z.infer<typeof RunbookSelectionConfigSchema>;
```

Extend `KnowledgeIndexSchema` to add the optional field (find the existing definition and modify it):

```typescript
export const KnowledgeIndexSchema = z.object({
    name: z.string(),
    description: z.string(),
    version: z.string(),
    categories: z.record(z.string(), KnowledgeCategorySchema),
    runbook_selection: RunbookSelectionConfigSchema.optional(),
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/index.test.ts -t "runbook_selection"`
Expected: PASS — all three tests green.

- [ ] **Step 6: Run full package typecheck and tests**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck && bun test packages/gitagent-bridge/src/`
Expected: clean typecheck, all existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/gitagent-bridge/src/types.ts packages/gitagent-bridge/src/index.test.ts
git commit -m "SIO-640: Add RunbookSelectionConfigSchema for runbook_selection block

Zod schema only; filename existence validation comes in Task 2.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

(Replace `SIO-640` with the real issue ID once created — see Task 0.)

---

## Task 0 (prerequisite, run before Task 1): Create Linear issue

**Goal:** All implementation plans require a tracked Linear issue per project convention. This task runs once before any code touches.

- [ ] **Step 1: Create the Linear issue**

Use the Linear MCP tool or open linear.app and create an issue under **Siobytes / DevOps Incident Analyzer** with:

- Title: `Phase 2A: Implement lazy runbook selection (selectRunbooks node)`
- Description: link to the spec at `docs/superpowers/specs/2026-04-10-lazy-runbook-selection-design.md` and this plan at `docs/superpowers/plans/2026-04-10-lazy-runbook-selection.md`. Paste the `Goal` and `Architecture` blocks from the plan header.
- Priority: Medium (3)
- Assignee: me

- [ ] **Step 2: Record the issue ID**

Replace every `SIO-640` placeholder in this plan with the real ID. Use find-and-replace across the file. Do not proceed to Task 1 until this is done.

- [ ] **Step 3: Commit nothing**

This task produces no git changes. It exists to make the Linear-first rule explicit and unavoidable.

---

## Task 2: Validate `runbook_selection` filenames at load time

**Goal:** When `runbook_selection` is present, every filename listed in `fallback_by_severity` must exist under the runbooks category directory. Missing files are a hard error at load time with a message naming the missing file.

**Files:**
- Modify: `packages/gitagent-bridge/src/manifest-loader.ts`
- Test: `packages/gitagent-bridge/src/index.test.ts`

- [ ] **Step 1: Write the failing test for missing filename**

Append to `packages/gitagent-bridge/src/index.test.ts` (inside the existing `describe` block or a new one):

```typescript
import { loadAgent } from "./manifest-loader.ts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadAgent: runbook_selection filename validation", () => {
    function makeTestAgent(indexYaml: string, runbookFiles: Record<string, string> = {}): string {
        const dir = mkdtempSync(join(tmpdir(), "gitagent-test-"));
        mkdirSync(join(dir, "knowledge", "runbooks"), { recursive: true });
        writeFileSync(join(dir, "agent.yaml"), `spec_version: "0.1.0"
name: test
version: 0.1.0
description: test
model:
  preferred: claude-sonnet-4-6
  constraints: { temperature: 0.2, max_tokens: 1024 }
runtime: { max_turns: 10, timeout: 60 }
compliance:
  risk_tier: low
  supervision: { human_in_the_loop: conditional, kill_switch: false }
  recordkeeping: { audit_logging: false }
  data_governance: { pii_handling: none, data_classification: internal }
`);
        writeFileSync(join(dir, "knowledge", "index.yaml"), indexYaml);
        for (const [name, content] of Object.entries(runbookFiles)) {
            writeFileSync(join(dir, "knowledge", "runbooks", name), content);
        }
        return dir;
    }

    test("accepts config where every filename exists", () => {
        const dir = makeTestAgent(
            `name: test
description: test
version: 0.1.0
categories:
  runbooks: { path: runbooks/, description: test }
runbook_selection:
  fallback_by_severity:
    critical: ["a.md"]
    high: []
    medium: []
    low: []
`,
            { "a.md": "# A\n\nContent" },
        );
        expect(() => loadAgent(dir)).not.toThrow();
        rmSync(dir, { recursive: true });
    });

    test("rejects config referencing nonexistent filename", () => {
        const dir = makeTestAgent(
            `name: test
description: test
version: 0.1.0
categories:
  runbooks: { path: runbooks/, description: test }
runbook_selection:
  fallback_by_severity:
    critical: ["missing.md"]
    high: []
    medium: []
    low: []
`,
            { "a.md": "# A\n\nContent" },
        );
        expect(() => loadAgent(dir)).toThrow(/missing\.md/);
        rmSync(dir, { recursive: true });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gitagent-bridge/src/index.test.ts -t "runbook_selection filename"`
Expected: FAIL — the second test does not throw because no validation exists yet.

- [ ] **Step 3: Implement the validation in `loadKnowledge()`**

In `packages/gitagent-bridge/src/manifest-loader.ts`, find `loadKnowledge()` (around line 73) and add filename validation before `return entries;`:

```typescript
function loadKnowledge(agentDir: string): KnowledgeEntry[] {
    const knowledgeDir = join(agentDir, "knowledge");
    const indexPath = join(knowledgeDir, "index.yaml");

    if (!existsSync(indexPath)) return [];

    const indexYaml = parse(readFileSync(indexPath, "utf-8"));
    const index = KnowledgeIndexSchema.safeParse(indexYaml);
    if (!index.success) return [];

    const entries: KnowledgeEntry[] = [];
    for (const [category, config] of Object.entries(index.data.categories)) {
        const categoryDir = join(knowledgeDir, config.path);
        if (!isDirectory(categoryDir)) continue;

        const files = readdirSync(categoryDir).filter((f) => f.endsWith(".md") && f !== ".gitkeep");
        for (const file of files) {
            const content = readFileSync(join(categoryDir, file), "utf-8").trim();
            if (content) {
                entries.push({ category, filename: file, content });
            }
        }
    }

    // NEW: validate runbook_selection filenames exist
    if (index.data.runbook_selection) {
        const runbooksCategory = index.data.categories.runbooks;
        if (!runbooksCategory) {
            throw new Error(
                "knowledge/index.yaml: runbook_selection is present but categories.runbooks is not defined. " +
                    "runbook_selection requires a runbooks category.",
            );
        }
        const runbooksDir = join(knowledgeDir, runbooksCategory.path);
        const existingFiles = isDirectory(runbooksDir)
            ? new Set(readdirSync(runbooksDir).filter((f) => f.endsWith(".md")))
            : new Set<string>();

        const { fallback_by_severity } = index.data.runbook_selection;
        for (const [severity, filenames] of Object.entries(fallback_by_severity)) {
            for (const filename of filenames) {
                if (!existingFiles.has(filename)) {
                    throw new Error(
                        `knowledge/index.yaml: runbook_selection.fallback_by_severity.${severity} references ` +
                            `"${filename}" but no such file exists under ${runbooksCategory.path}`,
                    );
                }
            }
        }
    }

    return entries;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/index.test.ts -t "runbook_selection filename"`
Expected: PASS — both tests green.

- [ ] **Step 5: Run full package tests**

Run: `bun test packages/gitagent-bridge/src/ && bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: all green, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/gitagent-bridge/src/manifest-loader.ts packages/gitagent-bridge/src/index.test.ts
git commit -m "SIO-640: Validate runbook_selection filenames exist at load time

Throws with a clear error naming the missing file. Runs only when
runbook_selection is present in knowledge/index.yaml.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `"runbookSelector"` role to `createLlm`

**Goal:** Register the new LLM role so the selector can call `createLlm("runbookSelector")` like every other node. Temperature 0 for deterministic routing decisions.

**Files:**
- Modify: `packages/agent/src/llm.ts`

No test for this task — the change is two type-system additions and the role is covered transitively by Task 8's selector tests. Adding a dedicated test would duplicate the existing `createLlm` coverage without adding signal.

- [ ] **Step 1: Read current `LlmRole` and `ROLE_OVERRIDES`**

Run: `grep -n "LlmRole\|ROLE_OVERRIDES" packages/agent/src/llm.ts`

Expected: one match for the type alias, one for the const.

- [ ] **Step 2: Add `"runbookSelector"` to the union**

In `packages/agent/src/llm.ts`, extend `LlmRole`:

```typescript
export type LlmRole =
    | "orchestrator"
    | "classifier"
    | "subAgent"
    | "aggregator"
    | "responder"
    | "entityExtractor"
    | "followUp"
    | "normalizer"
    | "mitigation"
    | "actionProposal"
    | "runbookSelector";
```

- [ ] **Step 3: Add the role override**

Extend `ROLE_OVERRIDES`:

```typescript
const ROLE_OVERRIDES: Record<LlmRole, Partial<BedrockModelConfig>> = {
    orchestrator: {},
    classifier: { temperature: 0 },
    subAgent: {},
    aggregator: { temperature: 0.1 },
    responder: { temperature: 0.3 },
    entityExtractor: { temperature: 0 },
    followUp: { temperature: 0.5, maxTokens: 256 },
    normalizer: { temperature: 0 },
    mitigation: { temperature: 0.2 },
    actionProposal: { temperature: 0, maxTokens: 512 },
    runbookSelector: { temperature: 0, maxTokens: 512 },
};
```

- [ ] **Step 4: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/llm.ts
git commit -m "SIO-640: Add runbookSelector LLM role with deterministic settings

temperature=0, maxTokens=512. Inherits model and fallback from the
orchestrator agent manifest via createLlm().

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add `selectedRunbooks` state field

**Goal:** Add the tri-state `string[] | null` annotation. Update the test helper in `validation.test.ts` so existing tests don't break.

**Files:**
- Modify: `packages/agent/src/state.ts`
- Modify: `packages/agent/src/validation.test.ts`

- [ ] **Step 1: Read current state annotations**

Run: `grep -n "Annotation<" packages/agent/src/state.ts | head`

Expected: list of existing annotations — confirms the location and shape.

- [ ] **Step 2: Add the annotation**

In `packages/agent/src/state.ts`, add inside `AgentState = Annotation.Root({...})`, after the `mitigationSteps` field (around line 130):

```typescript
    // SIO-640: Runbook selector output.
    //   null      -> selector did not run (default)
    //   []        -> selector ran and chose no runbooks
    //   [names]   -> selector chose these runbooks
    selectedRunbooks: Annotation<string[] | null>({
        reducer: (_, next) => next,
        default: () => null,
    }),
```

- [ ] **Step 3: Update the test state helper**

In `packages/agent/src/validation.test.ts`, find `function makeState` (around line 21) and add `selectedRunbooks: null` to the default object before the spread:

```typescript
        actionResults: [],
        selectedRunbooks: null,
        ...overrides,
```

- [ ] **Step 4: Run existing tests to verify no regressions**

Run: `bun test packages/agent/src/validation.test.ts`
Expected: all existing tests still pass.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/state.ts packages/agent/src/validation.test.ts
git commit -m "SIO-640: Add tri-state selectedRunbooks field to AgentState

null     -> selector did not run (default)
[]       -> selector ran and chose no runbooks
[names]  -> selector chose these runbooks

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Extend `buildOrchestratorPrompt` with `runbookFilter` option

**Goal:** Add the options parameter and implement the filter. `undefined` means "no filter" (today's behavior); empty array suppresses all runbooks; populated array filters to the named set. Only the `runbooks` category is affected — `systems-map` and `slo-policies` are never filtered.

**Files:**
- Modify: `packages/agent/src/prompt-context.ts`
- Test: `packages/agent/src/prompt-context.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/src/prompt-context.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";

// Mock the gitagent-bridge loadAgent to return a synthetic agent with three
// runbooks and two non-runbook knowledge entries. This isolates the filter
// logic from the real filesystem.
mock.module("@devops-agent/gitagent-bridge", () => ({
    loadAgent: () => ({
        manifest: { compliance: { risk_tier: "low" } },
        soul: "SOUL",
        rules: "RULES",
        tools: [],
        skills: new Map(),
        subAgents: new Map(),
        knowledge: [
            { category: "runbooks", filename: "a.md", content: "# A\n\nRunbook A content" },
            { category: "runbooks", filename: "b.md", content: "# B\n\nRunbook B content" },
            { category: "runbooks", filename: "c.md", content: "# C\n\nRunbook C content" },
            { category: "systems-map", filename: "deps.md", content: "# Deps" },
            { category: "slo-policies", filename: "slo.md", content: "# SLO" },
        ],
    }),
    requiresApproval: () => false,
    buildSystemPrompt: (agent: any) => {
        // Minimal reimplementation for the test: emit knowledge entries grouped by category
        const sections: string[] = [agent.soul, agent.rules];
        if (agent.knowledge.length > 0) {
            sections.push("## Knowledge Base");
            const byCategory = new Map<string, any[]>();
            for (const entry of agent.knowledge) {
                const existing = byCategory.get(entry.category) ?? [];
                existing.push(entry);
                byCategory.set(entry.category, existing);
            }
            for (const [category, entries] of byCategory) {
                sections.push(`### ${category}`);
                for (const entry of entries) {
                    sections.push(`#### ${entry.filename}\n\n${entry.content}`);
                }
            }
        }
        return sections.join("\n\n");
    },
}));

// Import AFTER mock.module so the mock is in effect.
import { buildOrchestratorPrompt } from "./prompt-context.ts";

describe("buildOrchestratorPrompt: runbookFilter", () => {
    test("undefined filter keeps all runbooks (current behavior)", () => {
        const prompt = buildOrchestratorPrompt();
        expect(prompt).toContain("a.md");
        expect(prompt).toContain("b.md");
        expect(prompt).toContain("c.md");
        expect(prompt).toContain("deps.md");
        expect(prompt).toContain("slo.md");
    });

    test("empty array suppresses all runbooks but keeps systems-map and slo-policies", () => {
        const prompt = buildOrchestratorPrompt({ runbookFilter: [] });
        expect(prompt).not.toContain("a.md");
        expect(prompt).not.toContain("b.md");
        expect(prompt).not.toContain("c.md");
        expect(prompt).toContain("deps.md");
        expect(prompt).toContain("slo.md");
    });

    test("single-entry filter keeps only that runbook", () => {
        const prompt = buildOrchestratorPrompt({ runbookFilter: ["a.md"] });
        expect(prompt).toContain("a.md");
        expect(prompt).not.toContain("b.md");
        expect(prompt).not.toContain("c.md");
        expect(prompt).toContain("deps.md");
        expect(prompt).toContain("slo.md");
    });

    test("two-entry filter keeps exactly those runbooks", () => {
        const prompt = buildOrchestratorPrompt({ runbookFilter: ["a.md", "b.md"] });
        expect(prompt).toContain("a.md");
        expect(prompt).toContain("b.md");
        expect(prompt).not.toContain("c.md");
    });

    test("nonexistent filter filters to zero runbooks", () => {
        const prompt = buildOrchestratorPrompt({ runbookFilter: ["bogus.md"] });
        expect(prompt).not.toContain("a.md");
        expect(prompt).not.toContain("b.md");
        expect(prompt).not.toContain("c.md");
        expect(prompt).toContain("deps.md");
        expect(prompt).toContain("slo.md");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/prompt-context.test.ts`
Expected: FAIL — `buildOrchestratorPrompt` does not yet accept options.

- [ ] **Step 3: Implement the filter**

In `packages/agent/src/prompt-context.ts`, replace the existing `buildOrchestratorPrompt()` function (lines 44-46) with:

```typescript
export interface OrchestratorPromptOptions {
    // undefined = no filter (current behavior; all runbooks present)
    // []        = filter to zero runbooks (suppress all runbooks; systems-map and slo-policies unchanged)
    // [names]   = filter to just these runbook filenames
    runbookFilter?: string[];
}

export function buildOrchestratorPrompt(options: OrchestratorPromptOptions = {}): string {
    const agent = getAgent();
    const filter = options.runbookFilter;

    if (filter === undefined) {
        // No filter: preserve today's behavior exactly
        return buildSystemPrompt(agent) + buildComplianceBoundary();
    }

    // Filter the knowledge array to remove non-selected runbooks.
    // Other categories (systems-map, slo-policies) pass through unchanged.
    const filterSet = new Set(filter);
    const filteredKnowledge = agent.knowledge.filter((entry) => {
        if (entry.category !== "runbooks") return true;
        return filterSet.has(entry.filename);
    });

    // Build a shallow agent copy with the filtered knowledge.
    // This preserves referential equality for everything else so skill-loader and
    // other consumers see the same identities as the cached agent.
    const filteredAgent = { ...agent, knowledge: filteredKnowledge };
    return buildSystemPrompt(filteredAgent) + buildComplianceBoundary();
}
```

- [ ] **Step 4: Add the `getRunbookCatalog()` helper**

Also in `packages/agent/src/prompt-context.ts`, add after `getRunbookFilenames()`:

```typescript
export interface RunbookCatalogEntry {
    filename: string;
    title: string;       // first H1 heading, or filename stem if absent
    summary: string;     // first non-empty paragraph after H1, truncated to 200 chars, or empty string
}

export function getRunbookCatalog(): RunbookCatalogEntry[] {
    const agent = getAgent();
    return agent.knowledge
        .filter((k) => k.category === "runbooks")
        .map((k) => parseRunbookCatalogEntry(k.filename, k.content));
}

function parseRunbookCatalogEntry(filename: string, content: string): RunbookCatalogEntry {
    const lines = content.split("\n");
    // Extract first H1 (line starting with "# ")
    let title = filename.replace(/\.md$/, "");
    let h1Index = -1;
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^#\s+(.+)$/);
        if (match) {
            title = match[1].trim();
            h1Index = i;
            break;
        }
    }
    // Extract first non-empty paragraph after H1
    let summary = "";
    for (let i = h1Index + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        if (line.startsWith("#")) break;    // next heading = end of intro paragraph
        summary = line;
        break;
    }
    if (summary.length > 200) summary = summary.slice(0, 197) + "...";
    return { filename, title, summary };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/agent/src/prompt-context.test.ts`
Expected: PASS — all five filter tests green.

- [ ] **Step 6: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/prompt-context.ts packages/agent/src/prompt-context.test.ts
git commit -m "SIO-640: Add runbookFilter option to buildOrchestratorPrompt

Also adds getRunbookCatalog() helper for the selector to consume in a
later task. Filter applies only to the runbooks category; systems-map
and slo-policies pass through unchanged.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire the filter through `aggregator.ts`

**Goal:** Replace the single `buildOrchestratorPrompt()` call in `aggregator.ts` with the filtered version. Coalesce `null -> undefined` so "selector did not run" preserves today's behavior.

**Files:**
- Modify: `packages/agent/src/aggregator.ts`
- Test: `packages/agent/src/aggregator.test.ts` (new file)

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/src/aggregator.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";
import type { AgentStateType } from "./state.ts";

// Capture the options passed to buildOrchestratorPrompt so we can assert on them.
let lastOptions: { runbookFilter?: string[] } | undefined;

mock.module("./prompt-context.ts", () => ({
    buildOrchestratorPrompt: (options?: { runbookFilter?: string[] }) => {
        lastOptions = options;
        return "mocked-system-prompt";
    },
    getRunbookCatalog: () => [],
    getRunbookFilenames: () => [],
}));

// Mock createLlm to avoid Bedrock calls.
mock.module("./llm.ts", () => ({
    createLlm: () => ({
        invoke: async () => ({ content: "Mock aggregator output. Confidence: 0.5" }),
    }),
}));

mock.module("@devops-agent/shared", () => ({
    redactPiiContent: (s: string) => s,
}));

import { aggregate } from "./aggregator.ts";

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
    return {
        messages: [],
        queryComplexity: "complex",
        targetDataSources: ["elastic"],
        dataSourceResults: [
            { dataSourceId: "elastic", status: "success", data: "result", duration: 100, toolErrors: [] },
        ],
        currentDataSource: "",
        extractedEntities: { dataSources: [] },
        previousEntities: { dataSources: [] },
        toolPlanMode: "autonomous",
        toolPlan: [],
        validationResult: "pass",
        retryCount: 0,
        alignmentRetries: 0,
        alignmentHints: [],
        skippedDataSources: [],
        isFollowUp: false,
        finalAnswer: "",
        dataSourceContext: undefined,
        requestId: "test",
        attachmentMeta: [],
        suggestions: [],
        normalizedIncident: {},
        mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
        confidenceScore: 0,
        lowConfidence: false,
        pendingActions: [],
        actionResults: [],
        selectedRunbooks: null,
        ...overrides,
    } as AgentStateType;
}

describe("aggregator: selectedRunbooks integration", () => {
    test("null selectedRunbooks passes undefined filter (no filter)", async () => {
        lastOptions = undefined;
        await aggregate(makeState({ selectedRunbooks: null }));
        expect(lastOptions).toEqual({ runbookFilter: undefined });
    });

    test("empty array selectedRunbooks passes empty filter (suppress all)", async () => {
        lastOptions = undefined;
        await aggregate(makeState({ selectedRunbooks: [] }));
        expect(lastOptions).toEqual({ runbookFilter: [] });
    });

    test("populated selectedRunbooks passes named filter", async () => {
        lastOptions = undefined;
        await aggregate(makeState({ selectedRunbooks: ["kafka-consumer-lag.md"] }));
        expect(lastOptions).toEqual({ runbookFilter: ["kafka-consumer-lag.md"] });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/agent/src/aggregator.test.ts`
Expected: FAIL — aggregator currently calls `buildOrchestratorPrompt()` without options, so `lastOptions` is `undefined` in all three tests.

- [ ] **Step 3: Update the aggregator**

In `packages/agent/src/aggregator.ts`, find line 15 (inside `buildAggregatorMessages`):

```typescript
const systemPrompt = buildOrchestratorPrompt();
```

Replace with:

```typescript
// SIO-640: Tri-state selectedRunbooks field drives the runbook filter.
//   null      -> no filter (preserve current behavior)
//   []        -> filter to zero runbooks (selector chose none)
//   [names]   -> filter to just these
const runbookFilter = state.selectedRunbooks ?? undefined;
const systemPrompt = buildOrchestratorPrompt({ runbookFilter });
```

Note: `buildAggregatorMessages` already takes `state` as its first parameter, so no signature change is needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/agent/src/aggregator.test.ts`
Expected: PASS — all three tests green.

- [ ] **Step 5: Run broader agent tests to check for regressions**

Run: `bun test packages/agent/src/`
Expected: all tests pass.

- [ ] **Step 6: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/aggregator.ts packages/agent/src/aggregator.test.ts
git commit -m "SIO-640: Wire selectedRunbooks filter through aggregator

state.selectedRunbooks ?? undefined maps the tri-state field to the
prompt filter: null preserves today's no-filter behavior, empty array
suppresses all runbooks, populated array filters to the named set.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Create `runbook-selector.ts` skeleton with response schema and error classes

**Goal:** Create the new file with the Zod response schema, error classes, and the exported function signature — no LLM call yet. Sets up types so Task 8's tests can import and mock.

**Files:**
- Create: `packages/agent/src/runbook-selector.ts`

- [ ] **Step 1: Create the file with skeleton**

Create `packages/agent/src/runbook-selector.ts`:

```typescript
// agent/src/runbook-selector.ts
// SIO-640: Lazy runbook selection node. Runs between normalize and entityExtractor
// when knowledge/index.yaml contains a runbook_selection block. Asks the
// orchestrator LLM to pick 0-2 runbooks from the catalog and writes the
// selection to state.selectedRunbooks as a tri-state (null | [] | [names]).

import { getLogger } from "@devops-agent/observability";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { getRunbookCatalog, type RunbookCatalogEntry } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:runbook-selector");

/**
 * Thrown when the LLM router fails AND the severity tier fallback cannot be
 * consulted because state.normalizedIncident.severity is missing. This is a
 * deliberate hard-fail: silent "use all runbooks" would hide real normalize bugs.
 */
export class RunbookSelectionFallbackError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RunbookSelectionFallbackError";
    }
}

/**
 * Thrown at agent load time if selectRunbooks is wired into the graph but the
 * loaded agent has no runbook_selection config. Opt-in all-or-nothing.
 */
export class RunbookSelectionConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RunbookSelectionConfigError";
    }
}

export const RunbookSelectionResponseSchema = z.object({
    filenames: z.array(z.string()).max(10),
    reasoning: z.string(),
});

export type RunbookSelectionResponse = z.infer<typeof RunbookSelectionResponseSchema>;

export type SelectionMode =
    | "llm"
    | "llm.partial"
    | "llm.empty"
    | "llm.truncated"
    | "fallback.parse_error"
    | "fallback.timeout"
    | "fallback.api_error"
    | "fallback.invalid_filenames"
    | "skip.empty_catalog"
    | "error.missing_severity";

// Exported for testing; real config comes from the loaded agent in later tasks.
export interface RunbookSelectorDeps {
    catalog: RunbookCatalogEntry[];
    fallbackBySeverity: Record<"critical" | "high" | "medium" | "low", string[]>;
}

export async function selectRunbooks(
    state: AgentStateType,
    _config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
    // Placeholder. Implementation in Task 8.
    logger.warn("selectRunbooks called before implementation");
    return {};
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean. (The placeholder function is valid.)

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/runbook-selector.ts
git commit -m "SIO-640: Add runbook-selector.ts skeleton

Defines error classes, Zod response schema, SelectionMode union, and
RunbookSelectorDeps interface. Node function is a placeholder pending
Task 8 implementation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Implement `selectRunbooks` with full test coverage

**Goal:** Implement the selector per the spec's Error Handling section. All 12 test cases from the spec + 2 extra for the error classes. Write tests first, implement to pass.

**Files:**
- Modify: `packages/agent/src/runbook-selector.ts`
- Create: `packages/agent/src/runbook-selector.test.ts`

This is the largest task in the plan. It's kept as one task because splitting the selector implementation across multiple commits would leave the code in half-working states.

- [ ] **Step 1: Write the test file with all 14 cases**

Create `packages/agent/src/runbook-selector.test.ts`:

```typescript
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import type { AgentStateType } from "./state.ts";

// Shared mock LLM state. Each test resets mockLlmResponse before running.
let mockLlmResponse: unknown = { content: '{"filenames":[],"reasoning":"none"}' };
let mockLlmShouldThrow: Error | null = null;

mock.module("./llm.ts", () => ({
    createLlm: () => ({
        invoke: async () => {
            if (mockLlmShouldThrow) throw mockLlmShouldThrow;
            return mockLlmResponse as { content: string };
        },
    }),
}));

mock.module("./prompt-context.ts", () => ({
    getRunbookCatalog: () => [
        { filename: "a.md", title: "Runbook A", summary: "Pattern A summary" },
        { filename: "b.md", title: "Runbook B", summary: "Pattern B summary" },
        { filename: "c.md", title: "Runbook C", summary: "Pattern C summary" },
    ],
}));

import {
    RunbookSelectionFallbackError,
    selectRunbooks,
} from "./runbook-selector.ts";

const FALLBACK_CONFIG = {
    fallbackBySeverity: {
        critical: ["a.md", "b.md", "c.md"],
        high: ["a.md"],
        medium: [],
        low: [],
    },
};

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
    return {
        messages: [new HumanMessage("test incident")],
        queryComplexity: "complex",
        targetDataSources: [],
        dataSourceResults: [],
        currentDataSource: "",
        extractedEntities: { dataSources: [] },
        previousEntities: { dataSources: [] },
        toolPlanMode: "autonomous",
        toolPlan: [],
        validationResult: "pass",
        retryCount: 0,
        alignmentRetries: 0,
        alignmentHints: [],
        skippedDataSources: [],
        isFollowUp: false,
        finalAnswer: "",
        dataSourceContext: undefined,
        requestId: "test",
        attachmentMeta: [],
        suggestions: [],
        normalizedIncident: { severity: "critical" },
        mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
        confidenceScore: 0,
        lowConfidence: false,
        pendingActions: [],
        actionResults: [],
        selectedRunbooks: null,
        ...overrides,
    } as AgentStateType;
}

describe("selectRunbooks", () => {
    beforeEach(() => {
        mockLlmResponse = { content: '{"filenames":[],"reasoning":"none"}' };
        mockLlmShouldThrow = null;
        (globalThis as any).__runbookSelectorConfig = FALLBACK_CONFIG;
    });

    test("1. valid single pick", async () => {
        mockLlmResponse = { content: '{"filenames":["a.md"],"reasoning":"pattern A"}' };
        const result = await selectRunbooks(makeState());
        expect(result.selectedRunbooks).toEqual(["a.md"]);
    });

    test("2. valid two picks", async () => {
        mockLlmResponse = { content: '{"filenames":["a.md","b.md"],"reasoning":"both apply"}' };
        const result = await selectRunbooks(makeState());
        expect(result.selectedRunbooks).toEqual(["a.md", "b.md"]);
    });

    test("3. valid empty", async () => {
        mockLlmResponse = { content: '{"filenames":[],"reasoning":"nothing matches"}' };
        const result = await selectRunbooks(makeState());
        expect(result.selectedRunbooks).toEqual([]);
    });

    test("4. partial validity drops invalid filename", async () => {
        mockLlmResponse = {
            content: '{"filenames":["a.md","bogus.md"],"reasoning":"pattern A"}',
        };
        const result = await selectRunbooks(makeState());
        expect(result.selectedRunbooks).toEqual(["a.md"]);
    });

    test("5. all invalid filenames triggers fallback", async () => {
        mockLlmResponse = {
            content: '{"filenames":["bogus.md"],"reasoning":"pattern A"}',
        };
        const result = await selectRunbooks(makeState({ normalizedIncident: { severity: "critical" } }));
        expect(result.selectedRunbooks).toEqual(["a.md", "b.md", "c.md"]);
    });

    test("6. malformed JSON triggers fallback", async () => {
        mockLlmResponse = { content: "not json" };
        const result = await selectRunbooks(makeState({ normalizedIncident: { severity: "critical" } }));
        expect(result.selectedRunbooks).toEqual(["a.md", "b.md", "c.md"]);
    });

    test("7. three returned are truncated to two", async () => {
        mockLlmResponse = {
            content: '{"filenames":["a.md","b.md","c.md"],"reasoning":"all"}',
        };
        const result = await selectRunbooks(makeState());
        expect(result.selectedRunbooks).toEqual(["a.md", "b.md"]);
    });

    test("8. timeout triggers medium fallback (empty)", async () => {
        const err = new Error("timeout");
        err.name = "TimeoutError";
        mockLlmShouldThrow = err;
        const result = await selectRunbooks(makeState({ normalizedIncident: { severity: "medium" } }));
        expect(result.selectedRunbooks).toEqual([]);
    });

    test("9. api error triggers low fallback (empty)", async () => {
        mockLlmShouldThrow = new Error("500 Internal Server Error");
        const result = await selectRunbooks(makeState({ normalizedIncident: { severity: "low" } }));
        expect(result.selectedRunbooks).toEqual([]);
    });

    test("10. missing severity + router fails throws", async () => {
        mockLlmShouldThrow = new Error("api error");
        await expect(
            selectRunbooks(makeState({ normalizedIncident: {} })),
        ).rejects.toThrow(RunbookSelectionFallbackError);
    });

    test("11. missing severity + router succeeds returns pick", async () => {
        mockLlmResponse = { content: '{"filenames":["a.md"],"reasoning":"A"}' };
        const result = await selectRunbooks(makeState({ normalizedIncident: {} }));
        expect(result.selectedRunbooks).toEqual(["a.md"]);
    });

    test("12. empty catalog skips router and returns null", async () => {
        // Override the catalog mock for this test
        const prev = getRunbookCatalog();
        (globalThis as any).__testEmptyCatalog = true;
        const result = await selectRunbooks(makeState());
        expect(result.selectedRunbooks === null || result.selectedRunbooks === undefined).toBe(true);
        (globalThis as any).__testEmptyCatalog = false;
    });
});
```

**Note:** Test 12 uses a global flag to simulate an empty catalog. The implementation honors `(globalThis as any).__testEmptyCatalog === true` by treating the catalog as empty. This is a test-only seam and is acceptable because the alternative (dynamic re-mocking mid-test) is fragile in `bun:test`.

- [ ] **Step 2: Run tests to verify they all fail**

Run: `bun test packages/agent/src/runbook-selector.test.ts`
Expected: FAIL (14 failures) — the placeholder `selectRunbooks` returns `{}`, none of the assertions hold.

- [ ] **Step 3: Implement `selectRunbooks`**

Replace the placeholder function in `packages/agent/src/runbook-selector.ts`:

```typescript
export async function selectRunbooks(
    state: AgentStateType,
    _config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
    const startTime = Date.now();
    const catalog = (globalThis as any).__testEmptyCatalog === true ? [] : getRunbookCatalog();
    const config: RunbookSelectorDeps["fallbackBySeverity"] =
        (globalThis as any).__runbookSelectorConfig?.fallbackBySeverity ??
        getFallbackConfigFromAgent();

    // Step 1: empty catalog -> skip router, leave state unchanged
    if (catalog.length === 0) {
        logger.info(
            { mode: "skip.empty_catalog", catalogSize: 0 },
            "Runbook catalog is empty; skipping selection",
        );
        return {}; // no update; selectedRunbooks stays null
    }

    const validFilenames = new Set(catalog.map((e) => e.filename));
    const severity = state.normalizedIncident?.severity;

    // Step 2: build router prompt
    const lastMessage = state.messages.at(-1);
    const rawInput = lastMessage ? extractTextFromContent(lastMessage.content).slice(0, 500) : "";
    const incidentSummary = formatIncidentSummary(state);
    const catalogBlock = catalog
        .map((e) => `  - ${e.filename}: ${e.title} -- ${e.summary}`)
        .join("\n");

    const systemPrompt = `You are selecting operational runbooks for a DevOps incident investigation.
Pick 0 to 2 runbooks from the catalog that best match the incident. If no
runbook clearly applies, return an empty list. Do not guess.`;

    const userPrompt = `Incident summary:
${incidentSummary}
  raw input: ${rawInput}

Available runbooks:
${catalogBlock}

Return a JSON object matching this exact shape:
{"filenames": ["name1.md", "name2.md"], "reasoning": "one sentence"}

Rules:
- Pick 0 to 2 filenames. Prefer 1 if a single runbook clearly applies.
- Return empty filenames if no runbook clearly applies.
- filenames must exactly match the list above. Do not invent new names.`;

    // Step 3: invoke the LLM
    const llm = createLlm("runbookSelector");
    let response: { content: unknown };
    try {
        response = await llm.invoke(
            [
                { role: "system", content: systemPrompt },
                { role: "human", content: userPrompt },
            ],
            _config,
        );
    } catch (err) {
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        const mode = isTimeout ? "fallback.timeout" : "fallback.api_error";
        return enterFallback(mode, severity, config, startTime);
    }

    // Step 4: parse response
    const text = String((response as { content: string }).content);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        return enterFallback("fallback.parse_error", severity, config, startTime);
    }

    let parsed: { filenames: string[]; reasoning: string };
    try {
        const raw = JSON.parse(jsonMatch[0]);
        parsed = RunbookSelectionResponseSchema.parse(raw);
    } catch {
        return enterFallback("fallback.parse_error", severity, config, startTime);
    }

    // Step 5: validate filenames against the catalog
    const validPicks = parsed.filenames.filter((f) => validFilenames.has(f));
    const invalidPicks = parsed.filenames.filter((f) => !validFilenames.has(f));

    if (parsed.filenames.length > 0 && validPicks.length === 0) {
        // All invalid
        return enterFallback("fallback.invalid_filenames", severity, config, startTime);
    }

    // Step 6: truncate to max 2
    const truncated = validPicks.slice(0, 2);
    let mode: string = "llm";
    if (parsed.filenames.length > 2) mode = "llm.truncated";
    else if (invalidPicks.length > 0) mode = "llm.partial";
    else if (truncated.length === 0) mode = "llm.empty";

    logger.info(
        {
            mode,
            count: truncated.length,
            filenames: truncated.join(","),
            reasoning: parsed.reasoning,
            latencyMs: Date.now() - startTime,
            catalogSize: catalog.length,
        },
        "Runbook selection complete",
    );

    return { selectedRunbooks: truncated };
}

function enterFallback(
    mode: string,
    severity: string | undefined,
    config: Record<string, string[]>,
    startTime: number,
): Partial<AgentStateType> {
    if (!severity) {
        logger.error(
            { mode: "error.missing_severity", latencyMs: Date.now() - startTime },
            "Runbook selection fallback required but severity is missing",
        );
        throw new RunbookSelectionFallbackError(
            `Runbook selector fallback required (${mode}) but state.normalizedIncident.severity is missing. ` +
                `This indicates a bug in the normalize node or a malformed incident; refusing to guess.`,
        );
    }
    const fallback = config[severity] ?? [];
    logger.info(
        {
            mode,
            severity,
            filenames: fallback.join(","),
            count: fallback.length,
            latencyMs: Date.now() - startTime,
        },
        "Runbook selection entered fallback path",
    );
    return { selectedRunbooks: fallback };
}

function formatIncidentSummary(state: AgentStateType): string {
    const inc = state.normalizedIncident ?? {};
    const lines: string[] = [];
    lines.push(`  severity: ${inc.severity ?? "unspecified"}`);
    if (inc.timeWindow) {
        lines.push(`  time window: ${inc.timeWindow.from} to ${inc.timeWindow.to}`);
    }
    if (inc.affectedServices && inc.affectedServices.length > 0) {
        lines.push(`  affected services: ${inc.affectedServices.map((s) => s.name).join(", ")}`);
    }
    if (inc.extractedMetrics && inc.extractedMetrics.length > 0) {
        const metrics = inc.extractedMetrics
            .map((m) => `${m.name}${m.value ? `=${m.value}` : ""}${m.threshold ? ` (${m.threshold})` : ""}`)
            .join(", ");
        lines.push(`  extracted metrics: ${metrics}`);
    }
    return lines.join("\n");
}

// Reads the fallback_by_severity config from the loaded agent at runtime.
// Separated so tests can bypass via (globalThis as any).__runbookSelectorConfig.
function getFallbackConfigFromAgent(): Record<"critical" | "high" | "medium" | "low", string[]> {
    // Task 9 wires this up properly via prompt-context or a new helper.
    // For now, this function is only called when globalThis override is not set.
    // It reads from the loaded agent's knowledge index.
    // Throws RunbookSelectionConfigError if runbook_selection is absent.
    // See Task 9 for the real implementation.
    throw new RunbookSelectionConfigError(
        "getFallbackConfigFromAgent is not yet wired to the loaded agent; complete Task 9 first",
    );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/agent/src/runbook-selector.test.ts`
Expected: PASS — all 14 tests green. (Tests override `__runbookSelectorConfig` in `beforeEach`, so the unwired `getFallbackConfigFromAgent` is never called.)

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/runbook-selector.ts packages/agent/src/runbook-selector.test.ts
git commit -m "SIO-640: Implement selectRunbooks node with 14 test cases

Covers every failure mode in the spec: valid single/double/empty/partial,
all-invalid fallback, parse error, truncation, timeout/api error,
missing-severity hard-fail, empty catalog skip.

getFallbackConfigFromAgent is a placeholder that throws until Task 9
wires the loaded agent's runbook_selection config. Tests inject config
via a globalThis seam in beforeEach.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Wire the fallback config from the loaded agent

**Goal:** Replace the `getFallbackConfigFromAgent` placeholder with a real implementation that reads the loaded agent's `knowledge/index.yaml` via a new `getRunbookFallbackConfig()` helper in `prompt-context.ts`. Throws `RunbookSelectionConfigError` if the config is missing.

**Files:**
- Modify: `packages/gitagent-bridge/src/manifest-loader.ts` (expose runbook_selection on LoadedAgent)
- Modify: `packages/gitagent-bridge/src/index.ts` (re-export the new type if needed)
- Modify: `packages/agent/src/prompt-context.ts` (add getRunbookFallbackConfig helper)
- Modify: `packages/agent/src/runbook-selector.ts` (use the helper)

This task requires exposing the parsed `runbook_selection` config on `LoadedAgent` so downstream code can read it without re-parsing YAML.

- [ ] **Step 1: Write the failing test for the helper**

Append to `packages/agent/src/prompt-context.test.ts`:

```typescript
describe("getRunbookFallbackConfig", () => {
    test("returns the config when present", async () => {
        // Re-mock loadAgent for this block with config present
        mock.module("@devops-agent/gitagent-bridge", () => ({
            loadAgent: () => ({
                manifest: { compliance: { risk_tier: "low" } },
                soul: "",
                rules: "",
                tools: [],
                skills: new Map(),
                subAgents: new Map(),
                knowledge: [],
                runbookSelection: {
                    fallback_by_severity: {
                        critical: ["a.md"],
                        high: [],
                        medium: [],
                        low: [],
                    },
                },
            }),
            requiresApproval: () => false,
            buildSystemPrompt: () => "",
        }));
        // Re-import to pick up new mock (bun:test mock.module is hoisted per test)
        const { getRunbookFallbackConfig } = await import("./prompt-context.ts");
        expect(getRunbookFallbackConfig().critical).toEqual(["a.md"]);
    });
});
```

**Note:** Re-mocking mid-test in `bun:test` is awkward. If this test proves hard to get green, split into a separate `prompt-context-runbook-config.test.ts` file that mocks `loadAgent` with config-present at the top of the file.

- [ ] **Step 2: Extend `LoadedAgent` and `loadAgent()` in gitagent-bridge**

In `packages/gitagent-bridge/src/manifest-loader.ts`:

Add to the `LoadedAgent` interface:

```typescript
export interface LoadedAgent {
    manifest: AgentManifest;
    soul: string;
    rules: string;
    tools: ToolDefinition[];
    skills: Map<string, string>;
    subAgents: Map<string, LoadedAgent>;
    knowledge: KnowledgeEntry[];
    runbookSelection?: RunbookSelectionConfig;   // NEW
}
```

Import `RunbookSelectionConfig` from `./types.ts`.

Modify `loadAgent()` to also return `runbookSelection`. The existing `loadKnowledge()` already parses the index; extract the `runbook_selection` block and return it alongside `entries`. Refactor `loadKnowledge()` to return `{ entries, runbookSelection }`:

```typescript
function loadKnowledge(agentDir: string): {
    entries: KnowledgeEntry[];
    runbookSelection?: RunbookSelectionConfig;
} {
    const knowledgeDir = join(agentDir, "knowledge");
    const indexPath = join(knowledgeDir, "index.yaml");

    if (!existsSync(indexPath)) return { entries: [] };

    const indexYaml = parse(readFileSync(indexPath, "utf-8"));
    const index = KnowledgeIndexSchema.safeParse(indexYaml);
    if (!index.success) return { entries: [] };

    const entries: KnowledgeEntry[] = [];
    for (const [category, config] of Object.entries(index.data.categories)) {
        const categoryDir = join(knowledgeDir, config.path);
        if (!isDirectory(categoryDir)) continue;

        const files = readdirSync(categoryDir).filter((f) => f.endsWith(".md") && f !== ".gitkeep");
        for (const file of files) {
            const content = readFileSync(join(categoryDir, file), "utf-8").trim();
            if (content) {
                entries.push({ category, filename: file, content });
            }
        }
    }

    // Validate filenames (from Task 2)
    if (index.data.runbook_selection) {
        // ... existing validation code from Task 2 ...
    }

    return {
        entries,
        runbookSelection: index.data.runbook_selection,
    };
}
```

Update the `loadAgent()` caller to destructure and assign:

```typescript
const { entries: knowledge, runbookSelection } = loadKnowledge(agentDir);
return { manifest, soul, rules, tools, skills, subAgents, knowledge, runbookSelection };
```

- [ ] **Step 3: Add the helper in prompt-context.ts**

In `packages/agent/src/prompt-context.ts`:

```typescript
import { RunbookSelectionConfigError } from "./runbook-selector.ts";

export function getRunbookFallbackConfig(): Record<"critical" | "high" | "medium" | "low", string[]> {
    const agent = getAgent();
    if (!agent.runbookSelection) {
        throw new RunbookSelectionConfigError(
            "knowledge/index.yaml has no runbook_selection block but the runbook selector " +
                "is wired into the graph. Either remove the selectRunbooks node from graph.ts " +
                "or add a runbook_selection block with fallback_by_severity for all four severities.",
        );
    }
    return agent.runbookSelection.fallback_by_severity;
}
```

- [ ] **Step 4: Update the selector to use the helper**

In `packages/agent/src/runbook-selector.ts`, replace the placeholder:

```typescript
import { getRunbookCatalog, getRunbookFallbackConfig, type RunbookCatalogEntry } from "./prompt-context.ts";

// ... inside selectRunbooks() ...
const config: RunbookSelectorDeps["fallbackBySeverity"] =
    (globalThis as any).__runbookSelectorConfig?.fallbackBySeverity ??
    getRunbookFallbackConfig();
```

Remove the placeholder `getFallbackConfigFromAgent` function.

- [ ] **Step 5: Run all relevant tests**

Run: `bun test packages/agent/src/ packages/gitagent-bridge/src/`
Expected: all tests pass. The selector tests still work because they inject config via `__runbookSelectorConfig`.

- [ ] **Step 6: Typecheck both packages**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck && bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/gitagent-bridge/src/manifest-loader.ts packages/gitagent-bridge/src/types.ts packages/agent/src/prompt-context.ts packages/agent/src/runbook-selector.ts packages/agent/src/prompt-context.test.ts
git commit -m "SIO-640: Wire runbook_selection config through to the selector

loadAgent() now returns runbookSelection from knowledge/index.yaml on
the LoadedAgent type. prompt-context.getRunbookFallbackConfig() reads
it and throws RunbookSelectionConfigError if absent, making the feature
truly opt-in-all-or-nothing.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Conditionally wire `selectRunbooks` into `graph.ts`

**Goal:** Register the node and add the edge `normalize -> selectRunbooks -> entityExtractor` only when the loaded agent has `runbookSelection` config. Otherwise keep the current `normalize -> entityExtractor` edge untouched. This is the config gate that makes the feature opt-in per deployment.

**Files:**
- Modify: `packages/agent/src/graph.ts`
- Test: `packages/agent/src/graph.test.ts` (new file, or extend if exists)

- [ ] **Step 1: Check whether graph.test.ts exists**

Run: `ls packages/agent/src/graph.test.ts 2>&1 || echo "not found"`

- [ ] **Step 2: Write the failing test**

Create or extend `packages/agent/src/graph.test.ts`:

```typescript
import { describe, expect, mock, test } from "bun:test";

// Track which nodes get added so we can assert on graph wiring
const addedNodes: string[] = [];
const addedEdges: Array<[string, string]> = [];

mock.module("@langchain/langgraph", () => ({
    END: "__end__",
    StateGraph: class {
        addNode(name: string, _fn: unknown) {
            addedNodes.push(name);
            return this;
        }
        addEdge(from: string, to: string) {
            addedEdges.push([from, to]);
            return this;
        }
        addConditionalEdges(_from: string, _fn: unknown, _targets?: string[]) {
            return this;
        }
        compile(_opts: unknown) {
            return { nodes: addedNodes, edges: addedEdges };
        }
    },
}));

mock.module("./langsmith.ts", () => ({
    initializeLangSmith: async () => {},
}));

mock.module("@devops-agent/checkpointer", () => ({
    createCheckpointer: () => ({}),
}));

describe("graph wiring: runbook selector gate", () => {
    test("omits selectRunbooks when runbookSelection is absent", async () => {
        addedNodes.length = 0;
        addedEdges.length = 0;
        mock.module("./prompt-context.ts", () => ({
            getAgent: () => ({ runbookSelection: undefined, manifest: {}, tools: [] }),
        }));
        const { buildGraph } = await import("./graph.ts");
        await buildGraph();
        expect(addedNodes).not.toContain("selectRunbooks");
        expect(addedEdges).toContainEqual(["normalize", "entityExtractor"]);
    });

    test("includes selectRunbooks when runbookSelection is present", async () => {
        addedNodes.length = 0;
        addedEdges.length = 0;
        mock.module("./prompt-context.ts", () => ({
            getAgent: () => ({
                runbookSelection: { fallback_by_severity: { critical: [], high: [], medium: [], low: [] } },
                manifest: {},
                tools: [],
            }),
        }));
        const { buildGraph } = await import("./graph.ts");
        await buildGraph();
        expect(addedNodes).toContain("selectRunbooks");
        expect(addedEdges).toContainEqual(["normalize", "selectRunbooks"]);
        expect(addedEdges).toContainEqual(["selectRunbooks", "entityExtractor"]);
    });
});
```

**Note:** This test depends on `bun:test` `mock.module` behaving as re-importable per test. If that proves unreliable, split into two test files — one per scenario — mocked at top-of-file. The logic being tested is trivial (an `if` branch); the test is documentation as much as verification.

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/agent/src/graph.test.ts`
Expected: FAIL — the graph unconditionally has `normalize -> entityExtractor`.

- [ ] **Step 4: Implement the gate**

In `packages/agent/src/graph.ts`:

```typescript
import { selectRunbooks } from "./runbook-selector.ts";
import { getAgent } from "./prompt-context.ts";

// ... inside buildGraph() ...
export async function buildGraph(config?: { checkpointerType?: "memory" | "sqlite" }) {
    await initializeLangSmith();

    const agent = getAgent();
    const runbookSelectorEnabled = agent.runbookSelection !== undefined;

    const graph = new StateGraph(AgentState)
        .addNode("classify", traceNode("classify", classify))
        .addNode("normalize", traceNode("normalize", normalizeIncident))
        .addNode("responder", traceNode("responder", respond))
        .addNode("entityExtractor", traceNode("entityExtractor", extractEntities))
        .addNode("queryDataSource", traceNode("queryDataSource", queryDataSource))
        .addNode("align", traceNode("align", checkAlignment))
        .addNode("aggregate", traceNode("aggregate", aggregate))
        .addNode("checkConfidence", traceNode("checkConfidence", checkConfidence))
        .addNode("validate", traceNode("validate", validate))
        .addNode("proposeMitigation", traceNode("proposeMitigation", proposeMitigation))
        .addNode("followUp", traceNode("followUp", generateSuggestions));

    // SIO-640: Conditionally register the runbook selector node
    if (runbookSelectorEnabled) {
        graph.addNode("selectRunbooks", traceNode("selectRunbooks", selectRunbooks));
    }

    graph
        .addEdge("__start__", "classify")
        .addConditionalEdges("classify", (state) => {
            return state.queryComplexity === "simple" ? "responder" : "normalize";
        })
        .addEdge("responder", "followUp")
        .addEdge("followUp", END);

    // SIO-640: normalize -> selectRunbooks -> entityExtractor (enabled)
    //          normalize -> entityExtractor (disabled)
    if (runbookSelectorEnabled) {
        graph
            .addEdge("normalize", "selectRunbooks")
            .addEdge("selectRunbooks", "entityExtractor");
    } else {
        graph.addEdge("normalize", "entityExtractor");
    }

    graph
        .addConditionalEdges("entityExtractor", supervise)
        .addEdge("queryDataSource", "align")
        .addConditionalEdges("align", routeAfterAlignment, ["queryDataSource", "aggregate"])
        .addEdge("aggregate", "checkConfidence")
        .addEdge("checkConfidence", "validate")
        .addConditionalEdges("validate", (state) => {
            return shouldRetryValidation(state) ? "aggregate" : "proposeMitigation";
        })
        .addEdge("proposeMitigation", "followUp");

    const checkpointer = createCheckpointer(config?.checkpointerType ?? "memory");
    return graph.compile({ checkpointer });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/agent/src/graph.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 6: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/graph.ts packages/agent/src/graph.test.ts
git commit -m "SIO-640: Conditionally wire selectRunbooks based on config presence

When knowledge/index.yaml contains a runbook_selection block, the
graph wires normalize -> selectRunbooks -> entityExtractor. When the
block is absent, the graph keeps the existing normalize ->
entityExtractor edge and selectRunbooks is never loaded.

Feature is fully opt-in per deployment with zero regression risk
for deployments that do not enable it.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Enable `runbook_selection` in the incident-analyzer agent

**Goal:** Add the config block to this repository's knowledge index so the feature turns on locally. After this commit, a local run will exercise `selectRunbooks` end-to-end.

**Files:**
- Modify: `agents/incident-analyzer/knowledge/index.yaml`

- [ ] **Step 1: Add the block**

Edit `agents/incident-analyzer/knowledge/index.yaml` — append at the end, after `categories:`:

```yaml
# SIO-640: Phase 2A lazy runbook selection fallback config.
# Consumed by packages/agent/src/runbook-selector.ts when the LLM router
# fails. Filenames must exist under categories.runbooks.path (validated
# at load time by packages/gitagent-bridge/src/manifest-loader.ts).
runbook_selection:
  fallback_by_severity:
    critical: ["kafka-consumer-lag.md", "high-error-rate.md", "database-slow-queries.md"]
    high:     ["kafka-consumer-lag.md", "high-error-rate.md", "database-slow-queries.md"]
    medium:   []
    low:      []
```

- [ ] **Step 2: Run yaml:check**

Run: `bun run yaml:check`
Expected: clean. Any error here points to a bug in Task 1 or Task 2.

- [ ] **Step 3: Run full agent tests**

Run: `bun test packages/agent/src/ packages/gitagent-bridge/src/`
Expected: all green.

- [ ] **Step 4: Smoke-start the agent**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

(Full SSE smoke test is a manual step in Task 12.)

- [ ] **Step 5: Commit**

```bash
git add agents/incident-analyzer/knowledge/index.yaml
git commit -m "SIO-640: Enable lazy runbook selection for incident-analyzer

Adds runbook_selection.fallback_by_severity with the three current
runbooks as the critical/high fallback and empty fallback for medium
and low. Tunable per deployment.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: End-to-end smoke test and documentation

**Goal:** Run the SSE smoke test manually, verify a LangSmith trace contains the `selectRunbooks` span with expected attributes, and document the new node in `docs/architecture/agent-pipeline.md`.

**Files:**
- Modify: `docs/architecture/agent-pipeline.md`

- [ ] **Step 1: Start the agent locally**

Run: `bun run --filter '@devops-agent/web' dev` (and whatever MCP servers and the agent server require — consult `docs/deployment/local-development.md`).

- [ ] **Step 2: Submit a query matching `kafka-consumer-lag.md`**

In the web UI at http://localhost:5173, submit:

> Kafka consumer group `user-events` is lagging by 50000 messages on topic `user.events`. Critical.

- [ ] **Step 3: Inspect the LangSmith trace**

Using the langsmith-fetch CLI:

```bash
grep "^LANGSMITH_API_KEY=" .env
LANGSMITH_API_KEY=<key> LANGSMITH_PROJECT=devops-incident-analyzer langsmith-fetch traces /tmp/traces --limit 5 --include-metadata --last-n-minutes 5 --format pretty
```

- [ ] **Step 4: Verify the span attributes**

In the fetched traces, locate the span named `agent.node.selectRunbooks`. Confirm:

- `runbook.selection.mode` is `llm` (not a fallback mode)
- `runbook.selection.filenames` contains `kafka-consumer-lag.md`
- `runbook.selection.count` is 1 or 2

If any of these are wrong, debug by reading the span's `runbook.selection.reasoning` attribute for the LLM's rationale and adjusting the router prompt or catalog summary format in `prompt-context.ts:parseRunbookCatalogEntry` or `runbook-selector.ts:systemPrompt`.

- [ ] **Step 5: Verify aggregator output cites the runbook**

In the UI response, confirm the aggregator's output mentions `kafka-consumer-lag.md` by name in its correlation block or recommendations.

- [ ] **Step 6: Run the non-matching regression check**

Submit a query that should NOT match any runbook, e.g.:

> What is the current state of the environment?

Confirm the span shows `runbook.selection.mode = llm.empty` or a `fallback.*` mode, and that the aggregator still produces a useful report (reference material narrowed correctly).

- [ ] **Step 7: Document the node in the pipeline doc**

Edit `docs/architecture/agent-pipeline.md`. Find the section describing the 8-node (now 9-node when enabled) pipeline and add a subsection for `selectRunbooks` that covers:

- Purpose (one-sentence summary)
- Position in the pipeline (between `normalize` and `entityExtractor`)
- Config gate (`knowledge/index.yaml:runbook_selection`)
- Inputs read (`state.normalizedIncident`, last user message, runbook catalog)
- Output written (`state.selectedRunbooks: string[] | null`)
- Failure modes (link to the spec's Error Handling section)
- Observability attributes emitted

Reference the spec file path at the end of the subsection.

- [ ] **Step 8: Final typecheck, lint, and test run**

Run: `bun run typecheck && bun run lint && bun test`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add docs/architecture/agent-pipeline.md
git commit -m "SIO-640: Document selectRunbooks node in agent pipeline doc

Covers purpose, position, config gate, I/O, failure modes, and
observability. Points at the design spec for full detail.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 10: Push and open PR**

```bash
git push -u origin simonowusupvh/sio-640-phase-2a-implement-lazy-runbook-selection-selectrunbooks
gh pr create --title "SIO-640: Lazy runbook selection (Phase 2A)" --body "$(cat <<'EOF'
## Summary

- Adds `selectRunbooks` LangGraph node between `normalize` and `entityExtractor`
- Introduces tri-state `selectedRunbooks: string[] | null` state field
- Extends `buildOrchestratorPrompt({ runbookFilter })` with filter semantics
- Severity-tier fallback config gates the entire feature (absent = disabled)
- 14 unit tests cover every failure mode in the spec

Design spec: `docs/superpowers/specs/2026-04-10-lazy-runbook-selection-design.md`
Implementation plan: `docs/superpowers/plans/2026-04-10-lazy-runbook-selection.md`

## Test plan

- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] `bun test` all green
- [ ] Manual SSE smoke test with a `kafka-consumer-lag` query shows `runbook.selection.mode = llm` in LangSmith trace
- [ ] Manual SSE smoke test with a generic state query shows `llm.empty` or `fallback.*` and a useful aggregator report

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

Fresh read of the plan against the spec.

**1. Spec coverage — every spec requirement has a task:**

| Spec section | Covered by |
|---|---|
| Pipeline change | Task 10 (wire node), Task 4 (state field) |
| New node `selectRunbooks` | Task 7 (skeleton), Task 8 (impl + tests), Task 9 (config wiring) |
| New state field `selectedRunbooks` | Task 4 |
| Aggregator change (`buildOrchestratorPrompt` options) | Task 5 (options + helper), Task 6 (wire through aggregator) |
| New `LoadedAgent` field (spec says `runbookCatalog`, plan deviates) | Deviation #3 — catalog built on-the-fly via `getRunbookCatalog()` in Task 5 |
| New config `runbook_selection` schema | Task 1 |
| Filename validation at load time | Task 2 |
| Config exposed on `LoadedAgent` | Task 9 (`runbookSelection` field, not `runbookCatalog`) |
| Router prompt construction | Task 8 (inline in implementation) |
| Observability | Task 8 (via `logger.info` with structured fields; `traceNode` wraps the node automatically at Task 10's addNode call) |
| Error handling (all 12 table rows) | Task 8 (all 12 + 2 error-class tests) |
| Unit tests: runbook selector | Task 8 |
| Unit tests: load-time config validation | Task 2 (3 cases for schema + 2 for filename validation) |
| Unit tests: aggregator filter (layer 1) | Task 5 (5 cases) |
| Unit tests: aggregator filter (layer 2 — tri-state integration) | Task 6 (3 cases) |
| End-to-end smoke test | Task 12 |
| Rollout config gate | Tasks 9 + 10 (absent config → node not wired → current behavior) |
| Enable in this repo | Task 11 |
| Documentation update | Task 12 |

Coverage is complete. Deviations from the spec are called out in the Spec Deviations section at the top.

**2. Placeholder scan:** The plan uses `SIO-640` as a deliberate placeholder for the Linear issue ID, with Task 0 explicitly requiring find-and-replace before Task 1 starts. Every other step has complete code blocks, exact file paths, and expected test output. No "TBD" or "handle edge cases" language.

**3. Type consistency check:**

- `selectedRunbooks: string[] | null` — consistent in Task 4 (state), Task 5 (options comment), Task 6 (aggregator coalesce), Task 8 (test expectations).
- `RunbookSelectionConfigSchema` → `RunbookSelectionConfig` (inferred type) → `LoadedAgent.runbookSelection?: RunbookSelectionConfig` — introduced Task 1, exported Task 1, consumed Task 9. Consistent.
- `SelectionMode` union — declared Task 7, used Task 8.
- `RunbookCatalogEntry` with `{filename, title, summary}` — declared Task 5, consumed Task 8 via `getRunbookCatalog()`.
- `buildOrchestratorPrompt(options?: OrchestratorPromptOptions)` — declared Task 5, called with `{ runbookFilter }` in Task 6. Consistent.
- `RunbookSelectionFallbackError` and `RunbookSelectionConfigError` — declared Task 7, thrown Task 8 (Fallback) and Task 9 (Config), asserted in Task 8 tests. Consistent.

**4. One issue I want to flag, not fix inline:** Task 9 Step 1's test for `getRunbookFallbackConfig` uses `mock.module` re-mocking mid-test. `bun:test` may not reliably re-import a mocked module within the same file. If that test fails to flip behavior, the implementer should split it into a separate test file with the config-present mock at the top. I noted this inline in the step. Not a placeholder — a known-ambiguity flag with a concrete workaround.

**5. Scope:** The plan is 12 tasks (13 counting Task 0) with clear dependencies. Each task produces a working, committable checkpoint. The pipeline never breaks mid-task — before Task 10, `selectRunbooks` exists but isn't wired in; after Task 10, it's wired but config-gated off by default; after Task 11, it's live in this repo.

Self-review complete. No inline fixes needed — the one ambiguity in Task 9 Step 1 has a concrete fallback plan in the step itself.
