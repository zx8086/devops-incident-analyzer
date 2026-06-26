# Skill promotion + confidence feedback loop — design

Date: 2026-06-26
Tickets:
- [SIO-1017](https://linear.app/siobytes/issue/SIO-1017) — Promote a skill proposal into a real SKILL.md (scaffold helper)
- [SIO-1016](https://linear.app/siobytes/issue/SIO-1016) — Skill confidence feedback loop (mutable per-skill outcome tracking)

Both are follow-ups to [SIO-1015](https://linear.app/siobytes/issue/SIO-1015) (skill-learning subsystem, PRs #305/#306), which shipped the **propose-only** half of the gitagent.sh Skills lifecycle: worthy turns crystallize as durable agent-memory `kind:skill` facts seeded with `confidence:"0.5"` and all counts `"0"`, surfaced at recall as `[proposed-skill (unpromoted)]`. Two gaps remain: turning a proposal into a loadable `SKILL.md` is fully manual (SIO-1017), and the confidence/usage counts never evolve because durable facts are immutable from the client (SIO-1016).

This design covers both and commits to an implementation order: **SIO-1017 first, then SIO-1016**, because the recommended SIO-1016 mechanism (defer-until-promotion) writes its counters into the promoted `SKILL.md` frontmatter that SIO-1017 produces.

## Constraints carried from SIO-1015 / SIO-1014

- **Durable agent-memory facts are immutable from the client.** No update/delete API; re-recording permanently doubles a fact (`reference_agent_memory_recall_dedup`). The seeded `confidence`/counts on a `kind:skill` fact can never be mutated in place.
- **Propose-only invariant.** Nothing is auto-loaded into prompts; `buildSystemPrompt`'s active-skill set is unchanged. A human promotes a proposal by authoring a `SKILL.md`.
- **`SkillFrontmatterSchema` (SIO-1014, `packages/gitagent-bridge/src/types.ts`)** is the contract any generated `SKILL.md` must satisfy. It is `.passthrough()` and validates the learning fields as **typed values**: `confidence: number ∈ [0,1]`, `usage_count|success_count|failure_count: int ≥ 0`, `learned_at: ISO-8601 string`, `learned_from: string`. Note the type gap: agent-memory annotations are an `AnnotationMap` of **strings** (`confidence:"0.5"`), so promotion must convert string annotations into typed frontmatter.
- **The post-turn seam already exists.** `registerPostTurnLearner` (`packages/agent/src/lifecycle.ts:67`) is invoked in `runPostTurn` (:236) from all three completion points. SIO-1016 reuses it; no new seam needed.

---

## SIO-1017 — Promote a skill proposal into a real SKILL.md

### Goal

Given a proposed `kind:skill` fact (by `skill_name`), scaffold `agents/<agent>/skills/<name>/SKILL.md` from its body + annotations, so a human reviews/edits a draft instead of writing from scratch. The output is a normal git-tracked file the SIO-1014 loader picks up (frontmatter → `skillMeta`, surfaced in the `## Skills` catalog).

### Surface

A CLI script at `packages/agent/src/cli/promote-skill.ts`, run via a package script with the repo's `--env-file` idiom (mirrors `packages/mcp-server-gitlab/src/cli/doctor-oauth.ts`). Living inside `packages/agent` lets it import `searchAgentMemory`/`selectedBackend` (`memory-backend.ts`) and the skill-learner field shapes directly via relative paths — `searchAgentMemory` is not (and need not become) a public package export.

```
bun run --filter @devops-agent/agent skill:promote -- --agent incident-analyzer --skill lag-correlation
```

Flags:
- `--agent <name>` (required) — the agent whose `agents/<agent>/skills/` tree receives the draft. Defaults to `incident-analyzer` (the only agent the learner runs for today).
- `--skill <skill_name>` (required) — the `skill_name` annotation to look up.
- `--force` — overwrite an existing `SKILL.md` (default: refuse).
- `--add-to-manifest` — also append the skill to the agent's `agent.yaml` `skills:` list (default: do NOT; print the exact line to add).

### Source data

Read the single `kind:skill` proposal fact by `skill_name`:

```ts
const hits = await searchAgentMemory(agent, "", { kind: "skill", skill_name: name }, 1, { deterministic: true });
```

Deterministic filter-only retrieval (the same idiom `proposalExists` already uses in `skill-learner.ts:135`) — the annotation filter is authoritative, not a ranked top-k window. The hit carries:
- `text` — the proposal body (`Proposed skill: <name> - <desc>` + `When to use:` + `Procedure:`), already PII-redacted at write time.
- `annotations` — `skill_name`, `task_category`, `confidence`, `learned_from`, `learned_at`, `usage_count`, `success_count`, `failure_count` (all strings).

A separate pure parser splits the body back into `description` / `when_to_use` / `procedure` sections (inverse of `buildSkillFactText`). This is a deterministic, testable function with no I/O.

**Paraphrase caveat (important).** When `LIVE_MEMORY_BACKEND=agent-memory`, the service **LLM-paraphrases fact bodies on ingest and strips literal markers** (`reference_agent_memory_paraphrases_on_ingest`): the `Proposed skill:` / `When to use:` / `Procedure:` labels `buildSkillFactText` writes will often NOT survive a round trip. Therefore the parser must be **lenient**: try the labelled markers first; if a section marker is absent, fall back to putting the whole recalled body into the `## Procedure` section (and use the `description` from… see next paragraph). The draft is always DRAFT-marked and human-reviewed, so a coarse fallback is acceptable — the human fixes the split. We do NOT fail the scaffold just because the prose was paraphrased.

`description` is recovered the same lenient way (first labelled line, else first sentence of the body). The structured identity fields the frontmatter actually needs (`skill_name`, `task_category`, `confidence`, `learned_*`, counts) come from **annotations, which round-trip verbatim** — so the parts that must be exact never depend on the paraphrased prose. The durable fix (out of scope here, noted as a one-line SIO-1015 follow-up) would be to also carry `description`/`when_to_use`/`procedure_summary` as annotations at crystallization time; until then the lenient parser is the right call for a propose-only draft.

### Output

`agents/<agent>/skills/<name>/SKILL.md`:

```markdown
---
name: lag-correlation
description: Correlate Kafka consumer lag with downstream Elasticsearch error spikes.
learned_from: thread:abc-123
learned_at: 2026-06-26T01:32:41Z
confidence: 0.5
usage_count: 0
success_count: 0
failure_count: 0
task_category: lag-correlation
---

# DRAFT — review before use

> This skill was scaffolded from a learned proposal (SIO-1017). Review the
> procedure, edit for correctness, and remove this banner before relying on it.
> It is NOT loaded until added to the agent's `agent.yaml` `skills:` list.

## When to use

<when_to_use from the proposal>

## Procedure

<procedure_summary from the proposal>
```

The frontmatter builder converts annotation strings to typed values (`Number(confidence)`, `Number.parseInt(count)`), drops keys that are absent/blank, and the result is validated against `SkillFrontmatterSchema.parse(...)` **before** the file is written. If validation fails (e.g. a malformed `confidence` annotation), the CLI exits non-zero with the Zod error and writes nothing — a draft is only ever written when it is known-valid.

### Safety

- **Refuse to overwrite** an existing `SKILL.md` unless `--force` (idempotent re-run is a no-op + message).
- **Not auto-loaded.** The draft does NOT modify `agent.yaml` unless `--add-to-manifest` is passed; by default the CLI prints `Add to agents/<agent>/agent.yaml under skills:\n  - <name>`. Local skills are manifest-gated, so an un-added draft is inert — exactly the propose-only safety posture.
- **DRAFT banner** in the body so a human reviewing the file (or the model, if it were ever loaded prematurely) sees it is unreviewed.

### Acceptance criteria

- Running the helper for a known `skill_name` writes a syntactically valid `SKILL.md` whose frontmatter parses under `SkillFrontmatterSchema` without warnings.
- The draft is clearly marked DRAFT and is NOT auto-added to `agent.yaml` (unless `--add-to-manifest`).
- Idempotent / refuses to overwrite an existing `SKILL.md` without `--force`.
- Unknown `skill_name` (no matching fact) exits non-zero with a clear message, writes nothing.
- Annotation→frontmatter type conversion + body parser are unit-tested in isolation (no network, no LLM).
- `bun run typecheck && bun run lint && bun run test` pass.

### Files

| File | Change |
| -- | -- |
| `packages/agent/src/cli/promote-skill.ts` | NEW: CLI entry — arg parse, recall fact, build+validate frontmatter, write file, manifest hint |
| `packages/agent/src/skill-promote.ts` | NEW: pure core — `parseSkillFactBody`, `buildSkillFrontmatter` (annotations→typed), `renderSkillMarkdown` |
| `packages/agent/package.json` | add `"skill:promote"` script |
| `packages/agent/src/skill-promote.test.ts` | NEW: body parser, type conversion, schema validity, DRAFT banner present |

---

## SIO-1016 — Skill confidence feedback loop

### The gap

gitagent.sh skills carry `confidence`/`usage_count`/`success_count`/`failure_count` that **evolve** as the skill is reused. SIO-1015 seeds them and never updates them, because durable facts cannot mutate in place.

### The three options

**Option 1 — Mutable side-store.** Track per-skill counters in a separate mutable store (bun:sqlite table or a KG node) keyed by `skill_name`, joined to the immutable proposal fact at render time.
- Pros: clean in-place mutation; true running counters for every proposal, promoted or not.
- Cons: a new store + lifecycle to own; counters live apart from the fact (two sources of truth to keep consistent at render); join logic in every surface that shows a skill. Heaviest option, and it refines a number on things no human has vetted.

**Option 2 — Reconcile-style append + dedupePreferring.** Append a new `kind:skill-outcome` fact per application carrying running totals; collapse to the latest at read via `dedupePreferring` + an outcome-recency rank (mirrors the SIO-1005 iac-change reconcile pattern: `dedupePreferring`, TTL-on-seed, the `Bun.cron` idiom).
- Pros: maximum reuse of an established repo pattern; no new store; append-only is the store's natural mode.
- Cons: unbounded growth (mitigated by TTL on the transient outcome facts); "latest wins" only yields correct totals if each appended fact carries the running sum, which means a read-modify-append race window per outcome; still spends durable-store writes on unpromoted proposals.

**Option 3 — Defer until promotion (RECOMMENDED).** Only track outcomes for skills a human has promoted to a real `SKILL.md` (SIO-1017). The frontmatter (`usage_count`/`success_count`/`failure_count`/`confidence`) is a git-tracked, naturally-mutable home for the counters.
- Pros: smallest correct surface; no new store, no immutability fight (a file is editable); counters are human-auditable in git history; aligns exactly with the propose-only posture — confidence only starts *meaning* something once a human has vetted the skill.
- Cons: does nothing for unpromoted proposals (they stay seeded at 0.5); depends on SIO-1017 landing first; updating frontmatter is a file write, so concurrent turns touching the same skill need a guard.

### Recommendation: Option 3

The whole subsystem is propose-only by deliberate design. Options 1 and 2 spend real infrastructure to refine a confidence number on a proposal **no human has reviewed** — and SIO-1015 already seeds `0.5` precisely because measuring confidence against immutable facts isn't worth it yet. Option 3 says: confidence becomes measurable exactly when a human promotes the skill to a `SKILL.md`, at which point the frontmatter is the obvious mutable, reviewable, version-controlled home for the counters. It is the smallest change that is actually correct, and it composes cleanly with SIO-1017. This is why SIO-1017 is implemented first.

### Mechanism

A pure updater + a thin post-turn wiring:

1. **`recordSkillOutcome(skillDir, outcome, opts)`** in a new `packages/agent/src/skill-outcome.ts`:
   - Reads `agents/<agent>/skills/<name>/SKILL.md`, parses frontmatter via the existing `manifest-loader` path (gray-matter + `SkillFrontmatterSchema`).
   - Bumps `usage_count += 1`, and `success_count`/`failure_count += 1` per `outcome`.
   - Recomputes `confidence` with **Laplace (add-one) smoothing**: `confidence = (success_count + 1) / (usage_count + 2)`. Starts a fresh promoted skill (0/0/0) at exactly the seeded 0.5 and moves monotonically toward the observed success rate, never hitting 0 or 1 on small samples.
   - Rewrites the file with updated frontmatter, body untouched. Pure given `(currentFrontmatter, outcome)` → `nextFrontmatter`; the file read/write is the only I/O and is isolated.
   - Best-effort: never throws to the caller; a parse failure or missing file is logged and skipped.

2. **Which skills are tracked.** Only skills that exist on disk as `agents/<agent>/skills/<name>/SKILL.md`. Unpromoted proposals have no file and are never touched — they remain seeded at 0.5 in agent-memory. The set of "skills exercised this turn" is read from the same completed-turn snapshot the learner already builds (`SkillLearnerTurn`); we extend the turn reader to also report which on-disk skill names were active/applied this turn (the manifest `skills:` list ∩ what ran). If a turn applied no promoted skill, the updater is a no-op.

3. **Outcome judgment.** Reuse the signals the learner already gates on: a turn is a **success** when it completed with no error and `confidenceScore >= MIN_CONFIDENCE` (0.6), a **failure** otherwise. No new LLM call — the post-turn snapshot already carries `confidenceScore` and the error state. (A richer per-skill judge is explicitly out of scope; the coarse turn-level signal is the honest first cut.)

4. **Wiring.** Extend the existing post-turn learner install (`skill-learner-install.ts`) — NOT a second seam — so one `registerPostTurnLearner` callback does both: crystallize new proposals (existing) and update outcomes for promoted skills exercised this turn (new). They are independent best-effort steps in the same callback. Gated by a new env flag **`SKILL_OUTCOME_TRACKING_ENABLED`** (`"true"|"1"`, off by default), same shape as `SKILL_LEARNING_ENABLED`. Unlike crystallization, outcome tracking does NOT require the agent-memory backend — it writes to git-tracked files, so it works on the `file` backend too.

5. **Concurrency.** Two turns finishing near-simultaneously could both read-modify-write the same `SKILL.md`. Guard with a per-file serialization: an in-process async mutex keyed by absolute file path (the web app is single-process). This is sufficient for the in-process model; cross-process safety is out of scope (documented).

### Surfacing evolved confidence

The promoted `SKILL.md` frontmatter is already surfaced by the SIO-1014 loader in the `## Skills` catalog. Once counts evolve, the catalog naturally reflects current confidence with no extra render path. The agent-memory `[proposed-skill (unpromoted)]` recall line is unchanged (it only ever showed the seed, and unpromoted proposals are not tracked).

### Acceptance criteria

- With `SKILL_OUTCOME_TRACKING_ENABLED=true`, a successful turn that applied a promoted skill bumps that skill's `usage_count`+`success_count` and recomputes `confidence` in its `SKILL.md`; a failed turn bumps `usage_count`+`failure_count`.
- The recomputed frontmatter still parses cleanly under `SkillFrontmatterSchema`.
- A turn that applied no promoted skill writes nothing.
- Unpromoted proposals (agent-memory `kind:skill` facts) are never modified — the immutability invariant holds.
- Disabled by env → updater is a no-op.
- Confidence uses Laplace smoothing: 0/0/0 → 0.5; recompute is exercised in a unit test.
- `bun run typecheck && bun run lint && bun run test` pass.

### Files

| File | Change |
| -- | -- |
| `packages/agent/src/skill-outcome.ts` | NEW: `recordSkillOutcome`, `nextFrontmatter` (pure), `computeConfidence` (Laplace), per-path mutex, env gate |
| `packages/agent/src/skill-learner-install.ts` | extend the post-turn callback to also call the outcome updater for promoted skills exercised this turn |
| `packages/agent/src/skill-learner-install.ts` (TurnReader) | extend `SkillLearnerTurn` (or the reader ctx) to report on-disk skills applied this turn |
| `apps/web/src/lib/server/agent.ts` | the existing `installSkillLearner(...)` call already runs both halves; ensure the turn reader reports applied skills |
| `packages/agent/src/skill-outcome.test.ts` | NEW: Laplace math, success/failure bumps, schema-valid after rewrite, env-off no-op, no-skill no-op, unpromoted untouched |

### Out of scope (both tickets)

- Auto-loading or auto-promoting skills into live prompts (propose-only invariant holds).
- A per-skill LLM outcome judge (coarse turn-level success signal is the first cut).
- Cross-process write safety for `SKILL.md` (in-process mutex only).
- Tracking confidence for unpromoted proposals (Option 1/2 territory; explicitly rejected).
- Mutating durable agent-memory `kind:skill` facts (impossible by constraint; the seed stays).

## Memory references

- `reference_agent_memory_recall_dedup` — durable facts are undeletable; re-record doubles. Drives the immutability constraint.
- `reference_iac_change_outcome_completed_mislabel` / SIO-1005 reconcile — the append+dedupePreferring precedent considered as Option 2.
- `reference_agent_memory_paraphrases_on_ingest` — agent-memory paraphrases fact bodies on write; the body parser in SIO-1017 must tolerate paraphrase (parse leniently, fall back to raw text).
