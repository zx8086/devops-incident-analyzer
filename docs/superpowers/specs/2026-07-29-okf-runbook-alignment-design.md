# OKF Runbook Alignment — Design Spec

> **Ticket**: [SIO-1282](https://linear.app/siobytes/issue/SIO-1282) — Spike: adopt OKF for runbooks/playbooks (skills stay agentskills.io)
> **Date**: 2026-07-29 | **Repo state**: `main` @ `543554f9` (post-SIO-1285)
> **Status**: Spike deliverable — a design + go/no-go, NOT a migration
> **Spec source**: [OKF SPEC.md](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), Apache 2.0, **v0.2 confirmed live on 2026-07-29**

## 1. Summary and recommendation

**Recommendation: adopt OKF v0.2 for `agents/*/knowledge/**` runbooks and playbooks, in
two phases, starting with incident-analyzer.** `SKILL.md` stays on
[agentskills.io](https://agentskills.io/home) and is out of scope.

The blocking work is one schema widening in `packages/gitagent-bridge/src/types.ts`. It is
small, and it moves the loader *toward* OKF conformance rather than bolting a format on top
of a hostile parser. Everything else is authoring convention.

**Go/no-go per agent:**

| Agent | Verdict | Rationale |
|---|---|---|
| incident-analyzer | **GO — phase 1** | 10 runbooks, 8 already carry `triggers`. Per-file selection already reads frontmatter, so OKF lifecycle fields have somewhere to plug in immediately (§6, Q6). |
| elastic-iac | **GO — phase 2** | 6 runbooks, 0 with triggers. Its selector is per-*category* and reads no frontmatter at all today, so the payoff is real but needs the selector change in Q6 to land first. |
| `SKILL.md` (both) | **NO-GO** | Out of scope by decision. Stays agentskills.io. |

## 2. Context — why now

Two prerequisites landed on 2026-07-29 and changed the calculus:

- **SIO-1281** restored 16 orphaned playbook sub-procedures (loader-registration bug).
- **SIO-1285** ([PR #523](https://github.com/zx8086/devops-incident-analyzer/pull/523), `227c947f`)
  gave elastic-iac a per-intent knowledge selector, unregistered `_archive/` and
  `health-snapshots/`, and added `knowledge_selection` to the Knowledge Tree schema.

SIO-1285 inverted the premise of question 6 (§6). Before it, elastic-iac's knowledge was
always-on, so migrating it had no prompt-cost upside and the case rested on provenance
alone. Now **both agents are selection-gated**, by different keys, which makes them
comparable for the first time and raises a new question the earlier analysis could not:
*should OKF frontmatter feed selection?*

### Verified baseline (`543554f9`, measured not copied)

```
elastic-iac       knowledge 416,603   entries 41   assembled prompt 485,959
  playbook 110,237(11) · specs 79,482(4) · issues 73,487(8)
  cost-plans 67,457(6) · runbooks 60,077(6) · reference 25,863(6)

incident-analyzer runbooks 61,176(10) · systems-map 1,895(1) · slo-policies 1,450(1)
                  assembled prompt 78,671

runbooks/triggers  incident-analyzer 10 / 8 withTriggers
                   elastic-iac        6 / 0 withTriggers
```

On disk but **not loaded**: `health-snapshots/` (4), `_archive/index.md`,
`_archive/eu-b2b-ilm/` (2), `_INDEX.md`.

## 3. The blocker — proven, not assumed

`RunbookFrontmatterSchema` (`packages/gitagent-bridge/src/types.ts:248-252`) is `.strict()`
with `triggers` as its **only** key, and it is **required**:

```ts
export const RunbookFrontmatterSchema = z
	.object({
		triggers: RunbookTriggersSchema,
	})
	.strict();
```

Runbook parsing uses a **bare `.parse()`** — it throws rather than degrading
(`manifest-loader.ts:338`):

```ts
const validated = RunbookFrontmatterSchema.parse(parsed);   // throws on any unknown key
```

**Executed against OKF-shaped frontmatter on `543554f9`** (this is measurement, not
inference — two independent rejection modes):

```
{type:"Runbook", title:"x", triggers:{...}}  -> REJECTED
   unrecognized_keys: "type", "title"
{type:"Runbook"}                             -> REJECTED
   invalid_type: triggers expected object, received undefined
   + unrecognized_keys: "type"
```

OKF requires `type` on every non-reserved `.md`. **0 of our knowledge files carry one.** So
adding `type:` to any runbook today breaks agent load with a throw.

Contrast `parseSkillFrontmatter` (`manifest-loader.ts:348`), which `console.warn`s and
degrades, backed by `SkillFrontmatterSchema` — already `.passthrough()` (`types.ts:282`).
**That is the model to mirror.**

### The irony that settles the design question

OKF v0.2's conformance section requires the opposite of `.strict()`. Quoting the spec:

> "Consumers MUST NOT reject a bundle because of: Missing optional frontmatter fields.
> Unknown `type` values. Unknown additional frontmatter keys. Broken cross-links. Missing
> `index.md` files."

Our loader currently violates every clause of that sentence for runbooks. **Widening is not
a concession to OKF — it is the conformance requirement**, and it makes the loader more
robust independent of whether we adopt the format.

## 4. Proposed schema (validated by execution)

```ts
export const RunbookFrontmatterSchema = z
	.object({
		triggers: RunbookTriggersSchema.optional(),   // NOTE: currently REQUIRED
		type: z.string().optional(),
		title: z.string().optional(),
		description: z.string().optional(),
		resource: z.string().optional(),
		tags: z.array(z.string()).optional(),
		status: z.enum(["draft", "stable", "deprecated"]).optional(),
		stale_after: z.string().optional(),
		// provenance/trust families -- add when a consumer actually reads them:
		// sources[], usage_window, generated{by,at}, verified[{by,at}]
	})
	.passthrough();
```

**Validated against 5 cases (run, not reasoned):**

| Case | Result |
|---|---|
| existing runbook (`triggers` only) | **PASS** — no regression |
| OKF concept (`type`+`title`, no triggers) | **PASS** |
| OKF + lifecycle (`status`, `stale_after`) | **PASS** |
| unknown producer key | **PASS** — and *preserved* it (OKF requires preservation) |
| malformed `triggers` | **FAIL** — the throw-path survives |

That last row is the important one: widening does **not** blunt the guard against real
authoring errors. A malformed `triggers` block still fails loudly.

**The trust family, deliberately commented out above, was also exercised** — because §11
names `verified` specifically ("consumers MUST treat a bare `verified` mapping as a
one-element list"), and it would be easy to read the commented-out block as meaning those
shapes are unsupported. They are not; `.passthrough()` already carries them:

| Case | Result against the schema exactly as written above |
|---|---|
| bare `verified` mapping | **PASS** — carried as an unknown key |
| `verified` as a list | **PASS** |
| `generated: {by, at}` | **PASS** |
| bad `status` enum (`status: whatever`) | **FAIL** — the typed field still rejects |

So the schema is §11-conformant **as written**, with no further change. Promote `verified` /
`generated` / `sources` from comments to typed fields only when a consumer actually reads
them — typing them earlier trades §11 tolerance for validation nobody uses.

### Making `triggers` optional is safe — the open risk, resolved

The handover flagged this Medium: "making `triggers` optional silently disables runbook
selection." **It does not.** Verified:

- `narrowCatalogByTriggers` (`runbook-selector.ts:322-336`) partitions on
  `e.triggers !== undefined` and **keeps trigger-less runbooks in the narrowed set** —
  they opt out of filtering, not out of the catalog. Zero trigger-declared runbooks yields
  `mode: "noop"` and the full catalog passes through.
- `getRunbookCatalog` (`prompt-context.ts:227-235`) passes `k.triggers` through as
  `undefined` with no guard — exactly what the consumer expects.

elastic-iac (0 triggers) already runs entirely through the `noop` path today.

**Confirmed by running the selector, not only by reading it.** The case that matters is the
one neither agent is in today: the **mixed** catalog a partial migration necessarily
creates, where some runbooks have been converted and some have not.

| Catalog | `mode` | kept |
|---|---|---|
| all declare `triggers` (today, incident-analyzer) | `narrowed` | matching only |
| **mixed — some converted, some not** | `narrowed` | matching **+ every trigger-less entry** |
| none declare `triggers` (today, elastic-iac) | `noop` | all |
| triggers present, zero match | `fallback` | all |

The mixed row is the safety property the migration depends on: a runbook that has *not* yet
been converted is never silently dropped from the catalog while its neighbours are. That
makes a **file-by-file migration safe to land incrementally** — no need to convert a whole
category atomically.

### Do NOT relax `RunbookTriggersSchema`

`triggers` stays strictly typed when present. Widening applies to the *envelope*, not to
the field the selector depends on.

## 5. What OKF buys us

| OKF field | Problem in this repo today |
|---|---|
| `status: draft\|stable\|deprecated` | SIO-1017's promotion DRAFT banner is prose in a body; OKF makes it queryable |
| `verified: {by: human:x}` | The HIL learning lane's entire purpose is human review, with no machine-readable record of it |
| `sources[]`, `usage_count`, `usage_window` | `packages/agent/src/skill-outcome.ts` already tracks these in bespoke frontmatter |
| `stale_after` | No staleness signal today — hence `authoring-skills-and-runbooks.md:62` sitting wrong for months (SIO-1278) and `:32` wrong until SIO-1285 |
| `generated: {by: agent/model}` | Distinguishes hand-authored from LLM-crystallized content |

`playbooks/` is a **first-class OKF directory**, appearing in 3 of 8 official examples with
`incident-response.md` as a named concept — our layout is already idiomatic.

### What OKF does NOT solve — state this plainly

OKF addresses **distribution and portability between producers and consumers**. It would
**not** have prevented any of our three recent knowledge bugs:

1. **SIO-1281** (16 orphaned sub-procedures) — a loader-*registration* failure.
2. **The `_archive/`-is-loaded trap** — a category-declaration failure.
3. **SIO-1285's silent-strip hazard** — a Zod `z.object` behaviour (see Q5 risk).

Adopting OKF for its own sake would be cargo-culting. Adopt it for the trust/lifecycle
fields in §5, which we have concrete uses for.

## 6. The seven open questions — decided

**Q1. Reserved-filename collision (`index.md`). — DECIDED: use `_INDEX.md`.**
OKF wants `index.md` as a directory listing with no frontmatter except `okf_version`. We
have `index.yaml` (loader config) and `_INDEX.md` (human-only, never loaded, pinned by
`elastic-iac-load.test.ts:63`).

Any `index.md` placed in a **registered** category directory *would* be loaded — the loader
takes every `*.md` directly under a category path. The `_archive/index.md` instance that
made this expensive is gone (no longer a registered category since SIO-1285). Three options
— `_INDEX.md` naming, nesting one level down (`loadKnowledge` does not recurse,
`manifest-loader.ts:188`), or accepting the cost per selected intent.

**The third option was priced rather than left open.** Conformant listing files
(`- [title](file.md) - description` per entry) across elastic-iac's 6 registered categories:

```
reference    6 entries ->   465 B      specs        4 ->   463 B
issues       8         ->   554 B      cost-plans   6 ->   678 B
runbooks     6         ->   750 B      playbook    11 -> 1,087 B
TOTAL                     3,997 B
prompt 485,959 -> 489,956   (+0.82%)
```

A conformant bundle-root `knowledge/index.md` — the one place frontmatter is legal on a
listing, carrying `okf_version: 0.2` — costs **zero**: `knowledge/` is not a registered
category, so it is not prompt-loaded (the same reason `_INDEX.md` is not, verified the same
way).

**Decision: `_INDEX.md`.** It is a proven convention, already test-pinned, and needs no
loader change. Document it as a deliberate OKF deviation; OKF requires consumers to
tolerate a missing `index.md`, so this is conformant.

**Why the measurement does not overturn that.** +0.82% is affordable, so cost is *not* the
deciding argument — and the earlier framing of this risk as **High** (in both the ticket and
the handover) does not survive measurement. What remains is that `_INDEX.md` needs no loader
change and is already test-pinned, against `index.md`'s benefit of matching all eight
official examples verbatim. That is a judgement call about conformance-versus-inertia, not a
cost trade.

Recorded so a future reader does not re-open Q1 believing the cost is unknown or large. If
the migration later adopts `index.md` for strict conformance, **+0.82% is the price**, and
the bundle root is free either way.

**Q2. Does OKF `verified`/`sources` replace `skill-outcome.ts`'s frontmatter? — DECIDED: neither. They do not meet.**
The bespoke fields (`confidence` Laplace-smoothed, `usage_count`, `success_count`,
`failure_count`, `learned_from`, `learned_at`) live on **`SKILL.md`**, which is out of OKF
scope by decision. Two formats covering two different file classes. No conflict, no
migration. If a runbook ever needs usage stats, use OKF `sources[].usage_count` there
rather than importing the skill fields.

**Q3. Bundle boundaries. — DECIDED: one bundle per agent `knowledge/`.**
Per-agent keeps bundle-relative links working within an agent and matches the loader's
existing unit of organisation. A repo-wide bundle would imply cross-agent links the loader
cannot resolve.

**Loader constraint, load-bearing:** `loadKnowledge` does **not** recurse
(`manifest-loader.ts:188`), so any nested structure OKF encourages is invisible. This is
deliberate — it is how `_archive/eu-b2b-ilm/` stays out of the prompt — so the bundle must
stay flat within each category.

**Q4. `triggers:` is non-OKF. — DECIDED: keep as a producer extension.**
OKF explicitly permits extra keys and requires consumers to preserve them. `triggers` is
our SIO-640 selection mechanism and stays strictly typed. Document it in the bundle's
`_INDEX.md` as a producer extension. Note 8/10 incident-analyzer and 0/6 elastic-iac
runbooks use it.

**Q5. Does `type:` duplicate the category system? — DECIDED: genuine cross-cut, not a duplicate.**
`index.yaml` categories classify by *directory*, and since SIO-1285 they are **load-bearing
for prompt cost**, not just organisation — `knowledge_selection.by_intent`
(`types.ts:216-222`) is a second consumer of those names. `type:` classifies by *kind*
independent of location, so a `Runbook` can live in `runbooks/` or `playbook/` and still be
selectable by kind. Keep both.

> **Hazard to carry into implementation.** A plain `z.object` **silently strips** unknown
> top-level keys with `success: true`. SIO-1285's `knowledge_selection` block would have
> parsed "successfully" and been discarded, with the feature never turning on and no error
> — the schema comment at `types.ts:231-233` documents exactly this. **Any new `index.yaml`
> key must ship with its schema field AND a probe asserting it actually loaded.**

**Q6. Which agents? — DECIDED: incident-analyzer first, elastic-iac second. The premise inverted.**

The pre-SIO-1285 reasoning was "elastic-iac knowledge is always-on, so migrating it has no
prompt-cost upside." **That premise is dead.** Both agents are now selection-gated:

- **incident-analyzer** — per-**file**, keyed on incident `triggers`, max 3 (SIO-640)
- **elastic-iac** — per-**category**, keyed on classifier `intent` (SIO-1285)

**The new question this enables: should OKF frontmatter feed selection?** `status:
deprecated` or a past `stale_after` are natural "do not put this in the prompt" signals.
Both selectors ignore file-level metadata today — elastic-iac's does not read frontmatter
at all. This is the strongest argument for migration and it did not exist before SIO-1285.

**Proposed follow-up (not this ticket):** teach `narrowCatalogByTriggers` to drop entries
whose `status` is `deprecated` or whose `stale_after` has passed. Cheap, deterministic, no
LLM call. incident-analyzer first because its selector already reads frontmatter.

**Q7. Validator interaction. — DECIDED: keep as a body convention for now.**
The tool-citation validator requires a `## All Tools Used Are Read-Only` section whose first
non-empty line is a comma-separated tool list (`runbook-validator.test.ts`). Promoting it to
a frontmatter `tools:` extension would be more machine-checkable and would fix the SIO-1278
class of bug (explanatory prose in that section split on commas into bogus tool names).

**But it is orthogonal to OKF** and would touch every runbook plus the validator. Keep the
body convention in this migration; file the frontmatter promotion as its own ticket so the
two changes stay independently revertable.

## 7. Worked example

Conversion candidate: `agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md`
(newest, cleanest, added in PR #517).

**Before** (loads today; would break the moment `type:` is added):
```yaml
---
triggers:
  metrics: [mcp, tool_error, tool_not_found, datasource_unavailable, empty_results]
  match: any
---
# MCP Tool Audit (datasource-agnostic)
```

**After** (OKF-conformant; requires the §4 widening):
```yaml
---
type: Runbook
title: MCP Tool Audit (datasource-agnostic)
description: Audit an MCP server end-to-end -- live-test every tool, separate real bugs
  from environment states, verify agent-side reachability, check error-envelope conformance.
tags: [mcp, audit, tooling]
status: stable
triggers:                      # producer extension, preserved per OKF (Q4)
  metrics: [mcp, tool_error, tool_not_found, datasource_unavailable, empty_results]
  match: any
verified:
  by: human:simon
  at: 2026-07-29T00:00:00Z
---
# MCP Tool Audit (datasource-agnostic)
```

`title`/`description` duplicate what `parseRunbookCatalogEntry` derives from the first H1
and first paragraph (200-char cap, `prompt-context.ts:261`). **Follow-up opportunity**: once
`title`/`description` are present, the catalog projection could read them directly instead
of parsing prose — more reliable, and it makes the 200-char summary authored rather than
truncated.

## 8. Migration sizing

| Agent | Files to touch | Notes |
|---|---|---|
| incident-analyzer | 10 runbooks + 1 systems-map + 1 slo-policies | 8 already have frontmatter; `type:`+`title:` is a 2-line addition each |
| elastic-iac | 6 runbooks | none have frontmatter — a full block each |
| elastic-iac (other categories) | 35 entries | `playbook`/`specs`/`issues`/`cost-plans`/`reference` have no frontmatter at all; phase 3 at the earliest |

**Phasing:**

1. **Phase 0 (blocking)** — widen `RunbookFrontmatterSchema` per §4. Ship alone, prove every
   existing runbook still loads with unchanged counts. No content changes.
2. **Phase 1** — convert incident-analyzer's 10 runbooks. Selector already reads frontmatter.
3. **Phase 2** — convert elastic-iac's 6 runbooks, plus the Q6 lifecycle-aware selection.
4. **Phase 3 (optional)** — the other 35 elastic-iac entries, only if lifecycle metadata
   earns its keep in phases 1-2.

Phase 0 is a prerequisite for everything and is independently valuable: it makes the loader
tolerant in the way OKF requires and the skill loader already is.

## 9. Verification

```bash
bun run typecheck && bun run lint && bun test packages/gitagent-bridge/src/
```

Every runbook must still load, with **exact** counts (not "smaller"):

```bash
bun -e 'import{loadAgent}from"./packages/gitagent-bridge/src/index.ts";for(const d of ["agents/incident-analyzer","agents/elastic-iac"]){const a=loadAgent(d);const r=a.knowledge.filter(k=>k.category==="runbooks");console.log(d,"runbooks:",r.length,"withTriggers:",r.filter(k=>k.triggers).length);}'
```
Baseline: incident-analyzer **10 / withTriggers 8**; elastic-iac **6 / withTriggers 0**.

```bash
bun -e 'import{loadAgent,buildSystemPrompt}from"./packages/gitagent-bridge/src/index.ts";const a=loadAgent("agents/elastic-iac");const by={};let t=0;for(const k of a.knowledge){by[k.category]=(by[k.category]||0)+k.content.length;t+=k.content.length;}console.log(JSON.stringify(by,null,1));console.log("knowledge",t,"entries",a.knowledge.length,"prompt",buildSystemPrompt(a).length);'
```
Baseline: `knowledge 416603 entries 41 prompt 485959`.

The throw-path must survive — a malformed runbook still fails loudly:
```bash
bun test packages/gitagent-bridge/src/runbook-validator.test.ts
```

> **Worktree gotcha (hit while writing this).** `bun -e` from a worktree *root* fails with
> `Cannot find package 'yaml'`/`'zod'`. Run from a package directory that has the dependency
> links (`cd packages/gitagent-bridge && bun -e ...`), and note `cd` persists between shell
> calls in some harnesses — prefer absolute paths.

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Following stale `file:line` citations | **High** | SIO-1285 shifted them; this spec's citations are verified on `543554f9` |
| Widening hides real authoring errors | Medium | `.passthrough()` the envelope, keep `triggers` strictly typed. Validated: malformed triggers still FAIL |
| Optional `triggers` disables selection | **Resolved — not a risk** | `narrowCatalogByTriggers` `noop` mode verified to keep trigger-less runbooks |
| A new `index.yaml` key silently stripped | **Certain if the field is omitted** | Plain `z.object` discards unknown keys with `success: true`. Add the field AND a load probe |
| An OKF `index.md` in a registered category gets loaded | Low (was High) | Q1: use `_INDEX.md`; `_archive` is no longer registered. **Measured** if adopted anyway: +3,997 B / +0.82%, bundle root free |
| OKF v0.2 -> v0.3 churn mid-migration | Low | Spec is designed for backward-compatible growth; minor bumps add optional fields. Pin `okf_version` at bundle root |
| Scope creep into `SKILL.md` | Medium | Out of scope by explicit decision |
| Treating OKF as a fix for the SIO-1281 bug class | Medium | It is not — §5 says so plainly |
| `bun run test` exits 133 with 0 failures | Medium | Pre-existing flaky lbug/Kuzu teardown segfault in `knowledge-graph`, unrelated |

## 11. Out of scope

- **Migrating `SKILL.md`** — stays agentskills.io by decision.
- **The KG and agent-memory wiki** — verified separate: nothing in `packages/knowledge-graph/`
  or `packages/shared/src/agent-memory.ts` *reads* `agents/*/knowledge/` at runtime. The
  `wiki-ingest` skill treats those paths as raw *source* it compiles **from**.
  One latent coupling worth knowing: `packages/knowledge-graph/src/migrate.ts:10-14` hardcodes
  `SEED_DEPENDENCIES` and cites `systems-map/service-dependencies.md` as the source **in a
  comment only** — no file read, so a migration cannot break it mechanically, but the seed
  data will silently drift from the doc it claims to derive from.
- **Content restoration** — SIO-1281, shipped.
- **Prompt-cost work** — SIO-1285, shipped. Build on it; do not redo it.
- **The migration itself** — follow-up tickets per §8 once this spec is approved.
- **Promoting the tool-citation list to frontmatter** — Q7, its own ticket.

## 12. Appendix — OKF v0.2 reserved fields (confirmed live 2026-07-29)

**Required**: `type` (producer-defined, not centrally registered — `type: Runbook` is legal
and idiomatic).
**Recommended**: `title`, `description`, `resource`, `tags`.
**Provenance**: `sources[]` (each needs `resource`; optional `id`, `title`, `author`,
`usage_count`, `last_modified`), `usage_window: {from, to}`.
**Trust**: `generated: {by, at}`, `verified: [{by, at}]` — a bare mapping MUST be treated as
a one-element list.
**Lifecycle**: `status: draft|stable|deprecated` (absent = `stable`), `stale_after: YYYY-MM-DD`.
**Computation** (Attested Computation type only — *not in the earlier research, noted for
completeness; we have no use for it today*): `runtime` (required for that type),
`parameters[]`, `computation`, `executor{resource,receipt}`, `attester{resource}`.

**Reserved filenames**: `index.md` (directory listing, `okf_version` frontmatter only),
`log.md` (chronological history, newest first, ISO-8601 date headings). All other `.md` are
concept documents.

**Actor convention**: `<producer>/<version>` for tools (`reference_agent/gemini-2.5-pro`),
`human:<id>` for people, `process:<id>` for automation. Producers MUST use `human:` for
hand-authored or human-confirmed content — consumers key trust classification on that prefix.

## 13. Related code references

- `packages/gitagent-bridge/src/types.ts:248-252` — `RunbookFrontmatterSchema`, the blocker
- `packages/gitagent-bridge/src/types.ts:282` — `SkillFrontmatterSchema`, already `.passthrough()`; the model
- `packages/gitagent-bridge/src/types.ts:216-234` — `KnowledgeSelectionConfigSchema` + `KnowledgeIndexSchema`; the silent-strip hazard, documented in-comment
- `packages/gitagent-bridge/src/manifest-loader.ts:188` — non-recursive category scan
- `packages/gitagent-bridge/src/manifest-loader.ts:338` — the bare `.parse()` that throws
- `packages/gitagent-bridge/src/manifest-loader.ts:348` — lenient `parseSkillFrontmatter`
- `packages/gitagent-bridge/src/manifest-loader.ts:245-269` — SIO-1285's load-time validation of `knowledge_selection` category names; the precedent for validating new config
- `packages/agent/src/iac/knowledge-selector.ts` — the SIO-1285 selector; where OKF lifecycle fields plug into selection (Q6)
- `packages/agent/src/prompt-context.ts:227-235` — `getRunbookCatalog`, reads `triggers` with no guard
- `packages/agent/src/prompt-context.ts:261` — the 200-char summary cap (Q7 / §7 follow-up)
- `packages/agent/src/runbook-selector.ts:322-336` — `narrowCatalogByTriggers`, the `noop` mode
- `agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md` — the conversion candidate
- `agents/elastic-iac/knowledge/index.yaml` — Knowledge Tree, now carrying `knowledge_selection`
