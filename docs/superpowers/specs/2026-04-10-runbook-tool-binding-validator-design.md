# Runbook Tool Binding Validator - Design Spec

> **Status:** Draft for review
> **Date:** 2026-04-10
> **Author:** Simon Owusu (with Claude Opus 4.6)
> **Related:** SIO-639 (Phase 1 documentation of the existing skills/runbooks loader path); this is Phase 2 brainstorm B
> **Supersedes:** none

## Context

Runbooks in `agents/*/knowledge/runbooks/*.md` reference MCP tool names in prose — for example, `kafka_list_consumer_groups`. These names must exactly match tools that the agent can actually dispatch via `tool_mapping.action_tool_map` entries in `agents/*/tools/*.yaml`. Today this binding is enforced only by authorial discipline and code review. If someone renames a tool in an MCP server or in a tool YAML, runbook prose continues to cite the old name, and the first sign of trouble is the LLM confidently recommending a dead tool at runtime. `bun run yaml:check` does not catch it (yamllint only checks YAML stylistic rules). `bun run typecheck` does not catch it. `bun run lint` does not catch it (Biome does not lint markdown).

SIO-639's `authoring-skills-and-runbooks.md` names this as a footgun but relies on procedural mitigation (grep before renaming, reviewer vigilance). This spec replaces the procedural mitigation with static enforcement.

## Goals

1. Detect runbook citations of tool names that are not present in the agent's `action_tool_map` union, at `bun test` time, with a clear per-runbook error message.
2. Detect drift between the two canonical sources of tool citations within each runbook (prose backticks vs the `## All Tools Used Are Read-Only` tail section).
3. Run automatically on every developer's local `bun test` and in CI without requiring new scripts, hooks, or configuration.
4. Zero false positives on the current 3-runbook set. **Empirically verified at spec time:** all 32 distinct tool names cited across `kafka-consumer-lag.md`, `high-error-rate.md`, and `database-slow-queries.md` are present in the union of `action_tool_map` entries across `agents/incident-analyzer/tools/*.yaml`.
5. Zero runtime cost. The validator is pure static analysis; `loadAgent()` is not modified.

## Non-Goals

- Fuzzy matching, typo suggestions, or rename detection. Missing is missing.
- Advisory-only warnings. Validation failures hard-fail `bun test`.
- Cross-agent tool lookups. Each agent is a closed world.
- Validating skills, systems-map entries, slo-policies entries, or any other knowledge category. Only runbooks.
- Validating sub-agent runbook directories. Sub-agents do not have runbooks today; if Phase 2 brainstorm C lands, the walk extends at that time.
- Runtime enforcement at `loadAgent()` time. Static analysis only.
- Escape hatches for deprecated or not-yet-landed tools. Authors must add tools to `action_tool_map` first, then reference them in runbooks. No exceptions.
- Integration with `bun run yaml:check`. `yamllint` does not parse markdown and adding a markdown-aware pass to the YAML check script would break the script's single responsibility.

## Architecture

### File location and scope

Single file: `packages/gitagent-bridge/src/runbook-validator.test.ts`.

Same package, same directory, and same co-location pattern as the existing `packages/gitagent-bridge/src/index.test.ts`. Picked up automatically by `bun test` via the existing root-level `test` script (`bun run --filter '*' test`). No changes to `package.json`, no new scripts, no Husky hooks, no GitHub Actions workflows.

### Component structure

All components are local functions in the test file. No exports from the package, no cross-module dependencies beyond `node:fs`, `node:path`, and the existing `yaml` package.

```
runbook-validator.test.ts
  |
  +-- extractProseCitations(content: string): Citation[]
  |     Walks content line by line. Skips fenced code blocks.
  |     Extracts every `identifier` wrapped in single backticks where
  |     the identifier matches /^[a-z][a-z0-9_]*$/ AND contains at
  |     least one underscore. Returns one Citation per match.
  |
  +-- extractTailSection(content: string): {
  |       citations: Citation[];
  |       errors: string[];
  |     }
  |     Finds a line matching exactly "## All Tools Used Are Read-Only"
  |     (case-sensitive). Parses the next non-empty line as a comma-
  |     separated list. Returns errors for missing, duplicate, empty,
  |     or malformed sections.
  |
  +-- buildAuthority(toolsDir: string): Set<string>
  |     Reads every .yaml file in toolsDir, parses it with the yaml
  |     package, and collects every tool name from every
  |     tool_mapping.action_tool_map.<action>.<tool_name>[] entry.
  |     Returns the union as a flat Set<string>. Tools without
  |     tool_mapping or action_tool_map contribute nothing.
  |
  +-- validateRunbook(
  |       runbookPath: string,
  |       content: string,
  |       authority: Set<string>
  |     ): ValidationReport
  |     Orchestrates the three extractors and computes the four
  |     mismatch buckets. Returns a ValidationReport. Does not read
  |     files; all I/O is delegated to the caller.
  |
  +-- formatReport(report: ValidationReport): string
  |     Converts a non-clean report into the multi-line failure
  |     message shown below. Called only when the report is non-clean.
  |
  +-- collectAgents(agentsRoot: string): AgentFixture[]
  |     readdirSync on agentsRoot. For each entry, checks whether
  |     <entry>/knowledge/runbooks/ exists and <entry>/tools/ exists.
  |     If both exist, returns an AgentFixture. Otherwise skips.
  |
  +-- The test suite:
        describe("extractProseCitations") { ... unit tests ... }
        describe("extractTailSection") { ... unit tests ... }
        describe("buildAuthority") { ... unit tests ... }
        describe("validateRunbook") { ... unit tests ... }
        describe("real agent runbook bindings") {
          for each agent fixture:
            describe(fixture.name) {
              for each runbook in fixture:
                test("<runbook filename> is clean")
            }
        }
```

### Identifier filter rationale

Runbook prose contains many backtick-wrapped identifiers that are not tool names — configuration keys, error codes, file extensions, protocol names. The filter is conservative by design: a prose backtick is treated as a tool citation if and only if the content between the backticks matches `/^[a-z][a-z0-9_]*$/` **and** contains at least one underscore (`_`).

The prose extractor walks content line by line and applies `/`([^`]+)`/g` per line to find backtick-wrapped segments. Each match is tested against the filter. Fenced code block detection (see below) suppresses matches inside fenced regions.

This excludes:
- Single-word identifiers: `` `timeout` ``, `` `latency` ``, `` `retention` ``
- PascalCase: `` `RebalanceInProgress` ``
- Hyphen-case: `` `dead-letter` ``, `` `service-name` ``
- Quoted values: `` `"error.response"` ``
- File extensions: `` `.dlq` ``

And includes every tool name used in the current runbooks: `kafka_list_consumer_groups`, `elasticsearch_search`, `capella_get_fatal_requests`, `query_api_requests`, etc.

The filter is a heuristic. It will produce false positives if a runbook legitimately wraps a non-tool snake_case identifier with multiple segments (e.g., `` `log_level` ``). At that point the author's options are: remove the backticks, pick a different identifier, or rename the underlying config key. The validator errs toward strictness because the opposite (permissive, allowing real stale references to slip through) defeats the purpose.

### Tail section parsing rules

- Header must match exactly: `## All Tools Used Are Read-Only` (case-sensitive, no trailing whitespace tolerated beyond what Markdown trims).
- The first non-empty line after the header is the canonical comma-separated list.
- Whitespace between commas is trimmed.
- Empty entries (`a.md, , b.md`) are ignored, not errored — authors sometimes leave trailing commas.
- Missing header → error `missing_tail_section`.
- More than one matching header in a single runbook → error `duplicate_tail_section`.
- Header present but the next non-empty content is a heading or a fenced code block → error `malformed_tail_section`.
- Header present but nothing follows before EOF → error `empty_tail_section`.

### Line number semantics

Citation line numbers are 1-based. For **prose citations**, the line number is the line on which the backtick match was found. For **tail citations**, all entries share the line number of the first non-empty content line under the tail header (i.e., the line containing the comma-separated list). This is coarser than column-level precision but sufficient for error messages — the fix location is the tail section itself, and the author sees all mismatched entries together.

### Fenced code block detection

The prose extractor maintains an `inFence: boolean` as it walks the content line by line. Any line whose trimmed content starts with ` ``` ` (three backticks, optionally followed by a language identifier) toggles the flag. When `inFence` is true, lines are not scanned for backtick citations. Nested fences are not supported — the first ` ``` ` after opening closes the fence. This is standard CommonMark behavior and the three current runbooks have no fenced blocks anyway.

### Authority set construction

`buildAuthority(toolsDir)` walks every `.yaml` file in the directory (top-level only, no recursion). For each file:

1. `readFileSync` the content.
2. `parse()` it with the `yaml` package.
3. Navigate to `tool_mapping.action_tool_map` (if present).
4. Iterate every key in `action_tool_map` and flatten the value arrays into the running set.

Files missing `tool_mapping`, missing `action_tool_map`, or failing YAML parse contribute nothing to the set. YAML parse failures are **not** swallowed — they propagate as test failures because a broken tool YAML already blocks `loadAgent()` in production.

### Cross-agent isolation

Each `AgentFixture` has its own `toolsDir` and `runbookPaths`. A runbook in `agents/agent-a/knowledge/runbooks/x.md` is validated against `agents/agent-a/tools/*.yaml` — never against other agents' tool YAMLs. This matches the real `loadAgent()` behavior and keeps the validator's failures scoped per-agent.

## Data Shapes

All local to the test file. No exports.

```typescript
interface Citation {
    name: string;              // the tool name, e.g. "kafka_list_consumer_groups"
    line: number;              // 1-based line number in the source runbook
    source: "prose" | "tail";  // which extractor produced this citation
}

interface ValidationReport {
    runbookPath: string;       // absolute path, for error message attribution
    missing: Citation[];       // cited but not in authority set
    proseOnly: Citation[];     // in prose but not in tail section
    tailOnly: Citation[];      // in tail but not in prose
    errors: string[];          // structural errors (missing/duplicate/malformed/empty tail, etc.)
}

interface AgentFixture {
    name: string;              // e.g. "incident-analyzer"
    agentDir: string;          // absolute path to agents/<name>/
    toolsDir: string;          // absolute path to agents/<name>/tools/
    runbookPaths: string[];    // absolute paths to each .md in agents/<name>/knowledge/runbooks/
}
```

A report is **clean** iff `missing.length === 0 && proseOnly.length === 0 && tailOnly.length === 0 && errors.length === 0`. Any non-clean report fails the corresponding test.

The `source` field on `Citation` is used during bucket computation. `validateRunbook` collects prose citations and tail citations separately, then computes:

- `missing` = citations from **either** source whose `name` is not in the authority set
- `proseOnly` = prose citations whose `name` is not in the set of tail citation names
- `tailOnly` = tail citations whose `name` is not in the set of prose citation names

A single tool cited in both prose and tail appears in neither `proseOnly` nor `tailOnly`. A tool missing from authority appears in `missing` regardless of which source cited it — if it's in both prose and tail, both citations land in `missing` with their respective line numbers.

## Failure Output

When `validateRunbook` produces a non-clean report, `formatReport` renders it into a multi-line string passed to the test's assertion message. Example:

```
Runbook: /abs/path/agents/incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md

Missing from action_tool_map (3):
  line 11: kafka_list_consumer_groups_v2
  line 14: kafka_describe_consumer_grupp
  line 51: capella_get_fatl_requests

Cited in prose but missing from "All Tools Used Are Read-Only" tail section (1):
  line 20: kafka_get_topic_offsets

Listed in tail section but not cited in prose (1):
  line 51: kafka_get_message_by_offset

Structural errors (0):
  (none)

Fix:
  - For each "Missing" entry: verify the tool name, or add it to an
    action_tool_map in agents/incident-analyzer/tools/*.yaml.
  - For each "prose only" entry: add the name to the "## All Tools Used
    Are Read-Only" tail section.
  - For each "tail only" entry: either cite it in prose or remove it
    from the tail section.
```

Empty buckets are still printed with `(none)` so the author sees the full shape at a glance.

## Edge Cases

| Situation | Behavior |
|---|---|
| Agent directory has no `knowledge/` | Skip agent (no fixture emitted) |
| Agent has `knowledge/` but no `runbooks/` subdirectory | Skip agent |
| `runbooks/` exists but is empty | Skip agent (no runbook paths to validate) |
| Runbook file is empty or whitespace-only | Error: `empty_runbook` |
| Runbook has no `## All Tools Used Are Read-Only` section | Error: `missing_tail_section` |
| Runbook has multiple matching section headers | Error: `duplicate_tail_section` |
| Tail header exists but the next non-empty content is a heading or fenced block | Error: `malformed_tail_section` |
| Tail header exists but nothing follows before EOF | Error: `empty_tail_section` |
| Prose has zero backtick-wrapped snake_case identifiers with underscores | Valid. Only the tail is validated against authority. |
| `tools/` directory exists but no file has `action_tool_map` | Authority is empty set. Every non-empty runbook fails (loud misconfiguration signal). |
| `tools/` directory is missing for an agent with runbooks | Structural error on the agent fixture: `missing_tools_dir` |
| YAML parse error in a `tools/*.yaml` file | Propagates as an uncaught error, failing the describe block |
| Tool cited in prose appears multiple times | Each occurrence is its own Citation with its own line number; set comparisons dedupe at the bucket level |
| Tool name appears inside a fenced triple-backtick block | Ignored — fenced blocks are skipped by the prose extractor |
| Tool cited with trailing punctuation outside the backticks | Captures only the identifier between backticks; punctuation is irrelevant |
| Duplicates within the tail section's comma-separated list | Error: `duplicate_in_tail_section` |
| Same tool cited multiple times in prose | Each occurrence is its own Citation with its own line number. If the tool is in authority and also in the tail section, all occurrences pass the checks. If it's missing from authority, every occurrence appears in the `missing` bucket — the author sees every line number to fix. |
| Tool cited inside an HTML comment (`<!-- kafka_foo -->`) | Not skipped; treated as prose. HTML comments are still raw characters in the file and if an author wraps a tool name in backticks inside one, the validator enforces the same rules. |

**What the validator does NOT handle:**

- Cross-agent tool references
- Deprecation warnings
- Fuzzy matching or rename detection
- Tools declared but not in any `action_tool_map` (treated as missing)
- Column-level precision in error messages

## Testing Strategy

The validator file itself ships with two layers of tests:

**Layer 1: Extractor and helper unit tests** using synthetic inline fixtures. No filesystem. No temp directories except for `buildAuthority` (which needs real `.yaml` files).

| Group | Test |
|---|---|
| `extractProseCitations` | wrapped snake_case identifier with underscore → citation |
| | single-word backtick (no underscore) → skipped |
| | PascalCase backtick → skipped |
| | hyphen-case backtick → skipped |
| | identifier with trailing punctuation outside backticks → captured cleanly |
| | identifier inside fenced code block → skipped |
| | multiple citations on one line → all captured with correct column-independent line number |
| | empty content → empty array |
| `extractTailSection` | standard section with comma-separated list → clean |
| | whitespace around names → trimmed |
| | missing header → `missing_tail_section` error |
| | duplicate header → `duplicate_tail_section` error |
| | header followed immediately by next heading → `empty_tail_section` |
| | header followed by fenced code block → `malformed_tail_section` |
| | header at EOF with nothing after → `empty_tail_section` |
| | duplicates within the tail list → `duplicate_in_tail_section` |
| `buildAuthority` | union across multiple tool yamls → flat set |
| | tool yaml without `action_tool_map` contributes nothing |
| | empty tools directory → empty set |
| | tool yaml with malformed YAML → propagates error |
| `validateRunbook` | clean runbook → clean report |
| | prose cites missing tool → `missing` bucket populated |
| | prose cites tool not in tail → `proseOnly` bucket populated |
| | tail lists tool not in prose → `tailOnly` bucket populated |
| | all three buckets populated simultaneously |
| | structural tail error → `errors` bucket populated, no per-bucket assertions |

**Layer 2: Production validation** against the real incident-analyzer runbooks. One explicit test per runbook; no dynamic test generation.

```typescript
describe("real agent runbook bindings", () => {
    describe("incident-analyzer", () => {
        test("kafka-consumer-lag.md is clean", () => {
            const path = join(AGENTS_ROOT, "incident-analyzer/knowledge/runbooks/kafka-consumer-lag.md");
            const content = readFileSync(path, "utf-8");
            const authority = buildAuthority(join(AGENTS_ROOT, "incident-analyzer/tools"));
            const report = validateRunbook(path, content, authority);
            if (!isClean(report)) {
                throw new Error(formatReport(report));
            }
        });
        test("high-error-rate.md is clean", () => { /* same shape */ });
        test("database-slow-queries.md is clean", () => { /* same shape */ });
    });
});
```

Adding a fourth runbook requires adding a fourth test line — no generator magic. Explicit is better than implicit for production assertions.

**What is NOT tested:**

- `collectAgents` directory walking (exercised transitively by Layer 2)
- Multi-agent scenarios (only `incident-analyzer` has runbooks today)
- Performance (5 YAMLs × 3 runbooks × ~100 lines runs in <100ms; benchmarking is waste)

## Rollout

1. Land this spec.
2. Run `superpowers:writing-plans` to produce a step-by-step implementation plan.
3. Create a Linear issue for the implementation work with the plan attached.
4. Implement in a single commit (or small series if TDD naturally splits). The validator is self-contained in one file, no refactors of other code.
5. Verify the test passes locally on the current 3 runbooks.
6. Verify the test fails when a runbook is deliberately broken (e.g., rename a reference) and the failure message is actionable.
7. Merge. On next `bun test`, the validator runs automatically. No rollout gate, no config.
8. Document the validator in `docs/development/authoring-skills-and-runbooks.md` (the SIO-639 guide) under the tool-name footgun section — the section will change from "relies on authorial discipline" to "enforced by `bun test`".

## Open Questions

None at spec time. Implementation plan will surface any further questions.

## Appendix: Alternatives Considered

**Runtime enforcement via `loadAgent()`.** Rejected. Moves a static problem to runtime and hides it from dev-time feedback. Also adds agent-load cost that doesn't pay for itself.

**Integration with `bun run yaml:check`.** Rejected. `yamllint` does not parse markdown and has a single responsibility (YAML stylistic linting). Bolting markdown-aware logic onto it would either require rewriting `yaml:check` from scratch or wrapping it in a shell pipeline. The `bun test` integration is cleaner.

**Top-level `bun run runbooks:check` script.** Rejected. Any script that isn't wired into `bun test` or CI is a script nobody remembers to run. Making it part of the test suite is the lowest-friction enforcement path.

**mcp_patterns glob matching as the authority source.** Rejected per Question 2. Globs like `kafka_*` accept any name starting with `kafka_`, including hallucinated ones. That's too permissive for the failure mode this validator targets.

**Live MCP tool enumeration as the authority source.** Rejected per Question 2. Requires MCP servers to be reachable during validation. Breaks CI, breaks offline dev, breaks the "runs on every `bun test`" property.

**Escape hatch via `<!-- validator:skip -->` HTML comments.** Rejected per Question 5. Adds maintenance surface and is obvious to abuse. Strict discipline is simpler.

**Explicit `runbook_tool_allowlist` in `knowledge/index.yaml`.** Rejected per Question 5. Another config block that has to stay in sync with reality. Same failure-mode-in-a-different-place as the thing this validator is trying to prevent.

**Warnings-only mode (non-failing).** Rejected per Question 4. Warnings don't block merges; this problem needs enforcement or it decays.

**Explicit frontmatter `tools:` list per runbook as the single source of truth.** Rejected per Question 1. Would require rewriting all three existing runbooks to add frontmatter, changes the authoring convention, and loses the dual-source cross-check that catches "prose says X, tail says Y" drift.

**Parsing tail section via YAML or JSON.** Rejected. Comma-separated prose matches the three existing runbooks' format exactly. Switching to YAML would require rewriting all three runbooks with no corresponding benefit.

**Generating test cases dynamically from the file walk.** Rejected. Explicit `test(...)` calls per runbook make failure output easier to navigate in test runners and make additions visible in PRs. Dynamic generation hides new test coverage behind file-system state.
