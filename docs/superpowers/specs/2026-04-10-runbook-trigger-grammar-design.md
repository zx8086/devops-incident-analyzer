# Runbook Trigger Grammar - Design Spec

> **Status:** Draft for review
> **Date:** 2026-04-10
> **Author:** Simon Owusu (with Claude Opus 4.6)
> **Related:** SIO-639 (Phase 1 docs), SIO-640 (Phase 2A lazy runbook selection), SIO-641 (Phase 2B tool-name validator), SIO-642 (Phase 2C sub-agent runbooks); this is Phase 2 brainstorm E
> **Supersedes:** none

## Context

Brainstorm A (SIO-640) introduced a `selectRunbooks` LangGraph node that uses an LLM router to pick 0-2 runbooks from the orchestrator's catalog per request. The router is pre-emptive: it positions the system for a scale inflection around 8-12 runbooks where LLM-based selection typically loses precision. Brainstorm A's design is complete and self-contained, but it leaves a question open for larger catalogs: at 50+ runbooks, presenting every candidate to the LLM router becomes noise, and the router's selection quality degrades regardless of how well-tuned the prompt is.

This spec introduces a deterministic **pre-filter** that runs inside `selectRunbooks` before the LLM router. Runbooks optionally declare YAML frontmatter with a `triggers:` block that matches against `NormalizedIncident` signals. The pre-filter narrows the catalog to runbooks whose triggers match the current incident; the LLM router then picks from the narrowed set. At small catalogs (3-10 runbooks) the filter is a lightweight optimization. At large catalogs (50+) it becomes essential.

The key discipline: **triggers narrow, they do not gatekeep.** If triggers match zero runbooks, the full catalog passes through to the router unchanged. If no runbook has triggers at all, the filter is a no-op. Triggers can only reduce the router's work, never starve it.

## Goals

1. Define a YAML frontmatter trigger grammar that matches against the three most useful `NormalizedIncident` axes: severity, affected service names, extracted metric names.
2. Implement a deterministic pre-filter (`narrowCatalogByTriggers`) inside brainstorm A's `selectRunbooks` node that narrows the catalog before the LLM router runs.
3. Keep the three current runbooks fully backwards compatible. No frontmatter required. Opt-in by runbook.
4. Fail loudly on frontmatter parse errors, schema violations, and typos — same discipline as brainstorms A and C.
5. Tweak brainstorm B's `extractProseCitations` to skip frontmatter blocks so YAML identifiers aren't mistaken for tool citations.
6. Emit observability attributes from `selectRunbooks` showing the filter mode (`noop`, `narrowed`, `fallback`) and the narrowing ratio.

## Non-Goals

- **Replacing brainstorm A's LLM router.** The router still runs. The filter only narrows its input.
- **Metric value thresholds.** Triggers match metric names only, not values. `metrics: [lag]` matches an incident metric named `consumer_lag` regardless of the numeric value. Metric value parsing is a rabbit hole (units, nulls, scientific notation, threshold semantics).
- **Negative matchers.** No `severity_exclude: [low]` or `not:` blocks. Positive-only grammar.
- **Regex matching.** All service and metric matches are case-insensitive substring. No regex support. Substring is enough to express the patterns that matter without inviting ReDoS concerns.
- **Temporal triggers.** No "this runbook applies only during business hours." Time windows exist in `NormalizedIncident` but not in the trigger grammar. Can be added later as a new axis.
- **Free-text matching on raw user query.** Triggers match `NormalizedIncident` fields only.
- **Cross-runbook logic.** Each runbook's match decision is independent.
- **Seeding frontmatter on existing runbooks.** The three current runbooks stay frontmatter-less as part of this spec's scope. Adding triggers to them is a separate ~15-line-per-file decision the user can make later without a new brainstorm.
- **Filtering non-runbook knowledge.** Systems-map and slo-policies entries are never frontmatter-parsed. They always pass through to the prompt unchanged.

## Hard Dependencies

Brainstorm E plugs directly into brainstorm A's pipeline and brainstorm B's validator:

- **SIO-640 (Phase 2A lazy runbook selection)** — must be implemented first. The filter lives inside `selectRunbooks`. If that node doesn't exist, there's nothing to plug into.
- **SIO-641 (Phase 2B tool-name binding validator)** — must be implemented first. `extractProseCitations()` needs a small tweak to skip frontmatter blocks; that function is introduced by SIO-641.
- **SIO-639 (Phase 1 docs)** — required transitively.
- **SIO-642 (Phase 2C scoped sub-agent runbooks)** — optional. Compatible if landed. Sub-agent runbooks can also opt into frontmatter using the same grammar.

Implementation cannot start until SIO-640 and SIO-641 are merged.

## Architecture

### Pipeline position

```
classify
  -> normalize (writes state.normalizedIncident)
  -> selectRunbooks [from SIO-640, modified here]
       |-- narrowCatalogByTriggers(catalog, normalizedIncident)   [NEW]
       |     returns filtered catalog or full catalog on zero-match fallback
       |-- calls LLM router against the (possibly narrowed) catalog
       `-- writes state.selectedRunbooks per brainstorm A's existing logic
  -> entityExtractor
  -> ... rest of brainstorm A's pipeline unchanged ...
```

The filter runs as the first step of `selectRunbooks` before any LLM work. Brainstorm A's state field, fallback config, and router prompt are untouched. The only observable difference is which catalog the router sees.

### Frontmatter parsing in `manifest-loader.ts`

`packages/gitagent-bridge/src/manifest-loader.ts` currently reads each `.md` file in a knowledge category directory and populates `KnowledgeEntry.content` with the raw file contents. This spec adds a parsing pass for runbook files specifically:

1. Read the file as a string.
2. Detect a leading `---\n` delimiter on the first line.
3. Find the matching closing `---\n` delimiter.
4. Parse the content between the delimiters as YAML using the existing `yaml` package.
5. Validate the parsed object with a new `.strict()` Zod schema (`RunbookTriggersSchema`).
6. Store the validated triggers on a new `KnowledgeEntry.triggers?` field.
7. Store the content after the closing delimiter as `KnowledgeEntry.content` — the body without the frontmatter.

If any step fails (YAML parse error, Zod validation error, missing closing delimiter), `loadAgent()` throws with a clear error message containing the file path and the specific failure reason. Loud failure at load time.

Files without a leading `---` are treated as having no frontmatter: `triggers` is `undefined`, `content` is the full file. This preserves backwards compatibility with the three current runbooks.

Only runbooks (category `runbooks`) are parsed this way. Other categories (systems-map, slo-policies) skip frontmatter parsing entirely — their content passes through verbatim, same as today.

### Deterministic pre-filter in `selectRunbooks`

Brainstorm A's `selectRunbooks` node is modified to call `narrowCatalogByTriggers()` as its first step. The return value determines which catalog the LLM router sees.

```typescript
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

The "trigger-less runbooks always pass" rule is deliberate: a runbook without frontmatter has opted out of filtering, not out of the catalog. The LLM router sees it regardless of what triggers the other runbooks declare.

The "zero matches → full catalog fallback" rule is equally deliberate: the filter can only reduce the router's work, never starve it. If the grammar is too narrow or the incident has signals none of the triggers cover, the system reverts to today's behavior rather than shipping an empty catalog to the LLM.

### Interaction with brainstorm B validator

`extractProseCitations()` in `runbook-validator.test.ts` (introduced by SIO-641) walks markdown files looking for backtick-wrapped snake_case identifiers. With frontmatter added, the validator must skip the frontmatter block when extracting citations — otherwise YAML content like `services: [kafka_consumer_group]` could be mistaken for a prose tool citation.

The tweak: before walking lines, detect a leading `---` block and skip all lines up to and including the closing `---`. The rest of the function works unchanged. ~5 lines of new code.

Two new tests in `runbook-validator.test.ts` verify the tweak:
1. A runbook with frontmatter and prose correctly extracts the prose citation (and only the prose citation).
2. A runbook with a snake_case identifier inside the frontmatter YAML is NOT extracted as a prose citation.

### What doesn't change

- **`skill-loader.ts`, `buildSystemPrompt()`, `buildKnowledgeSection()`** — unchanged. They emit `entry.content`, which is now the frontmatter-stripped body for runbooks and the raw content for everything else.
- **`buildSubAgentPrompt()`** — unchanged.
- **`loadAgent()` top-level signature and return type** — unchanged. Only the internal `loadKnowledge()` helper is touched.
- **The three current runbooks** — zero changes. They have no frontmatter and continue to work.
- **Brainstorm A's state field `selectedRunbooks`, its config gate, its severity-tier fallback config, its Zod response schema, its router prompt** — all unchanged. Only the catalog passed to the router changes.
- **Brainstorm C's sub-agent runbook walk** — compatible as-is. Sub-agent runbooks can also have frontmatter with the same semantics.

## Data Shapes

### `RunbookTriggersSchema` and `RunbookFrontmatterSchema`

Two new Zod schemas in `packages/gitagent-bridge/src/types.ts`:

```typescript
export const RunbookTriggersSchema = z.object({
    severity: z.array(z.enum(["critical", "high", "medium", "low"])).optional(),
    services: z.array(z.string()).optional(),
    metrics: z.array(z.string()).optional(),
    match: z.enum(["any", "all"]).optional(),
}).strict();

export type RunbookTriggers = z.infer<typeof RunbookTriggersSchema>;

export const RunbookFrontmatterSchema = z.object({
    triggers: RunbookTriggersSchema,
}).strict();

export type RunbookFrontmatter = z.infer<typeof RunbookFrontmatterSchema>;
```

`RunbookTriggersSchema` has three matchable axes — severity, services, metrics — plus a `match` combinator defaulting to `any` when omitted. All four fields are optional. `.strict()` means unknown keys under `triggers:` fail validation.

`RunbookFrontmatterSchema` is the outer wrapper that requires exactly one top-level key, `triggers`. It is also `.strict()`, so authors cannot add arbitrary top-level metadata like `tags:` or `author:` to runbook frontmatter. Everything in frontmatter must live under `triggers:` or it's rejected at load time.

The parser helper calls `RunbookFrontmatterSchema.parse()` on the YAML-parsed frontmatter object, then extracts `.triggers` from the validated result.

### Extended `KnowledgeEntry`

`packages/gitagent-bridge/src/manifest-loader.ts` gains a new optional field:

```typescript
export interface KnowledgeEntry {
    category: string;
    filename: string;
    content: string;                  // body with frontmatter stripped (for runbooks)
    triggers?: RunbookTriggers;       // NEW, only set for runbooks with valid frontmatter
}
```

Only runbooks populate `triggers`. Other knowledge entries (systems-map, slo-policies) leave it `undefined`.

### Extended `RunbookCatalogEntry`

`packages/agent/src/prompt-context.ts` gains a pass-through:

```typescript
export interface RunbookCatalogEntry {
    filename: string;
    title: string;
    summary: string;
    triggers?: RunbookTriggers;       // NEW — projected from KnowledgeEntry.triggers
}
```

`getRunbookCatalog()` copies `knowledgeEntry.triggers` onto each catalog entry. This avoids a second frontmatter parse in the selector and keeps all schema validation at the loader level.

## Trigger Grammar

### Frontmatter format

Runbooks with triggers start with a YAML frontmatter block delimited by `---` lines:

```markdown
---
triggers:
  severity: [critical, high]
  services: [kafka, consumer]
  metrics: [lag]
  match: any
---
# Kafka Consumer Lag Investigation

## Symptoms
- Consumer group lag exceeding threshold (>10,000 messages)
```

The opening `---` must be on line 1. The closing `---` must be on its own line. Content before the closing `---` is YAML; content after is the markdown body.

### The three matchable axes

| Axis | Type | Matches against |
|---|---|---|
| `severity` | `("critical" \| "high" \| "medium" \| "low")[]` | `incident.severity` — axis matches if the incident's severity is in the list |
| `services` | `string[]` | `incident.affectedServices[].name` — axis matches if at least one trigger pattern is a case-insensitive substring of at least one affected service name |
| `metrics` | `string[]` | `incident.extractedMetrics[].name` — axis matches if at least one trigger pattern is a case-insensitive substring of at least one extracted metric name |

All three axes are optional. A runbook can declare any subset. An axis that is not declared does not participate in matching.

### Per-axis match rules

**`severity` axis:**
- Not declared → axis does not participate.
- Declared + `incident.severity === undefined` → does not match (can't match on missing data).
- Declared + `incident.severity` defined → matches iff `triggers.severity.includes(incident.severity)`.

**`services` axis:**
- Not declared → axis does not participate.
- Declared + `incident.affectedServices` undefined or empty → does not match.
- Declared + `incident.affectedServices` non-empty → matches iff there exists a `pattern` in `triggers.services` and a `service` in `incident.affectedServices` such that `service.name.toLowerCase().includes(pattern.toLowerCase())`.

**`metrics` axis:**
- Same shape as services. Matches against `incident.extractedMetrics[].name` only (not values).

### Combinator (`match: any | all`)

The `match` field controls how declared axis results combine:

- **`match: any`** (default) — the runbook matches iff at least one declared axis matches.
- **`match: all`** — the runbook matches iff every declared axis matches.

`match` applies only to axes that are declared. A runbook with only `severity: [critical]` matches identically under `any` and `all` (one axis → both rules reduce to the same thing).

### Full match flow

```typescript
function matchTriggers(triggers: RunbookTriggers, incident: NormalizedIncident): boolean {
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

    // No axes declared → no match. Lint-level warning, not a crash.
    if (axisResults.length === 0) return false;

    const combinator = triggers.match ?? "any";
    return combinator === "all"
        ? axisResults.every((r) => r)
        : axisResults.some((r) => r);
}

function matchSeverityAxis(
    allowed: Array<"critical" | "high" | "medium" | "low">,
    incidentSeverity: NormalizedIncident["severity"],
): boolean {
    if (incidentSeverity === undefined) return false;
    return allowed.includes(incidentSeverity);
}

function matchServicesAxis(
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

function matchMetricsAxis(
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
```

Per-axis matchers are pure functions taking only the axis-relevant incident field, testable in isolation. They use `NormalizedIncident["field"]` type indexing to stay in sync with the source schema automatically — if `NormalizedIncident.affectedServices` ever gains new fields, the matchers won't need to be updated unless they actually read the new fields.

### Worked examples

**Example 1: `kafka-consumer-lag.md` with `match: any`**

```yaml
triggers:
  severity: [critical, high]
  services: [kafka, consumer]
  metrics: [lag]
```

| Incident | severity | services | metrics | match? |
|---|---|---|---|---|
| `{severity: "critical"}` | ✓ | ✗ (no data) | ✗ (no data) | **yes** (severity alone satisfies `any`) |
| `{severity: "low", affectedServices: [{name: "kafka-broker"}]}` | ✗ | ✓ ("kafka" ⊆ "kafka-broker") | ✗ | **yes** |
| `{severity: "low"}` | ✗ | ✗ | ✗ | **no** |
| `{severity: "high", affectedServices: [{name: "auth-service"}], extractedMetrics: [{name: "lag"}]}` | ✓ | ✗ | ✓ | **yes** |

**Example 2: hypothetical `api-critical-outage.md` with `match: all`**

```yaml
triggers:
  severity: [critical]
  services: [api, gateway]
  match: all
```

| Incident | severity | services | match? |
|---|---|---|---|
| `{severity: "critical", affectedServices: [{name: "api-gateway"}]}` | ✓ | ✓ | **yes** |
| `{severity: "critical", affectedServices: [{name: "worker"}]}` | ✓ | ✗ | **no** |
| `{severity: "high", affectedServices: [{name: "api-gateway"}]}` | ✗ | ✓ | **no** |
| `{severity: "critical"}` | ✓ | ✗ (no data) | **no** |

## Error Handling

| Situation | Behavior |
|---|---|
| Runbook has no frontmatter | `triggers` is `undefined` on `KnowledgeEntry`. Never narrowed out. Backwards compat. |
| Runbook has empty frontmatter `---\n---\n` | `yaml.parse("")` returns `undefined`. `RunbookFrontmatterSchema.parse(undefined)` throws because the schema requires an object with a `triggers` key. **Loud failure at load time** — surfaces empty/WIP frontmatter immediately. |
| Frontmatter with only `match: any` and no axes declared (`---\ntriggers:\n  match: any\n---`) | Parses cleanly as `{triggers: {match: "any"}}`. Runs through `matchTriggers` which sees zero axes → returns false → runbook never contributes matches. Lint-level signal (runbook always loses the filter), not a load-time crash. |
| Malformed YAML in frontmatter | `yaml` package throws. `loadKnowledge()` propagates with file path attached. Agent fails to load. |
| Frontmatter fails `.strict()` Zod validation (typo, unknown key, wrong type) | Zod throws. `loadKnowledge()` propagates with file path and field name. Agent fails to load. |
| Missing closing `---` | YAML parser treats the whole file as the frontmatter block. Usually produces a parse error. Loud failure. |
| Frontmatter `severity` value not in enum | Zod enum validation fails. Loud failure with typo-friendly error message. |
| Frontmatter `match` value not `"any"` or `"all"` | Zod enum validation fails. Loud failure. |
| Unknown top-level frontmatter key (e.g., `tags:`) | `.strict()` rejects. Loud failure. |
| Unknown key under `triggers:` (e.g., `metric:` typo) | `.strict()` rejects. Loud failure. |
| `state.normalizedIncident` is empty or missing | `matchTriggers` is called with an empty incident. Every declared axis returns false (missing data). Runbook contributes no match. Multiple such runbooks → fall-through to full catalog. |
| Partial incident data (severity set, no services) | Each axis independently decides. Severity-only runbooks can still match; service-only runbooks cannot. Per-axis independence by design. |
| Catalog is empty | Upstream `selectRunbooks` short-circuits to `skip.empty_catalog` per brainstorm A before `narrowCatalogByTriggers` runs. Unreachable in normal flow; test covered for safety. |
| Body is empty after frontmatter (runbook is frontmatter-only) | `KnowledgeEntry.content === ""`. Loaded legally. `buildKnowledgeSection` emits an empty body under the filename header. Useless but not an error — authors can commit frontmatter first and body later. |

**No retries, no fallback loops.** The filter is pure static logic. The only fallback is the zero-match fall-through to the full catalog, which is a single deterministic branch.

**Schema evolution.** Adding a new trigger axis (e.g., `regions: string[]`) is:
1. Add the field to `RunbookTriggersSchema` (optional, backwards compatible).
2. Add a per-axis matcher function.
3. Add it to the `matchTriggers` axis loop.

Existing runbooks without the new field continue to work. `.strict()` means authors can't add new fields and have them silently ignored — they'd get a loud load failure until the schema is updated. Correct default for this codebase.

## Testing

### Unit tests: `parseRunbookFrontmatter`

File: `packages/gitagent-bridge/src/manifest-loader.test.ts` (new file or extension)

11 tests against inline string fixtures covering every parse path:

| # | Test | Input | Expected |
|---|---|---|---|
| 1 | no frontmatter | `"# Runbook\nBody"` | `{ triggers: undefined, body: "# Runbook\nBody" }` |
| 2 | empty frontmatter throws | `"---\n---\n# Body"` | throws Zod error — `undefined` is not a valid frontmatter object |
| 2b | frontmatter with only `match` declared (no axes) | `"---\ntriggers:\n  match: any\n---\n# Body"` | `{ triggers: { match: "any" }, body: "# Body" }` (parses cleanly; `matchTriggers` will return false at match time) |
| 3 | severity only | `"---\ntriggers:\n  severity: [critical]\n---\n# Body"` | `{ triggers: { severity: ["critical"] }, body: "# Body" }` |
| 4 | all three axes + match | full frontmatter | all four fields parsed |
| 5 | frontmatter followed by paragraph | standard markdown body | triggers parsed, body is full markdown after closing delimiter |
| 6 | unknown trigger key (typo `metric:`) | `"---\ntriggers:\n  metric: [lag]\n---\n"` | throws Zod error with "unknown key" and field name |
| 7 | invalid severity value | `"---\ntriggers:\n  severity: [criticall]\n---\n"` | throws Zod enum error |
| 8 | invalid match value | `"---\ntriggers:\n  match: either\n---\n"` | throws Zod enum error |
| 9 | unknown top-level frontmatter key | `"---\ntags: [kafka]\n---\n"` | throws Zod strict error |
| 10 | missing closing `---` | content with no closing delimiter | throws with "unterminated frontmatter" or equivalent |
| 11 | malformed YAML | `"---\ntriggers: { severity: [critical\n---\n"` | throws from yaml package, filename attached by caller |

### Unit tests: per-axis matchers

File: `packages/agent/src/runbook-selector.test.ts` (extension of brainstorm A's test file)

12 tests across the three axis matchers:

| Function | Test | Input | Expected |
|---|---|---|---|
| `matchSeverityAxis` | severity in allowed list | `["critical","high"]`, `"critical"` | `true` |
| | severity not in list | `["critical"]`, `"low"` | `false` |
| | severity undefined | `["critical"]`, `undefined` | `false` |
| `matchServicesAxis` | substring match | `["kafka"]`, `[{name:"kafka-broker"}]` | `true` |
| | case-insensitive | `["KAFKA"]`, `[{name:"kafka-broker"}]` | `true` |
| | no match | `["kafka"]`, `[{name:"auth-api"}]` | `false` |
| | undefined services | `["kafka"]`, `undefined` | `false` |
| | empty services array | `["kafka"]`, `[]` | `false` |
| | multiple patterns, any match wins | `["kafka","consumer"]`, `[{name:"user-consumer"}]` | `true` |
| `matchMetricsAxis` | substring match | `["lag"]`, `[{name:"consumer_lag"}]` | `true` |
| | no match | `["lag"]`, `[{name:"latency"}]` | `false` |
| | undefined metrics | `["lag"]`, `undefined` | `false` |

### Unit tests: `matchTriggers` combinator

7 tests covering combinator semantics:

| # | Test | triggers | incident | match | Expected |
|---|---|---|---|---|---|
| 1 | `any`: severity matches, services declared but no match | `{severity:["critical"], services:["kafka"]}` | `{severity:"critical"}` | `"any"` | `true` |
| 2 | `any`: neither axis matches | `{severity:["critical"], services:["kafka"]}` | `{severity:"low"}` | `"any"` | `false` |
| 3 | `all`: both axes match | `{severity:["critical"], services:["kafka"]}` | `{severity:"critical", affectedServices:[{name:"kafka"}]}` | `"all"` | `true` |
| 4 | `all`: one axis fails | `{severity:["critical"], services:["kafka"]}` | `{severity:"critical", affectedServices:[{name:"auth"}]}` | `"all"` | `false` |
| 5 | `all`: one axis has no data | `{severity:["critical"], services:["kafka"]}` | `{severity:"critical"}` | `"all"` | `false` |
| 6 | no axes declared | `{}` | `{severity:"critical"}` | `"any"` | `false` |
| 7 | default combinator (match undefined) | `{severity:["critical"]}` | `{severity:"critical"}` | undefined | `true` |

### Unit tests: `narrowCatalogByTriggers`

7 tests covering the filter's three modes:

| # | Test | Catalog shape | Incident | Narrowed | Mode |
|---|---|---|---|---|---|
| 1 | noop: no runbook has triggers | 3 entries, all `triggers: undefined` | any | full catalog | `noop` |
| 2 | narrowed: one matches | 3 entries with triggers, one matches | matching incident | 1 matched entry | `narrowed` |
| 3 | narrowed: multiple match | 3 entries, two match | matching incident | 2 matched entries | `narrowed` |
| 4 | fallback: all have triggers, none match | 3 entries, none match | non-matching incident | full catalog | `fallback` |
| 5 | narrowed: mixed catalog, one matches | 1 with triggers (matches) + 2 without | matching incident | `[matched, trigger-less-1, trigger-less-2]` | `narrowed` |
| 6 | fallback: mixed catalog, trigger-declared doesn't match | 1 with triggers (doesn't match) + 2 without | non-matching incident | full catalog (all 3) | `fallback` |
| 7 | empty catalog (defensive) | `[]` | any | `[]` | `noop` |

Test 6 is the subtle one: when a trigger-declared runbook fails to match, the mixed catalog's trigger-less runbooks alone are NOT a "narrowed" match — the zero-match fallback fires and returns the full catalog. This matches the "fall through to full catalog when zero trigger-declared runbooks match" rule.

### Unit tests: validator `extractProseCitations` frontmatter skip

File: `packages/gitagent-bridge/src/runbook-validator.test.ts` (extension of brainstorm B's file)

2 new tests:

| Test | Input | Expected |
|---|---|---|
| runbook with frontmatter, prose cites tool | `"---\ntriggers:\n  severity: [high]\n---\n# Body\nUse \`kafka_list_topics\` here."` | 1 citation for `kafka_list_topics`, line number points to the line after the closing `---` |
| frontmatter contains snake_case identifier (red herring) | `"---\ntriggers:\n  services: [kafka_consumer_group]\n---\n# Body\n"` | 0 citations — frontmatter skipped, YAML identifier not mistaken for prose |

### Integration tests

File: `packages/agent/src/runbook-selector.test.ts`

Three end-to-end tests for `selectRunbooks` with the filter active:

1. **Triggers narrow the router's input set.** 5-entry catalog: 2 with triggers matching critical, 1 with triggers matching low, 2 without triggers. Call with `severity: "critical"`. Assert LLM is called with 4 runbooks (2 matching + 2 trigger-less), not the low-severity one. Assert `runbook.trigger_filter.mode === "narrowed"`.

2. **Zero-match fallback feeds full catalog to router.** Same 5-entry catalog. Call with `severity: "medium"` (no trigger-declared runbook matches). Assert LLM receives all 5 runbook names. Assert `runbook.trigger_filter.mode === "fallback"`.

3. **No-op when no runbook has triggers.** 3-entry catalog with no triggers. Call with any incident. Assert LLM receives all 3. Assert `runbook.trigger_filter.mode === "noop"`.

### Manual verification

After implementation, verify end-to-end:

1. Add minimal frontmatter to `kafka-consumer-lag.md`:
   ```yaml
   ---
   triggers:
     services: [kafka]
     metrics: [lag]
   ---
   ```
2. Run the existing brainstorm A integration test with a kafka-lag incident query.
3. Inspect the LangSmith trace for the `selectRunbooks` span.
4. Confirm `runbook.trigger_filter.mode === "narrowed"` and `runbook.trigger_filter.output_size` is 1 or 2.
5. Run a query that wouldn't match the frontmatter (e.g., "check Couchbase query latency").
6. Confirm `runbook.trigger_filter.mode === "fallback"`.
7. Revert the frontmatter change.

### What we're not testing

- Performance. String matching on 3-50 runbooks runs in microseconds.
- LLM behavior with narrowed vs full catalogs — brainstorm A's concern, not this spec's.
- Nested YAML documents within frontmatter — not a valid pattern.
- Non-runbook knowledge entries with frontmatter — they're never frontmatter-parsed.
- A synthetic 50-runbook catalog to stress-test narrowing — deferred until the real catalog grows.

## Rollout

1. Land this spec (commit it).
2. Run `superpowers:writing-plans` to produce an implementation plan.
3. Create Linear issue for implementation with the plan attached. Depends on SIO-640 and SIO-641 merging first.
4. Implement:
   - New `RunbookTriggersSchema` in `types.ts`
   - `parseRunbookFrontmatter()` helper in `manifest-loader.ts`
   - `KnowledgeEntry.triggers?` field
   - `RunbookCatalogEntry.triggers?` pass-through in `prompt-context.ts`
   - `matchTriggers()`, three per-axis matchers, `narrowCatalogByTriggers()` in `runbook-selector.ts`
   - `selectRunbooks` extension to call the filter before the router
   - `extractProseCitations` frontmatter skip in `runbook-validator.test.ts`
   - Unit tests (11 + 12 + 7 + 7 + 2 = 39)
   - 3 integration tests
5. Merge. No production runbooks are touched; the filter is a no-op until someone adds frontmatter.
6. Monitor LangSmith for `runbook.trigger_filter.mode` attributes. If `fallback` dominates after triggers are added, the grammar is too narrow and needs tuning.
7. Optional follow-up: add frontmatter to the three current runbooks in a small separate PR once the feature is proven. Not part of this spec's scope.

## Open Questions

None at spec time.

## Appendix: Alternatives Considered

**Replace brainstorm A's LLM router entirely with triggers.** Rejected. Triggers are deterministic but not expressive enough to capture every selection decision an LLM would make. Losing the LLM would regress selection quality on nuanced incidents. Brainstorm A's design has value that triggers complement, not replace.

**Augment the router with triggers as metadata (no pre-filter).** Rejected. Passes all runbooks to the LLM along with their trigger metadata, hoping the LLM uses it as a hint. Doesn't reduce the router's input set. Pays the cost of frontmatter without the benefit of narrowing.

**Store triggers in separate files (`foo.triggers.yaml` alongside `foo.md`).** Rejected. Introduces two files per runbook, easy to get out of sync, requires a new loader pass. Frontmatter in the same file is co-located and single-source-of-truth.

**Store triggers in a central `knowledge/index.yaml` runbook_triggers block.** Rejected. Same two-file sync problem, just with a single central file instead of one per runbook. Editing two files for every runbook change is friction.

**Match against raw user query text with regex.** Rejected per Question 2. Triggers match structured `NormalizedIncident` fields only. Regex against user query invites false positives and false negatives, and the normalize step already extracts the structured signals we care about.

**Match against entityExtractor output (ExtractedEntities + toolActions) instead of NormalizedIncident.** Rejected. Would require running triggers AFTER entityExtractor, which changes brainstorm A's pipeline position. Keeping the filter before entityExtractor preserves brainstorm A's design unchanged.

**Metric value thresholds (e.g., `metrics: [{name: "lag", gt: 10000}]`).** Rejected. Metric values in `NormalizedIncident` are `string`, not `number`. Parsing them correctly (units, scientific notation, nulls) is a rabbit hole. If a real need emerges, can be added as a new schema field without breaking existing runbooks.

**Negative matchers (`severity_exclude: [low]` or `not:` blocks).** Rejected. Positive matchers can express every case a negative matcher can, with less grammar complexity and fewer failure modes. An author who wants "everything except low" writes `severity: [critical, high, medium]`.

**Regex matching on services and metrics.** Rejected. Case-insensitive substring is enough for the patterns authors care about without inviting ReDoS concerns or regex-escape bugs.

**Temporal triggers (time-of-day, day-of-week).** Rejected for this spec. Could be added as a new axis later if a real use case emerges. Out of scope for the first pass.

**Cross-runbook logic ("this runbook applies unless X also matches").** Rejected. Each runbook's match decision is independent. Cross-runbook dependencies multiply failure modes and are nearly impossible to reason about as the catalog grows.

**Fail-loud on frontmatter parse errors vs warn-and-skip.** Rejected the warn-and-skip option. Silently skipping a broken trigger would make the filter inoperative for that runbook and nobody would notice until the catalog stopped narrowing. Loud failures are caught at `bun test` and load time. Consistent with brainstorms A and C.

**Lax Zod validation (no `.strict()`).** Rejected. Lax validation silently accepts typos (`metric` vs `metrics`, `critical` vs `criticall`), which makes the filter invisibly broken. `.strict()` catches every typo at load time. Correct default.

**Seed frontmatter on the three current runbooks as part of this spec.** Rejected. Premature. Adding triggers to existing runbooks is a separate ~15-line decision per runbook, doesn't need a new brainstorm, and is best done after the feature is proven on a synthetic integration test.
