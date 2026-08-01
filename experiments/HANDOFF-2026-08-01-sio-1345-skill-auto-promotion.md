# Handover: SIO-1345 — decide the skill auto-promotion approach

**Date:** 2026-08-01
**Ticket:** [SIO-1345](https://linear.app/siobytes/issue/SIO-1345/skill-learning-no-auto-promotion-path-promoting-a-proposed-skill) (Siobytes team)
**Parent epic/audit:** the KG (lbug) + Agent Memory subsystem audit, 2026-08-01 — see [SIO-1339](https://linear.app/siobytes/issue/SIO-1339) through [SIO-1344](https://linear.app/siobytes/issue/SIO-1344) (all merged, [devops-incident-analyzer#565](https://github.com/zx8086/devops-incident-analyzer/pull/565), squash-merged to `main` at `fb2a36aab26c92f444940ed4b781d1b8df737f49`)
**Repo state at handover:** `main` @ `fb2a36aab26c92f444940ed4b781d1b8df737f49` (PR #565 merged). No open branch for this ticket yet.
**Suggested branch name:** `claude/sio-1345-skill-auto-promotion`

## TL;DR

The skill-learning subsystem (`packages/agent/src/skill-learner.ts`) proposes reusable skills as durable `kind:skill` facts, but turning a proposal into a real, loadable `SKILL.md` requires a human to run a CLI (`skill-promote-cli.ts`) and then hand-edit `agent.yaml`'s `skills:` list — there is no automated path. This ticket asks: **should there be one, and if so what shape?** It is explicitly a design decision, not a drop-in fix — this handover exists so a fresh session can pick up the investigation with corrected facts (the original audit's problem statement was directionally right but got one significant detail wrong, corrected below) and actually decide + implement, rather than re-discovering the same ground.

**What's done:** nothing implemented yet. This is 100% investigation-to-date, now corrected and consolidated.
**What's next:** read the corrected findings below, then either (a) design and implement a promotion-assist mechanism, or (b) explicitly decide the manual gate is intentional (see the open question at the end) and close the ticket as won't-fix with that reasoning recorded.
**Gotcha already hit once:** the original ticket description (written same-day, before re-verification) claims "no auto-increment path for usage_count/success_count/failure_count... was found." That is **wrong** — re-verifying against current `main` found a real, tested, but production-inert counters mechanism. See "Corrected finding" below before you design anything, or you'll solve a problem that doesn't quite exist as originally stated.

## Context — how this ticket came to be

This ticket was filed during a broader audit of the Knowledge Graph and Agent Memory subsystems (kickoff prompt: `project_kg_agent_memory_audit_next_session` memory, follow-up: `project_kg_agent_memory_audit_complete` memory — both in `/Users/Simon.Owusu@Tommy.com/.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/`). That audit found 6 concrete bugs/gaps (SIO-1339–1344), all fixed and merged in PR #565. A separate **effectiveness assessment** (not a bug hunt — "is this subsystem actually useful to the agents, or just present") surfaced that skill-learning's five-gate funnel (feature flag → agent-memory backend → complex query → confidence ≥ 0.6 → ≥2 datasources → LLM worthiness judge → dedup check) terminates in a **fully manual** promotion step, capping the subsystem's real-world value regardless of how well the upstream gates work. SIO-1345 was filed to track deciding what, if anything, to do about that manual bottleneck.

## Where the bodies are buried

### The proposal funnel (this part is fine, no action needed)

`packages/agent/src/skill-learner.ts:182-204` (`learnFromTurn`):
```ts
export async function learnFromTurn(turn: SkillLearnerTurn, nowIso: string): Promise<void> {
	if (!isSkillLearningEnabled()) return;
	// Durable proposals require the agent-memory backend; on the file default there
	// is nowhere to store a kind:skill fact, so the learner is a no-op.
	if (selectedBackend() !== "agent-memory") return;

	const skip = preGateSkip(turn);
	if (skip) {
		logger.debug({ threadId: turn.threadId, reason: skip }, "skill-learner pre-gate skip");
		return;
	}

	const proposal = await judgeTurn(turn);
	if (!proposal?.name) return;

	if (await skillProposalExists(proposal.name)) {
		logger.debug({ skill: proposal.name }, "skill proposal already exists; skipping (dedup)");
		return;
	}

	enqueueFact(buildSkillFactText(proposal), nowIso, buildSkillAnnotations(proposal, turn.threadId, nowIso));
	logger.info({ skill: proposal.name, category: proposal.task_category }, "crystallized skill proposal");
}
```
Gates: `skill-learner.ts:28-33` (`MIN_CONFIDENCE = 0.6`, `MIN_DISTINCT_DATASOURCES = 2`), `skill-learner.ts:79-86` (`preGateSkip`, also requires `agentName === "incident-analyzer"` and `queryComplexity === "complex"`). This whole chain is correctly implemented, tested, and not the problem — don't touch it.

Env in the live `.env` at handover time: `SKILL_LEARNING_ENABLED` is **unset** (confirmed via `grep "^SKILL_LEARNING_ENABLED=" .env`, no match) — so in THIS environment the learner is currently off, independent of everything below. Agent Memory itself IS live here (`LIVE_MEMORY_ENABLED=true`, `LIVE_MEMORY_BACKEND=agent-memory`, confirmed against the real `.env`, not `.env.example` — see `feedback_validate_env_not_env_example` memory for why that distinction matters).

### The manual promotion step (this is the actual gap)

`packages/agent/src/skill-promote-cli.ts` (full file, 88 lines) — reads a `kind:skill` fact by name, renders it to a `SKILL.md` draft, writes it to `agents/<agent>/skills/<name>/SKILL.md`. Key facts, re-verified against current `main`:

- `parsePromoteArgs` (`skill-promote-cli.ts:32-48`) accepts only `--agent`, `--skill`, `--force`. **There is no `--add-to-manifest` flag** despite the file's own header comment (lines 7-8, 14-15) describing one — that comment is stale/aspirational, not implemented. Confirmed by reading the full file: `PromoteArgs` interface (line 26-30) has exactly `{agent, skill, force}`, and `main()` (lines 58-86) only ever calls `console.log(manifestHint(...))` (line 82) — it prints the line to paste into `agent.yaml`, never writes it.
- `manifestHint()` (`skill-promote-cli.ts:52-55`) is literally: `"To load this skill, add it under \`skills:\` in agents/${agent}/agent.yaml:\n  - ${skill}"`.
- `agent.yaml`'s `skills:` list (e.g. `agents/incident-analyzer/agent.yaml` — same pattern this session just used for `agents/elastic-iac/agent.yaml`'s `search-memory` entry in SIO-1344) is a static, hand-curated array. Nothing reads it dynamically from a "promoted" flag anywhere else.

So the two real manual steps are: (1) run the CLI, (2) hand-paste the printed line into `agent.yaml`. Confirmed, not changed from the original ticket's framing.

### Corrected finding — the counters DO exist, but are wired to a documented no-op

**This is the part the original SIO-1345 description got wrong.** Re-verifying against current `main` (not just the original audit's notes) found:

`packages/agent/src/skill-outcome.ts` (full file, 165 lines) implements a real, tested, Laplace-smoothed confidence-update mechanism:
- `computeConfidence(successCount, usageCount)` (line 34-36): `(success + 1) / (usage + 2)`.
- `nextFrontmatter()` (line 41-52): bumps `usage_count`/`success_count`/`failure_count` and recomputes `confidence` on a **promoted skill's SKILL.md frontmatter** (not the durable fact — the fact is immutable once written; the file is the mutable home, per the header comment at lines 3-8).
- `recordSkillOutcome()` (line 144-164): the actual file I/O, per-path mutex-locked, best-effort, gated on `SKILL_OUTCOME_TRACKING_ENABLED`.

**But**, per the code's own comment at `skill-learner-install.ts:33-36`:
> "there is no reliable per-turn 'this catalog skill was applied' signal today, so the production reader returns `appliedSkills:[]` (a documented no-op) until a follow-up ticket adds an application trace. The mechanism is shipped + tested so wiring it later is trivial."

And `skill-outcome.ts:135`: `recordSkillOutcomesForTurn` early-returns when `applied.length === 0` — which, per the caller comment above, is always true in production today.

**What this means for SIO-1345's scope**: the counters/confidence-tracking half of "how would a human know which proposal is worth promoting" is NOT missing infrastructure — it's shipped, tested, and sitting inert behind one missing piece: a per-turn "which promoted skills were actually applied this turn" trace, explicitly called out in the code as a known, anticipated follow-up. That's a **narrower, more specific, already-partially-scoped problem** than "no counters exist," and it only helps *post-promotion* confidence tracking anyway — it does nothing for the actual bottleneck this ticket is about, which is the **pre-promotion** decision (which of N proposed-but-never-promoted `kind:skill` facts is worth a human's time to promote at all). Don't conflate the two; a fresh session should scope any fix narrowly to whichever of these two gaps it's actually trying to close, and say explicitly which one it picked.

### The proposal discovery problem (the real pre-promotion gap, mostly unaddressed)

There is currently no tooling to **list** pending `kind:skill` proposals in one place — a human who wants to promote something has to already know the `skill_name` to pass to `skill-promote-cli.ts --skill <name>`. Confirmed: `grep -rn "kind.*skill" packages/agent/src/*.ts` finds writers/readers of individual skill facts (`skillProposalExists` at `skill-learner.ts:139`, dedup-only) but no list-all-proposals query or CLI subcommand. This is the actual "how would anyone find out there's something to promote" gap.

## The fix (three options, not yet chosen between)

No option has been implemented. A fresh session should pick one (or propose a fourth) and write a real plan before touching code — this repo's CLAUDE.md requires a Linear issue with the full plan before implementation begins, and SIO-1345 already exists as that issue, so update its description with the chosen plan rather than opening a new ticket.

1. **Lower-effort: a "list pending proposals" report/digest.** Add a query (mirrors `skillProposalExists`'s pattern, but returns all `kind:skill` facts for an agent instead of checking one name) and either a CLI subcommand (`skill-promote-cli.ts --list`) or a periodic digest (Slack/log/whatever this project's existing digest mechanisms are — check `docs/architecture/agent-concepts.md` or search for existing "digest"/"report" cron patterns before inventing one). Closes the discovery gap only; doesn't touch the counters question at all. Smallest, safest first step.
2. **Higher-effort: wire the missing per-turn application trace, then use real counters to prioritize.** Implement whatever `skill-learner-install.ts:33-36`'s comment anticipates — a way to know, per turn, which *promoted* skills were actually applied — then optionally add a threshold-based "this proposal has fired N times successfully, consider promoting" signal to option 1's digest. Only makes sense for skills that are ALREADY promoted (the counters live on the SKILL.md frontmatter, which doesn't exist until promotion) — so this doesn't help decide the FIRST promotion, only whether to keep/deprecate an already-promoted one. Re-read this distinction carefully before scoping; it's easy to conflate "which proposal to promote" with "which promoted skill to keep," and they need different mechanisms.
3. **Decide against automation entirely, close as won't-fix.** `agent.yaml`'s `skills:` list is also this agent's capability/scope boundary — every hand-authored skill is presumably reviewed before being added. A learned-and-auto-promoted skill would bypass that review. Before building 1 or 2, it's worth explicitly asking whoever designed the SIO-1126 HIL learning lane (the human-in-the-loop learning system this skill-learning subsystem is part of) whether the manual gate is a deliberate security/review boundary, not an oversight. If so, the right fix might just be option 1 (make proposals easy to FIND) with promotion staying manual forever by design — record that decision explicitly in SIO-1345 either way, since "we decided this is fine" is a valid, useful outcome too, not a failure to close the ticket.

## Verification

Whatever gets built:
```bash
bun run typecheck && bun run lint && bun test packages/agent/src/skill-learner.test.ts packages/agent/src/skill-outcome.test.ts packages/agent/src/skill-promote.test.ts packages/agent/src/skill-promote-cli.test.ts
```
Expected: all green, no new failures. If a live check is feasible (agent-memory backend reachable — confirm via `curl http://localhost:8070/health` returning `{"status":"healthy",...}`, matching this session's confirmed-live instance), smoke-test whichever mechanism you build against a real proposal fact rather than only unit tests.

## Files to modify (depends on chosen option)

| File | Likely change (option-dependent) |
|---|---|
| `packages/agent/src/skill-promote-cli.ts` | Option 1: add a `--list` subcommand or similar discovery command |
| `packages/agent/src/skill-learner.ts` | Option 1: possibly export a new "list all proposals" query alongside the existing `skillProposalExists` |
| `packages/agent/src/skill-learner-install.ts` | Option 2: wire the actual per-turn applied-skills reader (currently `appliedSkills:[]` stub, per its own comment) |
| `packages/agent/src/skill-outcome.ts` | Option 2 only: likely unchanged — the mechanism is already correct, just needs a real caller |
| SIO-1345 (Linear) | All options: update with the chosen plan before implementing; or close with recorded reasoning if option 3 |

## Workflow

- Branch off `main` (already has SIO-1339–1344 merged): `git checkout main && git pull && git checkout -b claude/sio-1345-skill-auto-promotion`.
- Linear: SIO-1345 is already In Backlog. Move to In Progress when starting, In Review when a PR opens, Done only with explicit user approval (never auto-transition, per this repo's global rule — note `reference_linear_pr_link_auto_transitions_to_done` memory: a merged PR with the Linear link WILL auto-flip it to Done, so if you want a human review step before Done, don't link the PR body to the issue until ready, or explicitly note the auto-transition to the user).
- Commit format: `SIO-1345: <message>`.
- PR: ready for review, never draft (repo-wide rule).
- CodeRabbit: triage every finding before merge, verify against live code first — see `reference_coderabbit_triage_verify_before_apply` memory and the CLAUDE.md "CodeRabbit Review Lifecycle" section for the exact SHA-scoped completion check. This session's PR #565 needed 3 full rounds of triage before it cleared (see that PR's history for a worked example of the reply+resolve pattern).

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Conflating "which proposal to promote" (pre-promotion) with "which promoted skill to keep" (post-promotion, counters-based) | High — this handover's own corrected finding shows how easy it is to conflate these | Scope the fix to exactly one; state which in the plan |
| Building automation that bypasses the deliberate human-review boundary on `agent.yaml`'s skill list | Medium | Ask the SIO-1126 designer before building option 2's promotion-trigger half; option 1 (discovery only) carries no such risk |
| `SKILL_LEARNING_ENABLED` being unset in this environment means nothing here is live-testable without first turning it on | Certain (confirmed this session) | Set it locally for testing; don't assume prod has it on either — check `.env`, not `.env.example`, in whatever environment you're validating against |
| Re-trusting the ORIGINAL SIO-1345 ticket text over this handover's corrected finding | Medium (Linear tickets don't auto-update when someone re-verifies) | This handover supersedes the original ticket's counters claim; update SIO-1345's Linear description with the correction as one of the first things you do |

## Out of scope

- Re-litigating SIO-1339–1344 — all merged and closed, don't reopen without new evidence.
- The question of whether `LIVE_MEMORY_ENABLED`/`LIVE_MEMORY_BACKEND` should default to `agent-memory` repo-wide — that was explicitly investigated and NOT ticketed this session (the user corrected an initial wrong assumption that it defaults off; see `feedback_validate_env_not_env_example` memory). Not this ticket's concern.
- Building the missing per-turn "applied skills" trace UNLESS option 2 is chosen — don't build it speculatively if option 1 or 3 is chosen instead.

## Related code references (already-correct patterns to reuse, not touch)

- `packages/agent/src/skill-learner.ts:139` (`skillProposalExists`) — the existing dedup-by-name query pattern; a "list all" query should look similar.
- `agents/elastic-iac/skills/search-memory/SKILL.md` + `agents/elastic-iac/agent.yaml:39` — this session's SIO-1344 work is the most recent example of manually wiring a skill into an `agent.yaml` skills list plus a matching gitagent-bridge fixture test (`packages/gitagent-bridge/src/elastic-iac-load.test.ts`'s `"search-memory skill content is loaded and reaches the assembled prompt"` test) — if option 1 or 2 ever needs to prove a promoted skill actually loads, that test is the template to copy.
- `packages/gitagent-bridge/src/skill-tool-coverage.test.ts` — this repo's established pattern for build-time (not LLM-behavior) structural canaries over skill/prompt content; useful if the chosen option needs any new structural guarantee.

## Memory references

- `project_kg_agent_memory_audit_complete` — the full audit this ticket originated from, all 6 sibling tickets' final disposition.
- `project_kg_agent_memory_audit_next_session` — the original kickoff prompt, still useful for the 9 KG + 6 Agent Memory gotchas (unrelated to this ticket but useful background if you end up touching adjacent code).
- `feedback_validate_env_not_env_example` — the correction from this session: always check the real `.env`, not `.env.example`, when asserting whether a subsystem is actually live in a given environment.
- `reference_hil_learning_lane_sio1126` — the HIL learning lane SIO-1126 built; read this before deciding option 3 (asking whether the manual promotion gate is a deliberate SIO-1126 design choice).
- `reference_skill_promotion_and_confidence` — prior memory on this exact seam (skill-promote.ts / confidence), predates this session's corrected finding about the counters mechanism — cross-check it against this handover's corrected version, don't trust it blindly if it repeats the "no counters" claim.
- `reference_coderabbit_triage_verify_before_apply`, `reference_coderabbit_review_latency_varies_widely` — CodeRabbit triage discipline, directly relevant since this ticket will go through the same review lifecycle PR #565 just did.
