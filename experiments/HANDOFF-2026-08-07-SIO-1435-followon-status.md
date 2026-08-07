# HANDOFF 2026-08-07: SIO-1435 follow-on status (2 threads shipped, 2 parked)

- **Date**: 2026-08-07
- **Tracking ticket**: https://linear.app/siobytes/issue/SIO-1435 (planning/handover ticket -- still Backlog, correctly so; it was never meant to be implemented directly)
- **Parent handover**: `experiments/HANDOFF-2026-08-07-SIO-1409-followon.md` -- this doc reports what happened to its four threads.
- **Repo state**: `main` @ `4dab90a4` (includes both PRs merged this session: #629, #631)
- **Suggested branch for any new work**: none needed right now -- see "What's left" below; the two open threads are either fully closed or explicitly blocked-by-design.

## TL;DR

Picked up all four threads from the SIO-1435 follow-on handover. Two shipped as real code changes with full review cycles (task-level + final whole-branch review + CodeRabbit, both merged). One resolved to "nothing to implement, decision already recorded." One was investigated, found a live signal that looked like an unblock, and was corrected back to "intentionally blocked" by direct user confirmation. **Nothing is mid-flight.** The two Backlog tickets that remain (SIO-1438, SIO-1439) are Backlog on purpose, not because something ran out of time.

## What shipped

### Thread 2 -- `server/discover` routing bug: DONE, merged

[SIO-1436](https://linear.app/siobytes/issue/SIO-1436), [PR #629](https://github.com/zx8086/devops-incident-analyzer/pull/629) (merged `5bfd9327`).

Root-caused to two independent gates in the installed `@modelcontextprotocol/server@2.0.0` bundle: (1) a claim-less `server/discover` request classifies as legacy at the HTTP routing layer, never reaching modern dispatch; (2) `McpServer`'s default `supportedProtocolVersions` has no `2026-07-28` entry, so the modern-only `_ondiscover` handler is never registered without an explicit override. Fixed in `packages/mcp-server-couchbase/src/server-v2.ts` + un-skipped the reproduction test in `server-v2-wire.test.ts`. One CodeRabbit finding (missing try/finally around the test's `handler.fetch()`), fixed and approved.

Nothing left here. If a fifth v2-pilot server is ever built, the same `supportedProtocolVersions` override will be needed -- that's now a known pattern, not a gap.

### Thread 1 -- agent-side `structuredContent` consumption: DONE, merged

[SIO-1437](https://linear.app/siobytes/issue/SIO-1437), [PR #631](https://github.com/zx8086/devops-incident-analyzer/pull/631) (merged `4dab90a4`). Also resolves [SIO-1425](https://linear.app/siobytes/issue/SIO-1425) as a duplicate (same scope, pre-existing, deliberately deferred out of SIO-1409 -- marked Duplicate, not Done, so the history stays intact).

The original framing ("blocked on `@langchain/mcp-adapters` v2 SDK support") was wrong -- re-investigation found `structuredContent` already routes to `ToolMessage.artifact` on the **installed v1 SDK**, today. The real gap was narrower: nothing in `packages/agent/src/` read `.artifact`. Implemented via full brainstorm -> spec -> plan -> subagent-driven-development cycle:
- `packages/agent/src/sub-agent-instrumentation.ts`: captures `ToolMessage.artifact`'s `mcp_structured_content` entry (Zod-validated via `safeParse`, not a manual type guard -- CodeRabbit fix).
- `packages/agent/src/sub-agent.ts`: `buildPersistedToolOutput` prefers the structured payload over `tryParseJson(text)` when present. Text is parsed only inside the branch that consumes it (a CodeRabbit fix -- the original fix-round code computed a throwaway `tryParseJson(text)` unconditionally even on the branch that doesn't use it, an unbounded parse the state cap exists to prevent).
- Zero extractor changes -- verified server `structuredContent` and text `content` are literally the same in-memory object for all 4 target tools (`kafka_get_consumer_group_lag`, `kafka_list_consumer_groups`, `aws_cloudwatch_describe_alarms`, `findLinkedIncidents`), so this is a data-source swap, not a reshaping.
- One latent bug caught by the final whole-branch review (not CodeRabbit): the non-typed-tool branch of `buildPersistedToolOutput` returned uncapped `structuredContent` while reporting a phantom truncation -- unreachable today (all 4 tools are `TYPED_FINDING_TOOLS` members, which takes a different branch) but a real defect for any future tool. Fixed to re-measure `structuredContent`'s own size against the cap.
- Eval reassessment (required per SIO-1425's own deferral note): scoped kafka-only live eval, 4/4 examples, no drift.
- CodeRabbit round 2: 6 findings, 4 fixed (including the parse-timing issue above), 2 declined (both targeted the plan doc's prose about commit/lint timing, not shipped code -- the plan already described a completed, reviewed implementation).

Design spec: `docs/superpowers/specs/2026-08-07-agent-structuredcontent-consumption-design.md`. Plan: `docs/superpowers/plans/2026-08-07-agent-structuredcontent-consumption.md`. Both committed on the merged branch, so they're in `main`'s history now.

Nothing left here either. Downstream consumers (`extractFindings`, the finding cards) are unaffected by design and didn't need touching.

## What's left (both intentionally parked, not queued work)

### Thread 3 -- chokepoint/logging idiom: [SIO-1438](https://linear.app/siobytes/issue/SIO-1438), Backlog

Decision already recorded: accept N-wraps-per-tool (`RegisteredTool.update({ callback })`) as the standing v2 idiom, since `packages/mcp-server-couchbase/src/v2/tool-call-wrappers.ts` already implements it correctly and no public dispatch-level hook exists in the v2 SDK. **Nothing to implement.** The ticket exists purely so Thread 4's fleet-wide migration sizing has something to point at. Filing an upstream `modelcontextprotocol/typescript-sdk` feature request for a middleware hook was explicitly deferred (not chosen), remains a future option if N-wraps proves costly at fleet scale -- not a next step, just a noted possibility.

### Thread 4 -- konnect MRTR pilot + fleet-wide v2 migration: [SIO-1439](https://linear.app/siobytes/issue/SIO-1439), Backlog

**konnect is confirmed intentionally offline** (direct user statement, 2026-08-07) -- do not reopen this. Worth flagging precisely because it looked like it might have changed: the main checkout's `.env` has a correctly-shaped `KONNECT_ACCESS_TOKEN` (`kpat_`-prefixed, would pass every static config-health check in `packages/mcp-server-konnect/src/config/health.ts`), which read as a real unblock signal until the user corrected it. Memory saved: `reference_konnect_purposely_disabled` -- read it before touching konnect again in any future session, and do not live-probe it or start the konnect MCP server based on `.env` inspection alone.

The fleet-wide v2 migration sub-thread is independent of konnect's status and is real, unstarted work if anyone wants it: `packages/mcp-server-couchbase/src/index-v2.ts` + `server-v2.ts` are the only existing live template for what a per-server v2 entrypoint looks like (8 remaining servers would each need their own). No discovery has been done on this sub-thread beyond that template existing -- it's genuinely just an idea, not scoped.

## Verification

Both merged PRs are already green on `main` -- no outstanding verification needed for shipped work. If picking up the fleet-wide migration sub-thread, the baseline check is:

```bash
bun run typecheck && bun run lint && bun test
```

## Memory references

`project_mcp_2026_spec_adoption_sio1409` (epic, complete), `reference_konnect_purposely_disabled` (new this session -- the konnect-is-not-actually-unblocked correction), `reference_sio1410_sdk130_zod_error_format_regression` (unrelated but adjacent SDK-version context from the same program).

## Out of scope

Re-litigating SIO-1410 through SIO-1424 (the closed parent epic) or SIO-1436/SIO-1437 (both Done, merged, no known follow-up). If either merged PR surfaces a regression later, that's a new ticket, not a reopen of these.
