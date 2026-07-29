# OKF runbook alignment — design spec (SIO-1282)

- **Date**: 2026-07-29
- **Ticket**: [SIO-1282](https://linear.app/siobytes/issue/SIO-1282) — Spike: adopt OKF for runbooks/playbooks (skills stay agentskills.io)
- **Repo state**: `main` @ `543554f9`
- **Status**: spike deliverable. **Recommendation: GO for incident-analyzer, GO for elastic-iac, schema-first, content second.**
- **Handover**: `experiments/HANDOFF-2026-07-29-SIO-1282-okf-spike-post-1285.md`

## TL;DR

Adopt **OKF v0.2** for `agents/*/knowledge/**`. `SKILL.md` stays [agentskills.io](https://agentskills.io/home) — out of scope.

Three things were measured rather than assumed, and two of them overturn the risk assessment the ticket was written on:

1. **The blocker is real and reproducible.** Adding OKF's required `type:` to a runbook today **throws** at agent load. Reproduced live; error names the unrecognized keys.
2. **The `index.md` collision is not a real cost.** Conformant per-directory `index.md` files add **3,997 bytes / +0.82%** to elastic-iac's prompt — not the "N files on a 125k-token prompt" risk rated *High*. Question 1 largely dissolves.
3. **Making `triggers` optional is safe by construction.** `narrowCatalogByTriggers` already handles absent triggers in three places, and a trigger-less runbook is *always kept*. Verified across four scenarios including the mixed state a partial migration creates.

Migration is **48 files** total (41 elastic-iac + 12 incident-analyzer, minus overlap), but the schema change is the only thing that must land before any content moves.

## 1. What OKF v0.2 actually specifies

Fetched from [SPEC.md](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) on 2026-07-29, not from press coverage (which describes v0.1).

| Family | Fields |
|---|---|
| **Required** | `type` (short string, producer-defined, not centrally registered) |
| **Recommended** | `title`, `description`, `resource`, `tags` |
| **Provenance** | `sources[]` (`resource` required; `id`, `title`, `author`, `usage_count`, `last_modified`), `usage_window` |
| **Trust** | `generated: {by, at}`, `verified: {by, at}` |
| **Lifecycle** | `status: draft\|stable\|deprecated`, `stale_after: YYYY-MM-DD` |
| **Attested computation** | `runtime`, `parameters`, `computation`, `executor`, `attester` — not relevant to us |

**Reserved filenames.** `index.md` = directory listing; **MAY carry frontmatter only at bundle root**, with an optional `okf_version` key; no frontmatter elsewhere. `log.md` = chronological history, no frontmatter. Every other `.md` is a concept document requiring frontmatter.

**Conformance (§11) — consumers MUST NOT reject a bundle for**: missing optional fields, unknown `type` values, unknown additional keys, broken cross-links, missing `index.md`. Consumers **MUST** treat a bare `verified` mapping as a one-element list, and **MUST NOT** reject a concept for a missing optional family.

**Actors.** `<producer>/<version>` for tools, `human:<id>` for people, `process:<id>` for automation. Trust classification keys off the `human:` prefix, so producers **MUST** use it for hand-authored or human-confirmed content.

**Extensions.** Producers MAY add any keys. Consumers SHOULD preserve them on round-trip and MUST NOT reject documents carrying them.

**Structure.** "A bundle is a directory tree of markdown files. The directory structure is independent of the domain." Bundles may be git repos, archives, or **subdirectories within larger repos**.

`playbooks/` is a first-class directory in 3 of 8 official examples (`saas-app`, `company-knowledge`, `ai-agent-context`), with `incident-response.md` as a named concept. **`index.md` appears at every directory level in all eight examples**, not just the bundle root.

## 2. The blocker — verified, not assumed

`packages/gitagent-bridge/src/types.ts:248-252`:
```ts
export const RunbookFrontmatterSchema = z
	.object({
		triggers: RunbookTriggersSchema,
	})
	.strict();
```

`triggers` is the only key and is required; `RunbookTriggersSchema` (`:237-245`) is `.strict()` too. Runbook parsing **throws** — `manifest-loader.ts:338` is a bare `.parse()`. Contrast `parseSkillFrontmatter` (`:348`), which warns and degrades.

**Reproduced live.** Adding `type: Runbook`, `title:`, `status:` to `agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md` and calling `loadAgent`:

```
Failed to parse runbook frontmatter in agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md: [
  ... unrecognized keys: ["type", "title", "status"] ...
```

**0 of the 48 knowledge files carry a `type:` field today.** So OKF conformance is impossible until the schema widens. File restored after the probe.

The irony to record: OKF's own conformance rules require consumers to *tolerate* unknown keys — the exact opposite of `.strict()`. **Widening moves toward the spec, not away from it.**

## 3. The 7 open questions — decisions

### Q1. Reserved-filename collision — **DECIDED: adopt `index.md`, accept the cost**

Prior concern: OKF wants `index.md` per directory; our loader loads every `*.md` directly under a registered category, so each would enter the prompt.

**Measured.** Realistic listing files (`- [title](file.md) - description` per entry) across elastic-iac's 6 registered categories:

```
reference    6 entries ->   465 B
issues       8         ->   554 B
runbooks     6         ->   750 B
specs        4         ->   463 B
cost-plans   6         ->   678 B
playbook    11         -> 1,087 B
TOTAL                     3,997 B
prompt 485,959 -> 489,956  (+0.82%)
```

**+0.82% is not a reason to deviate from the spec.** Adopt `index.md` at every level, as all eight official examples do. The risk rated *High* in the ticket and the handover was not measured; it does not survive measurement.

Two structural notes:
- `knowledge/index.yaml` (loader config) and `index.md` (OKF listing) **do not collide** — different extensions, different consumers. Keep both. Generating `index.md` from `index.yaml` is possible but adds a build step for ~4 KB of prose; author them by hand.
- `_INDEX.md` becomes redundant once per-directory `index.md` exists. Keep it for now (it is human-only and never loaded — pinned by `elastic-iac-load.test.ts:63`); retire it in the migration ticket.

**Bundle root.** `agents/<agent>/knowledge/index.md` carries `okf_version: 0.2` — the one place frontmatter is legal on a listing file. It sits at the `knowledge/` root, which is **not** a registered category, so it is *not* prompt-loaded. Zero cost.

### Q2. Does OKF `verified`/`sources` replace `skill-outcome.ts`'s frontmatter? — **DECIDED: no conflict, they cover different files**

`skill-outcome.ts`'s fields (`confidence` Laplace-smoothed, `usage_count`, `success_count`, `failure_count`, `learned_from`, `learned_at`) live on **`SKILL.md`**, which is explicitly out of OKF scope. The apparent overlap with `sources[].usage_count` and `verified` is two formats legitimately covering two file populations.

No migration, no dual-maintenance. Record the boundary explicitly so a future reader does not "harmonise" them.

### Q3. Bundle boundaries — **DECIDED: one bundle per agent**

`agents/<agent>/knowledge/` is one OKF bundle. The spec explicitly permits bundles as "subdirectories within larger repos."

Rationale: the two agents' knowledge bases are independently loaded, independently selected, and share no cross-links. A repo-wide bundle would imply cross-agent bundle-relative links that nothing needs and the loader could not follow.

**Loader constraint to record**: `loadKnowledge` does not recurse (`manifest-loader.ts:188` reads only `*.md` directly under a category path). Any nested structure OKF encourages is invisible to the loader. That is load-bearing, not incidental — it is how `_archive/eu-b2b-ilm/` stays out of the prompt.

### Q4. `triggers:` is non-OKF — **DECIDED: keep as a producer extension**

OKF permits extra keys and requires consumers to preserve them. `triggers` stays typed and strict inside the widened schema. Document it in the bundle-root `index.md` as a producer extension.

Counts: incident-analyzer **8 of 10** runbooks use it; elastic-iac **0 of 6**.

### Q5. Does `type:` duplicate the category system? — **DECIDED: a genuine cross-cut, not a duplicate**

Directory categories are now **load-bearing for prompt cost**, not just organisation: SIO-1285's `knowledge_selection.by_intent` keys on category names (`types.ts:216`). Categories answer "when is this loaded?"; `type:` answers "what kind of thing is this?".

They diverge usefully. `knowledge/playbook/` holds 11 files that are a mix of procedures and reference chapters — one category, two `type:` values. Recommended vocabulary: `Runbook`, `Playbook Section`, `Reference`, `Issue Register`, `Change Spec`, `Cost Plan`.

### Q6. Which agents? — **DECIDED: both, and the old reasoning is obsolete**

The ticket says elastic-iac "has no prompt-cost upside; the benefit is purely provenance/trust." **That premise died with SIO-1285.** Both agents are now selection-gated, by different keys:

| Agent | Selection | Key | Granularity |
|---|---|---|---|
| incident-analyzer | `selectRunbooks` (SIO-640) | incident `triggers` | per-file, max 3 |
| elastic-iac | `selectIacKnowledge` (SIO-1285) | classifier `intent` | per-category |

That makes them comparable for the first time, and raises the strongest argument for migrating elastic-iac: **OKF lifecycle fields are natural selection inputs.** `status: deprecated` and a past `stale_after` both mean "do not put this in the prompt", and *neither* selector reads file-level metadata today — elastic-iac's does not look at frontmatter at all.

This is a follow-up, not this spec's scope, but it is the reason the answer is "both" rather than "incident-analyzer first".

### Q7. Validator interaction — **DECIDED: keep the body convention; do not promote to frontmatter yet**

New finding: **the validator is test-only.** `runbook-validator.test.ts` has no corresponding `runbook-validator.ts`, no non-test source imports it, and CI exercises it only through `bun run test`. It is not a load-time gate.

So the choice is cheaper than the ticket assumed, and the conservative answer wins: the `## All Tools Used Are Read-Only` tail section stays a body convention. A `tools:` frontmatter extension would be more machine-checkable, but it duplicates information the body already carries and would need the validator rewritten to read frontmatter. Revisit if the validator is ever promoted to a real load-time or CI gate.

Record the SIO-1278 gotcha: that section's first non-empty line is parsed as a **comma-separated list**, so explanatory prose there splits into bogus tool names.

## 4. Proposed schema

```ts
// packages/gitagent-bridge/src/types.ts
const OkfActor = z.string();                       // "<producer>/<version>" | "human:<id>" | "process:<id>"
const OkfVerification = z.object({ by: OkfActor, at: z.string() });

export const RunbookFrontmatterSchema = z
	.object({
		// Producer extension (SIO-640 selectRunbooks). Kept strictly typed.
		// NOTE: was REQUIRED before SIO-1282; optional is a deliberate behaviour change.
		triggers: RunbookTriggersSchema.optional(),
		// OKF v0.2 reserved
		type: z.string().optional(),               // required BY OKF, optional here during migration
		title: z.string().optional(),
		description: z.string().optional(),
		resource: z.string().optional(),
		tags: z.array(z.string()).optional(),
		status: z.enum(["draft", "stable", "deprecated"]).optional(),
		stale_after: z.string().optional(),
		generated: z.object({ by: OkfActor, at: z.string() }).optional(),
		// Spec §11: a bare mapping MUST be treated as a one-element list.
		verified: z.union([OkfVerification, z.array(OkfVerification)]).optional(),
	})
	.passthrough();                                 // §11: MUST NOT reject unknown keys
```

**Prototyped and tested — 8/8 cases behaved as intended:**

| Case | Result |
|---|---|
| existing `triggers`-only file | accept (no regression) |
| OKF minimal (`type` only) | accept |
| `type` + `triggers` coexisting | accept |
| bare `verified` mapping | accept |
| `verified` as list | accept |
| unknown producer key | accept (§11 compliance) |
| bad `status` enum | **reject** |
| malformed `triggers` | **reject** (loud-failure path survives) |

`type` is `.optional()` here even though OKF requires it, so a partial migration cannot break the load. Tighten to required only once every file is converted — and note that tightening reintroduces the throw, so it belongs at the end of the migration, not the start.

### The `triggers`-optional safety question — resolved

The handover flagged that `getRunbookCatalog` (`prompt-context.ts:227`) reads `triggers: k.triggers` at `:233` with no guard. It does — but the consumer downstream is total. `narrowCatalogByTriggers` (`runbook-selector.ts:322-345`) handles absence in three places: a `noop` early-return when no entry has triggers, a `withoutTriggers` partition, and a final merge that **always** appends trigger-less entries.

**Simulated live across four scenarios:**

| Scenario | mode | kept |
|---|---|---|
| all have triggers (today) | `narrowed` | matching only |
| **mixed** (partial migration) | `narrowed` | matching **+ trigger-less** |
| none have triggers (elastic-iac shape) | `noop` | all |
| triggers present, zero match | `fallback` | all |

A trigger-less runbook is never silently dropped. **Making `triggers` optional is safe.**

## 5. Worked example

`agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md` — before:

```yaml
---
triggers:
  metrics: [mcp, tool_error, tool_not_found, datasource_unavailable, empty_results]
  match: any
---
# MCP Tool Audit (datasource-agnostic)
```

After (OKF-conformant; `triggers` preserved as a producer extension):

```yaml
---
type: Runbook
title: MCP Tool Audit
description: Datasource-agnostic audit of MCP tool availability and error modes.
status: stable
tags: [mcp, tooling, diagnostics]
generated:
  by: human:simon
  at: 2026-07-28
verified:
  by: human:simon
  at: 2026-07-28
triggers:
  metrics: [mcp, tool_error, tool_not_found, datasource_unavailable, empty_results]
  match: any
---
# MCP Tool Audit (datasource-agnostic)
```

Loads under the proposed schema; **throws** under the current one. Body unchanged — conversion is purely additive frontmatter.

## 6. Migration sizing

| Agent | Category | Files |
|---|---|---|
| **elastic-iac** | playbook | 11 |
| | issues | 8 |
| | cost-plans | 6 |
| | reference | 6 |
| | runbooks | 6 |
| | specs | 4 |
| | *(unloaded: health-snapshots 4, `_archive` 1+2)* | — |
| | **loaded subtotal** | **41** |
| **incident-analyzer** | runbooks | 10 |
| | systems-map | 1 |
| | slo-policies | 1 |
| | **subtotal** | **12** |
| | **TOTAL to convert** | **53** (41 + 12) |

Plus 9 new `index.md` files (6 + 3 categories) and 2 bundle-root `index.md`.

**Sequencing.** Schema first, in its own PR, with the existing test suite proving no regression. Content second, per agent, per category — each category is independently revertable. Tighten `type` to required last.

## 7. What OKF does NOT solve

State this plainly in any follow-up, because the format is easy to over-sell:

- **The SIO-1281 bug was a loader-registration failure.** 16 files were orphaned because nothing registered them. OKF frontmatter would not have prevented it — the files would have been perfectly conformant and still unloaded.
- **The `_archive`-is-loaded trap** (`reference_archive_category_is_loaded_nest_to_exclude`) was a category-config mistake. OKF has no opinion on which directories a consumer loads.
- **SIO-1285's silent-strip trap**: `KnowledgeIndexSchema` is a plain `z.object`, so an unknown top-level key parses `success: true` and is discarded. Any new `index.yaml` key needs its schema field, or the config is a no-op with no error. OKF does not help here either.

OKF addresses **distribution, portability, provenance and lifecycle** between producers and consumers. Every bug this repo has actually hit in this area was a *loader* bug. Adopt it for the trust/lifecycle metadata, not as a correctness mechanism.

## 8. Recommendation

**GO, schema-first, both agents.**

1. **PR 1 — schema only.** Widen `RunbookFrontmatterSchema` as above. No content changes. Existing suite proves no regression; add cases for the 8 shapes in §4.
2. **PR 2 — incident-analyzer content.** 12 files + 3 `index.md` + bundle root. Smallest surface, and the agent whose selector already reads frontmatter.
3. **PR 3 — elastic-iac content.** 41 files + 6 `index.md` + bundle root.
4. **PR 4 (follow-up ticket) — lifecycle-aware selection.** Feed `status: deprecated` / `stale_after` into both selectors. This is where OKF stops being metadata and starts paying for itself.
5. **Last — tighten `type` to required**, once every file carries it.

## Verification

```bash
bun run typecheck && bun run lint && bun test packages/gitagent-bridge/src/
```

Every runbook must still load, with the trigger counts unchanged:
```bash
bun -e 'import{loadAgent}from"./packages/gitagent-bridge/src/index.ts";for(const d of ["agents/incident-analyzer","agents/elastic-iac"]){const a=loadAgent(d);const r=a.knowledge.filter(k=>k.category==="runbooks");console.log(d,"runbooks:",r.length,"withTriggers:",r.filter(k=>k.triggers).length);}'
```
Baseline on `543554f9`: incident-analyzer **10 / withTriggers 8**; elastic-iac **6 / withTriggers 0**.

Full knowledge probe — assert the EXACT entry count, not "smaller" (a malformed `index.yaml` silently empties the knowledge base):
```bash
bun -e 'import{loadAgent,buildSystemPrompt}from"./packages/gitagent-bridge/src/index.ts";const a=loadAgent("agents/elastic-iac");console.log("entries",a.knowledge.length,"prompt",buildSystemPrompt(a).length);'
```
Baseline: `entries 41 prompt 485959`. After adding `index.md` files, expect **entries 47**, prompt ≈ **489,956**.

The throw-path must survive — a malformed runbook still fails loudly:
```bash
bun test packages/gitagent-bridge/src/runbook-validator.test.ts
```

**Worktree caveat**: a freshly created `git worktree` has no dependency links (`bun -e` fails on `yaml`), and `/tmp` is outside the repo tree entirely. Measure from a prepared worktree; confirm with `git diff --stat origin/main -- <paths>`.

## Related code references

- `packages/gitagent-bridge/src/types.ts:248-252` — the blocker
- `packages/gitagent-bridge/src/types.ts:282` — `SkillFrontmatterSchema`, already `.passthrough()`; the model
- `packages/gitagent-bridge/src/types.ts:216-234` — `KnowledgeSelectionConfigSchema` + `KnowledgeIndexSchema`; the silent-strip hazard
- `packages/gitagent-bridge/src/manifest-loader.ts:188` — non-recursive category scan
- `packages/gitagent-bridge/src/manifest-loader.ts:338` — the bare `.parse()` that throws
- `packages/gitagent-bridge/src/manifest-loader.ts:348` — lenient `parseSkillFrontmatter`
- `packages/gitagent-bridge/src/manifest-loader.ts:245-269` — SIO-1285 load-time config validation; precedent for validating new config
- `packages/agent/src/prompt-context.ts:227-235` — `getRunbookCatalog`
- `packages/agent/src/runbook-selector.ts:322-345` — `narrowCatalogByTriggers`, the three absence paths
- `packages/agent/src/iac/knowledge-selector.ts` — SIO-1285 selector; where lifecycle fields would plug in
- `packages/gitagent-bridge/src/elastic-iac-load.test.ts:63` — pins `_INDEX.md` as not-loaded

## Memory references

`project_two_format_split_skills_agentskills_runbooks_okf`, `reference_sio1285_iac_knowledge_selector`, `reference_archive_category_is_loaded_nest_to_exclude`, `reference_runbook_tail_section_is_parsed_as_csv`, `reference_skill_promotion_and_confidence`, `reference_hil_learning_lane_sio1126`, `reference_sio1228_skill_tool_binding`
