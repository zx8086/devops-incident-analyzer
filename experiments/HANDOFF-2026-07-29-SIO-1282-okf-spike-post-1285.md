# HANDOFF — SIO-1282: OKF runbook alignment spike (post-SIO-1285)

- **Date**: 2026-07-29
- **Ticket**: [SIO-1282](https://linear.app/siobytes/issue/SIO-1282) — Spike: adopt OKF for runbooks/playbooks (skills stay agentskills.io)
- **Project**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- **Repo state**: `main` @ `227c947f`
- **Suggested branch**: `sio-1282-okf-alignment-spike`
- **Status**: Backlog, not started. **Unblocked** — both prerequisites have landed.
- **Deliverable**: a design spec, NOT a migration — `docs/superpowers/specs/2026-07-XX-okf-runbook-alignment-design.md`
- **Supersedes**: `experiments/HANDOFF-2026-07-29-SIO-1282-okf-runbook-alignment-spike.md` (written @ `bdb5344e`, pre-SIO-1285). Still correct on the OKF v0.2 research; **stale on every measured figure and every `file:line` citation**.

## TL;DR

Two-format split, decided by the user on 2026-07-29: `SKILL.md` stays [agentskills.io](https://agentskills.io/home); `agents/*/knowledge/**` runbooks and playbooks move to **OKF v0.2**. This ticket produces a **spec with a go/no-go per agent**, not a migration.

One hard blocker to solve on paper first: `RunbookFrontmatterSchema` is `.strict()` with `triggers` as its only key, and runbook parsing **throws** rather than degrading. Adding OKF's required `type:` field breaks agent load today. **Verified still exact on `227c947f`** — but the line numbers moved (see below).

## Why this doc replaces the previous one

[SIO-1285](https://linear.app/siobytes/issue/SIO-1285) merged as [PR #523](https://github.com/zx8086/devops-incident-analyzer/pull/523) (`227c947f`). The previous handover told the reader, twice, to "re-check SIO-1285 before answering questions 1 and 6." **It has landed. Both are now answerable, and the answers changed.**

Four things moved underneath the old doc:

1. **Every byte figure is stale.** `_archive` and `health-snapshots` were unregistered from the prompt. Entry count 46 → **41**; knowledge 498,941 → **416,603**; assembled prompt 568,446 → **485,959**.
2. **elastic-iac knowledge is no longer always-on.** It now has a per-intent selector. That was the entire premise of question 6's "no prompt-cost upside" reasoning.
3. **Every `file:line` citation shifted** — SIO-1285 edited `types.ts` and `manifest-loader.ts` above the cited lines. The ticket body's `types.ts:228-232` and `manifest-loader.ts:281+` are both wrong now.
4. **The `_archive/index.md` collision is defused.** It is still on disk but **no longer a loaded category**, so it no longer occupies prompt bytes.

## Current baseline (measured on `227c947f`, not copied)

**elastic-iac** `knowledge/` — 41 entries, 6 loaded categories:

```
playbook          110,237  (11)
specs              79,482  ( 4)
issues             73,487  ( 8)
cost-plans         67,457  ( 6)
runbooks           60,077  ( 6)
reference          25,863  ( 6)
TOTAL             416,603      -> assembled prompt 485,959
```

Per-intent, via the new selector: `gitops` **357,844** · `converse` **154,237** · `info` **485,959** (the classifier's catch-all, deliberately unnarrowed).

On disk but **NOT loaded**: `health-snapshots/` (4 files), `_archive/index.md`, `_archive/eu-b2b-ilm/` (2 files), `_INDEX.md`.

**incident-analyzer** `knowledge/` — 12 entries: `runbooks` 61,176 (10) · `systems-map` 1,895 (1) · `slo-policies` 1,450 (1). Assembled prompt **78,671**.

**Runbook/trigger counts (unchanged, load-bearing for question 4):** incident-analyzer **10 runbooks / 8 with triggers**; elastic-iac **6 runbooks / 0 with triggers**.

## The hard blocker (re-verified, with CORRECTED line numbers)

`packages/gitagent-bridge/src/types.ts:248-252`:
```ts
export const RunbookFrontmatterSchema = z
	.object({
		triggers: RunbookTriggersSchema,
	})
	.strict();
```

`triggers` is the **only** key and is **required**. `RunbookTriggersSchema` is `.strict()` too.

Unlike skill parsing — which warns and degrades — **runbook parsing THROWS**. `packages/gitagent-bridge/src/manifest-loader.ts:338`:
```ts
const validated = RunbookFrontmatterSchema.parse(parsed);   // bare .parse() -> throws on any unknown key
```

Contrast `parseSkillFrontmatter` at `manifest-loader.ts:348`, which `console.warn`s and falls back to a minimal record. `SkillFrontmatterSchema` is already `.passthrough()` at `types.ts:282` — mirror it.

**0 of the knowledge files carry a `type:` field**, while OKF requires it on every non-reserved `.md`. So adding `type:` to any runbook today breaks agent load.

The irony worth putting in the spec: OKF's own conformance rules require consumers to *tolerate* unknown keys and not reject bundles — the exact opposite of `.strict()`. Widening moves **toward** the spec.

### Citation corrections vs the old doc and the ticket body

| Claim | Old (stale) | Correct on `227c947f` |
|---|---|---|
| `RunbookFrontmatterSchema` | `types.ts:228-232` | **`types.ts:248-252`** |
| `RunbookTriggersSchema` | `types.ts:217-224` | **`types.ts:237-245`** |
| Throwing `.parse()` | `manifest-loader.ts:281+` / `:300` | **`manifest-loader.ts:338`** |
| `parseSkillFrontmatter` | `:310-336` | **`:348`** |
| `SkillFrontmatterSchema` `.passthrough()` | `types.ts:262` | **`types.ts:282`** |
| Non-recursive `readdirSync` | `:181` | **`:188`** |

Unchanged: `getRunbookCatalog` `prompt-context.ts:227` (reads `triggers` with no guard at `:233`), `narrowCatalogByTriggers` `runbook-selector.ts:322`.

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
| `stale_after` | No staleness signal today — hence `authoring-skills-and-runbooks.md:62` sitting wrong for months (fixed in SIO-1278) and `:32` wrong until SIO-1285 fixed it |
| `generated: {by: agent/model}` | Distinguishes hand-authored from LLM-crystallized content |

## The 7 open questions — two are now ANSWERABLE

**1. Reserved-filename collision. — MATERIALLY EASED.**
OKF wants `index.md` (directory listing, no frontmatter). We have `index.yaml` (loader config) and `_INDEX.md` (human-only, never loaded — pinned by `elastic-iac-load.test.ts:63`).

The old doc's wrinkle was that `_archive/index.md` was *loaded*, costing 13.4 KB, and that an OKF `index.md` per category would add N such files to the prompt. **`_archive` is no longer a registered category**, so that specific instance is gone — the file sits on disk, unloaded.

The general risk remains but is now bounded and cheap to solve: any `index.md` placed in a *registered* category directory WILL be loaded (the loader takes every `*.md` directly under a category path). Three viable answers, and the selector changes the calculus:
  - name listings `_INDEX.md` (proven not-loaded convention), or
  - nest them one level down (`loadKnowledge` does not recurse — `manifest-loader.ts:188`), or
  - accept the cost only for categories a given intent selects.
Recommend the first; it already works and needs no loader change.

**2. Does OKF `verified`/`sources` replace or sit beside `skill-outcome.ts`'s frontmatter?**
The bespoke fields (`confidence` Laplace-smoothed, `usage_count`, `success_count`, `failure_count`, `learned_from`, `learned_at`) partly overlap `sources[].usage_count` and `verified`. **But they live on `SKILL.md`, which is out of OKF scope** — so this is likely two formats covering different files, not a conflict. State it explicitly either way.

**3. Bundle boundaries.** One bundle per agent `knowledge/`, or one repo-wide bundle with per-agent subdirs? Determines whether bundle-relative `/` links work across agents. **Loader constraint**: `loadKnowledge` does not recurse (`manifest-loader.ts:188`), so any subdirectory structure OKF encourages is invisible to the loader — load-bearing, not incidental (it is how `_archive/eu-b2b-ilm/` stays out of the prompt).

**4. `triggers:` is non-OKF.** It is our `selectRunbooks` mechanism (SIO-640). Keep as a producer extension (OKF permits extras and requires preservation) — confirm and document. Note only 8 of 10 incident-analyzer runbooks and **0 of 6** elastic-iac runbooks use it.

**5. Does `type:` duplicate the category system?** `index.yaml` categories already classify by directory. Is `type:` redundant or a finer cross-cut? Note SIO-1285 added a second consumer of those category names (`knowledge_selection.by_intent`), so categories are now load-bearing for prompt cost, not just organisation — an argument for `type:` being a genuine cross-cut rather than a duplicate.

**6. Which agents? — NOW ANSWERABLE, and the answer flipped.**
The old reasoning was: "elastic-iac knowledge is always-on, so migrating it has no prompt-cost upside; the benefit is purely provenance/trust." **That premise is dead.** elastic-iac now has a per-intent category selector (`knowledge_selection` in `knowledge/index.yaml`, `KnowledgeSelectionConfigSchema` at `types.ts:216`).

Both agents are now selection-gated, by different keys:
  - incident-analyzer: per-**file**, keyed on incident `triggers`, max 3 (SIO-640)
  - elastic-iac: per-**category**, keyed on classifier `intent` (SIO-1285)

That makes the two comparable for the first time, and it raises a genuinely new spec question the old doc could not ask: **should OKF frontmatter feed selection?** `status: deprecated` or a past `stale_after` are natural signals for "do not put this in the prompt", and both selectors currently ignore file-level metadata entirely (elastic-iac's does not even look at frontmatter). That is the strongest argument yet for migrating elastic-iac, and it did not exist a day ago.

**7. Validator interaction.** The tool-citation validator requires a `## All Tools Used Are Read-Only` section whose first non-empty line is a **comma-separated tool list** (`packages/gitagent-bridge/src/runbook-validator.test.ts`). Keep as a body convention layered on OKF, or promote to a frontmatter `tools:` extension? Frontmatter would be more machine-checkable — see the SIO-1278 gotcha where explanatory prose in that section split on commas into bogus tool names.

## The work (spike, not migration)

### Step 1 — Read the spec, not the coverage
Fetch [SPEC.md](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) and [okf.md/examples](https://okf.md/examples/) directly. Confirm the version is still 0.2 and no reserved field has been added since 2026-07-29.

### Step 2 — Answer the 7 questions with rationale
Each needs a decision, not a survey. Questions 1 and 6 were previously blocked on SIO-1285; both are now answerable, and 6's premise has inverted.

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

**Careful**: `triggers` is currently required. Making it optional is a behaviour change — check `getRunbookCatalog` (`prompt-context.ts:227`), which does `triggers: k.triggers` at `:233` with **no fallback, no guard, no default**, and `narrowCatalogByTriggers` (`runbook-selector.ts:322`). Its `noop` mode already handles "no runbook declares triggers" by passing the catalog through, so the machinery may tolerate it — verify rather than assume.

**New in this revision**: a plain `z.object` **silently strips** unknown top-level keys rather than rejecting them. That is how SIO-1285's `knowledge_selection` block would have failed — parsing `success: true` with the block discarded and the feature never turning on. If the spec proposes any new `index.yaml` key, it must also propose the schema field, or the config is a no-op with no error. See `KnowledgeIndexSchema` at `types.ts:226-234`.

### Step 4 — Worked example, before/after
Convert one existing runbook to a conformant OKF concept and show the diff. Suggested: `agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md` (newest, cleanest, added in PR #517). Prove the widened schema loads it.

### Step 5 — Size the migration and recommend go/no-go per agent
File counts per agent per category (baseline above). State explicitly what OKF does **not** solve: it addresses distribution/portability between producers and consumers. The SIO-1281 bug was a **loader-registration** failure — OKF would not have prevented it. Neither would it have prevented the `_archive/`-is-loaded trap, nor SIO-1285's silent-strip trap. Say all three in the spec.

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
Baseline on `227c947f`: incident-analyzer **10 / withTriggers 8**; elastic-iac **6 / withTriggers 0**.

Full knowledge probe (catches an accidental category drop — assert the EXACT entry count, not "smaller"):
```bash
bun -e 'import{loadAgent,buildSystemPrompt}from"./packages/gitagent-bridge/src/index.ts";const a=loadAgent("agents/elastic-iac");const by={};let t=0;for(const k of a.knowledge){by[k.category]=(by[k.category]||0)+k.content.length;t+=k.content.length;}console.log(JSON.stringify(by,null,1));console.log("knowledge",t,"entries",a.knowledge.length,"prompt",buildSystemPrompt(a).length);'
```
Baseline: `knowledge 416603 entries 41 prompt 485959`.

And confirm the throw-path still behaves — a malformed runbook must still fail loudly:
```bash
bun test packages/gitagent-bridge/src/runbook-validator.test.ts
```

**Worktree caveat**: a freshly created `git worktree` has no dependency links and `bun -e` fails with `Cannot find package 'yaml'`; `/tmp` is worse (outside the repo tree entirely). Measure from an existing prepared worktree or the main checkout, and confirm with `git diff --stat origin/main -- <paths>` that the paths you care about match the commit you mean to measure.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Following the old doc's or the ticket's `file:line` citations | **High** | All shifted by SIO-1285 — use the correction table above |
| Widening `RunbookFrontmatterSchema` hides real authoring errors | Medium | `.passthrough()` unknown keys but keep `triggers` and any relied-on OKF field strictly typed; the throw-on-malformed path must survive |
| Making `triggers` optional silently disables runbook selection | Medium | `getRunbookCatalog:233` reads it with no guard. Check `narrowCatalogByTriggers`' `noop` mode first |
| A new `index.yaml` key is silently stripped by the schema | **Certain if the schema field is omitted** | Plain `z.object` discards unknown keys with `success: true`. Add the field AND a probe asserting it loaded |
| An OKF `index.md` in a REGISTERED category is loaded into the prompt | Medium (was High) | `_archive` is no longer registered; use `_INDEX.md` naming or nest one level down |
| OKF v0.2 -> v0.3 churn mid-migration | Low | Spec is "explicitly designed for backward-compatible growth"; minor bumps add optional fields only. Pin `okf_version` in bundle-root `index.md` |
| Scope creep into `SKILL.md` | Medium | The user was explicit: skills stay agentskills.io. Out of scope |
| Treating OKF as a fix for the SIO-1281 class of bug | Medium | It is not. Say so in the spec |
| `bun run test` exits 133 with 0 failures | Medium | Pre-existing flaky lbug/Kuzu teardown segfault in `knowledge-graph`, not yours |

## Out of scope / non-goals

- **Migrating `SKILL.md` to OKF** — skills stay [agentskills.io](https://agentskills.io/home). The user removed this from an earlier draft.
- **Changing the KG or agent-memory wiki.** Verified separate: **nothing** in `packages/knowledge-graph/` or `packages/shared/src/agent-memory.ts` reads `agents/*/knowledge/`. The `wiki-ingest` skill treats `knowledge/...` paths as raw *source* it compiles **from**, into `memory/wiki/pages/`.
- **Content restoration** — SIO-1281, shipped.
- **Prompt-cost work** — SIO-1285, shipped and merged. Do not redo it; build on it.
- **The actual migration** — a follow-up ticket once this spec is approved.

## Related code references

- `packages/gitagent-bridge/src/types.ts:282` — `SkillFrontmatterSchema`, already `.passthrough()`; the model for widening
- `packages/gitagent-bridge/src/types.ts:216-234` — `KnowledgeSelectionConfigSchema` + `KnowledgeIndexSchema`; the newest `index.yaml` consumer and the silent-strip hazard
- `packages/gitagent-bridge/src/manifest-loader.ts:188` — non-recursive category scan
- `packages/gitagent-bridge/src/manifest-loader.ts:338` — the bare `.parse()` that throws
- `packages/gitagent-bridge/src/manifest-loader.ts:348` — lenient `parseSkillFrontmatter`
- `packages/gitagent-bridge/src/manifest-loader.ts:245-269` — SIO-1285's load-time validation of `knowledge_selection` category names (throws on a bad reference; error text at `:252`); the precedent for validating any new config
- `packages/agent/src/iac/knowledge-selector.ts` — the SIO-1285 selector; where OKF lifecycle fields would plug into selection (question 6)
- `packages/agent/src/prompt-context.ts:227` — `getRunbookCatalog`, built from `agent.knowledge` (a disk scan, not `index.yaml`)
- `packages/agent/src/runbook-selector.ts:322` — `narrowCatalogByTriggers`, incl. the `noop` mode relevant to optional triggers
- `agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md` — newest conformant runbook, the conversion candidate
- `agents/elastic-iac/knowledge/index.yaml` — the SIO-953 Knowledge Tree, now also carrying `knowledge_selection`

## Memory references

- `project_two_format_split_skills_agentskills_runbooks_okf` — **the primary one**; the decision, OKF v0.2 field list, the `.strict()` blocker, and the KG-vs-knowledge distinction
- `reference_sio1285_iac_knowledge_selector` — **new**; why the selector keys on intent, the `return {}` checkpoint trap, and the silent-strip schema hazard
- `reference_archive_category_is_loaded_nest_to_exclude` — `_archive/` loaded, nesting evades it, `loadKnowledge` does not recurse (note: `_archive` is now unregistered entirely)
- `reference_elastic_iac_always_on_knowledge_486kb` — the pre-SIO-1285 baseline; **historical now**, kept for the incident-analyzer contrast
- `reference_runbook_tail_section_is_parsed_as_csv` — the CSV tail-section rule behind question 7, plus the flaky exit-133 trap
- `reference_skill_promotion_and_confidence` — the `skill-outcome.ts` confidence loop behind question 2
- `reference_hil_learning_lane_sio1126` — the human-review lane that OKF's `verified` would record
- `reference_sio1228_skill_tool_binding` — why skill bodies are unconditionally in the prompt
