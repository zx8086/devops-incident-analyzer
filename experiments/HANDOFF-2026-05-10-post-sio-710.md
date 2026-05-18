# Handoff -- post SIO-710 -- Kafka Admin singleton shipped, SIO-708 next

**Date:** 2026-05-10
**Branch on disk at handoff:** `main` at `aa25224`
**Working tree:** clean (only `experiments/` untracked, intentional and gitignored)
**Linear status:** SIO-710 **Done** (auto-closed by GitHub integration on PR #61 merge)

---

## What this handoff is

Continuation of `HANDOFF-2026-05-10-post-log-hygiene.md`. That handoff recommended SIO-710 as the next pickup. It shipped this session as PR #61. Three tickets remain from the styles-v3 fallout (SIO-708, SIO-709, SIO-711, SIO-712 -- four if counting the trust trio individually), plus SIO-701 still blocked and SIO-702 still in In Review.

The previous handoff is still useful context for the trust trio rationale and SIO-702 close-out -- this is an addendum, not a replacement.

---

## What shipped this session

| PR | Commit | Ticket | What |
|----|--------|--------|------|
| [#61](https://github.com/zx8086/devops-incident-analyzer/pull/61) | `aa25224` | SIO-710 | Admin singleton (per-process, mirrors Producer cache) + fix dead `requestTimeout` -> `timeout` knob + new `KAFKA_TOOL_TIMEOUT_MS` env (default 30s) |

Done in Linear. Test counts at session end: kafka 209/209 pass, agent 275/275, atlassian 73/73, gitlab 28/28, shared 133/133. Workspace typecheck clean across all 12 packages. Pre-existing fails unchanged (couchbase 1, konnect 35, elastic crashes on missing `ES_URL`).

---

## What's still open from the styles-v3 fallout

### Theme 1 -- the remaining infrastructure timeout (high impact)

| ID | Priority | Title | Status |
|----|----------|-------|--------|
| **[SIO-708](https://linear.app/siobytes/issue/SIO-708)** | High | Elastic sub-agent: 4/4 `elasticsearch_search` timeouts on 1B-doc indices | Backlog |

Now the headline blocker. Same playbook as SIO-710 hypothetically applies (look for connection lifecycle + per-call timeout knob), but the surface is different: Elastic's HTTP client is `@elastic/elasticsearch`, not `@platformatic/kafka`, and the timeout-per-search is likely a per-request `requestTimeout` option on the search call itself rather than a connection knob. **First step is the query shape**: 1B-doc indices with an unbounded scan will time out regardless of connection reuse. Look at the styles-v3 transcript (the user has it locally) for the actual `elasticsearch_search` body before assuming it's a client-side fix.

**Recommended next pickup.**

### Theme 2 -- the trust trio (medium impact, harder validation)

| ID | Priority | Title | Status |
|----|----------|-------|--------|
| [SIO-709](https://linear.app/siobytes/issue/SIO-709) | Medium | Aggregator confidence (0.71) too high when critical metrics couldn't be re-verified live | Backlog |
| [SIO-711](https://linear.app/siobytes/issue/SIO-711) | Medium | Aggregator volunteered "not fabricated" -- meta-signal of LLM uncertainty | Backlog |
| [SIO-712](https://linear.app/siobytes/issue/SIO-712) | Medium | GitLab-vs-Couchbase deployment-vs-runtime contradiction recognised in prose but didn't fire a correlation rule | Backlog |

Bundle. Unchanged since the previous handoff. The styles-v3 transcript is the regression fixture for all three.

Note: SIO-707 already added a deterministic `confidenceCap: 0.6` when sub-agent toolErrorRate > 25%. SIO-709 is a different signal (LLM self-flagging "Gaps" but still > 0.6); possible approach is to parse the report's "Gaps" section in the aggregator and cap confidence further when non-empty.

### Theme 3 -- cross-account IAM (blocked)

| ID | Priority | Title | Status |
|----|----------|-------|--------|
| [SIO-701](https://linear.app/siobytes/issue/SIO-701) | High | Apply full-coverage IAM policy to `kafka-mcp-agentcore-role-dev` | Blocked |

Unchanged. Policy JSON staged at `/tmp/kafka-mcp-full-policy.json`. Runbook at `experiments/SIO-701-iam-policy-runbook.md`. Needs IAM-write credentials in AWS account `352896877281`.

**Indirect effect of SIO-710 shipping:** the `KAFKA_TOOL_TIMEOUT_MS` env (default 30s) is now the concrete knob to widen if the live MSK probe (once SIO-701 lands) shows borderline timing. MSK provider already overrides to 60s in `packages/mcp-server-kafka/src/providers/msk.ts:55` so the default is moot for AgentCore-on-MSK; it's the local/Confluent paths that pick up the new 30s default.

### Theme 4 -- pending live verification (don't mark Done yet)

[SIO-702](https://linear.app/siobytes/issue/SIO-702) -- still in **In Review**. Per the prior handoff: live integration probe (set `tokenObtainedAt: 0`, fire 10 concurrent `gitlab_search` calls, confirm exactly one `OAuth tokens saved` and zero `OAuth credentials invalidated`). No change.

---

## Recommended pickup order for the next session

1. **[SIO-708](https://linear.app/siobytes/issue/SIO-708)** -- Elastic search timeouts. Start with the query shape from the styles-v3 transcript before assuming a client-side fix. If it really is unbounded scan, the fix may live in the action-driven tool YAML (force a `track_total_hits: false` or smaller default `size`) rather than client config.
2. **Trust trio bundle** ([SIO-709](https://linear.app/siobytes/issue/SIO-709) + [SIO-711](https://linear.app/siobytes/issue/SIO-711) + [SIO-712](https://linear.app/siobytes/issue/SIO-712)). Aggregator-side work; styles-v3 transcript is the fixture.
3. **[SIO-701](https://linear.app/siobytes/issue/SIO-701)** -- whenever cross-account access materialises. Live MSK probe also validates the SIO-710 fix end-to-end.
4. **[SIO-702](https://linear.app/siobytes/issue/SIO-702)** close-out -- the headless-with-expired-token probe.

---

## What's worth knowing about SIO-710 (for the next session)

- **Library was @platformatic/kafka, not kafkajs.** Handoff hypothesis named kafkajs's `AdminClient`; the actual library is `@platformatic/kafka` and the construct was `Admin` (extends `Base` which owns a `ConnectionPool`). Same underlying pathology, different class names. If anyone references the original hypothesis, translate the names.
- **The `requestTimeout` knob was a no-op before this PR.** `client-manager.ts:18` wrote `opts.requestTimeout = ...`, but the library schema is `additionalProperties: false` and the actual option is `timeout`. The value was silently dropped. Renamed `KafkaConnectionConfig.requestTimeout` -> `timeout` and the call site uses `opts.timeout`. If you see any external doc or env reference to `KAFKA_REQUEST_TIMEOUT_MS`, it never existed -- the new env is `KAFKA_TOOL_TIMEOUT_MS`.
- **Library defaults are tighter than expected.** `connectTimeout: 5000`, `timeout: 5000`, `retries: 3`, `retryDelay: 1000`. Worst-case ~23s per call before the library throws. The new `KAFKA_TOOL_TIMEOUT_MS` (default 30000) lifts the per-RPC `timeout`; `connectTimeout` and retries are unchanged. If sleepy MSK still trips, lift `connectTimeout` next (no env knob exists for it yet -- would need a `KAFKA_CONNECT_TIMEOUT_MS` env mapping mirroring the new one).
- **Provider-supplied timeout wins.** `MskKafkaProvider` overrides to 60s at `providers/msk.ts:56` (and the same line was renamed `requestTimeout` -> `timeout` in this PR). The env-driven default only applies to local/Confluent paths.
- **No outer `Promise.race` wrapper.** A regression-guard test (`does not race fn(admin) against an outer timer`) pins this. The library's own `timeout` already binds first; an outer wrapper would be either redundant (loose) or a footgun (tight, would reject fn() that the library would otherwise complete). Don't reintroduce one.
- **Thundering-herd guard via `adminInitPromise`.** Concurrent `withAdmin` callers during cold-start share the same Admin construction. Asserted by `concurrent withAdmin callers share a single Admin construction` test.
- **Test seam stayed compatible.** `withAdmin<T>(fn) -> Promise<T>` signature unchanged. The other `kafka-service-*.test.ts` files fake the manager as `{ withAdmin: async (fn) => fn(fakeAdmin) }` and continue to work. Backward-compat pinned by an explicit test.

---

## Don'ts (carry-forward)

- **Don't mark SIO-702 Done.** Still waiting on the live integration probe.
- **Don't change `MCP_OAUTH_HEADLESS=true`.** Production posture.
- **Don't bundle SIO-708 with anything else.** Different surface (Elastic) from SIO-710 (Kafka); separate PRs let CI bisect.
- **Don't push directly to main.** Code goes through PR review.
- **Don't apply SIO-701 from the user's usual shell** -- wrong AWS account.
- **Don't reintroduce a `Promise.race` outer timer in `withAdmin`.** Library `timeout` is the only timeout we want; the regression-guard test exists for a reason.

---

## Useful pointers for the next session

- **First skill to invoke:** `superpowers:using-superpowers` (always), then `superpowers:systematic-debugging` for SIO-708 (debug-led ticket).
- **First file to read for SIO-708:** `agents/incident-analyzer/tools/elastic-logs.yaml` -- the action-driven tool bundle the elastic-agent loads via `tools: - elastic-logs` in `agents/incident-analyzer/agents/elastic-agent/agent.yaml`. MCP-side registration is at `packages/mcp-server-elastic/src/tools/index.ts:206`; implementation at `packages/mcp-server-elastic/src/tools/core/search.ts`. The styles-v3 transcript will show the actual query body that timed out -- without it, you're guessing.
- **Verification before claiming done:** every ticket runs `bun run typecheck`, `bun run lint`, and the touched-package tests. Capture actual output -- never claim "tests pass" without it.
- **Pre-existing test failures on main:** ~34, all unrelated -- Konnect/Couchbase live-service integration tests, PII redactor source scans, structured-logging source scans, plus mcp-server-elastic crashes on missing `ES_URL`. Don't be alarmed.
- **MSK-related changes:** the manual MSK probe in the SIO-710 PR description is still pending (deferred until SIO-701 lands cross-account access). Once SIO-701 is unblocked, drive 20 sequential `kafka_get_consumer_group_lag` calls and confirm zero timeouts + `Creating new Kafka admin client` logs exactly once -- that's the live regression check the unit reproducer can't fully cover.

---

## Cross-references

- [PR #61](https://github.com/zx8086/devops-incident-analyzer/pull/61) -- SIO-710 (this session)
- [HANDOFF-2026-05-10-post-log-hygiene.md](HANDOFF-2026-05-10-post-log-hygiene.md) -- the previous handoff; still load-bearing for the trust trio rationale and SIO-702 close-out
- [HANDOFF-2026-05-10-post-sio-702.md](HANDOFF-2026-05-10-post-sio-702.md) -- the original styles-v3 fallout summary; still load-bearing for SIO-708's hypothesis context
- [SIO-701-iam-policy-runbook.md](SIO-701-iam-policy-runbook.md) -- runbook for the cross-account IAM apply

---

*Handoff produced 2026-05-10 by Claude Opus 4.7 (1M context). One ticket shipped this session (SIO-710); three remain from the styles-v3 fallout (SIO-708, plus the SIO-709/711/712 trust trio); plus SIO-701 blocked on cross-account auth and SIO-702 still in In Review. Recommended next pickup: SIO-708.*
