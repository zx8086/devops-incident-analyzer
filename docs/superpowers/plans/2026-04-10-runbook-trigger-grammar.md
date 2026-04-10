# Runbook Trigger Grammar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a YAML frontmatter trigger grammar to runbooks, parse and validate it at load time, and integrate a deterministic pre-filter into brainstorm A's `selectRunbooks` node before the LLM router. Runbooks without frontmatter stay backwards compatible; runbooks with triggers narrow the router's input set based on `NormalizedIncident` signals.

**Architecture:** Four code files modified across two packages. `gitagent-bridge` gains Zod schemas and a frontmatter parser in `manifest-loader.ts`; `agent` gains per-axis matchers and a narrowing function in `runbook-selector.ts`; `prompt-context.ts` passes triggers from `KnowledgeEntry` through to `RunbookCatalogEntry`; `runbook-validator.test.ts` (from SIO-641) gets a small frontmatter-skip tweak. The filter runs inside `selectRunbooks` (from SIO-640) as its first step before any LLM call. Triggers narrow, they do not gatekeep: zero matches → full catalog fallback; no runbook has triggers → no-op.

**Tech Stack:** Bun 1.3.9+, TypeScript 5.x strict, Zod v4.3.6 with `.strict()`, `bun:test` with `mock.module()`, `yaml` package for YAML parsing, `NormalizedIncident` type from `@devops-agent/shared`.

**Source spec:** `docs/superpowers/specs/2026-04-10-runbook-trigger-grammar-design.md` — read first for full design rationale.

**Linear issue:** SIO-643

---

## Hard Prerequisites: SIO-640 AND SIO-641 Must Be Implemented First

This plan modifies files created by brainstorm A (SIO-640) and brainstorm B (SIO-641). Both must be implemented before Task 1 starts.

- **SIO-640 deliverables needed:** `packages/agent/src/runbook-selector.ts` (the `selectRunbooks` node, `RunbookCatalogEntry` type, `getRunbookCatalog()` helper), the co-located `runbook-selector.test.ts` with 14 unit tests.
- **SIO-641 deliverables needed:** `packages/gitagent-bridge/src/runbook-validator.test.ts` with `extractProseCitations()` function.

Task 0 verifies both prerequisites and halts if either is missing.

---

## Spec Deviations

None. The implementation follows the spec exactly.

---

## File Structure

**Modify:**
- `packages/gitagent-bridge/src/types.ts` — add `RunbookTriggersSchema`, `RunbookFrontmatterSchema`, inferred types
- `packages/gitagent-bridge/src/manifest-loader.ts` — add `parseRunbookFrontmatter()`, extend `loadKnowledge()`, add `triggers?` to `KnowledgeEntry`
- `packages/gitagent-bridge/src/index.test.ts` — 11 parser unit tests (file already exists from SIO-641)
- `packages/gitagent-bridge/src/runbook-validator.test.ts` — add frontmatter skip to `extractProseCitations()` and 2 tests (file from SIO-641)
- `packages/agent/src/prompt-context.ts` — extend `RunbookCatalogEntry` with `triggers?`, pass through in `getRunbookCatalog()`
- `packages/agent/src/runbook-selector.ts` — add per-axis matchers, `matchTriggers`, `narrowCatalogByTriggers`, integrate into `selectRunbooks` (file from SIO-640)
- `packages/agent/src/runbook-selector.test.ts` — add 29 new tests (file from SIO-640)

**Create:** Nothing

**Do not modify:**
- `skill-loader.ts`, `buildSystemPrompt()`, `buildKnowledgeSection()` (unchanged — they already consume the stripped `content`)
- `state.ts`, `graph.ts` (selector wiring unchanged)
- Brainstorm A's `selectedRunbooks` state field, Zod response schema, config gate, severity-tier fallback
- Brainstorm B's validator structure beyond the one `extractProseCitations` tweak
- The three current production runbooks — they stay frontmatter-less

---

## Task 0: Verify SIO-640 and SIO-641 are implemented

**Goal:** Hard-fail before any code changes if either prerequisite is missing.

**Files:** None

- [ ] **Step 1: Verify SIO-640's runbook-selector.ts exists and passes tests**

Run: `ls packages/agent/src/runbook-selector.ts 2>&1`
Expected: the file path is printed.

Run: `bun test packages/agent/src/runbook-selector.test.ts`
Expected: all tests pass (14+ tests per the SIO-640 plan).

If either fails: **STOP.** Implement SIO-640 first per `docs/superpowers/plans/2026-04-10-lazy-runbook-selection.md`, then return.

- [ ] **Step 2: Verify SIO-641's runbook-validator.test.ts exists and passes**

Run: `ls packages/gitagent-bridge/src/runbook-validator.test.ts 2>&1`
Expected: the file path is printed.

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: all tests pass (40 tests per the SIO-641 plan).

If either fails: **STOP.** Implement SIO-641 first per `docs/superpowers/plans/2026-04-10-runbook-tool-binding-validator.md`, then return.

- [ ] **Step 3: Verify required exports from SIO-640**

Run: `grep -E "export (type )?Runbook(CatalogEntry|SelectorDeps)|export (async )?function (selectRunbooks|getRunbookCatalog)" packages/agent/src/runbook-selector.ts packages/agent/src/prompt-context.ts`
Expected: at least one match for `RunbookCatalogEntry` and one for `getRunbookCatalog`.

If either is absent: SIO-640 was implemented differently than its plan. Read the actual file, adapt this plan's references, and document the deviation in a comment at the top of Task 1.

- [ ] **Step 4: No commit**

Verification only.

---

## Task 1: Add `RunbookTriggersSchema` and `RunbookFrontmatterSchema` to types.ts

**Goal:** Define the two Zod schemas and inferred types. No parsing logic yet; just the type definitions.

**Files:**
- Modify: `packages/gitagent-bridge/src/types.ts`
- Test: `packages/gitagent-bridge/src/index.test.ts`

- [ ] **Step 1: Write failing tests for both schemas**

Append to `packages/gitagent-bridge/src/index.test.ts` (after existing imports, add to the imports line):

```typescript
import {
    // ... existing imports from SIO-641 and earlier ...
    RunbookFrontmatterSchema,
    RunbookTriggersSchema,
} from "./index.ts";
```

Append to the end of the existing test file:

```typescript
describe("RunbookTriggersSchema", () => {
    test("accepts all three axes + match combinator", () => {
        const input = {
            severity: ["critical", "high"],
            services: ["kafka", "consumer"],
            metrics: ["lag"],
            match: "any",
        };
        expect(() => RunbookTriggersSchema.parse(input)).not.toThrow();
    });

    test("accepts empty object (all axes undefined)", () => {
        expect(() => RunbookTriggersSchema.parse({})).not.toThrow();
    });

    test("rejects invalid severity value", () => {
        const input = { severity: ["criticall"] };
        expect(() => RunbookTriggersSchema.parse(input)).toThrow();
    });

    test("rejects invalid match value", () => {
        const input = { match: "either" };
        expect(() => RunbookTriggersSchema.parse(input)).toThrow();
    });

    test("rejects unknown key (strict mode)", () => {
        const input = { metric: ["lag"] }; // typo: metric vs metrics
        expect(() => RunbookTriggersSchema.parse(input)).toThrow();
    });
});

describe("RunbookFrontmatterSchema", () => {
    test("accepts object with triggers key", () => {
        const input = { triggers: { severity: ["critical"] } };
        expect(() => RunbookFrontmatterSchema.parse(input)).not.toThrow();
    });

    test("rejects object without triggers key", () => {
        const input = { tags: ["kafka"] };
        expect(() => RunbookFrontmatterSchema.parse(input)).toThrow();
    });

    test("rejects object with triggers AND unknown top-level key", () => {
        const input = { triggers: { severity: ["critical"] }, author: "dev" };
        expect(() => RunbookFrontmatterSchema.parse(input)).toThrow();
    });

    test("rejects undefined (empty YAML parse result)", () => {
        expect(() => RunbookFrontmatterSchema.parse(undefined)).toThrow();
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gitagent-bridge/src/index.test.ts -t "RunbookTriggersSchema|RunbookFrontmatterSchema"`
Expected: FAIL with errors about undefined imports (`RunbookTriggersSchema` and `RunbookFrontmatterSchema` don't exist yet).

- [ ] **Step 3: Add the schemas to types.ts**

In `packages/gitagent-bridge/src/types.ts`, find the existing Zod imports (they already exist for other schemas like `AgentManifestSchema`). Add these at the end of the file, before the type exports block:

```typescript
export const RunbookTriggersSchema = z
    .object({
        severity: z.array(z.enum(["critical", "high", "medium", "low"])).optional(),
        services: z.array(z.string()).optional(),
        metrics: z.array(z.string()).optional(),
        match: z.enum(["any", "all"]).optional(),
    })
    .strict();

export type RunbookTriggers = z.infer<typeof RunbookTriggersSchema>;

export const RunbookFrontmatterSchema = z
    .object({
        triggers: RunbookTriggersSchema,
    })
    .strict();

export type RunbookFrontmatter = z.infer<typeof RunbookFrontmatterSchema>;
```

- [ ] **Step 4: Re-export the new schemas from index.ts**

In `packages/gitagent-bridge/src/index.ts`, find the existing re-exports from `./types.ts`. Add `RunbookFrontmatterSchema`, `RunbookTriggersSchema`, `type RunbookFrontmatter`, `type RunbookTriggers` to the exports list.

Example (the exact surrounding context depends on the current file layout):

```typescript
export {
    type AgentManifest,
    AgentManifestSchema,
    // ... other existing exports ...
    type RunbookFrontmatter,
    RunbookFrontmatterSchema,
    type RunbookTriggers,
    RunbookTriggersSchema,
    // ... rest of existing exports ...
} from "./types.ts";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/index.test.ts -t "RunbookTriggersSchema|RunbookFrontmatterSchema"`
Expected: 9 tests pass (5 for RunbookTriggersSchema, 4 for RunbookFrontmatterSchema).

- [ ] **Step 6: Run the full package test suite to confirm no regressions**

Run: `bun test packages/gitagent-bridge/src/`
Expected: all tests pass, including SIO-641's 40 tests and the 9 new schema tests.

- [ ] **Step 7: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/gitagent-bridge/src/types.ts packages/gitagent-bridge/src/index.ts packages/gitagent-bridge/src/index.test.ts
git commit -m "SIO-643: Add RunbookTriggersSchema and RunbookFrontmatterSchema

Two new Zod schemas with .strict() validation. RunbookTriggersSchema
has three optional axes (severity, services, metrics) plus a match
combinator. RunbookFrontmatterSchema is the outer wrapper requiring
exactly one top-level 'triggers' key. 9 unit tests cover both schemas
including typo detection (metric vs metrics) and strict mode rejection.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Implement `parseRunbookFrontmatter` helper in manifest-loader.ts

**Goal:** Add the frontmatter detection, YAML parse, and validation helper. Returns `{triggers?, body}`. Throws on any error with file path context added by the caller in Task 3.

**Files:**
- Modify: `packages/gitagent-bridge/src/manifest-loader.ts`
- Test: `packages/gitagent-bridge/src/index.test.ts`

- [ ] **Step 1: Write the 11 failing tests**

Append to `packages/gitagent-bridge/src/index.test.ts`:

```typescript
// Added helper imports at the top of the file alongside other gitagent-bridge imports:
// import { parseRunbookFrontmatter } from "./manifest-loader.ts";
// (if manifest-loader.ts does not export it yet, add the export in Step 3)

describe("parseRunbookFrontmatter", () => {
    test("1. no frontmatter", () => {
        const input = "# Runbook\nBody";
        const result = parseRunbookFrontmatter(input);
        expect(result.triggers).toBeUndefined();
        expect(result.body).toBe("# Runbook\nBody");
    });

    test("2. empty frontmatter block throws", () => {
        const input = "---\n---\n# Body";
        expect(() => parseRunbookFrontmatter(input)).toThrow();
    });

    test("2b. frontmatter with only match (no axes) parses", () => {
        const input = "---\ntriggers:\n  match: any\n---\n# Body";
        const result = parseRunbookFrontmatter(input);
        expect(result.triggers).toEqual({ match: "any" });
        expect(result.body).toBe("# Body");
    });

    test("3. severity only", () => {
        const input = "---\ntriggers:\n  severity: [critical]\n---\n# Body";
        const result = parseRunbookFrontmatter(input);
        expect(result.triggers).toEqual({ severity: ["critical"] });
        expect(result.body).toBe("# Body");
    });

    test("4. all three axes + match", () => {
        const input = [
            "---",
            "triggers:",
            "  severity: [critical, high]",
            "  services: [kafka]",
            "  metrics: [lag]",
            "  match: all",
            "---",
            "# Body",
        ].join("\n");
        const result = parseRunbookFrontmatter(input);
        expect(result.triggers).toEqual({
            severity: ["critical", "high"],
            services: ["kafka"],
            metrics: ["lag"],
            match: "all",
        });
        expect(result.body).toBe("# Body");
    });

    test("5. frontmatter followed by paragraph", () => {
        const input = [
            "---",
            "triggers:",
            "  severity: [high]",
            "---",
            "",
            "# Body",
            "",
            "Paragraph.",
        ].join("\n");
        const result = parseRunbookFrontmatter(input);
        expect(result.triggers).toEqual({ severity: ["high"] });
        expect(result.body.trim()).toBe("# Body\n\nParagraph.");
    });

    test("6. unknown trigger key (typo: metric)", () => {
        const input = "---\ntriggers:\n  metric: [lag]\n---\n";
        expect(() => parseRunbookFrontmatter(input)).toThrow();
    });

    test("7. invalid severity value", () => {
        const input = "---\ntriggers:\n  severity: [criticall]\n---\n";
        expect(() => parseRunbookFrontmatter(input)).toThrow();
    });

    test("8. invalid match value", () => {
        const input = "---\ntriggers:\n  match: either\n---\n";
        expect(() => parseRunbookFrontmatter(input)).toThrow();
    });

    test("9. unknown top-level frontmatter key", () => {
        const input = "---\ntags: [kafka]\n---\n";
        expect(() => parseRunbookFrontmatter(input)).toThrow();
    });

    test("10. missing closing ---", () => {
        const input = "---\ntriggers:\n  severity: [high]\n# Body";
        expect(() => parseRunbookFrontmatter(input)).toThrow();
    });

    test("11. malformed YAML", () => {
        const input = "---\ntriggers: { severity: [critical\n---\n";
        expect(() => parseRunbookFrontmatter(input)).toThrow();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gitagent-bridge/src/index.test.ts -t "parseRunbookFrontmatter"`
Expected: FAIL with `parseRunbookFrontmatter is not defined` or import errors.

- [ ] **Step 3: Implement `parseRunbookFrontmatter` in manifest-loader.ts**

In `packages/gitagent-bridge/src/manifest-loader.ts`, find the existing imports (around line 1-11). Add `RunbookFrontmatterSchema` and `RunbookTriggers` to the imports from `./types.ts`:

```typescript
import {
    type AgentManifest,
    AgentManifestSchema,
    KnowledgeIndexSchema,
    RunbookFrontmatterSchema,
    type RunbookTriggers,
    type ToolDefinition,
    ToolDefinitionSchema,
} from "./types.ts";
```

Add the helper function. Put it after `loadKnowledge()` (around line 98) and before the private helpers at the bottom of the file:

```typescript
/**
 * Detects, parses, validates, and strips YAML frontmatter from a runbook file's content.
 *
 * Returns:
 *   { triggers: undefined, body: <full content> }  when no frontmatter is present
 *   { triggers: RunbookTriggers, body: <stripped content> }  when valid frontmatter is present
 *
 * Throws on:
 *   - Missing closing --- delimiter
 *   - Malformed YAML
 *   - Zod validation failure (unknown keys, invalid enum values, etc.)
 *   - Empty frontmatter block (yaml.parse("") returns undefined, schema rejects)
 */
export function parseRunbookFrontmatter(content: string): {
    triggers?: RunbookTriggers;
    body: string;
} {
    // No leading --- means no frontmatter
    if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
        return { triggers: undefined, body: content };
    }

    // Find the closing --- delimiter. Start search after the opening delimiter.
    const afterOpening = content.indexOf("\n") + 1;
    const closingMatch = content.slice(afterOpening).match(/^---\r?\n?/m);
    if (!closingMatch || closingMatch.index === undefined) {
        throw new Error("Runbook frontmatter: missing closing --- delimiter");
    }

    const frontmatterYaml = content.slice(afterOpening, afterOpening + closingMatch.index);
    const bodyStart = afterOpening + closingMatch.index + closingMatch[0].length;
    const body = content.slice(bodyStart);

    // Parse YAML. yaml.parse("") returns undefined; the schema rejects that.
    const parsed = parse(frontmatterYaml);

    // Validate with the outer strict wrapper
    const validated = RunbookFrontmatterSchema.parse(parsed);

    return { triggers: validated.triggers, body };
}
```

**Note:** The `parse` function is already imported from `yaml` at the top of `manifest-loader.ts` (line 4). Do not add a duplicate import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/index.test.ts -t "parseRunbookFrontmatter"`
Expected: 12 pass (test 1, 2, 2b, 3, 4, 5, 6, 7, 8, 9, 10, 11).

- [ ] **Step 5: Run full package tests to confirm no regressions**

Run: `bun test packages/gitagent-bridge/src/`
Expected: all tests green.

- [ ] **Step 6: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/gitagent-bridge/src/manifest-loader.ts packages/gitagent-bridge/src/index.test.ts
git commit -m "SIO-643: Implement parseRunbookFrontmatter helper

Detects leading --- delimiter, parses YAML between delimiters, validates
with RunbookFrontmatterSchema (.strict()), returns {triggers?, body}.
Throws on missing closing delimiter, malformed YAML, or schema
validation errors. 12 unit tests cover every parse path including
typos (metric vs metrics), invalid enum values, strict mode rejection,
and empty frontmatter.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extend `KnowledgeEntry` and `loadKnowledge` to use the parser

**Goal:** Add the `triggers?` field to `KnowledgeEntry`, call `parseRunbookFrontmatter` from `loadKnowledge` for runbook files, store stripped body in `content`, attach file path to parse errors.

**Files:**
- Modify: `packages/gitagent-bridge/src/manifest-loader.ts`
- Test: `packages/gitagent-bridge/src/index.test.ts`

- [ ] **Step 1: Write integration tests for the extended loader**

Append to `packages/gitagent-bridge/src/index.test.ts`:

```typescript
describe("loadKnowledge: runbook frontmatter integration", () => {
    function makeTestAgent(runbookFiles: Record<string, string>): string {
        const dir = mkdtempSync(join(tmpdir(), "gitagent-trigger-test-"));
        mkdirSync(join(dir, "knowledge", "runbooks"), { recursive: true });
        writeFileSync(
            join(dir, "agent.yaml"),
            `spec_version: "0.1.0"
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
`,
        );
        writeFileSync(
            join(dir, "knowledge", "index.yaml"),
            `name: test
description: test
version: 0.1.0
categories:
  runbooks: { path: runbooks/, description: test }
`,
        );
        for (const [name, content] of Object.entries(runbookFiles)) {
            writeFileSync(join(dir, "knowledge", "runbooks", name), content);
        }
        return dir;
    }

    test("runbook with valid frontmatter populates triggers and strips content", () => {
        const dir = makeTestAgent({
            "a.md": "---\ntriggers:\n  severity: [critical]\n---\n# Runbook A\n\nBody.",
        });
        const agent = loadAgent(dir);
        const runbookEntry = agent.knowledge.find((e) => e.filename === "a.md");
        expect(runbookEntry).toBeDefined();
        expect(runbookEntry?.triggers).toEqual({ severity: ["critical"] });
        expect(runbookEntry?.content).toBe("# Runbook A\n\nBody.");
        expect(runbookEntry?.content).not.toContain("---");
        expect(runbookEntry?.content).not.toContain("triggers:");
        rmSync(dir, { recursive: true });
    });

    test("runbook without frontmatter leaves triggers undefined", () => {
        const dir = makeTestAgent({
            "b.md": "# Runbook B\n\nBody with no frontmatter.",
        });
        const agent = loadAgent(dir);
        const runbookEntry = agent.knowledge.find((e) => e.filename === "b.md");
        expect(runbookEntry).toBeDefined();
        expect(runbookEntry?.triggers).toBeUndefined();
        expect(runbookEntry?.content).toBe("# Runbook B\n\nBody with no frontmatter.");
        rmSync(dir, { recursive: true });
    });

    test("runbook with invalid frontmatter throws with file path in error", () => {
        const dir = makeTestAgent({
            "broken.md": "---\ntriggers:\n  severity: [criticall]\n---\n# Body",
        });
        expect(() => loadAgent(dir)).toThrow(/broken\.md/);
        rmSync(dir, { recursive: true });
    });

    test("mixed runbooks (some with frontmatter, some without) all load correctly", () => {
        const dir = makeTestAgent({
            "with.md": "---\ntriggers:\n  services: [kafka]\n---\n# With",
            "without.md": "# Without frontmatter",
        });
        const agent = loadAgent(dir);
        const withEntry = agent.knowledge.find((e) => e.filename === "with.md");
        const withoutEntry = agent.knowledge.find((e) => e.filename === "without.md");
        expect(withEntry?.triggers).toEqual({ services: ["kafka"] });
        expect(withEntry?.content).toBe("# With");
        expect(withoutEntry?.triggers).toBeUndefined();
        expect(withoutEntry?.content).toBe("# Without frontmatter");
        rmSync(dir, { recursive: true });
    });
});
```

**Note:** This assumes `mkdtempSync`, `writeFileSync`, `mkdirSync`, `rmSync`, `join`, and `tmpdir` are already imported at the top of `index.test.ts` (they should be from SIO-641's Task 2 tests). If not, add the imports:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gitagent-bridge/src/index.test.ts -t "runbook frontmatter integration"`
Expected: FAIL. The `triggers` field doesn't exist on `KnowledgeEntry` yet, and `loadKnowledge` doesn't call `parseRunbookFrontmatter`.

- [ ] **Step 3: Add `triggers?` to `KnowledgeEntry`**

In `packages/gitagent-bridge/src/manifest-loader.ts`, find the existing `KnowledgeEntry` interface (around line 13):

```typescript
export interface KnowledgeEntry {
    category: string;
    filename: string;
    content: string;
}
```

Extend with the new field:

```typescript
export interface KnowledgeEntry {
    category: string;
    filename: string;
    content: string;
    triggers?: RunbookTriggers;
}
```

- [ ] **Step 4: Modify `loadKnowledge` to parse runbook frontmatter**

In `packages/gitagent-bridge/src/manifest-loader.ts`, find the existing `loadKnowledge` function body. Locate the inner loop that reads file content and pushes to `entries`:

```typescript
for (const file of files) {
    const content = readFileSync(join(categoryDir, file), "utf-8").trim();
    if (content) {
        entries.push({ category, filename: file, content });
    }
}
```

Replace with:

```typescript
for (const file of files) {
    const rawContent = readFileSync(join(categoryDir, file), "utf-8").trim();
    if (!rawContent) continue;

    // Only runbooks get frontmatter parsed. Other categories (systems-map,
    // slo-policies) pass through verbatim.
    if (category === "runbooks") {
        try {
            const { triggers, body } = parseRunbookFrontmatter(rawContent);
            entries.push({
                category,
                filename: file,
                content: body,
                triggers,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Failed to parse runbook frontmatter in ${join(categoryDir, file)}: ${message}`,
            );
        }
    } else {
        entries.push({ category, filename: file, content: rawContent });
    }
}
```

The `try`/`catch` wraps the parser so the caller gets a meaningful error message that names the file path. Non-runbook categories bypass the parser entirely.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/index.test.ts -t "runbook frontmatter integration"`
Expected: 4 tests pass.

- [ ] **Step 6: Run the full gitagent-bridge test suite**

Run: `bun test packages/gitagent-bridge/src/`
Expected: all tests pass. The 3 production runbooks from `agents/incident-analyzer/knowledge/runbooks/` must still load cleanly (none of them have frontmatter, so they'll hit the `triggers === undefined` branch).

- [ ] **Step 7: Verify the production runbook validator (SIO-641) still passes**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: all tests pass. The validator reads `.content` which is now the stripped body; production runbooks have no frontmatter so `.content` is unchanged.

- [ ] **Step 8: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/gitagent-bridge/src/manifest-loader.ts packages/gitagent-bridge/src/index.test.ts
git commit -m "SIO-643: Wire parseRunbookFrontmatter into loadKnowledge

Adds triggers? field to KnowledgeEntry. loadKnowledge parses frontmatter
only for runbook files; systems-map and slo-policies pass through
verbatim. Parse errors are wrapped with file path context so load
failures name the problematic runbook. Backwards compatible with
runbooks that have no frontmatter.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Extend `RunbookCatalogEntry` with triggers pass-through

**Goal:** Add the `triggers?` field to `RunbookCatalogEntry` in `prompt-context.ts`, update `getRunbookCatalog()` to copy it from the corresponding `KnowledgeEntry`.

**Files:**
- Modify: `packages/agent/src/prompt-context.ts`

**No new tests in this task** — the pass-through is trivial and is exercised transitively by the integration tests in Task 6.

- [ ] **Step 1: Read the current `RunbookCatalogEntry` and `getRunbookCatalog` definitions**

Run: `grep -n "RunbookCatalogEntry\|getRunbookCatalog" packages/agent/src/prompt-context.ts`
Expected: line numbers for both definitions.

- [ ] **Step 2: Add `triggers?` to the type**

In `packages/agent/src/prompt-context.ts`, find the existing `RunbookCatalogEntry` interface (added by SIO-640 Task 5). It looks like:

```typescript
export interface RunbookCatalogEntry {
    filename: string;
    title: string;
    summary: string;
}
```

Extend with:

```typescript
export interface RunbookCatalogEntry {
    filename: string;
    title: string;
    summary: string;
    triggers?: RunbookTriggers;
}
```

- [ ] **Step 3: Import `RunbookTriggers` type**

Add to the imports at the top of `prompt-context.ts`:

```typescript
import type { RunbookTriggers } from "@devops-agent/gitagent-bridge";
```

Place this alongside the existing `@devops-agent/gitagent-bridge` imports if one already exists; otherwise add a new import line.

- [ ] **Step 4: Update `getRunbookCatalog` to pass through triggers**

Find the `getRunbookCatalog` function. It currently looks something like:

```typescript
export function getRunbookCatalog(): RunbookCatalogEntry[] {
    const agent = getAgent();
    return agent.knowledge
        .filter((k) => k.category === "runbooks")
        .map((k) => parseRunbookCatalogEntry(k.filename, k.content));
}
```

Modify the `.map(...)` to pass through `k.triggers`:

```typescript
export function getRunbookCatalog(): RunbookCatalogEntry[] {
    const agent = getAgent();
    return agent.knowledge
        .filter((k) => k.category === "runbooks")
        .map((k) => ({
            ...parseRunbookCatalogEntry(k.filename, k.content),
            triggers: k.triggers,
        }));
}
```

The spread-and-override pattern keeps the existing `parseRunbookCatalogEntry` helper unchanged (it returns `{filename, title, summary}`) while adding the new field.

- [ ] **Step 5: Run existing selector tests to confirm no regressions**

Run: `bun test packages/agent/src/runbook-selector.test.ts`
Expected: all SIO-640 tests still pass.

- [ ] **Step 6: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/prompt-context.ts
git commit -m "SIO-643: Pass runbook triggers through RunbookCatalogEntry

getRunbookCatalog now projects KnowledgeEntry.triggers onto
RunbookCatalogEntry.triggers so the selector can read them without
a second frontmatter parse. Type-level change only; no runtime
behavior change without a consumer.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Implement per-axis matchers and `matchTriggers` with TDD

**Goal:** Three pure functions (`matchSeverityAxis`, `matchServicesAxis`, `matchMetricsAxis`) plus the top-level `matchTriggers` combinator. All live as internal helpers in `runbook-selector.ts`.

**Files:**
- Modify: `packages/agent/src/runbook-selector.ts`
- Modify: `packages/agent/src/runbook-selector.test.ts`

- [ ] **Step 1: Write the 12 per-axis matcher tests**

Append to `packages/agent/src/runbook-selector.test.ts` (after SIO-640's existing `describe` blocks):

```typescript
import {
    matchMetricsAxis,
    matchSeverityAxis,
    matchServicesAxis,
    matchTriggers,
} from "./runbook-selector.ts";

describe("matchSeverityAxis", () => {
    test("severity in allowed list", () => {
        expect(matchSeverityAxis(["critical", "high"], "critical")).toBe(true);
    });

    test("severity not in list", () => {
        expect(matchSeverityAxis(["critical"], "low")).toBe(false);
    });

    test("severity undefined", () => {
        expect(matchSeverityAxis(["critical"], undefined)).toBe(false);
    });
});

describe("matchServicesAxis", () => {
    test("pattern is substring of service name", () => {
        expect(matchServicesAxis(["kafka"], [{ name: "kafka-broker" }])).toBe(true);
    });

    test("case-insensitive", () => {
        expect(matchServicesAxis(["KAFKA"], [{ name: "kafka-broker" }])).toBe(true);
    });

    test("no match", () => {
        expect(matchServicesAxis(["kafka"], [{ name: "auth-api" }])).toBe(false);
    });

    test("undefined affected services", () => {
        expect(matchServicesAxis(["kafka"], undefined)).toBe(false);
    });

    test("empty affected services array", () => {
        expect(matchServicesAxis(["kafka"], [])).toBe(false);
    });

    test("multiple patterns, any match wins", () => {
        expect(matchServicesAxis(["kafka", "consumer"], [{ name: "user-consumer" }])).toBe(true);
    });
});

describe("matchMetricsAxis", () => {
    test("pattern is substring of metric name", () => {
        expect(matchMetricsAxis(["lag"], [{ name: "consumer_lag" }])).toBe(true);
    });

    test("no match", () => {
        expect(matchMetricsAxis(["lag"], [{ name: "latency" }])).toBe(false);
    });

    test("undefined metrics", () => {
        expect(matchMetricsAxis(["lag"], undefined)).toBe(false);
    });
});
```

- [ ] **Step 2: Write the 7 combinator tests**

Append to the same test file:

```typescript
describe("matchTriggers combinator", () => {
    test("any: severity matches, services declared but no data", () => {
        const triggers = { severity: ["critical" as const], services: ["kafka"] };
        const incident = { severity: "critical" as const };
        expect(matchTriggers(triggers, incident)).toBe(true);
    });

    test("any: neither axis matches", () => {
        const triggers = { severity: ["critical" as const], services: ["kafka"] };
        const incident = { severity: "low" as const };
        expect(matchTriggers(triggers, incident)).toBe(false);
    });

    test("all: both declared axes match", () => {
        const triggers = {
            severity: ["critical" as const],
            services: ["kafka"],
            match: "all" as const,
        };
        const incident = {
            severity: "critical" as const,
            affectedServices: [{ name: "kafka-broker" }],
        };
        expect(matchTriggers(triggers, incident)).toBe(true);
    });

    test("all: one axis matches, other doesn't", () => {
        const triggers = {
            severity: ["critical" as const],
            services: ["kafka"],
            match: "all" as const,
        };
        const incident = {
            severity: "critical" as const,
            affectedServices: [{ name: "auth-api" }],
        };
        expect(matchTriggers(triggers, incident)).toBe(false);
    });

    test("all: one axis matches, other has no data", () => {
        const triggers = {
            severity: ["critical" as const],
            services: ["kafka"],
            match: "all" as const,
        };
        const incident = { severity: "critical" as const };
        expect(matchTriggers(triggers, incident)).toBe(false);
    });

    test("no axes declared (only match combinator)", () => {
        const triggers = { match: "any" as const };
        const incident = { severity: "critical" as const };
        expect(matchTriggers(triggers, incident)).toBe(false);
    });

    test("default combinator when match is undefined", () => {
        const triggers = { severity: ["critical" as const] };
        const incident = { severity: "critical" as const };
        expect(matchTriggers(triggers, incident)).toBe(true);
    });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/agent/src/runbook-selector.test.ts -t "matchSeverityAxis|matchServicesAxis|matchMetricsAxis|matchTriggers combinator"`
Expected: FAIL with "matchSeverityAxis is not defined" or similar.

- [ ] **Step 4: Implement the matchers in runbook-selector.ts**

In `packages/agent/src/runbook-selector.ts`, add these four functions. Place them after the existing exports but before the default export or `selectRunbooks` function:

```typescript
import type { NormalizedIncident, RunbookTriggers } from "@devops-agent/shared";
// (Import RunbookTriggers from @devops-agent/gitagent-bridge if @devops-agent/shared
// does not re-export it; check which package exports the type.)

export function matchSeverityAxis(
    allowed: Array<"critical" | "high" | "medium" | "low">,
    incidentSeverity: NormalizedIncident["severity"],
): boolean {
    if (incidentSeverity === undefined) return false;
    return allowed.includes(incidentSeverity);
}

export function matchServicesAxis(
    patterns: string[],
    affected: NormalizedIncident["affectedServices"],
): boolean {
    if (!affected || affected.length === 0) return false;
    const lowerNames = affected.map((s) => s.name.toLowerCase());
    return patterns.some((pattern) => {
        const lowerPattern = pattern.toLowerCase();
        return lowerNames.some((name) => name.includes(lowerPattern));
    });
}

export function matchMetricsAxis(
    patterns: string[],
    extracted: NormalizedIncident["extractedMetrics"],
): boolean {
    if (!extracted || extracted.length === 0) return false;
    const lowerNames = extracted.map((m) => m.name.toLowerCase());
    return patterns.some((pattern) => {
        const lowerPattern = pattern.toLowerCase();
        return lowerNames.some((name) => name.includes(lowerPattern));
    });
}

export function matchTriggers(
    triggers: RunbookTriggers,
    incident: NormalizedIncident,
): boolean {
    const axisResults: boolean[] = [];

    if (triggers.severity !== undefined) {
        axisResults.push(matchSeverityAxis(triggers.severity, incident.severity));
    }
    if (triggers.services !== undefined) {
        axisResults.push(matchServicesAxis(triggers.services, incident.affectedServices));
    }
    if (triggers.metrics !== undefined) {
        axisResults.push(matchMetricsAxis(triggers.metrics, incident.extractedMetrics));
    }

    // No axes declared -> no match. Lint-level signal, not a crash.
    if (axisResults.length === 0) return false;

    const combinator = triggers.match ?? "any";
    return combinator === "all"
        ? axisResults.every((r) => r)
        : axisResults.some((r) => r);
}
```

**Verify `RunbookTriggers` import path:** `RunbookTriggers` is exported from `@devops-agent/gitagent-bridge` per Task 1's re-export. Import it from there if `@devops-agent/shared` does not re-export:

```typescript
import type { RunbookTriggers } from "@devops-agent/gitagent-bridge";
```

Check existing imports in `runbook-selector.ts` to see which package other types come from and follow the same pattern.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/agent/src/runbook-selector.test.ts -t "matchSeverityAxis|matchServicesAxis|matchMetricsAxis|matchTriggers combinator"`
Expected: 19 pass (3 severity + 6 services + 3 metrics + 7 combinator).

- [ ] **Step 6: Run all selector tests to confirm no regressions**

Run: `bun test packages/agent/src/runbook-selector.test.ts`
Expected: all SIO-640 tests still pass plus the 19 new.

- [ ] **Step 7: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/runbook-selector.ts packages/agent/src/runbook-selector.test.ts
git commit -m "SIO-643: Implement per-axis matchers and matchTriggers combinator

Three pure per-axis functions (severity, services, metrics) and the
top-level matchTriggers combinator. All use NormalizedIncident[field]
type indexing to stay in sync with the source schema. Services and
metrics do case-insensitive substring matching. matchTriggers supports
any (default) and all combinators; runbooks with zero declared axes
never match. 19 unit tests cover every per-axis branch plus the 7
combinator cases.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Implement `narrowCatalogByTriggers` with TDD

**Goal:** The filter function that orchestrates the matchers. Returns `{narrowed, mode}` where mode is `noop | narrowed | fallback`.

**Files:**
- Modify: `packages/agent/src/runbook-selector.ts`
- Modify: `packages/agent/src/runbook-selector.test.ts`

- [ ] **Step 1: Write the 7 failing tests**

Append to `packages/agent/src/runbook-selector.test.ts`:

```typescript
import { narrowCatalogByTriggers } from "./runbook-selector.ts";
import type { RunbookCatalogEntry } from "./prompt-context.ts";

describe("narrowCatalogByTriggers", () => {
    const entry = (
        filename: string,
        triggers?: RunbookCatalogEntry["triggers"],
    ): RunbookCatalogEntry => ({
        filename,
        title: `Title of ${filename}`,
        summary: `Summary of ${filename}`,
        triggers,
    });

    test("noop: no runbook has triggers", () => {
        const catalog = [entry("a.md"), entry("b.md"), entry("c.md")];
        const result = narrowCatalogByTriggers(catalog, { severity: "critical" });
        expect(result.mode).toBe("noop");
        expect(result.narrowed).toEqual(catalog);
    });

    test("narrowed: one trigger-declared runbook matches", () => {
        const catalog = [
            entry("a.md", { severity: ["critical"] }),
            entry("b.md", { severity: ["low"] }),
            entry("c.md", { severity: ["high"] }),
        ];
        const result = narrowCatalogByTriggers(catalog, { severity: "critical" });
        expect(result.mode).toBe("narrowed");
        expect(result.narrowed).toHaveLength(1);
        expect(result.narrowed[0].filename).toBe("a.md");
    });

    test("narrowed: multiple trigger-declared runbooks match", () => {
        const catalog = [
            entry("a.md", { severity: ["critical", "high"] }),
            entry("b.md", { severity: ["low"] }),
            entry("c.md", { severity: ["critical"] }),
        ];
        const result = narrowCatalogByTriggers(catalog, { severity: "critical" });
        expect(result.mode).toBe("narrowed");
        expect(result.narrowed).toHaveLength(2);
        expect(result.narrowed.map((e) => e.filename).sort()).toEqual(["a.md", "c.md"]);
    });

    test("fallback: all runbooks have triggers, none match", () => {
        const catalog = [
            entry("a.md", { severity: ["critical"] }),
            entry("b.md", { severity: ["high"] }),
            entry("c.md", { severity: ["medium"] }),
        ];
        const result = narrowCatalogByTriggers(catalog, { severity: "low" });
        expect(result.mode).toBe("fallback");
        expect(result.narrowed).toEqual(catalog);
    });

    test("narrowed: mixed catalog, one trigger match + trigger-less pass", () => {
        const catalog = [
            entry("a.md", { severity: ["critical"] }),
            entry("b.md"), // trigger-less
            entry("c.md"), // trigger-less
        ];
        const result = narrowCatalogByTriggers(catalog, { severity: "critical" });
        expect(result.mode).toBe("narrowed");
        expect(result.narrowed).toHaveLength(3);
        expect(result.narrowed.map((e) => e.filename).sort()).toEqual(["a.md", "b.md", "c.md"]);
    });

    test("fallback: mixed catalog, trigger-declared doesn't match", () => {
        const catalog = [
            entry("a.md", { severity: ["critical"] }),
            entry("b.md"), // trigger-less
            entry("c.md"), // trigger-less
        ];
        const result = narrowCatalogByTriggers(catalog, { severity: "low" });
        expect(result.mode).toBe("fallback");
        expect(result.narrowed).toHaveLength(3);
        expect(result.narrowed).toEqual(catalog);
    });

    test("noop: empty catalog (defensive)", () => {
        const result = narrowCatalogByTriggers([], { severity: "critical" });
        expect(result.mode).toBe("noop");
        expect(result.narrowed).toEqual([]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/agent/src/runbook-selector.test.ts -t "narrowCatalogByTriggers"`
Expected: FAIL with "narrowCatalogByTriggers is not defined".

- [ ] **Step 3: Implement `narrowCatalogByTriggers`**

In `packages/agent/src/runbook-selector.ts`, add the function after `matchTriggers` (the function from Task 5):

```typescript
import type { RunbookCatalogEntry } from "./prompt-context.ts";

export function narrowCatalogByTriggers(
    catalog: RunbookCatalogEntry[],
    incident: NormalizedIncident,
): { narrowed: RunbookCatalogEntry[]; mode: "noop" | "narrowed" | "fallback" } {
    const withTriggers = catalog.filter((e) => e.triggers !== undefined);
    const withoutTriggers = catalog.filter((e) => e.triggers === undefined);

    // No runbook has triggers: the filter is a no-op
    if (withTriggers.length === 0) {
        return { narrowed: catalog, mode: "noop" };
    }

    // Match each trigger-declared runbook against the incident
    const matched = withTriggers.filter((e) => matchTriggers(e.triggers!, incident));

    // Zero matches: fall through to the full catalog
    if (matched.length === 0) {
        return { narrowed: catalog, mode: "fallback" };
    }

    // Narrowed set = matched trigger-declared runbooks + all trigger-less runbooks
    return { narrowed: [...matched, ...withoutTriggers], mode: "narrowed" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/agent/src/runbook-selector.test.ts -t "narrowCatalogByTriggers"`
Expected: 7 pass.

- [ ] **Step 5: Run the full selector test suite**

Run: `bun test packages/agent/src/runbook-selector.test.ts`
Expected: all tests pass (SIO-640's + Task 5's 19 + Task 6's 7).

- [ ] **Step 6: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/runbook-selector.ts packages/agent/src/runbook-selector.test.ts
git commit -m "SIO-643: Implement narrowCatalogByTriggers filter function

Returns {narrowed, mode} with mode in {noop, narrowed, fallback}.
noop when no runbook has triggers. narrowed when at least one trigger-
declared runbook matches - narrowed set includes all matched entries
plus every trigger-less entry (trigger-less runbooks opt out of
filtering, not out of the catalog). fallback when all runbooks with
triggers fail to match - returns the full catalog to prevent starving
the LLM router. 7 unit tests cover every mode and the mixed-catalog
edge cases.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Integrate the filter into `selectRunbooks` with observability

**Goal:** Call `narrowCatalogByTriggers` as the first step of `selectRunbooks` (inside the existing node from SIO-640). Emit observability attributes for the filter mode and sizes. Pass the narrowed catalog to the existing LLM router.

**Files:**
- Modify: `packages/agent/src/runbook-selector.ts`
- Modify: `packages/agent/src/runbook-selector.test.ts`

- [ ] **Step 1: Write 3 integration tests**

Append to `packages/agent/src/runbook-selector.test.ts`. These tests mock the LLM and catalog, invoke `selectRunbooks`, and assert on the filter's observable behavior:

```typescript
describe("selectRunbooks: trigger filter integration", () => {
    let lastPromptCatalogFilenames: string[] = [];

    beforeEach(() => {
        lastPromptCatalogFilenames = [];

        // Mock LLM to capture which runbooks appeared in the prompt
        mock.module("./llm.ts", () => ({
            createLlm: () => ({
                invoke: async ({ messages }: { messages: Array<{ content: string }> }) => {
                    const prompt = messages.map((m) => m.content).join("\n");
                    // Extract runbook filenames from the router catalog section of the prompt
                    lastPromptCatalogFilenames = (prompt.match(/[a-z0-9-]+\.md/g) ?? []).filter(
                        (v, i, a) => a.indexOf(v) === i,
                    );
                    return {
                        content: '{"filenames":[],"reasoning":"mock"}',
                    };
                },
            }),
        }));
    });

    test("narrowed mode: LLM receives only matching runbooks + trigger-less runbooks", async () => {
        mock.module("./prompt-context.ts", () => ({
            getRunbookCatalog: () => [
                {
                    filename: "match-a.md",
                    title: "Match A",
                    summary: "A",
                    triggers: { severity: ["critical"] },
                },
                {
                    filename: "match-b.md",
                    title: "Match B",
                    summary: "B",
                    triggers: { severity: ["critical"] },
                },
                {
                    filename: "nomatch.md",
                    title: "No Match",
                    summary: "X",
                    triggers: { severity: ["low"] },
                },
                { filename: "free-1.md", title: "Free 1", summary: "F1" },
                { filename: "free-2.md", title: "Free 2", summary: "F2" },
            ],
            getRunbookFallbackConfig: () => ({
                critical: ["match-a.md"],
                high: [],
                medium: [],
                low: [],
            }),
        }));

        const { selectRunbooks } = await import("./runbook-selector.ts");
        const state = makeState({
            normalizedIncident: { severity: "critical" },
            messages: [new HumanMessage("critical incident")],
        });

        await selectRunbooks(state);
        // Assert: LLM saw match-a, match-b, free-1, free-2 (4 filenames)
        //         NOT nomatch.md
        expect(lastPromptCatalogFilenames).toContain("match-a.md");
        expect(lastPromptCatalogFilenames).toContain("match-b.md");
        expect(lastPromptCatalogFilenames).toContain("free-1.md");
        expect(lastPromptCatalogFilenames).toContain("free-2.md");
        expect(lastPromptCatalogFilenames).not.toContain("nomatch.md");
    });

    test("fallback mode: LLM receives full catalog when no trigger matches", async () => {
        mock.module("./prompt-context.ts", () => ({
            getRunbookCatalog: () => [
                {
                    filename: "critical-only.md",
                    title: "Crit",
                    summary: "C",
                    triggers: { severity: ["critical"] },
                },
                {
                    filename: "high-only.md",
                    title: "High",
                    summary: "H",
                    triggers: { severity: ["high"] },
                },
            ],
            getRunbookFallbackConfig: () => ({
                critical: [],
                high: [],
                medium: [],
                low: [],
            }),
        }));

        const { selectRunbooks } = await import("./runbook-selector.ts");
        const state = makeState({
            normalizedIncident: { severity: "low" },
            messages: [new HumanMessage("low severity incident")],
        });

        await selectRunbooks(state);
        expect(lastPromptCatalogFilenames).toContain("critical-only.md");
        expect(lastPromptCatalogFilenames).toContain("high-only.md");
    });

    test("noop mode: no runbook has triggers, LLM receives full catalog", async () => {
        mock.module("./prompt-context.ts", () => ({
            getRunbookCatalog: () => [
                { filename: "a.md", title: "A", summary: "A" },
                { filename: "b.md", title: "B", summary: "B" },
                { filename: "c.md", title: "C", summary: "C" },
            ],
            getRunbookFallbackConfig: () => ({
                critical: [],
                high: [],
                medium: [],
                low: [],
            }),
        }));

        const { selectRunbooks } = await import("./runbook-selector.ts");
        const state = makeState({
            normalizedIncident: { severity: "critical" },
            messages: [new HumanMessage("test")],
        });

        await selectRunbooks(state);
        expect(lastPromptCatalogFilenames).toContain("a.md");
        expect(lastPromptCatalogFilenames).toContain("b.md");
        expect(lastPromptCatalogFilenames).toContain("c.md");
    });
});
```

**Note:** `makeState` and `HumanMessage` come from the existing test helpers from SIO-640's selector test file. If your implementation of SIO-640 used different helper names, adapt accordingly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/agent/src/runbook-selector.test.ts -t "selectRunbooks: trigger filter"`
Expected: FAIL. The selector doesn't call `narrowCatalogByTriggers` yet, so all runbooks including `nomatch.md` are in the prompt.

- [ ] **Step 3: Integrate the filter into `selectRunbooks`**

In `packages/agent/src/runbook-selector.ts`, find the existing `selectRunbooks` function body. Locate the lines where it gets the catalog via `getRunbookCatalog()` and builds the router prompt. Insert the filter step BEFORE the LLM invocation:

```typescript
export async function selectRunbooks(
    state: AgentStateType,
    _config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
    const startTime = Date.now();
    const fullCatalog = (globalThis as any).__testEmptyCatalog === true ? [] : getRunbookCatalog();

    // ... existing skip.empty_catalog branch from SIO-640 stays unchanged ...
    if (fullCatalog.length === 0) {
        logger.info(
            { mode: "skip.empty_catalog", catalogSize: 0 },
            "Runbook catalog is empty; skipping selection",
        );
        return {};
    }

    // SIO-643: Pre-filter via trigger grammar before the LLM router sees the catalog
    const incident = state.normalizedIncident ?? {};
    const filterResult = narrowCatalogByTriggers(fullCatalog, incident);
    const catalog = filterResult.narrowed;

    logger.info(
        {
            trigger_filter_mode: filterResult.mode,
            trigger_filter_input_size: fullCatalog.length,
            trigger_filter_output_size: catalog.length,
        },
        `Runbook trigger filter: ${filterResult.mode}`,
    );

    // Rest of the selector (config lookup, router prompt, LLM invocation, fallback handling)
    // uses `catalog` in place of the original fullCatalog. The config lookup and fallback
    // logic from SIO-640 stay unchanged.

    // ... continue with the rest of selectRunbooks as SIO-640 implemented it ...
}
```

**What this replaces:** Every reference to the full catalog inside the rest of `selectRunbooks` (e.g., building the router prompt, counting entries) should use `catalog` (the narrowed one) instead. If SIO-640's implementation referenced `catalog` by that name already, the only change is the insertion of the `narrowCatalogByTriggers` call and logging. If it used a different variable name, rename the references accordingly.

**Do not modify** the severity-tier fallback logic. That fallback fires on LLM API failure, which is independent of the trigger filter's fall-through behavior (which fires on zero trigger matches).

- [ ] **Step 4: Run integration tests to verify they pass**

Run: `bun test packages/agent/src/runbook-selector.test.ts -t "selectRunbooks: trigger filter"`
Expected: 3 pass.

- [ ] **Step 5: Run the full selector test suite**

Run: `bun test packages/agent/src/runbook-selector.test.ts`
Expected: all tests pass (SIO-640's original + Task 5's 19 + Task 6's 7 + Task 7's 3 = however many total).

- [ ] **Step 6: Run the full agent package tests**

Run: `bun test packages/agent/src/`
Expected: all tests pass.

- [ ] **Step 7: Typecheck**

Run: `bun run --filter '@devops-agent/agent' typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/runbook-selector.ts packages/agent/src/runbook-selector.test.ts
git commit -m "SIO-643: Integrate trigger filter into selectRunbooks

Runs narrowCatalogByTriggers as the first step of selectRunbooks
before any LLM call. Emits structured logger fields for the filter
mode (noop | narrowed | fallback) plus input/output sizes. The LLM
router sees the narrowed catalog when triggers match, the full
catalog when they don't. Severity-tier fallback (from SIO-640) is
unchanged and fires only on LLM API failure, orthogonal to the
trigger filter's fall-through behavior. 3 integration tests verify
all three filter modes end-to-end by asserting which runbook
filenames appear in the LLM prompt.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Tweak `extractProseCitations` to skip frontmatter blocks

**Goal:** Modify the existing function from SIO-641 to detect and skip YAML frontmatter blocks so snake_case identifiers in frontmatter aren't mistaken for prose citations.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Write the 2 failing tests**

Append to the existing `describe("extractProseCitations", ...)` block in `packages/gitagent-bridge/src/runbook-validator.test.ts`:

```typescript
test("runbook with frontmatter skips frontmatter when extracting prose citations", () => {
    const content = [
        "---",
        "triggers:",
        "  severity: [high]",
        "---",
        "# Body",
        "Use `kafka_list_topics` here.",
    ].join("\n");
    const citations = extractProseCitations(content);
    expect(citations).toHaveLength(1);
    expect(citations[0].name).toBe("kafka_list_topics");
    // Line number should point to the line within the original content
    // that contained the backtick match
    expect(citations[0].line).toBe(6);
});

test("frontmatter containing snake_case identifier is not extracted as citation", () => {
    const content = [
        "---",
        "triggers:",
        "  services: [kafka_consumer_group]",
        "---",
        "# Body",
        "No tool citations here.",
    ].join("\n");
    const citations = extractProseCitations(content);
    expect(citations).toHaveLength(0);
});
```

**Note:** `extractProseCitations` is a local (non-exported) function in `runbook-validator.test.ts` per SIO-641's design. The new tests go in the same file as the function so they have direct access. If SIO-641 exported the function, these tests work the same.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "extractProseCitations"`
Expected: the new frontmatter tests FAIL. The second test (`kafka_consumer_group` red herring) fails because the current `extractProseCitations` walks every line and picks up the YAML identifier.

- [ ] **Step 3: Tweak `extractProseCitations` to skip frontmatter**

In `packages/gitagent-bridge/src/runbook-validator.test.ts`, find the existing `extractProseCitations` function (from SIO-641's Task 2). It walks content line by line with an `inFence` toggle for triple-backtick code blocks.

Add a similar skip for leading frontmatter. The tweak: before the main loop, detect if the content starts with `---` on line 1, and if so, find the closing `---` and start the walk from the line after. Update the function:

```typescript
function extractProseCitations(content: string): Citation[] {
    const citations: Citation[] = [];
    const lines = content.split("\n");
    let inFence = false;

    // SIO-643: Skip leading YAML frontmatter block so its identifiers are not
    // mistaken for prose citations. The frontmatter is parsed by the loader
    // for runbooks; the validator should not re-interpret it.
    let startLine = 0;
    if (lines.length > 0 && lines[0].trim() === "---") {
        // Find the closing --- delimiter
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === "---") {
                startLine = i + 1;
                break;
            }
        }
        // If we never found a closing delimiter, startLine stays 0 and we
        // walk the full content. A missing closing delimiter is a load-time
        // error (see parseRunbookFrontmatter) so reaching this branch here
        // means the validator is being run on a malformed file anyway.
    }

    for (let i = startLine; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Toggle fenced code block state (existing logic from SIO-641)
        if (trimmed.startsWith("```")) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;

        // Find all backtick-wrapped segments on this line (existing logic)
        const backtickRegex = /`([^`]+)`/g;
        let match: RegExpExecArray | null;
        while ((match = backtickRegex.exec(line)) !== null) {
            const inner = match[1];
            if (/^[a-z][a-z0-9_]*$/.test(inner) && inner.includes("_")) {
                citations.push({ name: inner, line: i + 1, source: "prose" });
            }
        }
    }

    return citations;
}
```

The tweak is purely additive: the pre-walk frontmatter detector finds `startLine`, and the main loop starts from there instead of 0. Line numbers remain 1-based and correctly point to the original content line (since the main loop uses `i + 1`).

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "extractProseCitations"`
Expected: all existing `extractProseCitations` tests from SIO-641 still pass, plus the 2 new ones.

- [ ] **Step 5: Run the full validator test file to verify no regressions**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: all 40+ tests from SIO-641 still pass plus the 2 new.

- [ ] **Step 6: Run the full gitagent-bridge test suite**

Run: `bun test packages/gitagent-bridge/src/`
Expected: all tests pass.

- [ ] **Step 7: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-643: Skip YAML frontmatter in extractProseCitations

Detects a leading --- block at the top of runbook content and starts
the prose citation walk after the closing ---. Prevents snake_case
identifiers inside frontmatter YAML (e.g. services: [kafka_consumer_group])
from being mistaken for prose tool citations by the brainstorm B
validator. 2 new tests cover the happy path (prose citation after
frontmatter) and the red herring case (identifier inside YAML).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Manual end-to-end verification with synthetic frontmatter

**Goal:** Verify the full system works end-to-end by temporarily adding frontmatter to a real runbook, running an incident query, inspecting the LangSmith trace, and reverting.

**Files:**
- Temporarily modify: `agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md`

**Important:** Every modification below must be reverted before Task 10. No production changes from this task.

- [ ] **Step 1: Add minimal frontmatter to a production runbook**

Edit `agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md`. Prepend before the existing `# Kafka Consumer Lag Investigation` heading:

```
---
triggers:
  services: [kafka]
  metrics: [lag]
---
```

Verify the file now starts with `---`.

- [ ] **Step 2: Verify the runbook still loads cleanly**

Run: `bun test packages/gitagent-bridge/src/`
Expected: all tests pass. The runbook's frontmatter is parsed; `KnowledgeEntry.triggers` is populated; `KnowledgeEntry.content` is the stripped body without the frontmatter block.

- [ ] **Step 3: Verify the validator still passes**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: all tests pass. The validator skips the frontmatter block when extracting prose citations.

- [ ] **Step 4: Start the agent locally (if you want to run a real incident query)**

Run: `bun run --filter '@devops-agent/web' dev` and whatever MCP servers the agent needs per `docs/deployment/local-development.md`.

Open http://localhost:5173 and submit:

> Kafka consumer group user-events is lagging by 50000 messages on topic user.events. Critical.

- [ ] **Step 5: Inspect the LangSmith trace**

Using the `langsmith-fetch` CLI:

```bash
grep "^LANGSMITH_API_KEY=" .env
LANGSMITH_API_KEY=<key> LANGSMITH_PROJECT=devops-incident-analyzer langsmith-fetch traces /tmp/traces --limit 5 --include-metadata --last-n-minutes 5 --format pretty
```

In the fetched traces, locate the span named `agent.node.selectRunbooks`. Confirm the structured log message (or span attributes) shows:

- `trigger_filter_mode: "narrowed"`
- `trigger_filter_input_size: 3`  (three runbooks in the catalog)
- `trigger_filter_output_size` is at least 1 (the kafka runbook), possibly 3 if the other two runbooks are trigger-less (expected, since only kafka-consumer-lag.md has frontmatter in this test)

If the mode is `"noop"` instead of `"narrowed"`, the frontmatter parsing isn't being picked up — check that the edit to `kafka-consumer-lag.md` is saved and the agent was restarted after the edit.

- [ ] **Step 6: Submit a non-matching query**

Submit:

> What is the current state of the Couchbase cluster?

This query has no Kafka service and no lag metric. The trigger filter should either match zero runbooks or match none of them.

Inspect the trace. Confirm `trigger_filter_mode === "fallback"` (because the kafka-consumer-lag.md runbook now declares triggers and those triggers don't match the Couchbase query, and no other runbook has triggers).

- [ ] **Step 7: Revert the frontmatter**

```bash
git checkout agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md
```

Run: `git status`
Expected: no changes to any file under `agents/incident-analyzer/knowledge/runbooks/` — the checkout restored the file to its committed state.

- [ ] **Step 8: Run the final regression check**

Run: `bun test packages/agent/src/ packages/gitagent-bridge/src/`
Expected: all tests pass on the reverted state. No sub-agent runbook files should exist, no frontmatter on any production runbook.

- [ ] **Step 9: No commit**

This task produces no git changes. It is a pure verification exercise.

---

## Task 10: Full workspace verification

**Goal:** Final gate before PR creation. Verify the entire workspace is healthy.

**Files:** None

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: all tests pass across all packages.

- [ ] **Step 2: Full workspace typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Full workspace lint**

Run: `bun run lint`
Expected: no new Biome warnings attributable to this change.

- [ ] **Step 4: YAML check**

Run: `bun run yaml:check`
Expected: clean. (No YAML was touched, but this is a sanity check.)

- [ ] **Step 5: Verify file change scope**

Run: `git diff --name-only $(git merge-base HEAD main)...HEAD -- $(git diff --name-only $(git merge-base HEAD main)...HEAD | grep -v "docs/superpowers")`
Expected: exactly these files modified by this plan's implementation commits:

- `packages/gitagent-bridge/src/types.ts`
- `packages/gitagent-bridge/src/index.ts`
- `packages/gitagent-bridge/src/index.test.ts`
- `packages/gitagent-bridge/src/manifest-loader.ts`
- `packages/gitagent-bridge/src/runbook-validator.test.ts`
- `packages/agent/src/prompt-context.ts`
- `packages/agent/src/runbook-selector.ts`
- `packages/agent/src/runbook-selector.test.ts`

If additional files appear, investigate before proceeding.

- [ ] **Step 6: Verify zero production runbooks were modified**

Run: `git diff --name-only $(git merge-base HEAD main)...HEAD -- agents/`
Expected: empty output. No files under `agents/` should be modified.

If any file appears, Task 9's revert was incomplete. Revert the remaining files:

```bash
git checkout agents/incident-analyzer/knowledge/runbooks/
```

- [ ] **Step 7: No commit**

Verification only.

---

## Task 11: PR prep

**Goal:** Push and create the PR.

- [ ] **Step 1: Push the branch**

Run: `git push origin simonowusupvh/sio-621-standardize-mcp-server-structure-across-all-4-packages`
Expected: push succeeds.

(Note: this work stacks on SIO-621 alongside SIO-639/640/641/642 per the user's chosen strategy.)

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "SIO-643: Runbook trigger grammar (Phase 2E)" --body "$(cat <<'EOF'
## Summary

- Adds YAML frontmatter trigger grammar to runbooks (three axes: severity, services, metrics + match combinator)
- New Zod schemas `RunbookTriggersSchema` and `RunbookFrontmatterSchema` with `.strict()` validation
- `parseRunbookFrontmatter()` helper in `manifest-loader.ts` strips frontmatter from runbook content and validates via the schemas
- `KnowledgeEntry.triggers?` and `RunbookCatalogEntry.triggers?` fields carry the parsed triggers end to end
- `narrowCatalogByTriggers()` runs as the first step of `selectRunbooks` (from SIO-640), narrowing the catalog before the LLM router
- Triggers narrow, they do not gatekeep: zero matches → full catalog fallback; no runbook has triggers → no-op
- Observability: `selectRunbooks` logs `trigger_filter_mode` in `{noop, narrowed, fallback}` plus input/output sizes
- Brainstorm B validator tweak: `extractProseCitations` skips leading YAML frontmatter so YAML identifiers are not mistaken for prose tool citations
- Zero production runbooks modified; the three current runbooks stay frontmatter-less
- Backwards compatible: runbooks without frontmatter continue to work unchanged

## Test counts

- 9 Zod schema tests (RunbookTriggersSchema + RunbookFrontmatterSchema)
- 12 parseRunbookFrontmatter tests
- 4 loadKnowledge integration tests (frontmatter populates triggers, stripping works, errors attach file path)
- 19 per-axis matcher + matchTriggers combinator tests
- 7 narrowCatalogByTriggers tests
- 3 selectRunbooks integration tests (narrowed, fallback, noop modes)
- 2 extractProseCitations frontmatter skip tests

**Total: 56 new tests**

## Test plan

- [x] `bun test` all green
- [x] `bun run typecheck` clean
- [x] `bun run lint` clean
- [x] `bun run yaml:check` clean
- [x] Manual end-to-end verification with synthetic frontmatter on kafka-consumer-lag.md (Task 9): verified narrowed and fallback modes via LangSmith trace inspection, then reverted
- [x] Zero production runbook files modified

## Dependencies

Stacks on SIO-640 (Phase 2A lazy runbook selection) and SIO-641 (Phase 2B tool-name validator). Both must be implemented first. SIO-642 (Phase 2C sub-agent runbooks) is independent.

Design spec: `docs/superpowers/specs/2026-04-10-runbook-trigger-grammar-design.md`
Implementation plan: `docs/superpowers/plans/2026-04-10-runbook-trigger-grammar.md`
Linear issue: SIO-643

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Link implementation commits to SIO-643**

Open https://linear.app/siobytes/issue/SIO-643 and attach the commit URLs from Tasks 1-8 and the PR URL.

---

## Self-Review

Fresh read of the plan against the spec.

**1. Spec coverage:**

| Spec section | Covered by |
|---|---|
| `RunbookTriggersSchema` + `RunbookFrontmatterSchema` | Task 1 |
| `parseRunbookFrontmatter` helper | Task 2 |
| `KnowledgeEntry.triggers?` field + `loadKnowledge` integration | Task 3 |
| `RunbookCatalogEntry.triggers?` pass-through | Task 4 |
| Per-axis matchers (severity, services, metrics) | Task 5 |
| `matchTriggers` combinator with `any`/`all` | Task 5 |
| `narrowCatalogByTriggers` filter function | Task 6 |
| `selectRunbooks` integration with observability | Task 7 |
| `extractProseCitations` frontmatter skip | Task 8 |
| Manual end-to-end verification | Task 9 |
| Full workspace regression check | Task 10 |
| PR creation | Task 11 |
| Backwards compatibility for frontmatter-less runbooks | Verified by Task 3 ("runbook without frontmatter leaves triggers undefined") + Task 10 Step 6 ("zero production runbooks modified") |
| Loud failures on typos / parse errors | Task 1 (Zod strict tests) + Task 2 (parseRunbookFrontmatter tests 6, 7, 8, 9, 10, 11) + Task 3 ("invalid frontmatter throws with file path") |
| Zero production runbooks seeded with frontmatter | Task 9 revert + Task 10 Step 6 guard |

All spec requirements are covered. The non-goals (metric value thresholds, negative matchers, regex, temporal triggers, free-text query matching, cross-runbook logic) are explicitly NOT implemented, consistent with the spec.

**2. Placeholder scan:** Every code block is complete. Every step has exact commands and expected output. No "TBD", "TODO", "implement later", or "similar to Task N" language. One place that could read as vague — Task 7 Step 3 says "continue with the rest of selectRunbooks as SIO-640 implemented it" — but this is the correct instruction because the rest of the function is defined by the SIO-640 plan, not by this plan. The implementer reads SIO-640's plan for that code, then this plan's Task 7 explains only the incremental changes.

**3. Type consistency:**

- `RunbookTriggersSchema` / `RunbookTriggers` — declared Task 1, consumed by `parseRunbookFrontmatter` (Task 2), `KnowledgeEntry` (Task 3), `RunbookCatalogEntry` (Task 4), per-axis matchers (Task 5), `matchTriggers` (Task 5), `narrowCatalogByTriggers` (Task 6). Consistent.
- `RunbookFrontmatterSchema` — declared Task 1, consumed by `parseRunbookFrontmatter` (Task 2). Consistent.
- `narrowCatalogByTriggers` return type `{narrowed, mode}` with mode union `"noop" | "narrowed" | "fallback"` — declared Task 6, used in Task 7 observability logging. Consistent.
- `RunbookCatalogEntry` — extended Task 4 with `triggers?`, consumed Task 6 (via `e.triggers`), consumed Task 7 (via the integration path). Consistent.
- Per-axis matcher function signatures all use `NormalizedIncident["field"]` type indexing. Consistent.
- `KnowledgeEntry` import in Task 3 — extended with `triggers?` in the interface definition. Same interface referenced by all subsequent tasks via the re-export in `index.ts`.

**4. One risk worth calling out:** Task 5 Step 4's implementation includes an import comment: `// (Import RunbookTriggers from @devops-agent/gitagent-bridge if @devops-agent/shared does not re-export it; check which package exports the type.)`. This is a conditional import path because I don't know for certain which package re-exports `RunbookTriggers`. The plan instructs the implementer to check the existing imports in `runbook-selector.ts` and follow the same pattern. Not a placeholder — a deliberate instruction to use codebase conventions.

**5. Scope:** 12 tasks total (Tasks 0-11). Task 0 is verification of the dual prerequisite. Tasks 1-8 are the actual implementation, each producing a committable checkpoint. Task 9 is manual verification (no commits). Tasks 10-11 are final gates and PR creation.

Self-review complete. No inline fixes needed.
