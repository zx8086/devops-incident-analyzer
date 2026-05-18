# Handoff -- post SIO-702 -- 10 new issues from styles-v3 production run

**Date:** 2026-05-10
**Branch on disk at handoff:** `main` at `d3eb2c7` (SIO-702 merged via PR #55)
**Working tree:** clean (no uncommitted work; `experiments/` is the only untracked, intentionally so)
**Linear status:** SIO-702 sits in **In Review** -- live integration probe not yet run; do NOT mark it Done until the user confirms.

---

## What this handoff is

Two threads from the previous session:

1. **SIO-702 shipped.** PR #55 merged. Single-flight refresh-on-read in `BaseOAuthClientProvider.ensureFreshTokens()` plus stale-wipe guard on `invalidateCredentials('tokens')`. 218 OAuth-touching tests pass. Atlassian unaffected.
2. **The user ran a real incident investigation against production datasources and the system shipped a 0.71-confidence report with material data gaps.** Logs and the final report surfaced 10 distinct issues (SIO-703 to SIO-712). Each has its own ticket; nothing is implemented yet.

This doc captures everything a fresh session needs to pick up the next ticket without re-reading the previous transcript.

---

## SIO-702 follow-up state

| Item | State |
|------|-------|
| PR #55 | Merged to `main` at `d3eb2c7` |
| Local branch | Deleted |
| Linear status | **In Review** -- waiting on the live integration probe |
| Live probe | NOT YET RUN. Documented in PR #55 description. Steps: `bun run dev` for gitlab MCP, edit `~/.mcp-auth/gitlab/https___gitlab.com.json` to set `tokenObtainedAt: 0`, fire 10 concurrent `gitlab_search` calls, confirm exactly one `OAuth tokens saved`, zero `OAuth credentials invalidated`. **Do not move SIO-702 to Done until the user confirms.** |
| Production behaviour | Healthy in the styles-v3 run -- gitlab sub-agent completed at `messageCount:26, toolErrorCount:0, allToolsFailed:false`. No `OAuth credentials invalidated` lines in the run logs. This is *circumstantial* evidence the fix works under modest parallelism (~6 gitlab tool calls); the headless-with-expired-token probe still needs to run to close the ticket. |

---

## The 10 new issues from the styles-v3 run

The user ran a complex incident query against eu-b2b Couchbase Capella (styles-v3 service performance). All five sub-agents completed; aggregation shipped at 0.71 confidence. The run exposed a clean set of independent issues, organised here by theme.

### Theme 1 -- Silent data loss in Atlassian (highest triage impact)

| ID | Priority | Title |
|----|----------|-------|
| **[SIO-704](https://linear.app/siobytes/issue/SIO-704)** | High | Atlassian custom tools fail to parse `searchConfluencePages` / `searchJiraIssuesUsingJql` responses |
| **[SIO-706](https://linear.app/siobytes/issue/SIO-706)** | High | `atlassian_getJiraIssue` payloads (60-122KB) silently truncated to 32KB by sub-agent cap |

SIO-704: `getRunbookForAlert` and `getIncidentHistory` log `Failed to parse <upstream> response` and return empty/skeleton results. `findLinkedIncidents` (using the same upstream tool) parses fine, so the schema drift is in the *response shape* expected by these two specific wrappers. Atlassian MCP envelope is `{issues, isLast, nextPageToken}` per the working call.

SIO-706: Three of the run's `atlassian_getJiraIssue` calls truncated (122KB -> 32KB, 67KB -> 32KB, 65KB -> 32KB). The LLM sees a partial Jira issue with no marker -- unsafe for triage.

### Theme 2 -- MCP infrastructure under sustained load

| ID | Priority | Title |
|----|----------|-------|
| **[SIO-708](https://linear.app/siobytes/issue/SIO-708)** | High | Elastic sub-agent: 4/4 `elasticsearch_search` timeouts on 1B-doc indices |
| **[SIO-710](https://linear.app/siobytes/issue/SIO-710)** | High | Kafka MCP timeouts after a successful first batch (9 timeouts) |
| [SIO-705](https://linear.app/siobytes/issue/SIO-705) | Medium | kafka-mcp boots with empty error, konnect-mcp never recovers via health-poll |
| [SIO-707](https://linear.app/siobytes/issue/SIO-707) | Medium | Sub-agent `toolErrorCount` is a count, not a list of messages -- no per-failure visibility |

SIO-707 unblocks SIO-708 and SIO-710 -- without per-error messages we can't diagnose which query shapes timed out. Pattern in SIO-710 (successful first batch then a wave of timeouts) strongly suggests AdminClient connection-pool exhaustion in kafkajs.

SIO-705's `error:{}` empty serialisation is a separate small bug worth picking off in passing.

### Theme 3 -- Trust quality of the final report

| ID | Priority | Title |
|----|----------|-------|
| **[SIO-709](https://linear.app/siobytes/issue/SIO-709)** | Medium | Aggregator confidence 0.71 too high when "Gaps" section calls out missing data |
| [SIO-711](https://linear.app/siobytes/issue/SIO-711) | Medium | Aggregator volunteered "not fabricated" -- meta-signal of LLM uncertainty |
| [SIO-712](https://linear.app/siobytes/issue/SIO-712) | Medium | GitLab-vs-Couchbase deployment-vs-runtime contradiction recognised in prose but didn't fire a correlation rule |

This trio should be tackled together. They're all about the same failure mode: the agent produces technically-correct prose but ships the report with confidence that doesn't match the data quality. The styles-v3 transcript should become a regression fixture for all three.

### Theme 4 -- Operational hygiene

| ID | Priority | Title |
|----|----------|-------|
| [SIO-703](https://linear.app/siobytes/issue/SIO-703) | Medium | MCP servers re-log "server created" / "proxy tools registered" on every tool call |

Pure observability noise. Single-file logger placement fix in HTTP stateless mode for both gitlab and atlassian MCPs.

---

## Recommended pickup order

The user explicitly **did not** ask the previous session to start implementing -- the close was "create a handover document for a new session." So the new session inherits the choice. Suggested order:

1. **[SIO-704](https://linear.app/siobytes/issue/SIO-704)** -- smallest blast radius, immediate triage win. Two Zod schemas to update in `packages/mcp-server-atlassian/src/tools/`. Likely under 2 hours including a regression test that pins the envelope shape.
2. **[SIO-707](https://linear.app/siobytes/issue/SIO-707)** -- unblocks visibility into Kafka and Elastic timeouts. Adds per-error logging to the sub-agent's tool runner; modest scope, big diagnostic payoff.
3. **[SIO-708](https://linear.app/siobytes/issue/SIO-708)** + **[SIO-710](https://linear.app/siobytes/issue/SIO-710)** -- once we have error messages, fix the underlying timeouts. SIO-710's hypothesis (AdminClient lifecycle) should be checked first; could be a one-line singleton fix.
4. **[SIO-706](https://linear.app/siobytes/issue/SIO-706)** -- proxy wrapper enhancement (`fields` projection on `atlassian_getJiraIssue`) plus a truncation marker. Touches the proxy contract so worth doing in a separate commit from SIO-704.
5. **[SIO-709](https://linear.app/siobytes/issue/SIO-709) + [SIO-711](https://linear.app/siobytes/issue/SIO-711) + [SIO-712](https://linear.app/siobytes/issue/SIO-712)** -- the trust trio. Bundle. Use the styles-v3 transcript as a regression fixture.
6. **[SIO-703](https://linear.app/siobytes/issue/SIO-703)** + **[SIO-705](https://linear.app/siobytes/issue/SIO-705)** -- log hygiene. Pick off in passing.

---

## What's worth knowing about the SIO-702 implementation (for future sessions)

The fix landed in **`packages/shared/src/oauth/base-provider.ts`**, not the GitLab subclass. Key shape:

- New constants: `TOKEN_EXPIRY_SKEW_MS = 60_000` and `STALE_INVALIDATION_WINDOW_MS = 5_000` (both exported from `@devops-agent/shared`).
- New persisted-state field: `tokenObtainedAt?: number` on `PersistedOAuthState`. Stamped by `saveTokens()`.
- New protected method: `ensureFreshTokens()` -- single-flight refresh-on-read with skew. Subclasses opt in by overriding `tokens()` to delegate to this.
- New protected method: `doRefresh()` -- default throws. GitLab overrides with the existing `/oauth/token` POST body. Atlassian doesn't override (its sync `tokens()` never reaches this path).
- New behaviour in `invalidateCredentials('tokens')`: skip the wipe when `Date.now() - lastSaveAt < STALE_INVALIDATION_WINDOW_MS`. `'all'` bypasses the guard intentionally.

**Atlassian was modified** to plumb an optional `clock?: () => number` through its options bag for testability. No production behaviour change. The Atlassian wipe-test was updated to inject a clock that crosses the guard window.

If a future session adds another public-client OAuth integration (Linear, GitHub-OAuth, etc.), it just needs to:
- Override `tokens()` to `async return this.ensureFreshTokens()`
- Override `protected async doRefresh()` with the actual `/oauth/token` POST body

Atlassian inherits the stale-wipe guard automatically; if Atlassian ever rotates refresh_tokens in the future, no further code changes are needed.

---

## Don'ts

- **Do not mark SIO-702 Done.** Wait for the user to run the live probe.
- **Do not change `MCP_OAUTH_HEADLESS=true`.** That's the production posture.
- **Do not patch the MCP SDK.** Override at the provider boundary.
- **Do not add doc-only commits to feature branches.** Per memory, doc-only handoffs commit to `main` directly. This handoff doc is in `experiments/` which is gitignored anyway.
- **Do not bundle SIO-704 with SIO-706 in the same PR.** They touch different layers (parser vs proxy contract).

---

## Cross-references

- [PR #55](https://github.com/zx8086/devops-incident-analyzer/pull/55) -- SIO-702 merged
- [SIO-702](https://linear.app/siobytes/issue/SIO-702) -- In Review (live probe pending)
- [SIO-687](https://linear.app/siobytes/issue/SIO-687) -- LangSmith 422 fix (mentioned for cross-reference; not on critical path)
- [SIO-681](https://linear.app/siobytes/issue/SIO-681) -- correlation enforcement; SIO-712 extends this rule class
- The styles-v3 transcript itself -- not committed; user has the local logs from the 6:05 PM session if needed for fixture data

---

## Pointers for the new session

- **First skill to invoke:** `superpowers:using-superpowers` (always), then `superpowers:systematic-debugging` if picking up SIO-704 or SIO-707 (debug-led tickets).
- **First file to read:** depends on the chosen ticket. For SIO-704: `packages/mcp-server-atlassian/src/tools/get-runbook-for-alert.ts` and `get-incident-history.ts`.
- **Verification before claiming done:** every ticket must run `bun run typecheck`, `bun run lint`, and the touched-package tests. Do not claim "tests pass" without the output captured.
- **34 pre-existing test failures** on `main` are unrelated to anything we're doing -- Konnect/Couchbase live-service integration tests, PII redactor source scans, structured-logging source scans. Don't be alarmed by them.

---

*Handoff produced 2026-05-10 by Claude Opus 4.7 (1M context). Phase 1 (RCA on SIO-702) and Phase 2 (issue logging from production run) are complete. Implementation backlog is SIO-704 through SIO-712, ready for pickup in any order; recommended sequence above.*
