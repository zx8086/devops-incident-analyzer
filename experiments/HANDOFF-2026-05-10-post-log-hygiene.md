# Handoff -- post log-hygiene -- 5 PRs shipped, 4 tickets remain from styles-v3 fallout

**Date:** 2026-05-10
**Branch on disk at handoff:** `main` at `5cc1595`
**Working tree:** clean (only `experiments/` untracked, intentional and gitignored)
**Linear status:** all five tickets shipped this session are **Done** (auto-completed by GitHub integration on PR merge)

---

## What this handoff is

Continuation of the post-SIO-702 work documented in `HANDOFF-2026-05-10-post-sio-702.md`. That handoff identified 10 issues from the styles-v3 production run (SIO-703 through SIO-712). Five are now shipped; four remain open; one (SIO-712) was renumbered/redirected -- see below. Plus SIO-701 (cross-account IAM, blocked).

The previous handoff is still useful context -- this one is an addendum, not a replacement.

---

## What shipped this session

| PR | Commit | Ticket | What |
|----|--------|--------|------|
| [#56](https://github.com/zx8086/devops-incident-analyzer/pull/56) | `61b6755` | SIO-707 | Per-failure tool error visibility in sub-agent logs + 25%/0.6 deterministic confidence cap |
| [#57](https://github.com/zx8086/devops-incident-analyzer/pull/57) | `a1e1cb3` | SIO-704 | Defensive Atlassian content parser shared across 3 custom wrappers; auth-required signal now propagates as `isError: true` |
| [#58](https://github.com/zx8086/devops-incident-analyzer/pull/58) | `d9a6bad` | SIO-706 | Triage-projection wrapper for `atlassian_getJiraIssue`; default response fits under 8KB |
| [#59](https://github.com/zx8086/devops-incident-analyzer/pull/59) | `1fb7ae3` | SIO-705 | Serialize MCP connect errors so the failure cause survives pino logging |
| [#60](https://github.com/zx8086/devops-incident-analyzer/pull/60) | `5cc1595` | SIO-703 | "server created" / "proxy tools registered" once per process instead of per-request |

All Done in Linear. Test counts at session end: agent 275/275, atlassian 73/73, gitlab 28/28, shared 133/133. Workspace typecheck clean across all 12 packages.

---

## What's still open from the styles-v3 fallout

### Theme 1 -- now-diagnosable infrastructure issues (high impact, medium risk)

| ID | Priority | Title | Status |
|----|----------|-------|--------|
| **[SIO-708](https://linear.app/siobytes/issue/SIO-708)** | High | Elastic sub-agent: 4/4 `elasticsearch_search` timeouts on 1B-doc indices | Backlog |
| **[SIO-710](https://linear.app/siobytes/issue/SIO-710)** | High | Kafka MCP timeouts under sustained load (9 timeouts on group-lag/topic-offsets/describe) | Backlog |

Both unblocked by SIO-707 (per-error logs). Handoff hypothesis for SIO-710: kafkajs `AdminClient` connection-pool exhaustion -- *"could be a one-line singleton fix."* SIO-708 needs query-shape investigation against 1B-doc indices and likely a different timeout knob (the `MCP_CONNECT_TIMEOUT_MS` is for connect, not for individual `_search` calls).

**Recommended next pickup.** SIO-710 first (smaller, hypothesis already articulated), SIO-708 second.

### Theme 2 -- the trust trio (medium impact, harder validation)

| ID | Priority | Title | Status |
|----|----------|-------|--------|
| [SIO-709](https://linear.app/siobytes/issue/SIO-709) | Medium | Aggregator confidence (0.71) too high when critical metrics couldn't be re-verified live | Backlog |
| [SIO-711](https://linear.app/siobytes/issue/SIO-711) | Medium | Aggregator volunteered "not fabricated" -- meta-signal of LLM uncertainty | Backlog |
| [SIO-712](https://linear.app/siobytes/issue/SIO-712) | Medium | GitLab-vs-Couchbase deployment-vs-runtime contradiction recognised in prose but didn't fire a correlation rule | Backlog |

Bundle. The styles-v3 transcript (which the user has locally; not committed) becomes a regression fixture for all three. Each is about the same failure mode: prose is technically correct but confidence number doesn't match data quality.

Note: SIO-707 already added a *deterministic* confidence cap when sub-agent toolErrorRate > 25%. SIO-709 is about a different signal -- the LLM itself flagging "Gaps" but still returning > 0.6. Possible approach: parse the report's "Gaps" section in the aggregator and cap confidence further when it's non-empty.

### Theme 3 -- cross-account IAM (blocked)

| ID | Priority | Title | Status |
|----|----------|-------|--------|
| [SIO-701](https://linear.app/siobytes/issue/SIO-701) | High | Apply full-coverage IAM policy to `kafka-mcp-agentcore-role-dev` | Blocked |

Policy JSON staged at `/tmp/kafka-mcp-full-policy.json`. Runbook at `experiments/SIO-701-iam-policy-runbook.md`. Needs IAM-write credentials in AWS account `352896877281`; user's usual shell is `356994971776`.

Once applied: re-run the live probe in the runbook. Don't mark Done until the user confirms `kafka_get_cluster_info` returns no `awsError`.

### Theme 4 -- pending live verification (don't mark Done yet)

[SIO-702](https://linear.app/siobytes/issue/SIO-702) -- the user's previous session -- is in **In Review** still. Per the prior handoff: live integration probe (set `tokenObtainedAt: 0`, fire 10 concurrent `gitlab_search` calls, confirm exactly one `OAuth tokens saved` and zero `OAuth credentials invalidated`). Production behaviour is healthy (circumstantial), but the headless-with-expired-token probe still hasn't run.

---

## Recommended pickup order for the next session

1. **[SIO-710](https://linear.app/siobytes/issue/SIO-710)** -- handoff hypothesis is concrete (AdminClient pool/singleton); now diagnosable from SIO-707 logs once a fresh production run lands.
2. **[SIO-708](https://linear.app/siobytes/issue/SIO-708)** -- companion timeout fix; needs more discovery work but high impact (Elastic is the busiest sub-agent).
3. **Trust trio bundle** ([SIO-709](https://linear.app/siobytes/issue/SIO-709) + [SIO-711](https://linear.app/siobytes/issue/SIO-711) + [SIO-712](https://linear.app/siobytes/issue/SIO-712)).
4. **[SIO-701](https://linear.app/siobytes/issue/SIO-701)** -- whenever cross-account access materialises.

---

## What's worth knowing about the SIO-707 / SIO-705 / SIO-703 implementations (for the next session)

### SIO-707 (per-failure visibility + 25% cap)

- Data layer was already 80% there: `ToolErrorSchema` had `{toolName, category, message, retryable}`; `extractToolErrors` already classified.
- The PR added: PII redaction at extraction time (`redactPiiContent` from `@devops-agent/shared`), a `toolErrors` array in the `Sub-agent completed` log payload (count preserved for backward compat), and `messageCount` on `DataSourceResult`.
- The deterministic cap reuses the existing `confidenceCap` state field (originally added by SIO-681 for correlation enforcement). The aggregator now sets `confidenceCap: 0.6` when any sub-agent's `toolErrors.length / messageCount > 0.25`. Reuses the same constant value as `correlation/enforce-node.ts:11`.
- **Boundary cases pinned by tests:** 10/40 (25.0%) caps; 9/40 (22.5%, the actual styles-v3 ratio) does NOT cap; cap never raises a lower LLM score.

### SIO-704 (defensive Atlassian parser)

- Three wrappers had identical fragile parse logic. Consolidated into `packages/mcp-server-atlassian/src/tools/custom/parse-atlassian-content.ts`.
- The "Failed to parse" log was firing on `JSON.parse` throw. Most likely root cause in production: the proxy's `ATLASSIAN_AUTH_REQUIRED` plain-text fallback at `atlassian-client/proxy.ts:185-189` was being silently swallowed. The new parser detects that prefix and throws `AtlassianAuthRequiredError`, which the registered tool handler converts to `isError: true` so the LLM sees the auth failure.
- Pagination envelopes (`{issues, isLast, nextPageToken}`) tolerated as a side effect.
- The styles-v3 transcript was never committed, so we don't know with certainty whether the production failure was auth-required, multi-block, or something else. The fix is defensive against all three.

### SIO-706 (triage-projection wrapper)

- New custom wrapper `atlassian_getJiraIssue` overrides the generic proxy registration via `CUSTOM_OVERRIDDEN_UPSTREAM_TOOLS` (exported from `tools/custom/index.ts`, read by `tools/proxy/index.ts`).
- Default field set is the 13-field `TRIAGE_FIELDS` constant (description truncated to 4KB with marker). Total payload < 8KB even for issues with long descriptions.
- `fields="*"` returns the full upstream issue and forwards no `fields` filter (lets Rovo decide). Use sparingly -- it'll trip the existing 64KB text-truncation path.
- Forwards the `fields` arg to upstream (`fields: "summary,status,..."`) so Rovo can do server-side filtering when supported.

### SIO-705 (error serialization)

- Helper: `serializeMcpConnectError(reason, url)` -- handles plain `Error`, subclass names, `AggregateError` (Node fetch wraps DNS/socket failures), one-level `cause` chain, and non-Error rejections.
- Applied to both the boot path (`createMcpClient`) and reconnect path (`reconnectServer`) so log shape matches across boot and recovery cycles.
- The "konnect never recovered via health-poll" sub-question was deferred. Once the next production run lands, we'll see konnect's actual error in plain text and can choose to fix the root cause.

### SIO-703 (once-per-process logging)

- Module-scoped once-flag in 4 sites (atlassian server.ts + proxy/index.ts; gitlab server.ts + proxy/index.ts).
- Test seams: each module exports `_resetXForTest` and `_isXForTest`. Tests verify flag transitions without mocking pino itself (which proved unreliable).
- HTTP stateless mode runs `createServerFactory` per request *by design* -- only the logs needed quieting.

---

## Don'ts (carry-forward)

- **Don't mark SIO-702 Done.** Still waiting on the live integration probe (per the previous handoff).
- **Don't change `MCP_OAUTH_HEADLESS=true`.** Production posture.
- **Don't bundle SIO-708 with SIO-710 in one PR.** Different surfaces (Elastic search query-shape vs Kafka AdminClient lifecycle); separate PRs let CI bisect.
- **Don't push directly to main.** Code goes through PR review.
- **Don't apply SIO-701 from the user's usual shell** -- wrong AWS account.

---

## Useful pointers for the next session

- **First skill to invoke:** `superpowers:using-superpowers` (always), then `superpowers:systematic-debugging` if picking up SIO-708/710 (debug-led tickets).
- **First file to read for SIO-710:** `packages/mcp-server-kafka/src/services/kafka-service.ts` and `client-manager.ts` -- look for AdminClient lifecycle (singleton vs per-call). The handoff hypothesis is that AdminClient is being recreated per tool call and the connection pool isn't being closed cleanly.
- **First file to read for SIO-708:** `packages/mcp-server-elastic/src/tools/` -- find the `elasticsearch_search` tool and check whether there's a per-call timeout knob distinct from `MCP_CONNECT_TIMEOUT_MS`. Then look at the query shape in the styles-v3 transcript to see if it's an unbounded scan against a 1B-doc index.
- **Verification before claiming done:** every ticket runs `bun run typecheck`, `bun run lint`, and the touched-package tests. Capture actual output -- never claim "tests pass" without it.
- **Pre-existing test failures on main:** ~34, all unrelated -- Konnect/Couchbase live-service integration tests, PII redactor source scans, structured-logging source scans. Don't be alarmed.

---

## Cross-references

- [PR #56](https://github.com/zx8086/devops-incident-analyzer/pull/56) -- SIO-707
- [PR #57](https://github.com/zx8086/devops-incident-analyzer/pull/57) -- SIO-704
- [PR #58](https://github.com/zx8086/devops-incident-analyzer/pull/58) -- SIO-706
- [PR #59](https://github.com/zx8086/devops-incident-analyzer/pull/59) -- SIO-705
- [PR #60](https://github.com/zx8086/devops-incident-analyzer/pull/60) -- SIO-703
- [HANDOFF-2026-05-10-post-sio-702.md](HANDOFF-2026-05-10-post-sio-702.md) -- the previous handoff; still load-bearing for SIO-702 close-out and theme rationale
- [SIO-701-iam-policy-runbook.md](SIO-701-iam-policy-runbook.md) -- runbook for the cross-account IAM apply

---

*Handoff produced 2026-05-10 by Claude Opus 4.7 (1M context). Five tickets shipped in this session (SIO-707, SIO-704, SIO-706, SIO-705, SIO-703); four remain from the styles-v3 fallout (SIO-708, SIO-710, SIO-709, SIO-711, SIO-712 -- five if counting the trust trio components individually); plus SIO-701 still blocked on cross-account auth and SIO-702 still in In Review. Recommended next pickup: SIO-710.*
