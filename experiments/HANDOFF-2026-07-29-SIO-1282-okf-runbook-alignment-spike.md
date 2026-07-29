# HANDOFF — SIO-1282: Spike — adopt OKF for runbooks/playbooks

- **Date**: 2026-07-29
- **Ticket**: [SIO-1282](https://linear.app/siobytes/issue/SIO-1282) — Spike: adopt OKF for runbooks/playbooks (skills stay agentskills.io)
- **Project**: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- **BLOCKED ON**: [SIO-1281](https://linear.app/siobytes/issue/SIO-1281) — must land first (it deletes 16 files and restores 14 playbook sections; converting them first is wasted work)
- **Repo state**: `main` @ `5b3c796a`
- **Suggested branch**: `sio-1282-okf-alignment-spike`
- **Deliverable**: a design spec, NOT a migration — `docs/superpowers/specs/<date>-okf-runbook-alignment-design.md`

## TL;DR

Adopt a two-format split, decided by the user on 2026-07-29:

| Content | Format |
|---|---|
| `agents/*/skills/*/SKILL.md` | **Agent Skills** — https://agentskills.io/home — **UNCHANGED, out of scope** |
| `agents/*/knowledge/**` runbooks + playbooks | **OKF v0.2** — https://okf.md/examples/ · [SPEC.md](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) |

This spike answers 7 open questions and produces a spec with a go/no-go per agent. **There is a hard blocker that must be solved before any content moves**: `RunbookFrontmatterSchema` is `.strict()` and runbook parsing *throws*, so adding OKF's required `type:` field breaks agent load today.

## Context — how this ticket came to be

During SIO-1278 ([PR #517](https://github.com/zx8086/devops-incident-analyzer/pull/517)) and the SIO-1281 investigation, the user made two framing corrections that led here:

1. **"knowledge" in this system means the KG + agent-memory wiki**, not the on-disk `agents/*/knowledge/` directory. Verified separate — see Non-goals.
2. **Skills and runbooks are different artifact kinds and should use different formats.** Skills = a procedure the agent performs at a pipeline stage. Runbooks/playbooks = knowledge it consults. Hence: agentskills.io for the former, OKF for the latter.

The user asked whether OKF is the right choice for scalability. Research says the fit is good — with one real blocker and several collisions to resolve first.

## Spec facts (researched 2026-07-29 — do not re-derive)

**OKF is at v0.2, not v0.1.** All press coverage (techtimes, heise, marktechpost, June 2026) describes v0.1. Use [SPEC.md](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), which is Apache 2.0 and has since added the trust/provenance/lifecycle families that make it interesting here.

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
| `stale_after` | No staleness signal today — hence `authoring-skills-and-runbooks.md:62` sitting wrong for months (fixed in SIO-1278) |
| `generated: {by: agent/model}` | Distinguishes hand-authored from LLM-crystallized content |

## Where the bodies are buried

### THE HARD BLOCKER

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

`triggers` is the **only** key, and both schemas are `.strict()`. Worse, unlike skill parsing — which warns and degrades — **runbook parsing THROWS** (`packages/gitagent-bridge/src/manifest-loader.ts:281+`, cf. the lenient `parseSkillFrontmatter` at `:310-336`).

**Measured: 0 of the existing knowledge files carry a `type:` field**, while OKF requires it on every non-reserved `.md`. So adding `type:` to any runbook today breaks agent load.

Note the irony worth putting in the spec: OKF's own conformance rules require consumers to *tolerate* unknown keys and not reject bundles — the exact opposite of `.strict()`. Widening moves **toward** the spec. `SkillFrontmatterSchema` (`types.ts:242-262`) is already `.passthrough()` — mirror it.

### Current structure (baseline, `5b3c796a`)

elastic-iac `knowledge/` — 46 files across 8 categories:
```
reference: 6   issues: 8   runbooks: 6   specs: 4
cost-plans: 6  playbook: 11  health-snapshots: 4  _archive: 1
```
Plus `knowledge/index.yaml` (loader category config, SIO-953) and `knowledge/_INDEX.md` (human-only, deliberately NOT loaded). `knowledge/_archive/index.md` already exists.

incident-analyzer `knowledge/` — 10 runbooks + `systems-map/`, `slo-policies/`, governed by `knowledge/index.yaml` with a `runbook_selection` block.

### The critical asymmetry between the two agents

`agents/elastic-iac/knowledge/index.yaml` states it outright:
> `# No runbook_selection: that wires incident-analyzer's selectRunbooks node, which the IaC graph (buildIacGraph) does not have. The runbooks here are eu-cld incident references, loaded as plain knowledge.`

So: **incident-analyzer knowledge is trigger-gated and cheap; elastic-iac knowledge is always-on.** Migrating elastic-iac has no prompt-cost upside — the benefit there is purely provenance/trust. This drives open question 6.

## The 7 open questions

1. **Reserved-filename collision.** OKF wants `index.md` (directory listing, no frontmatter). We have `index.yaml` (loader config) and `_INDEX.md` (human-only, not loaded), plus an existing `_archive/index.md`. Rename, dual-maintain, or generate `index.md` from `index.yaml`?
2. **Does OKF `verified`/`sources` replace or sit beside `skill-outcome.ts`'s frontmatter?** The bespoke fields (`confidence` Laplace-smoothed, `usage_count`, `success_count`, `failure_count`, `learned_from`, `learned_at`) partly overlap `sources[].usage_count` and `verified`. **But they live on `SKILL.md`, which is out of OKF scope** — so is this a real conflict, or two formats covering different files? Likely the latter; state it explicitly either way.
3. **Bundle boundaries.** One bundle per agent `knowledge/`, or one repo-wide bundle with per-agent subdirs? Determines whether bundle-relative `/` links work across agents.
4. **`triggers:` is non-OKF.** It is our `selectRunbooks` mechanism (SIO-640). Keep as a producer extension (OKF permits extras and requires preservation) — confirm and document.
5. **Does `type:` duplicate the category system?** `index.yaml` categories already classify by directory. Is `type:` redundant or a finer cross-cut?
6. **Which agents?** incident-analyzer (trigger-gated, cheap) vs elastic-iac (always-on, provenance-only benefit). One, both, or incident-analyzer first?
7. **Validator interaction.** The tool-citation validator requires a `## All Tools Used Are Read-Only` section whose first non-empty line is a **comma-separated tool list** (`packages/gitagent-bridge/src/runbook-validator.test.ts:114-183`). Keep as a body convention layered on OKF, or promote to a frontmatter `tools:` extension field? Frontmatter would be more machine-checkable — see the SIO-1278 gotcha where explanatory prose in that section split on commas into bogus tool names.

## The work (spike, not migration)

### Step 1 — Read the spec, not the coverage

Fetch [SPEC.md](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) and [okf.md/examples](https://okf.md/examples/) directly. Confirm the version is still 0.2 and no reserved field has been added since 2026-07-29.

### Step 2 — Answer the 7 questions with rationale

Each needs a decision, not a survey. Question 1 (filename collision) and question 6 (which agents) are the two that most change the migration's shape.

### Step 3 — Propose the widened schema

Keep `triggers` typed; add OKF reserved families as optional; `.passthrough()` the remainder. Sketch:

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

**Careful**: `triggers` is currently required and every existing runbook has it. Making it optional is a behaviour change — check whether `selectRunbooks` or `getRunbookCatalog` (`packages/agent/src/prompt-context.ts:227-235`) assumes presence.

### Step 4 — Worked example, before/after

Convert one existing runbook (suggest `agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md`, the newest and cleanest) to a conformant OKF concept. Show the diff. Prove the widened schema loads it.

### Step 5 — Size the migration and recommend go/no-go per agent

File counts per agent per category (baseline above). State explicitly what OKF does **not** solve: it addresses distribution/portability between producers and consumers. The SIO-1281 bug was a *loader-registration* failure — OKF would not have prevented it, and adopting OKF does not fix it.

## Files to modify (spike)

| File | Change |
|---|---|
| `docs/superpowers/specs/<date>-okf-runbook-alignment-design.md` | **New** — the deliverable |
| `packages/gitagent-bridge/src/types.ts` | *Proposed* schema only — implement in the follow-up migration ticket, not here |

Optionally a single converted runbook as a proof-of-concept, clearly marked, if it helps validate the schema.

## Verification

For the spike, verification is the worked example loading under the proposed schema:

```bash
bun run typecheck && bun run lint && bun test packages/gitagent-bridge/src/
```

If a schema change is prototyped, confirm every existing runbook still loads:
```bash
bun -e 'import{loadAgent}from"./packages/gitagent-bridge/src/index.ts";for(const d of ["agents/incident-analyzer","agents/elastic-iac"]){const a=loadAgent(d);const r=a.knowledge.filter(k=>k.category==="runbooks");console.log(d,"runbooks:",r.length,"withTriggers:",r.filter(k=>k.triggers).length);}'
```
Baseline on `5b3c796a`: incident-analyzer 10 runbooks, elastic-iac 6.

And confirm the throw-path still behaves — a malformed runbook must still fail loudly, not silently degrade:
```bash
bun test packages/gitagent-bridge/src/runbook-validator.test.ts
```
Baseline: 59 pass / 0 fail.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Migrating content before SIO-1281 lands | **High if sequencing ignored** | SIO-1281 deletes 16 files and rewrites 14 playbook sections. Do not start content work until it merges |
| Widening `RunbookFrontmatterSchema` hides real authoring errors | Medium | `.passthrough()` unknown keys but keep `triggers` and any OKF field we rely on strictly typed; the throw-on-malformed path must survive |
| Making `triggers` optional silently disables runbook selection | Medium | Check `selectRunbooks` / `getRunbookCatalog` for presence assumptions before relaxing it |
| OKF v0.2 -> v0.3 churn mid-migration | Low | Spec is "explicitly designed for backward-compatible growth"; minor bumps add optional fields only. Pin `okf_version` in bundle-root `index.md` |
| Scope creep into `SKILL.md` | Medium | The user was explicit: skills stay agentskills.io. Out of scope |
| Treating OKF as a fix for the SIO-1281 class of bug | Medium | It is not. Say so in the spec |

## Out of scope / non-goals

- **Migrating `SKILL.md` to OKF** — skills stay [agentskills.io](https://agentskills.io/home). This was in an earlier draft and the user removed it.
- **Changing the KG or agent-memory wiki.** Verified separate: **nothing** in `packages/knowledge-graph/` or `packages/shared/src/agent-memory.ts` reads `agents/*/knowledge/`. The `wiki-ingest` skill treats `knowledge/...` paths as raw *source* it compiles **from**, into `memory/wiki/pages/`. On-disk knowledge = prompt-loaded reference text; KG/wiki = the durable queryable layer.
- **Content restoration** — that is SIO-1281.
- **The actual migration** — a follow-up ticket once this spec is approved.

## Related code references

- `packages/gitagent-bridge/src/types.ts:242-262` — `SkillFrontmatterSchema`, already `.passthrough()`; the model for widening
- `packages/gitagent-bridge/src/manifest-loader.ts:160-234` — `loadKnowledge`, category loading, and `runbook_selection` filename validation
- `packages/gitagent-bridge/src/manifest-loader.ts:310-336` — lenient `parseSkillFrontmatter` (warns) vs `parseRunbookFrontmatter` (throws)
- `packages/agent/src/prompt-context.ts:227-235` — `getRunbookCatalog`, built from `agent.knowledge` (a disk scan, not `index.yaml`)
- `packages/agent/src/runbook-selector.ts:1-40` — `selectRunbooks`, the LLM picks 0-3 per turn
- `agents/incident-analyzer/knowledge/runbooks/mcp-tool-audit.md` — newest conformant runbook, good conversion candidate
- `agents/elastic-iac/knowledge/index.yaml` — the SIO-953 Knowledge Tree and the "no runbook_selection" note

## Memory references

- `project_two_format_split_skills_agentskills_runbooks_okf` — **the primary one**; the decision, OKF v0.2 field list, the `.strict()` blocker, and the KG-vs-knowledge distinction
- `reference_runbook_tail_section_is_parsed_as_csv` — the CSV tail-section rule behind open question 7, plus the flaky exit-133 trap
- `reference_skill_promotion_and_confidence` — the `skill-outcome.ts` confidence loop behind open question 2
- `reference_hil_learning_lane_sio1126` — the human-review lane that OKF's `verified` would record
- `reference_sio1228_skill_tool_binding` — why skill bodies are unconditionally in the prompt (the cost side of open question 6)
