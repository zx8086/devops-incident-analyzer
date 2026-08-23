# HANDOFF: SIO-1525 follow-ups -- terminalize renovate-lane KG changes (+ smaller import-sweep items)

- **Date**: 2026-08-23
- **Ticket**: none yet -- create a Siobytes issue at pickup (per workflow rules) and add it to the [DevOps Incident Analyzer project](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a). Parent context ticket: [SIO-1525](https://linear.app/siobytes/issue/SIO-1525/import-external-gitlab-config-changes-into-agent-memory-knowledge) (Done). Related: [SIO-1475](https://linear.app/siobytes/issue/SIO-1475) (renovate lane), [SIO-1005](https://linear.app/siobytes/issue/SIO-1005) (reconcile sweep).
- **Repo state**: `main` @ `f6640eb9` (docs: bake-off head-to-head for PR #675). Feature landed in PR [#675](https://github.com/zx8086/devops-incident-analyzer/pull/675), squash `7f5e8442`.
- **Suggested branch**: `claude/renovate-lane-terminal-outcome`

## TL;DR

SIO-1525's gitlab-import sweep is live and verified (76 records backfilled into KG + Agent Memory, recall proven end-to-end). It exposed one real gap it deliberately does NOT fix: a renovate change the AGENT itself triggers ends up with **no terminal record in either store**. The lane's KG `ConfigChange` is written `outcome:"proposed"` with **no MR edge** (mrUrl unknown at trigger time), so the KG reconcile sweep can never advance it -- and the import sweep intentionally commit-skips the merged commit because the agent's `renovate-trigger` memory fact carries that `mr_url`. Success = an agent-triggered renovate MR that merges eventually shows `outcome:"applied"` on its lane ConfigChange (or an equivalent terminal record), without double-recording.

## Context -- how this surfaced

SIO-1525 (spec: the "Plan" section of the Linear issue; implementation PR #675) imports externally-made GitLab config changes into both durable stores. During review round 2 the commit-level MR dedupe was tightened so the importer skips commits whose MR this agent already recorded -- including via `kind:"renovate-trigger"` facts (added after the live probe showed merged renovate MRs would otherwise double-record). Correct for dedupe, but it means the *import* path will never supply the missing "applied" record for agent-triggered renovate merges either. Bot-made Renovate MRs (no agent fact) are unaffected -- they import fine (verified live: eu-b2b MR !516 `security_detection_engine` imported and surfaced in recall).

## Where the bodies are buried

1. **The lane write has no MR edge, by design** -- [packages/agent/src/iac/nodes.ts:918-930](../packages/agent/src/iac/nodes.ts):

```ts
	// SIO-1475: one KG ConfigChange write per trigger, here (not in watchRenovateMr) so a
	// later "check again" re-poll never writes a duplicate node for the same logical trigger --
	// ...  mrUrl is intentionally omitted -- it is not
	// known yet at trigger time; see the design spec's explicit "what this does NOT do" note.
	await recordLaneConfigChange({
		id: state.requestId,
		deployment: inFlight.deployment,
		workflow: "renovate",
		outcome: "proposed",
		summary: `renovate ${inFlight.deployment} -> ${marker.marker}`,
		threadId: state.threadId || undefined,
	});
```

2. **The MR url IS learned later** -- `watchRenovateMr` captures it at [nodes.ts:1005](../packages/agent/src/iac/nodes.ts) (`renovateMrUrl: mrUrl`) and the durable fact records it at [nodes.ts:11184](../packages/agent/src/iac/nodes.ts) (`if (state.renovateMrUrl) a.mr_url = state.renovateMrUrl;` in `buildRenovateFactAnnotations`) -- but nothing ever writes the KG `PROPOSED_IN` edge or advances the node.

3. **The KG reconcile sweep requires the MR edge** -- `proposedChangesWithMr` at [packages/knowledge-graph/src/reader.ts:610](../packages/knowledge-graph/src/reader.ts) matches `(c:ConfigChange)-[:PROPOSED_IN]->(m:MergeRequest)`; a lane node without the edge never qualifies, so it stays `"proposed"` forever.

4. **The import sweep deliberately skips these commits** -- [packages/agent/src/iac/gitlab-import.ts:458](../packages/agent/src/iac/gitlab-import.ts) builds the commit-level skip set from `["iac-change", "renovate-trigger"]` fact kinds, and [gitlab-import.ts:656-657](../packages/agent/src/iac/gitlab-import.ts) skips the whole commit when `recordedMrUrls.has(mr.url)`. Do NOT "fix" this by removing renovate-trigger from the skip set -- that reintroduces the double-record the live probe caught.

## The fix (step-by-step)

Preferred shape: **give the lane node its MR edge once the MR is known, and let the existing reconcile machinery do the rest.** No new sweep, no new store semantics.

1. In `watchRenovateMr` ([nodes.ts around 1005](../packages/agent/src/iac/nodes.ts)), when `mrUrl` is first resolved for the in-flight trigger, re-write the lane change WITH the MR link. `recordLaneConfigChange` drops `mrUrl`? No -- it forwards it ([packages/agent/src/iac/lane-knowledge.ts:71-80](../packages/agent/src/iac/lane-knowledge.ts), `LaneChangeInput.mrUrl` exists); it drops only `filePaths`/`createdAt`. So:

```ts
	// SIO-XXXX: attach the MR to the trigger-time ConfigChange so the KG reconcile sweep
	// (proposedChangesWithMr requires the PROPOSED_IN edge) can advance it to applied/
	// rejected/failed. MERGE-idempotent on id: re-polls re-attach the same edge harmlessly.
	await recordLaneConfigChange({
		id: <the trigger turn's requestId -- see gotcha below>,
		deployment,
		workflow: "renovate",
		outcome: "proposed", // unchanged; reconcile owns the terminal transition
		mrUrl,
		threadId: state.threadId || undefined,
	});
```

2. **Gotcha -- the id**: the trigger-time node used `state.requestId` of the TRIGGER turn. A later "check again" turn has a NEW requestId, so the resume path must recover the original id or the write creates a second node. The durable in-flight marker (`renovateInFlightMarker`, written at trigger) is the natural carrier -- add the trigger `requestId` to it (it already persists `deployment/marker/line/triggerAtIso`, [nodes.ts:911-916](../packages/agent/src/iac/nodes.ts)) and thread it back on resume. Same-turn resolution (trigger and MR discovered in one turn) can just reuse `state.requestId`.
3. **Verify reconcile compatibility**: `reconcileKnowledgeGraph` derives the iid from the url (`mrIidFromUrl`, [packages/agent/src/iac/reconcile.ts:437](../packages/agent/src/iac/reconcile.ts)) and calls `fetchMrLiveState` -- nothing renovate-specific needed. The memory-side `enumerateUnreconciledChanges` keys on `kind:"iac-change"` facts with `mr_iid`; renovate facts are `kind:"renovate-trigger"` so the memory leg is untouched (acceptable: the KG node is the system of record for outcome; extend later only if memory-side terminal facts are wanted).
4. Update `docs/architecture/agent-pipeline.md` / the SIO-1475 design note ("what this does NOT do") to reflect that the MR edge IS now written post-discovery.

## Verification

```bash
bun run typecheck && bun run lint
cd packages/agent && bun test          # incl. lane-knowledge + renovate tests
cd ../knowledge-graph && bun test src/knowledge-graph.test.ts   # full suite crashes on a PRE-EXISTING ladybug.integration segfault; run unit files
```

Manual probe (app running, `KNOWLEDGE_GRAPH_ENABLED=true`): trigger a renovate update via the agent, wait for the MR, then query the in-process KG MCP (:9087, note the arg is `cypher`, not `query`):

```bash
curl -sS -X POST http://localhost:9087/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kg_run_cypher","arguments":{"cypher":"MATCH (c:ConfigChange {workflow: '"'"'renovate'"'"'})-[:PROPOSED_IN]->(m:MergeRequest) RETURN c.id, c.outcome, m.url"}}}'
# expect: the trigger node with the MR url; after merge + a reconcile sweep tick (*/30), outcome advances to applied
```

Expected: exactly ONE ConfigChange per trigger (re-polls must not mint new nodes), and the gitlab-import sweep still reports the merged commit as `skippedAlreadyRecorded` (its log line: `gitlab-import sweep complete`).

## Files to modify

| File | Change |
|---|---|
| `packages/agent/src/iac/nodes.ts` | Re-write lane change with `mrUrl` in `watchRenovateMr` once resolved; add trigger `requestId` to `renovateInFlightMarker` |
| `packages/agent/src/iac/lane-knowledge.ts` | None expected (`mrUrl` already forwarded) -- confirm |
| `packages/agent/src/iac/renovate*.test.ts` (or the lane's existing test file) | New-node-vs-re-attach idempotency, resume-path id recovery |
| `docs/architecture/agent-pipeline.md` | Note the renovate lane now links its MR |

## Secondary follow-ups (separate, optional -- do NOT bundle into the ticket above)

1. **Durable watermark for the import sweep.** [gitlab-import.ts:427](../packages/agent/src/iac/gitlab-import.ts) keeps the watermark in-process only; every restart re-scans the full lookback window (30d default) and converges through dedupe. Correct but chatty: a cold process needs ~5 bootstrap sweeps (limit 50) or one cron tick (limit 200) to re-cover the window. If GitLab API volume ever matters, persist the watermark (a file under `apps/web/.data/`, or piggyback a memory fact). Low priority -- the module header documents the trade-off deliberately.
2. **Merge-commit titles make weak summaries.** Non-squash merges import with `change_summary` like "Merge branch 'x' into 'main'" ([gitlab-import.ts:384,586](../packages/agent/src/iac/gitlab-import.ts) use `commit.title`). When `getCommitMergedMrUrl` resolved an MR, prefer the MR title (one extra field off the already-fetched `/merge_requests` response). Cosmetic.
3. **Watch item, no action**: the memory dedupe sets are built from deterministic (filter-only) recall, which has no top-k truncation today (SIO-998). If the Agent Memory service ever caps deterministic responses, `importedIds` could under-fill and re-write facts; the KG per-id check remains authoritative when the graph is on.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Resume-path uses a fresh requestId -> duplicate renovate node | High if step 2's id recovery is skipped | Carry trigger requestId in `renovateInFlightMarker`; test asserts single node |
| Re-poll re-attaches edge repeatedly | Certain (by design) | MERGE-idempotent; no-op |
| Reconcile advances the node before the apply pipeline is understood for renovate MRs | Medium | `settleLifecycle`'s orphaned-apply aging rule (7d) already covers merged-no-apply-job; verify a renovate MR's apply path matches the gitops one before trusting `applied` |
| Editing nodes.ts (13k lines) import graph breaks minimal test mocks | Medium | Known class -- see memory `reference_iac_nodes_import_graph_breaks_minimal_mocks` |

## Out of scope

- Removing `renovate-trigger` from the import sweep's commit-level skip set (reintroduces double-records).
- Memory-side terminal facts for renovate (KG outcome is sufficient for now).
- Anything about the bake-off (both bots stay active; ledger is `docs/code-review-bakeoff.md`).
- Re-running the SIO-1525 backfill -- it is DONE in production (76 records, all ten 9.5.2 upgrades, recall verified 2026-08-23).

## Related code references (already-correct patterns to mirror)

- Fleet lane's terminal settlement via reconcile: `reconcileFleetOne` / `enumerateDispatchedFleetFacts`, [packages/agent/src/iac/reconcile.ts:233-335](../packages/agent/src/iac/reconcile.ts) -- the "durable marker carries identity for a later process to settle" pattern.
- KG reconcile advance: `reconcileKnowledgeGraph` [reconcile.ts:457](../packages/agent/src/iac/reconcile.ts).
- Import-side exclusion contract: `mrUrlHasChange` ignores `gitlab:` ids, [packages/knowledge-graph/src/writer.ts:494-505](../packages/knowledge-graph/src/writer.ts) -- the renovate fix must keep NON-import lane nodes matchable there.

## Memory references

`reference_sio1525_gitlab_import_sweep` (design + 5 live-probe gotchas), `reference_hil_learning_flag_and_learn_command` (n/a), `reference_iac_nodes_import_graph_breaks_minimal_mocks`, `reference_sio1005`-era notes via `feedback_auto_merge_after_greptile_triage`, `reference_pr661_review_gate_gotchas` (review-gate mechanics), `reference_agent_memory_relevant_k_default_10_truncation` (semantic-mode only; deterministic mode is the one the importer uses).
