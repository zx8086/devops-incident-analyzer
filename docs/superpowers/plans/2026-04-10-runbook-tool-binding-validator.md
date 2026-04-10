# Runbook Tool Binding Validator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a static validator as a single `bun:test` file at `packages/gitagent-bridge/src/runbook-validator.test.ts` that walks every agent's runbooks, extracts tool name citations from prose backticks and the `## All Tools Used Are Read-Only` tail section, and fails the test if any citation is not in the agent's `action_tool_map` union or if prose and tail disagree.

**Architecture:** Single file, ~350 lines including tests. Local helpers only — no new package exports, no new config, no runtime cost, no changes to `loadAgent()`. The validator reuses `loadAgent()` from `@devops-agent/gitagent-bridge` to read the agent's tool definitions; it does NOT re-parse YAML files. Two test layers share the file: extractor unit tests against synthetic inline string fixtures, and production validation tests against real incident-analyzer runbooks (one explicit test per runbook).

**Tech Stack:** Bun 1.3.9+, TypeScript 5.x strict, `bun:test` with `describe`/`test`/`expect`, `node:fs` (readFileSync, readdirSync, existsSync, statSync), `node:path` (join), `import.meta.dir` for path resolution, existing `loadAgent()` from `@devops-agent/gitagent-bridge`.

**Source spec:** `docs/superpowers/specs/2026-04-10-runbook-tool-binding-validator-design.md` — read first for full design rationale.

**Linear issue:** SIO-641

---

## Spec Deviations

This plan supersedes the spec where they disagree. One deviation:

1. **`buildAuthority()` takes `ToolDefinition[]`, not `toolsDir: string`.** The spec said the authority builder would read and parse YAML files directly. During plan research I discovered that `loadAgent()` already parses every `tools/*.yaml` and exposes them as `ToolDefinition[]` on `LoadedAgent`. The validator reuses that parsing. Consequences:
   - The "YAML parse failure propagates" test case from the spec is no longer relevant — YAML parsing happens inside `loadAgent()`, and if it fails, `loadAgent()` throws before the validator ever runs. That's correct behavior: a broken agent definition should block all validation, not just runbook validation.
   - The `buildAuthority()` signature is `(tools: ToolDefinition[]) => Set<string>` instead of `(toolsDir: string) => Set<string>`.
   - The `collectAgents()` helper returns `AgentFixture` objects that include the loaded `agent: LoadedAgent` rather than a `toolsDir: string`.
   - The "empty tools directory" test case becomes "empty tools array" — same effective assertion, different input shape.
   - One less `node:fs` dependency in the validator (no direct YAML parsing).

All other spec details are implemented as-written.

---

## File Structure

**Create:**
- `packages/gitagent-bridge/src/runbook-validator.test.ts` — the entire feature in one file

**Do not modify:**
- Any existing source file in `packages/gitagent-bridge/src/`
- Any `agents/` directory content
- Any package.json or configuration file
- Any other package

**Optional documentation update** (Task 13, can be done separately):
- `docs/development/authoring-skills-and-runbooks.md` — remove the "relies on authorial discipline" language from the tool-name footgun section and replace with a reference to the validator

---

## Task 0: Verify Linear issue is linked

**Goal:** The Linear issue SIO-641 already exists (created during the brainstorm phase). This task is a sanity check that the implementer is working from the right issue before touching any code. No code changes.

- [ ] **Step 1: Verify SIO-641 exists and is assigned to you**

Open https://linear.app/siobytes/issue/SIO-641/phase-2b-runbook-tool-name-binding-validator

Confirm: status is Backlog, assignee is you, blocked by SIO-639.

- [ ] **Step 2: Confirm the spec commit is visible on the branch**

Run: `git log --oneline | grep SIO-641`
Expected: at least one commit `SIO-641: Add Phase 2 brainstorm B design spec for runbook tool-name binding validator`

- [ ] **Step 3: Read the spec before writing code**

Run: `wc -l docs/superpowers/specs/2026-04-10-runbook-tool-binding-validator-design.md`
Expected: ~354 lines. Skim it top to bottom before starting Task 1.

---

## Task 1: Create the file skeleton with types

**Goal:** Create the file with local type definitions, empty function stubs, and a single placeholder test to confirm the file is picked up by `bun test`. No implementation yet.

**Files:**
- Create: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Create the file with skeleton**

Create `packages/gitagent-bridge/src/runbook-validator.test.ts`:

```typescript
// gitagent-bridge/src/runbook-validator.test.ts
// SIO-641: Runbook tool-name binding validator. Walks every agent's runbooks,
// extracts tool name citations from prose and the "All Tools Used Are Read-Only"
// tail section, and fails bun test if any citation is not in the agent's
// action_tool_map union or if prose and tail disagree.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type LoadedAgent, loadAgent, type ToolDefinition } from "./index.ts";

// ============================================================================
// Types
// ============================================================================

interface Citation {
    name: string;              // the tool name, e.g. "kafka_list_consumer_groups"
    line: number;              // 1-based line number in the source runbook
    source: "prose" | "tail";  // which extractor produced this citation
}

interface TailSectionResult {
    citations: Citation[];
    errors: string[];
}

interface ValidationReport {
    runbookPath: string;
    missing: Citation[];       // cited but not in authority set
    proseOnly: Citation[];     // in prose but not in tail section
    tailOnly: Citation[];      // in tail but not in prose
    errors: string[];          // structural errors
}

interface AgentFixture {
    name: string;              // e.g. "incident-analyzer"
    agent: LoadedAgent;        // parsed via loadAgent()
    runbookPaths: string[];    // absolute paths to each .md in knowledge/runbooks/
}

// ============================================================================
// Helpers (stubs - implemented in later tasks)
// ============================================================================

function extractProseCitations(content: string): Citation[] {
    // Task 2
    return [];
}

function extractTailSection(content: string): TailSectionResult {
    // Task 3
    return { citations: [], errors: [] };
}

function buildAuthority(tools: ToolDefinition[]): Set<string> {
    // Task 4
    return new Set();
}

function validateRunbook(
    runbookPath: string,
    content: string,
    authority: Set<string>,
): ValidationReport {
    // Task 5
    return { runbookPath, missing: [], proseOnly: [], tailOnly: [], errors: [] };
}

function formatReport(report: ValidationReport): string {
    // Task 6
    return "";
}

function isClean(report: ValidationReport): boolean {
    return (
        report.missing.length === 0 &&
        report.proseOnly.length === 0 &&
        report.tailOnly.length === 0 &&
        report.errors.length === 0
    );
}

function collectAgents(agentsRoot: string): AgentFixture[] {
    // Task 7
    return [];
}

// ============================================================================
// Tests - placeholder to confirm the file is picked up
// ============================================================================

describe("runbook-validator skeleton", () => {
    test("placeholder passes", () => {
        expect(isClean({ runbookPath: "", missing: [], proseOnly: [], tailOnly: [], errors: [] })).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to confirm the file is picked up**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: 1 pass (the placeholder), 0 fail.

- [ ] **Step 3: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-641: Add runbook-validator.test.ts skeleton with local types

Defines Citation, TailSectionResult, ValidationReport, and AgentFixture
interfaces. Stub functions for all helpers. One placeholder test to
confirm the file is picked up by bun test.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Implement `extractProseCitations` with TDD

**Goal:** Walk content line by line, skip fenced code blocks, extract backtick-wrapped snake_case identifiers with at least one underscore.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/gitagent-bridge/src/runbook-validator.test.ts`, replace the `describe("runbook-validator skeleton", ...)` block with:

```typescript
describe("extractProseCitations", () => {
    test("wrapped snake_case identifier with underscore -> citation", () => {
        const content = "Use `kafka_list_consumer_groups` to enumerate groups.";
        const citations = extractProseCitations(content);
        expect(citations).toHaveLength(1);
        expect(citations[0]).toEqual({ name: "kafka_list_consumer_groups", line: 1, source: "prose" });
    });

    test("single-word backtick (no underscore) -> skipped", () => {
        const content = "The `timeout` value is 10 seconds.";
        expect(extractProseCitations(content)).toHaveLength(0);
    });

    test("PascalCase backtick -> skipped", () => {
        const content = "State is `RebalanceInProgress` right now.";
        expect(extractProseCitations(content)).toHaveLength(0);
    });

    test("hyphen-case backtick -> skipped", () => {
        const content = "The `dead-letter` topic has poison messages.";
        expect(extractProseCitations(content)).toHaveLength(0);
    });

    test("identifier with trailing punctuation outside backticks -> captured cleanly", () => {
        const content = "Use `kafka_describe_topic`.";
        const citations = extractProseCitations(content);
        expect(citations).toHaveLength(1);
        expect(citations[0].name).toBe("kafka_describe_topic");
    });

    test("identifier inside fenced code block -> skipped", () => {
        const content = [
            "Normal line with `kafka_list_topics`.",
            "```bash",
            "run `kafka_fake_tool_name` here",
            "```",
            "After fence: `kafka_get_topic_offsets`.",
        ].join("\n");
        const citations = extractProseCitations(content);
        expect(citations).toHaveLength(2);
        expect(citations.map((c) => c.name)).toEqual(["kafka_list_topics", "kafka_get_topic_offsets"]);
        expect(citations[0].line).toBe(1);
        expect(citations[1].line).toBe(5);
    });

    test("multiple citations on one line", () => {
        const content = "Use `kafka_list_consumer_groups` and `kafka_describe_consumer_group` together.";
        const citations = extractProseCitations(content);
        expect(citations).toHaveLength(2);
        expect(citations.map((c) => c.name)).toEqual([
            "kafka_list_consumer_groups",
            "kafka_describe_consumer_group",
        ]);
    });

    test("empty content -> empty array", () => {
        expect(extractProseCitations("")).toEqual([]);
    });
});
```

- [ ] **Step 2: Run tests to verify they all fail**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "extractProseCitations"`
Expected: FAIL — the stub returns `[]`, so the "citation present" tests fail.

- [ ] **Step 3: Implement `extractProseCitations`**

Replace the stub in `runbook-validator.test.ts`:

```typescript
function extractProseCitations(content: string): Citation[] {
    const citations: Citation[] = [];
    const lines = content.split("\n");
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Toggle fenced code block state
        if (trimmed.startsWith("```")) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;

        // Find all backtick-wrapped segments on this line
        const backtickRegex = /`([^`]+)`/g;
        let match: RegExpExecArray | null;
        while ((match = backtickRegex.exec(line)) !== null) {
            const inner = match[1];
            // Must be snake_case lowercase with at least one underscore
            if (/^[a-z][a-z0-9_]*$/.test(inner) && inner.includes("_")) {
                citations.push({ name: inner, line: i + 1, source: "prose" });
            }
        }
    }

    return citations;
}
```

- [ ] **Step 4: Run tests to verify they all pass**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "extractProseCitations"`
Expected: 8 pass, 0 fail.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-641: Implement extractProseCitations with fence-aware parsing

Walks content line by line, toggles inFence on triple-backtick lines,
extracts backtick-wrapped identifiers matching /^[a-z][a-z0-9_]*\$/
with at least one underscore. Excludes single-word identifiers,
PascalCase, hyphen-case. 8 unit tests cover filter semantics.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Implement `extractTailSection` with TDD

**Goal:** Find the `## All Tools Used Are Read-Only` header, parse the next non-empty line as a comma-separated list, report structural errors for missing/duplicate/empty/malformed sections.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `runbook-validator.test.ts` after the `extractProseCitations` describe block:

```typescript
describe("extractTailSection", () => {
    test("standard section with comma-separated list", () => {
        const content = [
            "# Runbook",
            "",
            "## Investigation",
            "Use `kafka_list_topics`.",
            "",
            "## All Tools Used Are Read-Only",
            "kafka_list_topics, kafka_describe_topic, kafka_get_topic_offsets",
        ].join("\n");
        const result = extractTailSection(content);
        expect(result.errors).toEqual([]);
        expect(result.citations).toHaveLength(3);
        expect(result.citations.map((c) => c.name)).toEqual([
            "kafka_list_topics",
            "kafka_describe_topic",
            "kafka_get_topic_offsets",
        ]);
        // All tail citations share the same line number (the content line)
        expect(result.citations.every((c) => c.line === 7)).toBe(true);
        expect(result.citations.every((c) => c.source === "tail")).toBe(true);
    });

    test("whitespace around names is trimmed", () => {
        const content = [
            "## All Tools Used Are Read-Only",
            "  a_one  ,   a_two ,a_three  ",
        ].join("\n");
        const result = extractTailSection(content);
        expect(result.errors).toEqual([]);
        expect(result.citations.map((c) => c.name)).toEqual(["a_one", "a_two", "a_three"]);
    });

    test("empty entries from trailing commas are ignored", () => {
        const content = [
            "## All Tools Used Are Read-Only",
            "a_one, , a_two,",
        ].join("\n");
        const result = extractTailSection(content);
        expect(result.errors).toEqual([]);
        expect(result.citations.map((c) => c.name)).toEqual(["a_one", "a_two"]);
    });

    test("missing header -> missing_tail_section error", () => {
        const content = "# Runbook\n\nJust some content without the tail section.";
        const result = extractTailSection(content);
        expect(result.errors).toContain("missing_tail_section");
        expect(result.citations).toEqual([]);
    });

    test("duplicate header -> duplicate_tail_section error", () => {
        const content = [
            "## All Tools Used Are Read-Only",
            "a_one",
            "",
            "## All Tools Used Are Read-Only",
            "a_two",
        ].join("\n");
        const result = extractTailSection(content);
        expect(result.errors).toContain("duplicate_tail_section");
    });

    test("header followed immediately by next heading -> empty_tail_section", () => {
        const content = [
            "## All Tools Used Are Read-Only",
            "",
            "## Next Section",
            "content",
        ].join("\n");
        const result = extractTailSection(content);
        expect(result.errors).toContain("empty_tail_section");
    });

    test("header followed by fenced code block -> malformed_tail_section", () => {
        const content = [
            "## All Tools Used Are Read-Only",
            "```",
            "some code",
            "```",
        ].join("\n");
        const result = extractTailSection(content);
        expect(result.errors).toContain("malformed_tail_section");
    });

    test("header at EOF with nothing after -> empty_tail_section", () => {
        const content = "## All Tools Used Are Read-Only";
        const result = extractTailSection(content);
        expect(result.errors).toContain("empty_tail_section");
    });

    test("duplicates within tail list -> duplicate_in_tail_section", () => {
        const content = [
            "## All Tools Used Are Read-Only",
            "a_one, a_two, a_one",
        ].join("\n");
        const result = extractTailSection(content);
        expect(result.errors).toContain("duplicate_in_tail_section");
    });
});
```

- [ ] **Step 2: Run tests to verify they all fail**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "extractTailSection"`
Expected: FAIL (9 failures).

- [ ] **Step 3: Implement `extractTailSection`**

Replace the stub:

```typescript
function extractTailSection(content: string): TailSectionResult {
    const lines = content.split("\n");
    const HEADER = "## All Tools Used Are Read-Only";

    // Find all occurrences of the header
    const headerIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === HEADER) {
            headerIndices.push(i);
        }
    }

    if (headerIndices.length === 0) {
        return { citations: [], errors: ["missing_tail_section"] };
    }
    if (headerIndices.length > 1) {
        return { citations: [], errors: ["duplicate_tail_section"] };
    }

    const headerLine = headerIndices[0];

    // Find the first non-empty content line after the header
    let contentLineIdx = -1;
    for (let i = headerLine + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === "") continue;
        contentLineIdx = i;
        break;
    }

    if (contentLineIdx === -1) {
        return { citations: [], errors: ["empty_tail_section"] };
    }

    const contentLine = lines[contentLineIdx].trim();

    // Reject if the next non-empty content is a heading or a fenced block
    if (contentLine.startsWith("#")) {
        return { citations: [], errors: ["empty_tail_section"] };
    }
    if (contentLine.startsWith("```")) {
        return { citations: [], errors: ["malformed_tail_section"] };
    }

    // Parse comma-separated list
    const names = contentLine
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    // Check for duplicates
    const seen = new Set<string>();
    const errors: string[] = [];
    for (const name of names) {
        if (seen.has(name)) {
            errors.push("duplicate_in_tail_section");
            break;
        }
        seen.add(name);
    }

    const citations: Citation[] = names.map((name) => ({
        name,
        line: contentLineIdx + 1,
        source: "tail",
    }));

    return { citations, errors };
}
```

- [ ] **Step 4: Run tests to verify they all pass**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "extractTailSection"`
Expected: 9 pass, 0 fail.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-641: Implement extractTailSection with 9 edge-case tests

Exact header match 'All Tools Used Are Read-Only', first non-empty
line after header is the canonical comma-separated list. Reports
structural errors: missing, duplicate, empty, malformed, duplicate
entries within list. Tail citations share the content line number.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Implement `buildAuthority` with TDD

**Goal:** Build the authoritative set of tool names by walking `ToolDefinition[]` and unioning every `tool_mapping.action_tool_map.<action>.<tool_name>[]` entry.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```typescript
describe("buildAuthority", () => {
    test("union across multiple tool definitions", () => {
        const tools: ToolDefinition[] = [
            {
                name: "kafka-introspect",
                description: "Kafka",
                input_schema: { type: "object", properties: {} },
                tool_mapping: {
                    mcp_server: "kafka",
                    mcp_patterns: ["kafka_*"],
                    action_tool_map: {
                        action_a: ["kafka_list_topics", "kafka_describe_topic"],
                        action_b: ["kafka_get_topic_offsets"],
                    },
                },
            },
            {
                name: "elastic-logs",
                description: "Elastic",
                input_schema: { type: "object", properties: {} },
                tool_mapping: {
                    mcp_server: "elastic",
                    mcp_patterns: ["elasticsearch_*"],
                    action_tool_map: {
                        search: ["elasticsearch_search", "elasticsearch_count_documents"],
                    },
                },
            },
        ] as ToolDefinition[];
        const authority = buildAuthority(tools);
        expect(authority.has("kafka_list_topics")).toBe(true);
        expect(authority.has("kafka_describe_topic")).toBe(true);
        expect(authority.has("kafka_get_topic_offsets")).toBe(true);
        expect(authority.has("elasticsearch_search")).toBe(true);
        expect(authority.has("elasticsearch_count_documents")).toBe(true);
        expect(authority.size).toBe(5);
    });

    test("tool without tool_mapping contributes nothing", () => {
        const tools: ToolDefinition[] = [
            {
                name: "notify-slack",
                description: "Slack",
                input_schema: { type: "object", properties: {} },
            },
        ] as ToolDefinition[];
        const authority = buildAuthority(tools);
        expect(authority.size).toBe(0);
    });

    test("tool with tool_mapping but no action_tool_map contributes nothing", () => {
        const tools: ToolDefinition[] = [
            {
                name: "tool-a",
                description: "A",
                input_schema: { type: "object", properties: {} },
                tool_mapping: {
                    mcp_server: "a",
                    mcp_patterns: ["a_*"],
                },
            },
        ] as ToolDefinition[];
        const authority = buildAuthority(tools);
        expect(authority.size).toBe(0);
    });

    test("empty tools array -> empty set", () => {
        expect(buildAuthority([]).size).toBe(0);
    });

    test("duplicate tool names across actions are deduplicated", () => {
        const tools: ToolDefinition[] = [
            {
                name: "kafka-introspect",
                description: "Kafka",
                input_schema: { type: "object", properties: {} },
                tool_mapping: {
                    mcp_server: "kafka",
                    mcp_patterns: ["kafka_*"],
                    action_tool_map: {
                        action_a: ["kafka_list_topics", "kafka_describe_topic"],
                        action_b: ["kafka_describe_topic"], // duplicate
                    },
                },
            },
        ] as ToolDefinition[];
        const authority = buildAuthority(tools);
        expect(authority.size).toBe(2);
        expect(authority.has("kafka_describe_topic")).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "buildAuthority"`
Expected: FAIL.

- [ ] **Step 3: Implement `buildAuthority`**

Replace the stub:

```typescript
function buildAuthority(tools: ToolDefinition[]): Set<string> {
    const authority = new Set<string>();
    for (const tool of tools) {
        const actionMap = tool.tool_mapping?.action_tool_map;
        if (!actionMap) continue;
        for (const toolNames of Object.values(actionMap)) {
            for (const name of toolNames) {
                authority.add(name);
            }
        }
    }
    return authority;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "buildAuthority"`
Expected: 5 pass.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-641: Implement buildAuthority over ToolDefinition[]

Unions every tool name from every tool_mapping.action_tool_map across
the passed-in tool definitions. Tools without tool_mapping or without
action_tool_map contribute nothing. Reuses loadAgent()'s already-
parsed ToolDefinition shape instead of re-reading YAML files.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Implement `validateRunbook` with TDD

**Goal:** Orchestrate the three extractors and compute the four mismatch buckets.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```typescript
describe("validateRunbook", () => {
    const makeRunbook = (
        proseTools: string[],
        tailTools: string[],
    ): string => {
        const proseLines = proseTools.length > 0
            ? ["## Investigation", ...proseTools.map((t) => `Use \`${t}\` here.`)]
            : ["## Investigation", "Nothing to do."];
        const tailLines = [
            "",
            "## All Tools Used Are Read-Only",
            tailTools.join(", "),
        ];
        return ["# Runbook", "", ...proseLines, ...tailLines].join("\n");
    };

    test("clean runbook -> clean report", () => {
        const authority = new Set(["a_one", "a_two"]);
        const content = makeRunbook(["a_one", "a_two"], ["a_one", "a_two"]);
        const report = validateRunbook("/fake/path.md", content, authority);
        expect(report.missing).toEqual([]);
        expect(report.proseOnly).toEqual([]);
        expect(report.tailOnly).toEqual([]);
        expect(report.errors).toEqual([]);
        expect(isClean(report)).toBe(true);
    });

    test("prose cites missing tool -> missing bucket", () => {
        const authority = new Set(["a_real"]);
        const content = makeRunbook(["a_fake"], ["a_fake"]);
        const report = validateRunbook("/fake/path.md", content, authority);
        expect(report.missing).toHaveLength(2); // cited in both prose and tail
        expect(report.missing.every((c) => c.name === "a_fake")).toBe(true);
        // Same name appears in both prose and tail; neither proseOnly nor tailOnly
        expect(report.proseOnly).toEqual([]);
        expect(report.tailOnly).toEqual([]);
    });

    test("prose cites tool not in tail -> proseOnly bucket", () => {
        const authority = new Set(["a_one", "a_two"]);
        const content = makeRunbook(["a_one", "a_two"], ["a_one"]);
        const report = validateRunbook("/fake/path.md", content, authority);
        expect(report.missing).toEqual([]);
        expect(report.proseOnly).toHaveLength(1);
        expect(report.proseOnly[0].name).toBe("a_two");
        expect(report.tailOnly).toEqual([]);
    });

    test("tail lists tool not in prose -> tailOnly bucket", () => {
        const authority = new Set(["a_one", "a_two"]);
        const content = makeRunbook(["a_one"], ["a_one", "a_two"]);
        const report = validateRunbook("/fake/path.md", content, authority);
        expect(report.missing).toEqual([]);
        expect(report.proseOnly).toEqual([]);
        expect(report.tailOnly).toHaveLength(1);
        expect(report.tailOnly[0].name).toBe("a_two");
    });

    test("all three buckets populated simultaneously", () => {
        const authority = new Set(["a_one"]);
        // prose: a_one (valid), a_two (missing, prose only)
        // tail:  a_one, a_three (missing, tail only)
        const content = makeRunbook(["a_one", "a_two"], ["a_one", "a_three"]);
        const report = validateRunbook("/fake/path.md", content, authority);
        expect(report.missing.map((c) => c.name).sort()).toEqual(["a_three", "a_two"]);
        expect(report.proseOnly.map((c) => c.name)).toEqual(["a_two"]);
        expect(report.tailOnly.map((c) => c.name)).toEqual(["a_three"]);
        expect(isClean(report)).toBe(false);
    });

    test("structural tail error bubbles to errors bucket", () => {
        const authority = new Set(["a_one"]);
        // Content with no tail section at all
        const content = "# Runbook\n\n## Investigation\nUse `a_one`.\n";
        const report = validateRunbook("/fake/path.md", content, authority);
        expect(report.errors).toContain("missing_tail_section");
        expect(isClean(report)).toBe(false);
    });

    test("same tool cited multiple times in prose preserves line numbers", () => {
        const authority = new Set(["a_one"]);
        const content = [
            "# Runbook",
            "## Investigation",
            "First mention: `a_fake`.",
            "Second mention: `a_fake`.",
            "",
            "## All Tools Used Are Read-Only",
            "a_fake",
        ].join("\n");
        const report = validateRunbook("/fake/path.md", content, authority);
        expect(report.missing).toHaveLength(3); // 2 prose + 1 tail
        const proseMissing = report.missing.filter((c) => c.source === "prose");
        expect(proseMissing).toHaveLength(2);
        expect(proseMissing[0].line).toBe(3);
        expect(proseMissing[1].line).toBe(4);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "validateRunbook"`
Expected: FAIL.

- [ ] **Step 3: Implement `validateRunbook`**

Replace the stub:

```typescript
function validateRunbook(
    runbookPath: string,
    content: string,
    authority: Set<string>,
): ValidationReport {
    const proseCitations = extractProseCitations(content);
    const tailResult = extractTailSection(content);

    const missing: Citation[] = [];
    const proseOnly: Citation[] = [];
    const tailOnly: Citation[] = [];

    // Missing bucket: any citation whose name is not in authority
    for (const c of proseCitations) {
        if (!authority.has(c.name)) missing.push(c);
    }
    for (const c of tailResult.citations) {
        if (!authority.has(c.name)) missing.push(c);
    }

    // Drift buckets: comparison of unique names between prose and tail sets
    const proseNames = new Set(proseCitations.map((c) => c.name));
    const tailNames = new Set(tailResult.citations.map((c) => c.name));

    for (const c of proseCitations) {
        if (!tailNames.has(c.name)) proseOnly.push(c);
    }
    // Dedupe proseOnly to one entry per name (first occurrence)
    const proseOnlySeen = new Set<string>();
    const proseOnlyDeduped: Citation[] = [];
    for (const c of proseOnly) {
        if (proseOnlySeen.has(c.name)) continue;
        proseOnlySeen.add(c.name);
        proseOnlyDeduped.push(c);
    }

    for (const c of tailResult.citations) {
        if (!proseNames.has(c.name)) tailOnly.push(c);
    }

    return {
        runbookPath,
        missing,
        proseOnly: proseOnlyDeduped,
        tailOnly,
        errors: tailResult.errors,
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "validateRunbook"`
Expected: 7 pass.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-641: Implement validateRunbook with bucket computation

Composes prose and tail extractors, computes missing/proseOnly/
tailOnly buckets. Missing bucket preserves all occurrences (one per
line) so error messages show every citation to fix. proseOnly bucket
is deduped by name. Tail structural errors propagate to the errors
bucket.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Implement `formatReport` with TDD

**Goal:** Convert a non-clean ValidationReport into a multi-line human-readable failure message.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```typescript
describe("formatReport", () => {
    test("clean report has no formatted output (should not be called)", () => {
        // formatReport is called only on non-clean reports. This test
        // documents the behavior anyway: even on a clean report, the
        // output is well-formed.
        const report: ValidationReport = {
            runbookPath: "/fake/path.md",
            missing: [],
            proseOnly: [],
            tailOnly: [],
            errors: [],
        };
        const text = formatReport(report);
        expect(text).toContain("/fake/path.md");
        expect(text).toContain("Missing from action_tool_map (0)");
    });

    test("formats missing bucket with line numbers", () => {
        const report: ValidationReport = {
            runbookPath: "/x/y.md",
            missing: [
                { name: "kafka_fake", line: 11, source: "prose" },
                { name: "capella_fake", line: 20, source: "tail" },
            ],
            proseOnly: [],
            tailOnly: [],
            errors: [],
        };
        const text = formatReport(report);
        expect(text).toContain("Missing from action_tool_map (2)");
        expect(text).toContain("line 11: kafka_fake");
        expect(text).toContain("line 20: capella_fake");
    });

    test("formats all four buckets together", () => {
        const report: ValidationReport = {
            runbookPath: "/x/y.md",
            missing: [{ name: "m_one", line: 5, source: "prose" }],
            proseOnly: [{ name: "p_one", line: 6, source: "prose" }],
            tailOnly: [{ name: "t_one", line: 99, source: "tail" }],
            errors: ["empty_tail_section"],
        };
        const text = formatReport(report);
        expect(text).toContain("Missing from action_tool_map (1)");
        expect(text).toContain("prose but missing from");
        expect(text).toContain("Listed in tail section but not cited");
        expect(text).toContain("Structural errors (1)");
        expect(text).toContain("empty_tail_section");
        expect(text).toContain("Fix:");
    });

    test("empty buckets print (none)", () => {
        const report: ValidationReport = {
            runbookPath: "/x/y.md",
            missing: [{ name: "m_one", line: 5, source: "prose" }],
            proseOnly: [],
            tailOnly: [],
            errors: [],
        };
        const text = formatReport(report);
        expect(text).toContain("(none)");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "formatReport"`
Expected: FAIL.

- [ ] **Step 3: Implement `formatReport`**

Replace the stub:

```typescript
function formatReport(report: ValidationReport): string {
    const lines: string[] = [];
    lines.push(`Runbook: ${report.runbookPath}`);
    lines.push("");

    lines.push(`Missing from action_tool_map (${report.missing.length}):`);
    if (report.missing.length === 0) {
        lines.push("  (none)");
    } else {
        for (const c of report.missing) {
            lines.push(`  line ${c.line}: ${c.name}`);
        }
    }
    lines.push("");

    lines.push(
        `Cited in prose but missing from "All Tools Used Are Read-Only" tail section (${report.proseOnly.length}):`,
    );
    if (report.proseOnly.length === 0) {
        lines.push("  (none)");
    } else {
        for (const c of report.proseOnly) {
            lines.push(`  line ${c.line}: ${c.name}`);
        }
    }
    lines.push("");

    lines.push(`Listed in tail section but not cited in prose (${report.tailOnly.length}):`);
    if (report.tailOnly.length === 0) {
        lines.push("  (none)");
    } else {
        for (const c of report.tailOnly) {
            lines.push(`  line ${c.line}: ${c.name}`);
        }
    }
    lines.push("");

    lines.push(`Structural errors (${report.errors.length}):`);
    if (report.errors.length === 0) {
        lines.push("  (none)");
    } else {
        for (const e of report.errors) {
            lines.push(`  ${e}`);
        }
    }
    lines.push("");

    lines.push("Fix:");
    lines.push("  - For each \"Missing\" entry: verify the tool name, or add it to");
    lines.push("    an action_tool_map in the agent's tools/*.yaml.");
    lines.push("  - For each \"prose only\" entry: add the name to the");
    lines.push("    \"## All Tools Used Are Read-Only\" tail section.");
    lines.push("  - For each \"tail only\" entry: either cite it in prose or remove");
    lines.push("    it from the tail section.");

    return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "formatReport"`
Expected: 4 pass.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-641: Implement formatReport for human-readable test failures

Emits all four buckets (missing/proseOnly/tailOnly/errors) with line
numbers, empty buckets show (none), trailing 'Fix:' footer explains
the three remediations. 4 tests cover formatting.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Implement `collectAgents` with TDD

**Goal:** Walk `agents/` directory, return one `AgentFixture` per agent that has both a `knowledge/runbooks/` directory with `.md` files and a loadable agent definition.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("collectAgents", () => {
    function makeTempAgentsRoot(): string {
        return mkdtempSync(join(tmpdir(), "runbook-validator-test-"));
    }

    function writeAgentYaml(agentDir: string, name: string): void {
        writeFileSync(
            join(agentDir, "agent.yaml"),
            `spec_version: "0.1.0"
name: ${name}
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
    }

    test("returns fixture for agent with runbooks", () => {
        const root = makeTempAgentsRoot();
        const agentDir = join(root, "test-agent");
        mkdirSync(join(agentDir, "knowledge", "runbooks"), { recursive: true });
        writeAgentYaml(agentDir, "test-agent");
        writeFileSync(join(agentDir, "knowledge", "runbooks", "rb1.md"), "# Runbook 1");
        writeFileSync(join(agentDir, "knowledge", "runbooks", "rb2.md"), "# Runbook 2");

        const fixtures = collectAgents(root);
        expect(fixtures).toHaveLength(1);
        expect(fixtures[0].name).toBe("test-agent");
        expect(fixtures[0].runbookPaths).toHaveLength(2);
        expect(fixtures[0].runbookPaths.every((p) => p.endsWith(".md"))).toBe(true);

        rmSync(root, { recursive: true });
    });

    test("skips agent with no knowledge directory", () => {
        const root = makeTempAgentsRoot();
        const agentDir = join(root, "plain-agent");
        mkdirSync(agentDir, { recursive: true });
        writeAgentYaml(agentDir, "plain-agent");

        const fixtures = collectAgents(root);
        expect(fixtures).toHaveLength(0);

        rmSync(root, { recursive: true });
    });

    test("skips agent with empty runbooks directory", () => {
        const root = makeTempAgentsRoot();
        const agentDir = join(root, "empty-rb-agent");
        mkdirSync(join(agentDir, "knowledge", "runbooks"), { recursive: true });
        writeAgentYaml(agentDir, "empty-rb-agent");

        const fixtures = collectAgents(root);
        expect(fixtures).toHaveLength(0);

        rmSync(root, { recursive: true });
    });

    test("excludes .gitkeep from runbook paths", () => {
        const root = makeTempAgentsRoot();
        const agentDir = join(root, "a");
        mkdirSync(join(agentDir, "knowledge", "runbooks"), { recursive: true });
        writeAgentYaml(agentDir, "a");
        writeFileSync(join(agentDir, "knowledge", "runbooks", ".gitkeep"), "");
        writeFileSync(join(agentDir, "knowledge", "runbooks", "real.md"), "# Real");

        const fixtures = collectAgents(root);
        expect(fixtures).toHaveLength(1);
        expect(fixtures[0].runbookPaths).toHaveLength(1);
        expect(fixtures[0].runbookPaths[0].endsWith("real.md")).toBe(true);

        rmSync(root, { recursive: true });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "collectAgents"`
Expected: FAIL.

- [ ] **Step 3: Implement `collectAgents`**

Replace the stub:

```typescript
function collectAgents(agentsRoot: string): AgentFixture[] {
    if (!existsSync(agentsRoot)) return [];
    const entries = readdirSync(agentsRoot);
    const fixtures: AgentFixture[] = [];

    for (const entry of entries) {
        const agentDir = join(agentsRoot, entry);
        if (!statSync(agentDir).isDirectory()) continue;

        const runbooksDir = join(agentDir, "knowledge", "runbooks");
        if (!existsSync(runbooksDir)) continue;
        if (!statSync(runbooksDir).isDirectory()) continue;

        const runbookPaths = readdirSync(runbooksDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => join(runbooksDir, f));

        if (runbookPaths.length === 0) continue;

        // loadAgent will throw if the agent definition is broken;
        // we let it propagate so the test suite fails loudly.
        const agent = loadAgent(agentDir);

        fixtures.push({ name: entry, agent, runbookPaths });
    }

    return fixtures;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "collectAgents"`
Expected: 4 pass.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-641: Implement collectAgents via directory walk + loadAgent

Walks agents/ top level, filters to directories with knowledge/
runbooks/ subdirectories containing at least one .md file, calls
loadAgent() to get ToolDefinition[]. Skips .gitkeep files. loadAgent()
failures propagate to fail the test suite loudly. 4 tests use temp
directories for isolation.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Production validation test for incident-analyzer runbooks

**Goal:** Wire everything together. Walk real agents, validate real runbooks, fail with formatted messages on any issue.

**Files:**
- Modify: `packages/gitagent-bridge/src/runbook-validator.test.ts`

- [ ] **Step 1: Add the production test block**

Append to the test file (at the bottom, after all helper describe blocks):

```typescript
// ============================================================================
// Production validation - real agents
// ============================================================================

const AGENTS_ROOT = join(import.meta.dir, "../../../agents");
const PRODUCTION_FIXTURES = collectAgents(AGENTS_ROOT);

describe("real agent runbook bindings", () => {
    for (const fixture of PRODUCTION_FIXTURES) {
        describe(fixture.name, () => {
            const authority = buildAuthority(fixture.agent.tools);

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

- [ ] **Step 2: Run the production test block**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "real agent runbook bindings"`

Expected: 3 pass (one test per runbook: `kafka-consumer-lag.md`, `high-error-rate.md`, `database-slow-queries.md`). All clean because the spec's empirical verification confirmed every tool name exists in the action_tool_map union.

- [ ] **Step 3: Run the entire test file**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: all unit tests (8 + 9 + 5 + 7 + 4 + 4 = 37) plus 3 production tests = 40 pass.

- [ ] **Step 4: Run the entire package test suite to check for regressions**

Run: `bun test packages/gitagent-bridge/src/`
Expected: existing tests from `index.test.ts` still pass, plus the new 40 from `runbook-validator.test.ts`.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter '@devops-agent/gitagent-bridge' typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gitagent-bridge/src/runbook-validator.test.ts
git commit -m "SIO-641: Wire production validation for real agent runbooks

Top-level AGENTS_ROOT resolution via import.meta.dir, one describe
block per fixture, one test per runbook. Uses throw with formatted
report for failure messages rather than expect() so the output is
readable in test runners. All 3 incident-analyzer runbooks pass
on day one per the spec's empirical verification.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Prove the validator catches real breakage

**Goal:** Manually introduce each failure mode, confirm the validator catches it with actionable messages, then revert. This is a verification step to build confidence before merge — not something that ships.

**Files:**
- Temporarily modify: `agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md`

**Important:** Every sub-step below must be reverted before committing. No production changes from this task.

- [ ] **Step 1: Break a tool name in prose**

Edit `agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md` line 11, change:

```
Use `kafka_list_consumer_groups` to enumerate all groups.
```

to:

```
Use `kafka_list_consumer_groupsXXX` to enumerate all groups.
```

- [ ] **Step 2: Run the test and inspect the failure**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "kafka-consumer-lag.md is clean"`

Expected: FAIL with an error message containing:
- Path to `kafka-consumer-lag.md`
- `Missing from action_tool_map (1):`
- `line 11: kafka_list_consumer_groupsXXX`
- The `Fix:` footer

If the message does not match, the validator has a bug. Inspect the output, fix the bug, rerun.

- [ ] **Step 3: Revert the break**

Change `kafka_list_consumer_groupsXXX` back to `kafka_list_consumer_groups`.

Run: `git diff agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md`
Expected: empty — no changes.

- [ ] **Step 4: Break the prose-tail drift (prose-only)**

Add a new line after line 11 in the same file:

```
Also use `kafka_get_cluster_info` to inspect broker state.
```

(This tool exists in the action_tool_map, so it's not "missing" — but it's not in the tail section, so it should land in `proseOnly`.)

- [ ] **Step 5: Run the test and inspect the failure**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "kafka-consumer-lag.md is clean"`

Expected: FAIL with:
- `Missing from action_tool_map (0):  (none)`
- `Cited in prose but missing from "All Tools Used Are Read-Only" tail section (1):`
- `  line 12: kafka_get_cluster_info`

- [ ] **Step 6: Revert**

Remove the added line. Confirm `git diff` is empty.

- [ ] **Step 7: Break the tail section (tail-only)**

Edit the last line of the same file (the `## All Tools Used Are Read-Only` list) and add ` , kafka_get_cluster_info` at the end.

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "kafka-consumer-lag.md is clean"`

Expected: FAIL with:
- `Listed in tail section but not cited in prose (1):`
- `  line 51: kafka_get_cluster_info` (or whatever the content line is)

- [ ] **Step 8: Revert**

Remove ` , kafka_get_cluster_info` from the tail section. Confirm `git diff` is empty.

- [ ] **Step 9: Break the tail section (missing)**

Delete the entire `## All Tools Used Are Read-Only` section from the file.

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts -t "kafka-consumer-lag.md is clean"`

Expected: FAIL with:
- `Structural errors (1):`
- `  missing_tail_section`

- [ ] **Step 10: Revert**

Restore the deleted section. Confirm `git diff` is empty.

- [ ] **Step 11: Final verification**

Run: `bun test packages/gitagent-bridge/src/runbook-validator.test.ts`
Expected: all 40 tests pass. If anything fails here, revert completely:

```bash
git checkout agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md
```

- [ ] **Step 12: No commit**

This task produces no git changes. It is a pure verification exercise. `git status` should show only the previous task's commits and the untracked `kafka-mcp-agentcore.tar.gz`, nothing else.

---

## Task 10: Full test suite run

**Goal:** Verify the validator does not break any other package's tests.

- [ ] **Step 1: Run the full workspace test suite**

Run: `bun test`
Expected: all tests across all packages pass, including the 40 new tests in `packages/gitagent-bridge/src/runbook-validator.test.ts`.

- [ ] **Step 2: Run the full workspace typecheck**

Run: `bun run typecheck`
Expected: clean across all packages.

- [ ] **Step 3: Run the full workspace lint**

Run: `bun run lint`
Expected: no new Biome warnings attributable to this change. (The repo has pre-existing warnings in other files; the validator file should produce zero.)

- [ ] **Step 4: Run the YAML check**

Run: `bun run yaml:check`
Expected: clean. (No YAML was touched, so this is a sanity check.)

- [ ] **Step 5: No commit**

Verification only. If any step fails, stop and fix before proceeding to Task 11.

---

## Task 11: Update the authoring guide

**Goal:** SIO-639's `docs/development/authoring-skills-and-runbooks.md` contains a "tool-name footgun" section that currently says the binding is enforced by "code review and authorial discipline, not by the loader." With the validator landed, that language is wrong and needs updating.

**Files:**
- Modify: `docs/development/authoring-skills-and-runbooks.md`

- [ ] **Step 1: Read the current footgun section**

Run: `grep -n "Tool-Name Footgun\|tool-name" docs/development/authoring-skills-and-runbooks.md`

Expected: the footgun subsection and the line about "code review and authorial discipline."

- [ ] **Step 2: Update the section**

In `docs/development/authoring-skills-and-runbooks.md`, find the section titled `## The Tool-Name Footgun` and replace its content with:

```markdown
## The Tool-Name Footgun (now enforced)

Runbooks reference MCP tool names directly in prose (for example, `capella_get_longest_running_queries` or `kafka_get_consumer_group_lag`). These names correspond to entries in `agents/incident-analyzer/tools/*.yaml` `action_tool_map` blocks, which in turn correspond to the real tool names exposed by each MCP server.

**As of SIO-641, this binding is enforced statically by `bun test`.**

The validator lives at `packages/gitagent-bridge/src/runbook-validator.test.ts`. It runs on every `bun test` invocation and fails if any runbook cites a tool name that is not present in the union of `action_tool_map` entries across the agent's `tools/*.yaml` files. It also fails if the prose backticks and the `## All Tools Used Are Read-Only` tail section disagree within a single runbook.

**Authoring rules enforced by the validator:**

1. Every tool name cited in prose (wrapped in single backticks) must exist in some `action_tool_map` entry in the agent's tool YAMLs.
2. Every runbook must have a `## All Tools Used Are Read-Only` section at the bottom.
3. The tail section must be a comma-separated list matching every tool name cited in prose. Extras in either direction fail the validator.
4. The ordering constraint: if you need to cite a new tool in a runbook, add it to an `action_tool_map` entry first, then reference it in the runbook. Runbook-first authoring is not supported.

**There is no escape hatch.** No inline exemption markers, no allowlist config. If the validator fails on a tool name, either the citation is wrong or the action map is wrong — fix one or the other.

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
```

- [ ] **Step 3: Typecheck the docs (lint)**

Run: `bun run lint`
Expected: clean. (Biome doesn't lint markdown, so this is a sanity check.)

- [ ] **Step 4: Commit**

```bash
git add docs/development/authoring-skills-and-runbooks.md
git commit -m "SIO-641: Update authoring guide to reflect validator enforcement

Replaces the 'code review and authorial discipline' language in the
tool-name footgun section with a reference to the new validator.
Documents the four authoring rules the validator enforces and the
failure output format authors will see when things go wrong.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Final verification and PR prep

**Goal:** One last end-to-end check before opening the PR.

- [ ] **Step 1: Review the diff**

Run: `git diff main...HEAD --stat`
Expected:
```
 docs/development/authoring-skills-and-runbooks.md     | ~30 +++-
 packages/gitagent-bridge/src/runbook-validator.test.ts| ~600 ++++++
 2 files changed, ~630 insertions(+), ~10 deletions(-)
```

(Line counts are approximate — the validator file is ~550-650 lines depending on formatting.)

- [ ] **Step 2: Confirm no other files were touched**

Run: `git diff main...HEAD --name-only`
Expected: exactly two files. If anything else appears, investigate.

- [ ] **Step 3: Run the full test suite one more time**

Run: `bun test && bun run typecheck && bun run lint && bun run yaml:check`
Expected: all clean.

- [ ] **Step 4: Push the branch**

Run: `git push origin simonowusupvh/sio-621-standardize-mcp-server-structure-across-all-4-packages`
Expected: push succeeds.

(Note: this implementation stacks on the SIO-621 branch, same as SIO-639 and the SIO-640 spec/plan. If you want it on its own branch instead, branch off SIO-621 first before running Task 1.)

- [ ] **Step 5: Link the implementation commits to SIO-641**

Use the Linear MCP tool or open linear.app/siobytes/issue/SIO-641 and attach the commit URLs from Tasks 1-8 and 11 (or just the final one).

- [ ] **Step 6: Open the PR**

```bash
gh pr create --title "SIO-641: Runbook tool-name binding validator (Phase 2B)" --body "$(cat <<'EOF'
## Summary

- Adds a static validator as `packages/gitagent-bridge/src/runbook-validator.test.ts`
- Walks every agent's runbooks, extracts tool name citations from prose backticks and the tail section
- Fails `bun test` if any citation is missing from the action_tool_map union or if prose and tail disagree
- 37 unit tests + 3 production validation tests (one per real runbook)
- No runtime cost, no new scripts, no new config
- Updates the SIO-639 authoring guide to reflect static enforcement

Design spec: `docs/superpowers/specs/2026-04-10-runbook-tool-binding-validator-design.md`
Implementation plan: `docs/superpowers/plans/2026-04-10-runbook-tool-binding-validator.md`
Linear issue: SIO-641

## Test plan

- [ ] `bun test` clean (40 new tests)
- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] Manual: break a tool name in prose and confirm the validator fails with an actionable message (covered by Task 9 verification)

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
| File location (single `.test.ts` in gitagent-bridge) | Task 1 |
| Component structure (7 helpers + 2 test layers) | Tasks 1-8 |
| Local types (Citation, ValidationReport, AgentFixture, TailSectionResult) | Task 1 |
| Identifier filter (snake_case + underscore) | Task 2 |
| Prose extraction with fenced code block skip | Task 2 |
| Tail section parsing (header match, list, edge cases) | Task 3 |
| Authority set from action_tool_map union | Task 4 (via spec deviation — uses ToolDefinition[] not YAML re-parse) |
| validateRunbook bucket computation | Task 5 |
| Failure output format with "Fix:" footer | Task 6 |
| Directory walking and AgentFixture collection | Task 7 |
| Production validation tests (one per real runbook) | Task 8 |
| Verification that the validator catches real breakage | Task 9 |
| Regression check across the full workspace | Task 10 |
| Authoring guide update | Task 11 |
| PR creation | Task 12 |

All spec requirements are covered. The one deviation (authority source) is called out explicitly in the header.

**2. Placeholder scan:** Every code block is complete. Every step has exact commands and expected output. No "TODO", "TBD", "handle edge cases", or "similar to Task N" language. The only placeholder-like artifact is line counts in Task 12 Step 1 ("~600 ++++++" and "~30 +++-") which are deliberately approximate because Biome formatting can shift exact counts; the "exactly two files" check in Step 2 is the real guard.

**3. Type consistency check:**

- `Citation` shape `{name, line, source}` — declared Task 1, used in Tasks 2, 3, 5, 6. Consistent.
- `ValidationReport` shape — declared Task 1, populated in Task 5, formatted in Task 6. Consistent.
- `TailSectionResult.errors: string[]` — declared Task 1, populated in Task 3, consumed in Task 5 (via `tailResult.errors`). Consistent.
- `AgentFixture.agent: LoadedAgent` — declared Task 1, populated in Task 7, consumed in Task 8 via `fixture.agent.tools`. Consistent.
- `buildAuthority(tools: ToolDefinition[])` — declared Task 1, tested Task 4, called Task 8 with `fixture.agent.tools`. Consistent.
- `isClean(report)` — declared Task 1, used Tasks 5, 8. Consistent.
- `collectAgents(agentsRoot)` — declared Task 1, tested Task 7, called Task 8 with `AGENTS_ROOT`. Consistent.

**4. One note on Task 9:** The "break and revert" verification pattern relies on the implementer remembering to revert. I explicitly require `git diff` checks after each revert step and a final `git checkout` safety net. This is the only task in the plan that temporarily modifies production content; everything else is purely additive.

**5. Empirical verification baked in:** The spec confirmed all 32 tool names in the 3 current runbooks exist in the action_tool_map union. Task 8 Step 2 expects 3 passing production tests on day one. If this expectation is wrong at implementation time, someone added a new runbook or changed an action map between spec-time and implementation-time — that's useful information surfaced by the validator doing its job.

**6. Scope:** 12 implementation tasks + Task 0 prerequisite. Each task produces a working, committable checkpoint. The only task that doesn't commit is Task 9 (verification) and Task 10 (full-suite run) — both are intentional verification gates, not work units.

Self-review complete. No inline fixes needed.
