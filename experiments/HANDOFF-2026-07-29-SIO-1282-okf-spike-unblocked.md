# HANDOFF — SIO-1282: OKF runbook alignment spike (UNBLOCKED)

- **Date**: 2026-07-29
- **Ticket**: [SIO-1282](https://linear.app/siobytes/issue/SIO-1282) — Spike: adopt OKF for runbooks/playbooks (skills stay agentskills.io)
- **Project**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- **Blocker CLEARED**: [SIO-1281](https://linear.app/siobytes/issue/SIO-1281) merged as [PR #519](https://github.com/zx8086/devops-incident-analyzer/pull/519) (`f1d54eb3`). This spike may now start.
- **Repo state**: `main` @ `9c001236`
- **Suggested branch**: `sio-1282-okf-alignment-spike`
- **Deliverable**: a design spec, NOT a migration — `docs/superpowers/specs/2026-07-XX-okf-runbook-alignment-design.md`
- **Supersedes**: `experiments/HANDOFF-2026-07-29-SIO-1282-okf-runbook-alignment-spike.md` (written pre-merge at `5b3c796a`; still accurate on the spec research, stale on repo state)

## TL;DR

Two-format split, decided by the user on 2026-07-29: `SKILL.md` stays [agentskills.io](https://agentskills.io/home); `agents/*/knowledge/**` runbooks and playbooks move to **OKF v0.2**. This ticket produces a **spec with a go/no-go per agent**, not a migration.

There is one hard blocker to solve on paper first: `RunbookFrontmatterSchema` is `.strict()` with `triggers` as its only key, and runbook parsing **throws** rather than degrading. Adding OKF's required `type:` field breaks agent load today. Verified still exact on `9c001236`.

## What changed since the original handover

SIO-1281 landed, and it moved the ground under this ticket in three ways.

1. **The 16 files this spike must not convert are gone.** They were deleted; 14 sections were restored into `knowledge/playbook/`, and 2 eu-b2b runbooks were archived to `knowledge/_archive/eu-b2b-ilm/`. The sequencing risk the original handover flagged is now discharged.
2. **elastic-iac counts shifted.** `playbook` grew 94,289 -> **110,237 bytes**; `_archive` shrank to **13,432**; `runbooks` is **6**, unchanged. Entry count is still **46**. Re-measure rather than trusting the old table.
3. **A new, directly relevant finding.** `knowledge/_archive/` **is a loaded category** — files placed directly in it stay in the prompt. Exclusion works only by nesting one level down, because `loadKnowledge` does not recurse (`manifest-loader.ts:181`). That interacts with OKF's reserved `index.md` and with bundle boundaries (open questions 1 and 3 below). See `reference_archive_category_is_loaded_nest_to_exclude`.

## Spec facts (researched 2026-07-29 — do not re-derive)

**OKF is at v0.2, not v0.1.** All press coverage (techtimes, heise, marktechpost, June 2026) describes v0.1. Use [SPEC.md](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), Apache 2.0, which has since added the trust/provenance/lifecycle families that make it interesting here.

Reserved frontmatter fields:
- **Required**: `type` (string, producer-defined, not centrally registered — so `type: Runbook` is legal and idiomatic)
- **Recommended**: `title`, `description`, `resource`, `tags`
- **Provenance**: `sources[]` (each with `resource` required, plus `id`, `title`, `author`, `usage_count`, `last_modified`), `usage_window: {from, to}`
- **Trust**: `generated: {by, at}`, `verified: {by, at}` (bare mapping = single-element list)
- **Lifecycle**: `status: draft|stable|deprecated` (default `stable`), `stale_after: YYYY-MM-DD`
- **Extension**: producers MAY add keys; consumers MUST preserve and not reject them

Reserved filenames: `index.md` (directory listing, no frontmatter except `okf_version` at bundle root), `log.md` (chronological history). All other `.md` are concept documents.

Actor convention: `<producer>/<version>` for tools, `human:<id>` for people, `process:<id>` for automation. Trust tiers derive from `verified`: absent = unverified, non-human = machine-confirmed, `human:` = human-reviewed.

Conformance: every non-reserved `.md` needs parseable frontmatter with a non-empty `type`. **Consumers must tolerate** missing optional fields, unknown `type` values, unknown keys, broken cross-links, and missing `index.md`.

`playbooks/` is a **first-class OKF directory**, appearing in 3 of 8 official examples (`saas-app`, `company-knowledge`, `ai-agent-context`) with `incident-response.md` as a named concept.

## Why OKF earns its keep here

| OKF field | Problem in this repo |
|---|---|
| `status: draft\|stable\|deprecated` | SIO-1017's promotion DRAFT banner is prose in a body; OKF makes it queryable |
| `verified: {by: human:x}` -> trust tiers | The HIL learning lane's whole purpose is human review, with no machine-readable record |
| `sources[]` + `usage_count`, `usage_window` | `packages/agent/src/skill-outcome.ts` already tracks `usage_count`/`success_count` in bespoke frontmatter |
| `stale_after` | No staleness signal today — hence `authoring-skills-and-runbooks.md:62` sitting wrong for months (fixed in SIO-1278), and `:32` still wrong today (SIO-1285) |
| `generated: {by: agent/model}` | Distinguishes hand-authored from LLM-crystallized content |

## THE HARD BLOCKER (verified on `9c001236`)

`packages/gitagent-bridge/src/types.ts:217-232`:
```ts
export const RunbookTriggersSchema = z
	.object({
		severity: z.array(z.enum(["critical", "high", "medium", "low"])).optional(),
		services: z.array(z.string()).optional(),
		metrics: z.array(z.string()).optional(),
		match: z.enum(["any", "all"]).optional(),
	})
	.strict();

export const RunbookFrontmatterSchema = z
	.object({
		triggers: RunbookTriggersSchema,
	})
	.strict();
```

`triggers` is the **only** key and is **required** (no `.optional()`). Both schemas are `.strict()`.

Worse, unlike skill parsing — which warns and degrades — **runbook parsing THROWS**. `packages/gitagent-bridge/src/manifest-loader.ts:300`:
```ts
const validated = RunbookFrontmatterSchema.parse(parsed);   // bare .parse() -> throws on any unknown key
```
Call sites that propagate the throw: `manifest-loader.ts:199, 211, 225`. Contrast `parseSkillFrontmatter` (`:310-336`), which `console.warn`s and falls back to a minimal record at `:322` and `:333`. The comment at `:306-309` states the asymmetry deliberately.

**Measured on `9c001236`: 0 of the knowledge files carry a `type:` field**, while OKF requires it on every non-reserved `.md`. So adding `type:` to any runbook today breaks agent load.

Note the irony worth putting in the spec: OKF's own conformance rules require consumers to *tolerate* unknown keys and not reject bundles — the exact opposite of `.strict()`. Widening moves **toward** the spec. `SkillFrontmatterSchema` (`types.ts:242-262`) is already `.passthrough()` at `:262` — mirror it.

## Current structure (baseline, `9c001236` — re-measured post-SIO-1281)

elastic-iac `knowledge/` — 46 entries across 8 categories:
```
playbook          110,237   (11 files)   <- +15,948 from SIO-1281
specs              79,482   ( 4)
issues             73,487   ( 8)
health-snapshots   68,906   ( 4)
cost-plans         67,457   ( 6)
runbooks           60,077   ( 6)
reference          25,863   ( 6)
_archive           13,432   ( 1, index.md only)
TOTAL             498,941
```
Plus `knowledge/index.yaml` (loader category config, SIO-953), `knowledge/_INDEX.md` (human-only, deliberately NOT loaded), and now `knowledge/_archive/eu-b2b-ilm/` (2 files, **not loaded** — nested deliberately).

incident-analyzer `knowledge/` — **10 runbooks, 8 with triggers**, plus `systems-map/` and `slo-policies/`, governed by `knowledge/index.yaml` with a `runbook_selection` block.

**elastic-iac: 6 runbooks, `withTriggers: 0`.** Not one declares triggers — they load as plain knowledge. This matters for open question 4 and for any thought of making `triggers` optional.

## The critical asymmetry between the two agents

`agents/elastic-iac/knowledge/index.yaml:16-18` states it outright:
> `# No runbook_selection: that wires incident-analyzer's selectRunbooks node, which the IaC graph (buildIacGraph) does not have. The runbooks here are eu-cld incident references, loaded as plain knowledge.`

So: **incident-analyzer knowledge is trigger-gated and cheap; elastic-iac knowledge is always-on.** Migrating elastic-iac has no prompt-cost upside — the benefit there is purely provenance/trust. This drives open question 6, and it is exactly what [SIO-1285](https://linear.app/siobytes/issue/SIO-1285) exists to change. **Check SIO-1285's status before answering question 6** — if it has landed, the calculus for elastic-iac changes.

## The 7 open questions

1. **Reserved-filename collision.** OKF wants `index.md` (directory listing, no frontmatter). We have `index.yaml` (loader config), `_INDEX.md` (human-only, not loaded), and `_archive/index.md` (loaded, 13.4 KB). Rename, dual-maintain, or generate `index.md` from `index.yaml`? **New wrinkle**: an OKF `index.md` in every category directory would be **loaded into the prompt** for every category — adding N listing files to a prompt that already carries ~125k tokens. Answer this one with SIO-1285 in view.
2. **Does OKF `verified`/`sources` replace or sit beside `skill-outcome.ts`'s frontmatter?** The bespoke fields (`confidence` Laplace-smoothed, `usage_count`, `success_count`, `failure_count`, `learned_from`, `learned_at`) partly overlap `sources[].usage_count` and `verified`. **But they live on `SKILL.md`, which is out of OKF scope** — so is this a real conflict, or two formats covering different files? Likely the latter; state it explicitly either way.
3. **Bundle boundaries.** One bundle per agent `knowledge/`, or one repo-wide bundle with per-agent subdirs? Determines whether bundle-relative `/` links work across agents. **Note the loader constraint**: `loadKnowledge` does not recurse, so any subdirectory structure OKF encourages is invisible to the loader — that is load-bearing, not incidental (it is how `_archive/eu-b2b-ilm/` stays out of the prompt).
4. **`triggers:` is non-OKF.** It is our `selectRunbooks` mechanism (SIO-640). Keep as a producer extension (OKF permits extras and requires preservation) — confirm and document. Note only 8 of 10 incident-analyzer runbooks and **0 of 6** elastic-iac runbooks actually use it.
5. **Does `type:` duplicate the category system?** `index.yaml` categories already classify by directory. Is `type:` redundant or a finer cross-cut?
6. **Which agents?** incident-analyzer (trigger-gated, cheap) vs elastic-iac (always-on, provenance-only benefit today). One, both, or incident-analyzer first? **Re-check SIO-1285 first.**
7. **Validator interaction.** The tool-citation validator requires a `## All Tools Used Are Read-Only` section whose first non-empty line is a **comma-separated tool list** (`packages/gitagent-bridge/src/runbook-validator.test.ts`). Keep as a body convention layered on OKF, or promote to a frontmatter `tools:` extension field? Frontmatter would be more machine-checkable — see the SIO-1278 gotcha where explanatory prose in that section split on commas into bogus tool names.

## The work (spike, not migration)

### Step 1 — Read the spec, not the coverage

Fetch [SPEC.md](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) and [okf.md/examples](https://okf.md/examples/) directly. Confirm the version is still 0.2 and no reserved field has been added since 2026-07-29.

### Step 2 — Answer the 7 questions with rationale

Each needs a decision, not a survey. Questions 1 (filename collision) and 6 (which agents) most change the migration's shape, and both now depend on SIO-1285.

### Step 3 — Propose the widened schema

Keep `triggers` typed; add OKF reserved families as optional; `.passthrough()` the remainder:

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
		// sources / usage_window / generated / verified ...
	})
	.passthrough();
```

**Careful**: `triggers` is currently required. Making it optional is a behaviour change — check `getRunbookCatalog` (`packages/agent/src/prompt-context.ts:227-235`), which does `triggers: k.triggers` at `:233` with **no fallback, no guard, no default**, and `selectRunbooks`' `narrowCatalogByTriggers` (`runbook-selector.ts:322-344`). Note the `noop` mode already handles "no runbook declares triggers" by passing the catalog through, so the machinery may tolerate it — verify rather than assume.

### Step 4 — Worked example, before/after

Convert one existing runbook to a conformant OKF concept and show the diff. Suggested: `agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md` (newest, cleanest, added in PR #517). Prove the widened schema loads it.

### Step 5 — Size the migration and recommend go/no-go per agent

File counts per agent per category (baseline above). State explicitly what OKF does **not** solve: it addresses distribution/portability between producers and consumers. The SIO-1281 bug was a **loader-registration** failure — OKF would not have prevented it. Neither would it have prevented the `_archive/`-is-loaded trap. Say both in the spec.

## Files to modify (spike)

| File | Change |
|---|---|
| `docs/superpowers/specs/2026-07-XX-okf-runbook-alignment-design.md` | **New** — the deliverable |
| `packages/gitagent-bridge/src/types.ts` | *Proposed* schema only — implement in the follow-up migration ticket, not here |

Optionally one converted runbook as a proof-of-concept, clearly marked, if it helps validate the schema.

## Verification

```bash
bun run typecheck && bun run lint && bun test packages/gitagent-bridge/src/
```

If a schema change is prototyped, confirm every existing runbook still loads:
```bash
bun -e 'import{loadAgent}from"./packages/gitagent-bridge/src/index.ts";for(const d of ["agents/incident-analyzer","agents/elastic-iac"]){const a=loadAgent(d);const r=a.knowledge.filter(k=>k.category==="runbooks");console.log(d,"runbooks:",r.length,"withTriggers:",r.filter(k=>k.triggers).length);}'
```
Baseline on `9c001236`: incident-analyzer **10 / withTriggers 8**; elastic-iac **6 / withTriggers 0**.

And confirm the throw-path still behaves — a malformed runbook must still fail loudly, not silently degrade:
```bash
bun test packages/gitagent-bridge/src/runbook-validator.test.ts
```
Baseline: **59 pass / 0 fail** (verified on `9c001236`).

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Widening `RunbookFrontmatterSchema` hides real authoring errors | Medium | `.passthrough()` unknown keys but keep `triggers` and any OKF field we rely on strictly typed; the throw-on-malformed path must survive |
| Making `triggers` optional silently disables runbook selection | Medium | `getRunbookCatalog:233` reads it with no guard. Check `narrowCatalogByTriggers`' `noop` mode before relaxing |
| An OKF `index.md` per category adds N files to an already-125k-token prompt | **High for elastic-iac** | Coordinate with SIO-1285; consider `_INDEX.md`-style non-loaded naming, or nest |
| OKF v0.2 -> v0.3 churn mid-migration | Low | Spec is "explicitly designed for backward-compatible growth"; minor bumps add optional fields only. Pin `okf_version` in bundle-root `index.md` |
| Scope creep into `SKILL.md` | Medium | The user was explicit: skills stay agentskills.io. Out of scope |
| Treating OKF as a fix for the SIO-1281 class of bug | Medium | It is not. Say so in the spec |
| `bun run test` exits 133 with 0 failures | Medium | Pre-existing flaky lbug/Kuzu teardown segfault in `knowledge-graph`, not yours |

## Out of scope / non-goals

- **Migrating `SKILL.md` to OKF** — skills stay [agentskills.io](https://agentskills.io/home). The user removed this from an earlier draft.
- **Changing the KG or agent-memory wiki.** Verified separate: **nothing** in `packages/knowledge-graph/` or `packages/shared/src/agent-memory.ts` reads `agents/*/knowledge/`. The `wiki-ingest` skill treats `knowledge/...` paths as raw *source* it compiles **from**, into `memory/wiki/pages/`. On-disk knowledge = prompt-loaded reference text; KG/wiki = the durable queryable layer.
- **Content restoration** — SIO-1281, shipped.
- **Prompt-cost work** — SIO-1285. Related but separate; coordinate, do not merge the tickets.
- **The actual migration** — a follow-up ticket once this spec is approved.

## Related code references

- `packages/gitagent-bridge/src/types.ts:242-262` — `SkillFrontmatterSchema`, already `.passthrough()` at `:262`; the model for widening
- `packages/gitagent-bridge/src/manifest-loader.ts:160-234` — `loadKnowledge`, category loading, non-recursive `readdirSync` at `:180`
- `packages/gitagent-bridge/src/manifest-loader.ts:300` — the bare `.parse()` that throws
- `packages/gitagent-bridge/src/manifest-loader.ts:306-336` — lenient `parseSkillFrontmatter` and the comment explaining the asymmetry
- `packages/agent/src/prompt-context.ts:227-235` — `getRunbookCatalog`, built from `agent.knowledge` (a disk scan, not `index.yaml`)
- `packages/agent/src/runbook-selector.ts:322-344` — `narrowCatalogByTriggers`, incl. the `noop` mode relevant to optional triggers
- `agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md` — newest conformant runbook, the conversion candidate
- `agents/elastic-iac/knowledge/index.yaml` — the SIO-953 Knowledge Tree and the "no runbook_selection" note at `:16-18`

## Memory references

- `project_two_format_split_skills_agentskills_runbooks_okf` — **the primary one**; the decision, OKF v0.2 field list, the `.strict()` blocker, and the KG-vs-knowledge distinction
- `reference_archive_category_is_loaded_nest_to_exclude` — **new**; `_archive/` loads, nesting evades it, and `loadKnowledge` does not recurse
- `reference_elastic_iac_always_on_knowledge_486kb` — **new**; why elastic-iac migration has no prompt-cost upside until SIO-1285
- `reference_runbook_tail_section_is_parsed_as_csv` — the CSV tail-section rule behind open question 7, plus the flaky exit-133 trap
- `reference_skill_promotion_and_confidence` — the `skill-outcome.ts` confidence loop behind open question 2
- `reference_hil_learning_lane_sio1126` — the human-review lane that OKF's `verified` would record
- `reference_sio1228_skill_tool_binding` — why skill bodies are unconditionally in the prompt (the cost side of open question 6)
