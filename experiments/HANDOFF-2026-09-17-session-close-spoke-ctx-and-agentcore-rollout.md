# HANDOFF: session close, 2026-09-17 evening -- spoke ctx tools, AgentCore AWS deploy, and what is still open

| | |
|---|---|
| Date | 2026-09-17 (session ran about 15:45 to 17:45 UTC) |
| Tickets | [SIO-1786](https://linear.app/siobytes/issue/SIO-1786) Done (its user-side replay has since been run, see the update), [SIO-1787](https://linear.app/siobytes/issue/SIO-1787) Done (closed by the user 2026-09-17, was In Review when this was written), [SIO-1788](https://linear.app/siobytes/issue/SIO-1788) Done |
| Related | [SIO-1726](https://linear.app/siobytes/issue/SIO-1726), [SIO-1734](https://linear.app/siobytes/issue/SIO-1734) (spoke context-mode, shipped earlier), [SIO-1774](https://linear.app/siobytes/issue/SIO-1774) (the change the AgentCore deploy shipped), [SIO-1784](https://linear.app/siobytes/issue/SIO-1784) (separate, own handover: `experiments/HANDOFF-2026-09-17-SIO-1784.md`) |
| PRs | #819 merged as `798e9b29`, #820 merged as `61b43f87`; follow-up session #821 to #824; second update #826 merged as `cf5ba637`, #825 closed unmerged; third update #827 merged as `09781ab9`, #828 merged as `95433027`; fourth update #830 merged as `adde28a3`, #829 merged as `3dccce03`, #831 merged as `dfabe40a`; fifth update #832 merged as `4df76f04`; sixth update #833 merged as `c3c1d7d0`; seventh update #834 merged as `296b9f84`; eighth update #835 merged as `98904cf6`, #836 merged as `d35c1e80`; tenth update #837 merged as `dd9ca382`, #838 merged as `796193bd` |
| Repo state | `origin/main` at `61b43f87` when written; `7a77c575` after the follow-up session (PRs #821, #822, #823, #824); `cf5ba637` after the second update (PR #826); `95433027` after the third update (PRs #827, #828); `dfabe40a` after the fourth update (PRs #829, #830, #831); `4df76f04` after the fifth update (PR #832); `c3c1d7d0` after the sixth update (PR #833); `296b9f84` after the seventh update (PR #834); `d35c1e80` after the eighth (PRs #835, #836); `796193bd` after the tenth (PRs #837, #838). No branch is open. |
| Deployed state | Fleet bundle `97b9d8ad` on all 8 spokes and both hubs since 2026-09-18 10:17 UTC (ninth update; it was `61b43f87` before, which is the rollback target). AWS AgentCore runtime on v16. The SIO-1792 change is to the operator-side fleet CLI and needs no deploy; the SIO-1793 change is tests only. |
| Nature | Nothing here is in progress. Every item under "What is still open" is now closed or ticketed; see the third update for the tickets, the fourth and fifth for what happened to them, and the SEVENTH update for the final state: every ticket is Done or Cancelled except SIO-1799, which stays in Backlog on purpose until its own 60-day rule (2026-11-16). Nothing else is left. Later the same day four follow-ups were ticketed (SIO-1804 to SIO-1807): SIO-1805 is Done, SIO-1804 is merged AND deployed (ninth update) and stays In Review until a real sample or a quiet period settles its cause, SIO-1806 and SIO-1807 are Done (tenth update). After the tenth update the owner closed the last two by decision: SIO-1804 Done, SIO-1799 Cancelled (see the close-out note). NOTHING IS OPEN. |

## TL;DR

Three things shipped and were verified live: the AWS MCP AgentCore runtime went v15 to v16 carrying
SIO-1774's `describe_alarms` slimming (78618 to 36186 bytes, toolCount still 70); the fleet was found
already current, then re-rolled for SIO-1788; and SIO-1788 itself, which hides four context-mode
maintenance tools from the spokes and fixes the spoke persona's self-description. What is left is
five loose ends, listed under "What is still open". Both of the two that mattered most have since
closed: the SIO-1786 replay was run and passed (first update), and the 24 `packages/agent` failures
were the command, bare `bun test` without `--isolate`, not the code (first update; a second session
then re-derived it the hard way and fixed the CLAUDE.md instruction that caused it, second update).
SIO-1792 and SIO-1793 are also Done (third update). What remains is the untriaged observations
listed in the first update, none of which has a ticket.

## Session summary

The session opened as a review request: read the SIO-1786 handover, and review putting an MCP server
on the fleet spokes so they can use context-mode. The review's headline was that this was ALREADY
built, merged and live (SIO-1726, SIO-1734, SIO-1735): each spoke runs `context-mode` as a local MCP
server and `pi-mcp-adapter` connects it to Pi through one `~/.pi/agent/mcp.json` entry. The user then
redirected the session to closing out the day's deployments, and later asked for the review's one
real finding to be implemented.

| Order | What | Outcome |
|---|---|---|
| 1 | Fleet close-out (SIO-1787) | Both hub buckets already held `12a7be86`; the only differences from main were a test file and an incident-analyzer tool YAML, neither of which runs on a host. Publish deliberately SKIPPED. All 8 spokes and both hubs verified over SSM. |
| 2 | AgentCore AWS deploy (SIO-1786 step 3) | Image built from main, pushed with tag `sio-1774`, runtime updated changing only `containerUri`. Verified by behaviour through the SigV4 proxy. |
| 3 | Runbook entry (SIO-1786 step 4, PR #819) | Three Greptile rounds, every finding verified against code or the live runtime before applying, 5/5 on the third. |
| 4 | SIO-1788 (PR #820) | Implemented, canaried on a dev spoke BEFORE merge, merged at Greptile 5/5 with no findings, rolled out host by host over SSM to dev then prd. |

**Decisions the user made, which bind future work:**

- The prd fleet rollout was pre-approved on condition that dev verifies clean. The AgentCore runtime
  update was NOT pre-approved and got its own explicit go-ahead. Approval for one production step is
  not approval for the next.
- Rollouts go HOST BY HOST OVER SSM when an operator tunnel may be open, not through
  `just fleet rollout/status`. The recipe is in memory `reference_fleet_rollout_host_by_host_over_ssm`.
- Do not publish a functionally empty bundle: it relaunches Pi on every host for nothing.

**What live verification found that review and tests had not:**

- A verification that still shows OLD behaviour after an AgentCore update is most likely testing the
  old image. The SigV4 proxy keeps one process-wide MCP session and AgentCore pins a session to the
  microVM it started on. `DELETE /mcp` on the proxy resets it. Three verification calls looked like a
  failed deploy for this reason.
- Runtime READY is not "new version live": the DEFAULT endpoint switched 46 s after the runtime
  reported READY. Found only because a Greptile finding was checked against the live runtime.
- Log streams can disprove the new image, never prove it: the runtime boots a microVM about once a
  minute on whatever version is live.
- A spoke really did expose all eleven `ctx_*` tools. That had only been inferred from the config
  until the canary's control run listed them.

All three AgentCore lessons are in `docs/runbooks/mcp-agentcore-image-deployment.md` (step 5, step 6
and the 2026-09-17 entry) and in memory `reference_agentcore_proxy_sticky_session_tests_old_image`.

## Update, 2026-09-17 late evening (follow-up session): what changed since this was written

Read this first. It supersedes the matching parts of "What is still open" below, which are kept as
written so the reasoning stays visible.

| Item below | Status now |
|---|---|
| 1. SIO-1786 replay | DONE. Every checklist item passed; scorecard posted on [SIO-1786](https://linear.app/siobytes/issue/SIO-1786). Two things remain unproven, see below. |
| 2. Twenty-four local-only failures | EXPLAINED, not a defect. Wrong command. See below. |
| 3. `ajv` CI flake | Unchanged. Did not recur on the two CI runs of PR #821. |
| 4. `just fleet status` hang | Ticketed as [SIO-1792](https://linear.app/siobytes/issue/SIO-1792) (Backlog). Cause of the original hang still not reproduced. |
| 5. SIO-1788 acceptance gaps | The offline half is ticketed as [SIO-1793](https://linear.app/siobytes/issue/SIO-1793) (Backlog). The live hub message per environment is still the user's. |

**The replay (item 1).** Web app restarted, full replay on all six datasources with estates
`eu-oit-prd` + `eu-shared-services-prd`. Truncation logged `indexedRows: 400`, no
`evidence_index.unavailable`, `cacheReadTokens` grew turn over turn on every sub-agent, and the
SIO-1774 slimming showed in a real run (`capella_get_completed_requests` 37 KB against 745 KB,
`aws_cloudwatch_describe_alarms` 18 KB and 26 KB against 78 KB and 118 KB). `pi verification cards
proposed` was 2: one estate logged `blockedBy: matched` (the service runs there, that card is
correct, it was approved and came back `confirmed`), the other logged
`services-incomplete:<one cluster>`, which is exactly the [SIO-1784](https://linear.app/siobytes/issue/SIO-1784)
case and is recorded there as its second live data point. Approve opened a `verify` entry in the
fleet pane and the verdict arrived.

Still unproven after the replay, noted and not chased: `subagent.final_turn_forced` (SIO-1779) did
not fire, which is expected, because `shouldForceFinalTurn` in `packages/agent/src/sub-agent.ts`
needs three consecutive rounds in which EVERY tool result is a refusal.

The other item that was open here, the key-decision write after a pi verdict
(`recordVerdictDecision` in `packages/agent/src/pi-verdict-memory.ts`), is now PROVEN. On a second
live run the same evening a verify card was approved, and in the same second the hub reported the
message `complete`, the log carried `Recorded key decision` with `requestId` equal to the pi message
id rather than an incident request id, `backend: agent-memory`. That `requestId` is the signature
of this write. Recorded on SIO-1786.

**The 24 failures (item 2) were the command, not the worktree and not the code.** Reproduced in a
fresh worktree with `bun install --frozen-lockfile`, on code identical to main:

```
cd packages/agent && bun test             4616 pass, 69 skip, 24 fail   (the numbers in item 2, exactly)
cd packages/agent && bun test --isolate   4709 pass, 0 fail
```

The package script is `bun test --isolate` (`packages/agent/package.json`), and CI runs that script.
The eight failing suites all live in `packages/agent/src/iac/*.test.ts` and share a process-global
`mock.module("../memory-backend.ts")`, last registration wins; without `--isolate` it leaks across
files. The "about 50 fewer tests" were the 69 skips, not uncollected files: 4616 + 69 + 24 = 4709.
This is already in memory as `reference_bun_test_isolate_kills_mock_module_pollution`. Rule: run a
package's tests with `bun run test` (or its exact script), never bare `bun test`. A fresh worktree
also needs `bunx svelte-kit sync` before `apps/web` tests, or `$lib` does not resolve; the web
package script does that too.

**New from the replay:**

- [SIO-1789](https://linear.app/siobytes/issue/SIO-1789), merged as PR #821 (`37bf49d2`): the fleet
  pane now renders a pi verdict or investigation (chip, summary, claims with evidence), and the
  verify / investigate cards only send and show a one-line status. With no pane configured the card
  still renders the result itself. EXERCISED LIVE against the prd hub the same evening: a
  `partially confirmed` verdict rendered in the pane and the card collapsed to its status line.
- [SIO-1794](https://linear.app/siobytes/issue/SIO-1794), merged as PR #823 (`4426ae7d`), two
  follow-ups from that live use. Pane entries now run oldest first (`startEntry` in
  `apps/web/src/lib/stores/pi-fleet-reducer.ts` appends; it used to prepend, so the investigate card
  a verify raised landed ABOVE the finished verify), and `PiFleetPane.svelte` scrolls the newest
  entry into view when the entry count grows, and only then. The collapsed "Raw reply" block under a
  rendered result is removed; an object reply that is neither a verdict nor an investigation still
  renders as raw JSON. The scroll is browser-only and has no unit test: not yet looked at live.
- [SIO-1790](https://linear.app/siobytes/issue/SIO-1790), merged as PR #822 (`a8ec01cc`):
  `AWSFindingsCard` logged `rawCount: 0` on every run although `aws_cloudwatch_describe_alarms`
  returned alarms in both estates. Root cause, reproduced live: the tool declares an `outputSchema`,
  so `@langchain/mcp-adapters` returns content `{ type, text, structuredContent }` and files the
  structured copy as an artifact; `wrapAwsToolsWithEstate`
  (`packages/agent/src/aws-tool-estate-wrapper.ts`) re-creates each AWS tool with `createTool` and
  calls the inner tool with plain args, which DROPS the artifact; the wrapper object was then
  persisted as `rawJson`, and `DescribeAlarmsResponseSchema` (all keys optional) accepted it and
  read no `MetricAlarms`. SIO-1774 had unwrapped that shape for the model-facing copy only, and its
  test supplied an artifact an AWS tool never has. Fix: the capture in
  `packages/agent/src/sub-agent-instrumentation.ts` reuses `dropDuplicateStructuredContent`. Live
  before and after: persisted keys `type,text,structuredContent` and 0 alarms, then
  `CompositeAlarms,MetricAlarms,$metadata` and 26 alarms. Not yet seen in a full run: the next one
  that calls the tool should log `rawCount` above 0. Only this tool was affected (the two kafka and
  one atlassian tools with an `outputSchema` are raw adapter tools and keep their artifact), but any
  AWS or elastic tool that gains an `outputSchema` is covered too. Seen in passing and NOT
  investigated: with focus `pvh-services-styles-v3`, 25 of 26 alarms counted as in focus although no
  alarm exists for that service, so `matchesFocus` may be matching on shared name fragments.
- [SIO-1791](https://linear.app/siobytes/issue/SIO-1791), merged as PR #824 (`7a77c575`):
  `subagent.loop_guard_stop` logged `unproductiveSearches: 0` next to `reason: unproductive-streak`
  for `gitlab_search` on both live runs. The REASON was right both times (three empty results in a
  row, per-tool cap 3); the line was not. `unproductiveSearches` is a counter only the
  `elasticsearch_search` path increments, so it reads 0 for every other tool. The line now also logs
  `unproductiveForTool` and `totalUnproductive`, and the run-wide cap (`MAX_UNPRODUCTIVE_PER_RUN`),
  which used to be reported as a streak although it can stop a tool that never came back empty
  itself, is `reason: run-backstop`. `stopReasonFor` in `packages/agent/src/sub-agent-loop-guard.ts`
  takes an optional tool name and follows `shouldShortCircuit`'s order, per-tool cap first.
  Deliberately unchanged: the text the model reads. The reason also selects the stop message and
  `gitlab-agent`'s project-resolution skill keys on that wording; `stopMessageFor` only
  special-cases `duplicate-call`, so the new value selects no new message (pinned by a test). The
  split is generic-path only, so `elasticsearch_search` and `aws_logs_start_query`, which have their
  own caps, are never labelled from the generic counters. Left alone on purpose: on a run-wide stop
  the model still reads that the tool "has returned nothing useful several times in a row", which
  may not be true of that tool; changing it is a model-behaviour change and a separate decision.
  Not yet seen in a run: whether the running web app picked the agent package change up by hot
  reload, or needs a restart, was not checked.
- Checked and NOT bugs: the Couchbase and Elastic findings cards at `rawCount: 0` (their source
  tools were not called, or did not match), one AWS sub-agent turn at 165k input tokens (two results
  just under the 131072-byte cap set by `SUBAGENT_TOOL_RESULT_CAP_BYTES`; the cap bounds a result,
  not a conversation), and the `AWS estate config drift` warning (the local `AWS_ESTATES` lists an
  estate the AgentCore runtime does not carry; routing already filters it out).

**For item 4, what the code verifiably allows** (detail in SIO-1792): both defects named below are
confirmed, and there is a real forever-blocker next to them. The `/health` fetch in `withHubTunnel`
and the `listAgents` fetch in `packages/pi-coms/scripts/fleet/hub.ts` have no `AbortSignal`, so one
connect that neither resolves nor rejects hangs the command. `runShellOutput` is correctly bounded.
`withHubTunnel`, `runStatus` and `runRollout` have no test coverage.

**For item 5** (detail in SIO-1793): the `else` branch that removes `mcp.json` has no test, and the
one existing test injects its own `CTX_SERVER` and asserts that same string, so a wrong path on the
script's `CTX_SERVER=` line would still pass. An operator sends a hub message with
`just hub-tunnel <env>`, then `just coms <hub> <cname>`, then `coms_net_send` from that console;
there is no `fleet` subcommand for it.

**Seen on the second live run, not ticketed and not investigated:** while a verify waits, every
25-second poll slice logs `pi.hub.call.failed` for `POST /v1/agents/<id>/heartbeat` with
`404 agent_not_found`, a different agent id each time (10 warnings for one verify), next to a
`pi.hub.await.exhausted` warning per slice. The analyzer registers, sends, and deregisters at once,
so the heartbeats have nothing to hit. The verdict still arrived, so it looks like warn-level noise
in the same class as SIO-1791. Confirm in `packages/agent/src/action-tools/pi-coms-client.ts` before
ticketing.

SIO-1787 is Done: the user closed it on 2026-09-17. Its one follow-up, `fleet status` / `rollout`
failing fast instead of hanging, is SIO-1792 and the two tickets are linked.

## Second update, 2026-09-17 21:00 to 21:20 UTC (the original session, resumed): SIO-1795, a wrong investigation and its correction

The session that wrote this document was resumed after the follow-up session above had already
landed on main, and was asked to investigate the 24 failures (item 2). It did not read the update
above or the memory it cites, ran bare `bun test` throughout, and reached the wrong conclusion
before finding the right one. Recorded here because the artefacts of the wrong path exist and a
reader may meet them.

**What it got right:** without `--isolate`, `mock.module()` is process-global, nothing undoes it
between test files, and Bun chooses the file order from the filesystem (on bun 1.4.2 a JUnit report
showed it ignoring the order of paths given on the command line). Real leaked stubs were found by
pairwise bisection: `iac/renovate-integration.test.ts` (one describe with no restore, a
`memory-backend` stub whose search returns nothing), `iac/local-tools.test.ts` (a
`@devops-agent/knowledge-graph` stub, only `memory-backend` restored), and three files that replace
the whole `@devops-agent/shared` package with `redactPiiContent` as the identity function
(`aggregator.test.ts`, `aggregator-grounding-integration.test.ts`,
`tests/integration/styles-v3-replay.test.ts`). Fourteen files stub `prompt-context.ts` partially
with no restore. None of this matters under `--isolate`, which is what the package script and CI run.

**What it got wrong:** "CI is green only because its file order happens to avoid the damage" and
"CI is one directory-order change away from red". Both rested on bare `bun test`, including a
Linux-container cross-check that was also bare. On a pristine copy of main, `bun test --isolate`
was `4714 pass, 0 fail`.

**Artefacts and their state:**

- [SIO-1795](https://linear.app/siobytes/issue/SIO-1795): created with the wrong analysis, then
  retitled and given a correction banner at the top; the wrong text is kept underneath, marked as
  wrong. Done, via PR #826.
- PR #826 (`cf5ba637`, merged): one paragraph of `CLAUDE.md`. It used to say `cd packages/<name>
  && bun test` and that this is how `apps/web` "must be run". It now says `bun run test`, and why:
  `packages/agent` and `apps/web` isolate, `apps/web` also runs `svelte-kit sync`, `pi-coms`
  installs its nested deps. Measured on one commit: `packages/agent` bare 24 fail vs script 0;
  `apps/web` bare 17 fail plus 12 errors vs script 0. A path filter keeps the flag (`bun run test
  src/iac`). There is no `bunfig.toml` key for isolation (checked against the Bun docs, and
  `[test] isolate = true` was tried and is ignored) and a preload cannot see the flag, so bare
  `bun test` cannot be made safe; the instruction had to change.
- [SIO-1796](https://linear.app/siobytes/issue/SIO-1796) and PR #825 (five test files restoring
  the leaked stubs): the user closed the PR unmerged and cancelled the ticket on the advice above.
  The patch was correct and harmless, but it fixed a problem the script already avoids, and would
  not have made bare `bun test` reliable anyway (the fourteen `prompt-context.ts` stubbers).
- Memory: the duplicate memory the session wrote was deleted; the lesson was folded into the
  existing `reference_bun_test_isolate_kills_mock_module_pollution`, whose stale line ("packages/agent
  does NOT isolate") is corrected, and that memory is now linked from `MEMORY.md` directly.

**The lesson, for the next person who sees "passes alone, fails in the suite, green on CI":** compare
your command with the package's `"test"` script and with what CI runs before anything else. The
answer was on main (the update above) and in memory two hours before the investigation started.

## Third update, 2026-09-18 05:00 to 05:50 UTC (the original session, resumed again): SIO-1793 and SIO-1792 done

Both tickets the first update opened for items 4 and 5 are implemented, merged and Done.

**SIO-1793, PR #827 (`09781ab9`), tests only.** `tests/agent-bootstrap-project-scope.test.ts`
now slices the launcher's whole `mcp.json` block (`CTX_SERVER=` through `fi`; the launcher heredoc
is quoted, so `$HOME` expands at run time) and runs it under `bash -euo pipefail` in a `mkdtemp`
HOME with a stand-in bundle file, then inspects the file left behind. Covered: enabled with the
bundle present (valid JSON, `args` equal to the script's OWN `CTX_SERVER` path, the four
maintenance tools excluded, the documented ones not); `CTX_MODE_ENABLED=false` and `=0` remove a
pre-existing file; enabled but bundle missing removes it; an unrelated value counts as enabled.
Mutation-checked against the real script: a wrong `CTX_SERVER` path fails 2 tests (the old test
passed it), swapping one excluded tool for a documented one fails 1. Greptile 5/5, no findings.

**SIO-1792, PR #828 (`95433027`).** The other session had left substantive uncommitted work in
worktree `sio-1792-fleet-tunnel`; with the user's go-ahead it was reviewed, tested and committed
as found on that session's branch, then finished from this worktree (the harness refuses writes to
another worktree, so the clean, pushed worktree was removed and its branch checked out here). The
tunnel now lives in `packages/pi-coms/scripts/fleet/tunnel.ts` with injectable deps: every
`/health` attempt carries `AbortSignal.timeout`; after the attempts it throws
`tunnel to <hub> did not answer /health`; a tunnel process that exits early fails fast and names
the likely cause; the process is spawned `detached` in its own group and teardown signals the
GROUP (SIGTERM, then SIGKILL, bounded waits), with SIGINT/SIGTERM handlers because `finally` does
not run when the CLI is signalled; a hub already answering on the hub's `local_port` (the
operator's own `just hub-tunnel`) is reused and left alone. `listAgents` in `scripts/fleet/hub.ts`
has a 15 s timeout, and `HubHttpError` marks an answer retrying will not change (HTTP refusal, or a
2xx whose body is not JSON), which the rollout poll fails fast on while retrying transport stalls.

Greptile round 1 was 4/5 with two findings, both verified and fixed: the reuse probe accepted any
2xx on `/health` (an unrelated local service would have been taken for a hub; it now requires the
hub's real payload, `ok === true` plus `server_id`, per `handleHealth` in
`scripts/coms-net-server.ts`), and an unparseable listing was retried to the ten-minute deadline.
Round 2: 5/5. 14 tunnel tests, one with real processes proving the spawned command's child dies
on teardown (which also proves Bun 1.4.2 honours `detached: true`); pi-coms 578 pass.

**Live acceptance, credentials refreshed by the user:** `just fleet status` on the two dev spokes,
rc 0 in 12 s, nothing left on 8787; on the two prd spokes WITH the operator's prd tunnel already
open on 8788, which is the exact scenario that hung during SIO-1787: rc 0 in 10 s, logged
`using the tunnel already open`, the operator's tunnel survived. Before that, with expired
credentials, the real `aws` CLI failed in 2 s with the clear message and nothing was left
listening. The original 5-minute hang was never reproduced; the code path it took is gone.

**Now the only open things from this document**, each ticketed on 2026-09-18 (all Backlog,
unassigned; nothing is in progress):

| Observation | Ticket |
|---|---|
| possible `matchesFocus` false positives on shared name fragments, 25 of 26 alarms in focus (first update, SIO-1790 bullet) | [SIO-1797](https://linear.app/siobytes/issue/SIO-1797), Medium |
| heartbeat `404 agent_not_found` warnings on every poll slice during a pi verify (first update, "Seen on the second live run") | [SIO-1798](https://linear.app/siobytes/issue/SIO-1798), Low |
| the `ajv` CI flake seen once (item 3) | [SIO-1799](https://linear.app/siobytes/issue/SIO-1799), Low, a place for a recurrence to land |
| the `PiFleetPane` scroll not yet looked at live (first update, SIO-1794 bullet) | [SIO-1800](https://linear.app/siobytes/issue/SIO-1800), Low, live check with four steps |
| the live hub message to one spoke per environment (item 5, user-driven) | [SIO-1801](https://linear.app/siobytes/issue/SIO-1801), Low, operator recipe on the ticket |
| NEW, raised by the user on 2026-09-18: the Atlassian findings card lists tickets unrelated to the incident. Mechanism read from the code: `findLinkedIncidents` builds a JQL that ORs `text ~ "<service>"` with `text ~ "<every error keyword>"` ordered by recency (SIO-1093 broadened it on purpose), and the extractor's SIO-1244 provenance rule then treats every hit of a focus-scoped envelope as in focus. Keyword retrieval where relevance is the question; same family as SIO-1797 | [SIO-1802](https://linear.app/siobytes/issue/SIO-1802), Medium. Four options weighed on the ticket (tighter JQL, clause scoring, a Rovo `atlassian_search` semantic pass, a relevance judge); the SIO-1244 fixture (DEVOPS-1405 on run 43796e9f) must keep passing |

With that, nothing in this document is untracked.

**Session close, 2026-09-18 05:45 UTC.** Everything this document tracks is either Done (SIO-1786,
SIO-1787, SIO-1788, SIO-1792, SIO-1793, SIO-1795) or in Backlog with a ticket (SIO-1797 to
SIO-1802). `origin/main` is at the commit that adds this paragraph. Deployed state is unchanged
since the third update: fleet bundle `61b43f87` on all 8 spokes and both hubs, AWS AgentCore
runtime v16. No branch is open, no process the sessions started is running, both tunnel ports
are free of anything the sessions opened.

## Fourth update, 2026-09-18 06:00 to 07:45 UTC (a new session): the six Backlog tickets worked through

A fresh session read this document, planned all six tickets as one piece of work, and executed the
plan. Three code tickets are merged; the three no-code tickets are recorded on Linear. Detail, with
commands and outputs, is in each ticket's comments; this is the summary and what is left.

| Ticket | Outcome | State on Linear |
|---|---|---|
| [SIO-1797](https://linear.app/siobytes/issue/SIO-1797) | PR #830, `adde28a3`. Verified live | Done (moved by the merged PR link) |
| [SIO-1798](https://linear.app/siobytes/issue/SIO-1798) | PR #829, `3dccce03`. Verified live | Done (moved by the merged PR link) |
| [SIO-1802](https://linear.app/siobytes/issue/SIO-1802) | PR #831, `dfabe40a`. ONE live check left, see below | Done (moved by the merged PR link, NOT by a person) |
| [SIO-1799](https://linear.app/siobytes/issue/SIO-1799) | No recurrence in 45 CI runs since the flake | Backlog, by its own 60-day rule |
| [SIO-1800](https://linear.app/siobytes/issue/SIO-1800) | 3 of 4 checks pass live, 1 not exercisable, no code change, one finding for a decision | In Review |
| [SIO-1801](https://linear.app/siobytes/issue/SIO-1801) | prd half passed; dev half not done | In Progress |

**SIO-1797: the ticket's hypothesis was half wrong.** `pvh` and `v3` are under `MIN_TOKEN_LENGTH`
and can never match. The whole false-positive surface was ONE token, `service`: `SUFFIX_PATTERN`
strips `-service` only at end of string, a focus ending in `-v3` keeps it, and an alarm haystack
never ends in `-service`. Reproduced with the 26 live alarm names (read-only `DescribeAlarms`):
25 of 26 scoped, every one via `service`; 0 of 26 after. `matchesFocus` now skips `GENERIC_TOKENS`
in its overlap loop only. `tokenize()` is untouched because `focus-match.test.ts` pins its output,
`normalize()` because its output is persisted knowledge-graph identity (SIO-1103). Live:
`AWSFindingsCard` `rawCount: 64` (26 + 38, the two estates, counted independently),
`filterMode: unscoped-fallback`, `fallbackCount: 5`.

**SIO-1798: not a reap race.** `pollPiAction` builds a fresh `PiComsClient` per slice (random
`sessionId`, never registered) and `awaitReply` heartbeated unconditionally, so the hub answered 404
every slice. One guard in the shared client (`if (this.registered)`) fixes that path and
`awaitFleetMessage`, which had the same defect. Greptile round 1 caught a real flaw in my first
version: it demoted `pi.hub.await.exhausted` by budget size, but `fleet_await_reply` and `runHubTask`
pass the operator-configurable `verifyTimeoutMs` and never re-poll, so a short
`PI_COMS_VERIFY_TIMEOUT_MS` would have hidden a genuine final timeout. `awaitReply` now takes
`{ partial?: boolean }` and only the three callers that really re-poll pass it. Live: a whole verify
through the pane, six slices, zero `pi.hub.call.failed`, no heartbeat POST in the log.

**SIO-1802: the evidence changed the fix.** The offending runs were pulled from LangSmith first. On
the styles-v3 run all 15 returned tickets were unrelated, and re-running its JQL live showed why:
**JQL `text ~ "a b"` is a stemmed bag of words, not a phrase.** `styles scope` matched a ticket
saying "Style" and "out of scope". Results are capped by recency, so junk filled every slot and the
exact prior incidents were never retrieved; a post-filter alone would have produced an EMPTY card.
Same run with only the multi-word keywords phrase-quoted: 88 matches to 36, and 0 to 5 of the top
15 about the incident's own service. Also corrected: the upstream already returns `description`,
`labels` and `components` by default; `shapeIssue` discarded them. Shipped: phrase-quoting in
`buildJql`, `matchedBy` + `score` per ticket, a per-issue keep rule in the extractor (structural
hit or two keyword phrases; no `matchedBy` keeps the SIO-1244 provenance rule), and a chip on the
card. Three Greptile rounds, both findings reproduced before fixing (a literal substring misses a
phrase split by a newline or `**bold**`; then my fix anchored a term only at its start, so `api`
hit `apiary`). End to end on the live top 15: 15 unrelated before, 5 kept after, all incidents of
the focus service.

**What is left, all three need the owner:**

1. **SIO-1802, the tool inside the running server.** Restart the Atlassian MCP (9085) and the web
   app on merged `main`, replay the styles-v3 incident, and expect the logged `jql` to carry
   `\"kv timeout\"` phrase-quoted, the card to list the `pvh-services-styles-v3` incident reports
   with chips such as `service + 2 keywords`, and `AtlassianFindingsCard` `filteredCount` below
   `rawCount`. A second instance was deliberately NOT started from the worktree: it would share the
   OAuth token store with the running server, and a refresh by either can invalidate the other
   (memory `reference_atlassian_oauth_refresh_race_root_cause`). Linear shows this ticket Done
   because the PR merged; that is the integration, not a verdict.
2. **SIO-1801, the dev half.** It cannot go through the fleet pane, which lists prd hubs only by
   design (SIO-1696, `apps/web/src/lib/server/pi-fleet.ts`). Operator console route on the ticket.
   prd half: spoke `eu-oit-prd`, exactly the seven `ctx_` tools, and `INSTANCES=2` matching an
   independent `DescribeInstances`.
3. **SIO-1800, a decision.** The pane scrolls a new entry into view when it is ADDED (a short
   "Waiting" stub). When the reply arrives the entry grows and nothing scrolls, so the reply lands
   partly below the fold: 108 px and 81 px hidden, measured twice. This is the documented intent of
   SIO-1794 ("an arriving result must not move the reader"), and check 3 shows that intent working,
   so it was NOT changed. Recommendation on the ticket: stick to the bottom only when the reader
   was already there.

**Seen in passing, none ticketed:** the verify in the live run ended `error: response not valid
JSON` (the hub rejecting the spoke's reply against the verify schema; spoke-side, intermittent,
yesterday's verifies returned verdicts); `findLinkedIncidents`' `resolvedAt` / `mttrMinutes` are
probably always null, because the upstream default field set has no `resolutiondate`;
`get-runbook-for-alert.ts` builds Confluence CQL with the same unquoted multi-word `text ~`; and
`packages/knowledge-graph`'s suite segfaults the Bun runner locally (rc 139, zero tests run,
identical on base content; CI runs it).

**State at close.** `origin/main` at the commit that adds this section, on top of `dfabe40a`. No
branch is open, locally or on origin, from this session. The isolated web instance on 5174 was
stopped by its server id and the port proven free; the operator's prd tunnel on 8788 was left
untouched. Deployed state is unchanged: fleet bundle `61b43f87`, AWS AgentCore runtime v16. The
three merged changes load on the next restart of the web app (agent and web packages) and of the
Atlassian MCP. A gitignored `.claude/launch.json` with the 5174 replay recipe was left in the
worktree on purpose, for check 1 above.

New memory from this session: `reference_jql_text_tilde_is_bag_of_words`,
`feedback_git_switch_no_track_and_never_tail_git`; extended:
`reference_sandbox_blocks_listen_fake_eaddrinuse`.

## Fifth update, 2026-09-18 07:45 to 08:20 UTC (same session): the SIO-1802 replay failed, was fixed, and passed

This supersedes item 1 of "What is left" in the fourth update. Items 2 and 3 there are unchanged.

The main checkout was fast-forwarded and the replay run. **It failed the acceptance: the card was
EMPTY** (`rawCount: 10`, `filteredCount: 0`, `droppedAll: true`). The sub-agent had passed generic
SINGLE-word keywords (`TIMEOUT`, `article`, `styles`, `kv`). PR #831's phrase-quoting only helps
multi-word keywords, so the one OR matched 1,043 tickets in 90 days, today's "Article Master"
tickets took all 10 recency-capped slots, and #831's attribution then correctly dropped all 10.
Honest, but the focus service's incidents were never retrieved. Measured live: the service clauses
alone return exactly the 10 related tickets.

**PR #832, merged as `4df76f04`:** `findLinkedIncidents` searches the service and the keywords
SEPARATELY, in parallel, and service hits always lead; keyword-only hits fill what is left of
`limit`. `buildJql` takes `match: all | service | keywords` with the default unchanged, so
`get-incident-history` is untouched. Greptile went 3/5 then 5/5, and both findings were real flaws
in the split: `Promise.all` tied the halves together (now `allSettled`, with a `configWarning`
naming the half that failed), and a global score sort let three generic keywords outrank a service
hit. Verified live against Jira before the PR and again after the review fixes, by running the new
function locally with its upstream calls routed through the running server's own proxied search
(no second OAuth client).

**Replay on `4df76f04`, run `d0fbb492`: passed.** `rawCount: 15`, `filteredCount: 12`. The card
shows 12 rows, the two exact prior incidents first with the chip `service + 5 keywords`, then the
rest of that service's incidents, each chip's title listing every clause. On the first turn of
that thread the sub-agent never called `findLinkedIncidents` at all (`rawCount: 0`, no card): the
card is fed only by that one tool, so its absence on some runs is normal.

**Still open on SIO-1802, one false positive from a known limit.** An unrelated ticket is kept at
the bottom of the card on the chip `2 keywords`: the model passes generic single words (and even
the service name as a keyword), and two generic words satisfy the extractor's two-keyword rule. The
card explains why it is there, which is what the ticket asked for, but it is unrelated. The cleaner
fix is the prompt: `agents/incident-analyzer/agents/atlassian-agent/SOUL.md` tells the model to
pass "the cited error phrase plus key entities", and it decomposes the phrase into single words.
Not done when this was written; DONE since, as SIO-1803, see the sixth update.

**Two operational facts worth keeping:** the Atlassian MCP runs `bun --hot`, so a `git pull` in the
main checkout reloads it in place with the SAME pid and start time (an unchanged pid is not "not
restarted"; prove the running code by calling the tool on `:9085/mcp`). And Linear moves a ticket
to Done whenever a linked PR merges: SIO-1802 was reopened by hand after the failed replay and was
moved to Done again by #832.

State at close: `origin/main` at the commit that adds this section, on top of `4df76f04`. No branch
from this session is open. Port 5174 free; the operator's tunnel (8788) and the Atlassian MCP
(9085) were never touched. Nothing deployed.

## Sixth update, 2026-09-18 08:25 to 08:45 UTC (same session): SIO-1803, the prompt fix, and what is left overall

**[SIO-1803](https://linear.app/siobytes/issue/SIO-1803), PR #833, merged as `c3c1d7d0`.** Created
as the follow-up the fifth update called for, related to SIO-1802. Prompt only: one section of
`agents/incident-analyzer/agents/atlassian-agent/SOUL.md`. The old text said WHAT to pass as
`errorKeywords` and nothing about FORM, and its `atlassian_search` example is a run of loose words,
right for one free-text query and wrong for a list whose every entry becomes its own search
clause. The section now gives the form rules: keep a phrase whole, prefer distinctive identifiers
(exception class, request type, error code, business term), never a generic single word or an
estate-wide technology on its own, never the service name, 2 to 5 entries, with the styles-v3
incident as the worked wrong/right example. No `agent.yaml` bump, matching the last three edits of
that file. Greptile 5/5 on the first round, no findings. Linear moved it to Done on merge.

The RIGHT example was run against Jira BEFORE it went into the prompt (11 returned: the 10 related
tickets plus one keyword-only hit the card drops; the WRONG list pulled in five junk tickets).

Live, isolated instance on 5174 loading the new prompt, Atlassian only:

| Incident | `errorKeywords` the model passed | Result |
|---|---|---|
| styles-v3, twice | UnambiguousTimeoutException, GetRequest, `kv timeout`, styles-v3 | `rawCount: 11`, `filteredCount: 11`; 11 rows, all incident tickets, the exact prior incidents first, NO unrelated ticket |
| PDF rendering on another service, shares no words with the example | SIMPLE_PDF, fo:table-columns, TransformerException, `PDF generation failed` | 5 returned; the day before the same incident got FOP and `PDF generation` and returned 10 mostly unrelated |

Before the change the same styles-v3 incident got `TIMEOUT, article, styles, kv` and even the
service name. The same disciplined lists also reached `getIncidentHistory`. Limits, stated on the
ticket: the first two runs are the incident used as the worked example, so the third run is the
evidence that the rule generalises; `styles-v3` is the application's alias from the log line, not
the normalised service name; prompt behaviour is probabilistic, so this is three runs and not a
guarantee. If generic words reappear, the backstop is the rule-side option recorded on SIO-1802
(count only multi-word or distinctive keywords towards the two-keyword threshold). The prompt
takes effect on the next web app restart: agent definitions are cached in memory
(`agentCache`, `packages/agent/src/llm.ts`). No MCP restart is needed.

**With that, SIO-1802's acceptance is met in full:** related tickets only, keyword-found tickets
still arrive, and every row says why it is there.

**What is left from this whole document, as of this update.** Two items, both need the owner, and
neither needs code:

1. **[SIO-1801](https://linear.app/siobytes/issue/SIO-1801), the dev half** (In Progress). One
   real hub message to one DEV spoke with the two prompts on the ticket. It cannot go through the
   fleet pane, which lists prd hubs only by design (SIO-1696); it needs the operator console route
   (`just hub-tunnel` for dev, then `just coms <hub> <cname>`). The prd half passed.
2. **[SIO-1800](https://linear.app/siobytes/issue/SIO-1800), check 2** (In Review). "The
   investigate entry lands below the finished verify" could not be exercised, because the verify in
   the live run ended `error: response not valid JSON` on the spoke side and so raised no
   investigate card. It needs one verify that returns a verdict. Checks 1, 3 and 4 passed.

Not work, but a decision waiting on the owner, recorded on SIO-1800: a reply that arrives after its
pane entry was added lands partly below the fold (108 px and 81 px measured). That is the
documented intent of SIO-1794, so it was not changed.

[SIO-1799](https://linear.app/siobytes/issue/SIO-1799) stays in Backlog by its own rule (no
recurrence in 45 CI runs; close as not reproducible after 2026-11-16).

State at close: `origin/main` at the commit that adds this section, on top of `c3c1d7d0`. This
worktree and the main checkout are level with it. No branch from this session is open, locally or
on origin. Port 5174 free; the operator's tunnel (8788) and the Atlassian MCP (9085) were never
touched. Nothing deployed: fleet bundle `61b43f87`, AWS AgentCore runtime v16.

## Seventh update, 2026-09-18 08:50 to 09:30 UTC (same session): SIO-1800 and SIO-1801 finished. Nothing is left but SIO-1799's waiting period

The owner asked for the SIO-1800 recommendation to be implemented and every ticket finished. This
supersedes the "what is left" list in the sixth update: both of its items are done.

**[SIO-1801](https://linear.app/siobytes/issue/SIO-1801), the dev half: done, Done.** No operator
console was needed after all. The pane UI hides dev hubs by design (SIO-1696), but its send path
resolves EVERY configured hub, so `POST /api/pi/messages` with `hubKey: eu-shared-services-dev`
is the same hub client and a real hub message to the live dev spoke. The session opened the dev
tunnel itself (`just hub-tunnel eu-shared-services-dev 8787`, from the main checkout) and closed
it afterwards by pid, checking the command line first. Spoke `eu-shared-services-dev`: exactly the
seven `ctx_` tools, then `TOOLS_USED=ctx_batch_execute,ctx_execute; INSTANCES=3`, which matches an
independent read-only `DescribeInstances` on that account. The same two prompts on `eu-oit-dev`
answered correctly too, but that count could not be verified (no AWS profile for that account), so
it is recorded as unverified. Closed by hand on the owner's instruction; there is no PR to do it.

**[SIO-1800](https://linear.app/siobytes/issue/SIO-1800): check 2 passed, and the recommendation
shipped as PR #834 (`296b9f84`). Done.**

- Check 2: on an AWS replay the verify for `eu-shared-services-prd` returned a real verdict this
  time (`partially confirmed`), which raised an investigate card. Read from the DOM: the
  investigate entry landed BELOW the finished verify and was scrolled into view. All four checks
  on the ticket have now passed live.
- The change: a reader who was AT THE BOTTOM now follows an arriving reply; a reader who scrolled
  up is still never moved, so SIO-1794's rule stands. The decision is a pure function in
  `apps/web/src/lib/components/pi-fleet-scroll.ts` (9 tests); "was at the bottom" is captured in
  `$effect.pre`, before the DOM grows. Live: 12 px left below the fold after a reply (the section's
  own padding) instead of 108 and 81; a reader parked at `scrollTop` 30 stayed at 30.
- **A flaw in the first commit, found by measuring it live and not by review (Greptile had given
  it 5/5).** `nearest` aligns an entry taller than the pane by its TOP, which is the intended "a
  long verdict opens at its start"; but the top of the scroller is covered by the pinned spoke
  picker, so a 1,882 px verdict opened with 127 px of it, the status and the start of the summary,
  UNDER the picker. The old scroll-on-add never hit this because it only scrolled to short stubs.
  Fixed in a second commit: the scroller carries `scroll-padding-top` equal to the picker's
  measured `offsetHeight` (measured because the picker is sized to its content, SIO-1721). Live
  after it: a 1,300 px reply opens with 0 px under the picker.

**Final state of every ticket this document tracks:**

| Ticket | State |
|---|---|
| SIO-1786, SIO-1787, SIO-1788, SIO-1792, SIO-1793, SIO-1795 | Done (earlier updates) |
| SIO-1796 | Cancelled (second update) |
| SIO-1797, SIO-1798, SIO-1802, SIO-1803 | Done, merged, verified live |
| SIO-1800 | Done, PR #834 |
| SIO-1801 | Done, both environments, both counts verified |
| SIO-1799 | Backlog ON PURPOSE. It is a landing place for a recurrence of a CI flake seen once; its own acceptance is "fixed with a test, or closed as not reproducible after 60 days". No recurrence in 45 CI runs. Closing it before 2026-11-16 would contradict the ticket, so it was left. |

**Nothing else is left from the tickets above.** The four things seen in passing during the session
were ticketed afterwards at the owner's request, each checked against the code first. All four
are Backlog, unassigned, nothing in progress:

| Observation | Ticket |
|---|---|
| A verify to `eu-shared-services-prd` once ended `error: response not valid JSON`; the next one, 100 minutes later, returned a verdict. Checking the code corrected how this document described it earlier: the error is raised by the SPOKE extension (`packages/pi-coms/extensions/turnReply.ts`, `buildTurnReplies`), not by the hub, and the model's text is discarded when extraction fails, so the failure cannot be diagnosed. SIO-1580 already made the extractor lenient; this gets past it | [SIO-1804](https://linear.app/siobytes/issue/SIO-1804), Medium. Make it diagnosable first, then fix the shape that shows up |
| Atlassian MTTR is probably always null. BOTH `findLinkedIncidents` and `getIncidentHistory` compute it from `resolutiondate`, neither search call passes a `fields` list, and the upstream default set does not include that field (seen absent on a live response). Wider than first noted: it empties the MTTR / recurrence half of the incident-history findings, and the fixtures supply the field directly, so no test can see it | [SIO-1805](https://linear.app/siobytes/issue/SIO-1805), Medium. Confirm read-only on resolved tickets before changing the request |
| `get-runbook-for-alert.ts` builds Confluence CQL with unquoted multi-word `text ~` and `title ~` terms, the shape SIO-1802 fixed for Jira. NOT confirmed that CQL behaves like JQL, and this tool already ranks with `scorePage`, so it is a milder case | [SIO-1806](https://linear.app/siobytes/issue/SIO-1806), Low. Measure first; it may close with no code change |
| `packages/knowledge-graph`: `bun run test` segfaults the Bun runner locally (rc 139, zero tests executed, Bun 1.4.2, identical with a touched file restored to base content; CI is green). Not tried: main checkout vs worktree, sandboxed vs not. The native `lbug` library is the obvious suspect (SIO-1129, SIO-1165, SIO-1236 were lbug crashes) | [SIO-1807](https://linear.app/siobytes/issue/SIO-1807), Low. The package cannot be verified locally before a push |

State at close: `origin/main` at the commit that adds this section, on top of `296b9f84`. No
branch from this session is open, locally or on origin. Every process the session started is
stopped and proven so: the web instance on 5174 (by server id, port free) and the dev tunnel on
8787 (by pid, port free). The operator's prd tunnel (8788) and the Atlassian MCP (9085) were never
touched. Nothing deployed: fleet bundle `61b43f87`, AWS AgentCore runtime v16. The merged agent and
web changes (SIO-1797, SIO-1798, SIO-1800, SIO-1803) load on the next web app restart; the
Atlassian MCP already hot-reloaded SIO-1802.

## Eighth update, 2026-09-18 09:20 to 09:45 UTC (same session): SIO-1805 done and live, SIO-1804 merged but NOT deployed

Two of the four follow-up tickets from the seventh update were worked. SIO-1806 and SIO-1807 are
untouched, Backlog.

**[SIO-1805](https://linear.app/siobytes/issue/SIO-1805), PR #835 (`98904cf6`): Done, live.**
Confirmed read-only on RESOLVED tickets first (the original observation was on unresolved ones,
which proved less than it seemed): with `fields` omitted the upstream returns `resolution: Done`
and NO `resolutiondate` key; with an explicit list, real timestamps. So `findLinkedIncidents` and
`getIncidentHistory` had reported no resolution time for anything, and the history's MTTR read
"nothing was ever resolved". Both calls now pass an explicit, exported field list
(`LINKED_INCIDENT_FIELDS`, `INCIDENT_HISTORY_FIELDS`); an explicit list REPLACES the upstream
default, so everything a tool reads must be named. No `customfield_severity` exists on the site
(204 fields checked), so `priority` is the only severity signal. The tests could not see the
defect because their fixtures supply `resolutiondate` directly; the new
`test/upstream-field-shape.test.ts` uses a fake that returns only the requested fields, and the
real default set when none are requested (mutation-checked, 3 tests fail without the params).
Verified in the RUNNING server after it hot-reloaded: 2 resolved tickets with an MTTR (was 0);
history 20 incidents, 17 unresolved, an overall MTTR, 3 of 7 monthly buckets with one (was none).
The history call also stopped pulling up to 100 descriptions it never reads.

**[SIO-1804](https://linear.app/siobytes/issue/SIO-1804), PR #836 (`d35c1e80`): merged, NOT
deployed, In Review.** Linear closed it on merge and it was reopened by hand, because only half
its acceptance is met.

- Diagnosable: the spoke's "response not valid JSON" now carries the text's length, its stop
  reason and a bounded head and tail, on one line under 450 characters. It already reaches the
  spoke's `coms-net-log` entry, the hub message, the sender's card and the monitor's
  `(uninvestigated: ...)` digest line.
- Two real defects in `packages/pi-coms/extensions/jsonPayload.ts`, each reproduced before it
  was changed. (a) A candidate that failed to parse was DESCENDED INTO: the first `{...}` failing
  sent a second pass to the first `[...]`, which for a verdict is the `claims` array inside the
  broken object, returned as if it were the whole reply; four of six realistic shapes yielded
  that fragment. A failed span is now skipped whole and an unbalanced one stops the scan.
  (b) Raw control characters inside a string are invalid JSON and the models emit them
  (SIO-1219); each candidate is retried with those escaped, mirroring
  `packages/agent/src/llm-json.ts` locally because the extension is bundled standalone for Pi.
  Trailing commas, single quotes and comments are deliberately not repaired.
- This supports a hypothesis, no more: a broken verdict used to surface as "misses the schema"
  (the fragment) and as "not valid JSON" only when the inner array failed too, which a raw
  newline inside a claim's evidence text does.

**What SIO-1804 still needs, and it is the owner's call:** the extension runs on the spokes, so
nothing changes in production until a fleet bundle is published and rolled out. That is a
deployment and was NOT started. Standing procedure: canary on a dev spoke first, then host by
host over SSM (memory `reference_fleet_rollout_host_by_host_over_ssm`). After it, the next
failure carries its own evidence; if none occurs for a while, the control-character repair was
probably the cause and the ticket can close. Checked with
`git diff --stat 61b43f87 origin/main -- packages/pi-coms agents/pi-fleet`: against the deployed
bundle, the only files that RUN ON A HOST and differ are `extensions/jsonPayload.ts` and
`extensions/turnReply.ts`; the rest is the operator-side fleet CLI (SIO-1792) and tests. So the
next publish is NOT a functionally empty one, and it carries exactly this change to the spokes.

State at close: `origin/main` at the commit that adds this section, on top of `d35c1e80`. No
branch from this session is open. No process was started in this round except read-only calls to
the running Atlassian MCP. Nothing deployed.

## Ninth update, 2026-09-18 09:55 to 10:20 UTC (same session): the SIO-1804 bundle is deployed, dev canary first, then production

The owner approved it in these words: "go ahead, canary on dev then roll out to prd". Fleet bundle
`97b9d8ad` (`origin/main`, carries PR #836) is now on all 8 spokes and both hubs. Rollback target:
`61b43f87`, by republishing it from a detached checkout of that commit and running
`pi-coms-update` per host.

Done host by host over SSM with `pi-coms-update` per instance id, no fleet CLI and no tunnel
(memory `reference_fleet_rollout_host_by_host_over_ssm`), from a worktree detached at
`origin/main` with a clean tree:

1. `publish-fleet.sh --stage-only` first: the stage held the new `extensions/jsonPayload.ts` and
   `extensions/turnReply.ts`, no `.pi` dir, the right `.bundle-version`.
2. Dev: baseline read, publish to the dev hub's bucket, canary `eu-shared-services-dev`, then
   `eu-oit-dev`, then the dev hub. After the hub restart all four dev peers (two spokes, two
   monitors) re-registered within 2 seconds and neither Pi relaunched.
3. Production: baseline read of all seven hosts, publish to the production hub's bucket, canary
   `eu-shared-services-prd`, then the rest one at a time with a halt on the first failed verify,
   production hub last. 12 peers plus the operator console re-registered, 0 errors in the hub
   journal.

Verified on every spoke: `.bundle-version`, a new Pi pid with its context-mode server child,
`agent registered with the hub as <name>`, `pi-agent`, `pi-monitor` and `herdr` active with
`NRestarts=0`, `mcp.json` still excluding the four ctx maintenance tools (SIO-1788), no `.pi` dir.
A final sweep 4 to 17 minutes after each relaunch showed the same Pi pid and exactly one relaunch
per host.

Functional probe on the dev canary and the production canary, importing the DEPLOYED files with
the host's own bun as the `piagent` user: a verdict with a raw newline inside a string parses with
the newline preserved; a broken verdict returns `undefined` rather than the inner `claims` array;
the error reads `response not valid JSON (19 chars, stop=stop; text: I could not finish.)`.

Two things learned, both worth keeping:

- **A publish starts the clock for every host of that hub, not only the canary.** The State
  Manager association runs `pi-coms-update` every 30 minutes on its own schedule. Two production
  spokes converged by themselves within a minute of the production publish, before the loop
  reached them. So "canary" after a publish means "the first host I look at", not "the only host
  that changes"; the real gate is the DEV environment, which has its own bucket. If a production
  canary fails, republish the old bundle at once rather than investigating first.
- **The halt check fired falsely on the first self-converged host.** Its `pi-coms-update` was a
  no-op and its "registered" line was older than the 3 minute journal window the verify read. A
  verify script must anchor on the Pi process start time, not on a fixed recent window. Re-read
  with a 25 minute window: clean. (A second probe then failed because zsh does not word-split an
  unquoted variable; run such loops under `bash` or pass arguments explicitly.)

Not done: an end to end schema-bound hub message after the rollout. No dev tunnel was up, and a
production send needs its own approval. The on-host probe plus the hub registrations stand in.

**[SIO-1804](https://linear.app/siobytes/issue/SIO-1804) stays In Review on purpose.** The
diagnosability half of its acceptance is live. The cause (a raw control character inside a
claim's evidence text) is still a hypothesis: the next "not valid JSON" from any spoke now carries
its own length, stop reason, head and tail; if none occurs over a period of normal verify and
investigate traffic, the repair was probably the cause. Closing it is the owner's call.
[SIO-1806](https://linear.app/siobytes/issue/SIO-1806) and
[SIO-1807](https://linear.app/siobytes/issue/SIO-1807) are untouched, Backlog.
[SIO-1799](https://linear.app/siobytes/issue/SIO-1799) waits for 2026-11-16.

State at close: `origin/main` at the commit that adds this section, on top of `97b9d8ad`. No
branch is open, no process of this session is running, and the operator's own production tunnel
on 8788 was left alone and is still listening.

## Tenth update, 2026-09-18 10:20 to 10:50 UTC (same session): SIO-1806 and SIO-1807 done. Both tickets' premises were wrong, and measuring found the real defects

**[SIO-1806](https://linear.app/siobytes/issue/SIO-1806), PR #837 (`dd9ca382`): Done, live.**
The ticket asked whether Confluence CQL treats `~ "a b"` as a bag of words like JQL. It does. But
measured on a real incident, phrase-quoting moved the match count from 3376 to 3369, and no
expected runbook was in the 25 results the tool saw either way. Three real defects:

- `ORDER BY lastModified DESC` plus the default page of 25 handed `scorePage` the most recently
  EDITED matches (sprint retrospectives scoring 0). Removed; Confluence then ranks by relevance.
- Single-word keywords OR-ed over full text swamp the query. Now: query 1 is runbook-LIKE pages
  (Confluence's own blueprint labels `kb-how-to-article` and `kb-troubleshooting-article`,
  `runbook`, or a title word) about the service or citing a keyword; query 2 is pages citing the
  error, where a phrase stands alone and a single word must co-occur with the service; the old
  broad query runs only as a fallback. The only label the scorer rewarded, `runbook`, is on one
  page of the whole site.
- The tool read `id`, `spaceKey`, `labels` and `lastUpdated` off the top level of a search result,
  where none exist, so every link was `/wiki/spaces/undefined/pages/undefined` and the freshness
  and label scores never applied. The SIO-1805 class of defect again: the fixtures supplied the
  imagined shape. They now carry the captured one. Labels need `expand: "content.metadata.labels"`.

The service is NEVER phrase-quoted (a full deployment name matched 0 pages as a phrase, 45 as
words); multi-word keywords are, through `isPhraseKeyword`, shared with the Jira tool. Verified in
the RUNNING server after it hot-reloaded: the service's support notes and support guide come first,
then troubleshooting guides and a runbook, all with real ids, spaces, dates and links. A second
real incident returns the datastore troubleshooting page. 205 package tests, mutation-checked.

**[SIO-1807](https://linear.app/siobytes/issue/SIO-1807), PR #838 (`796193bd`): Done.** The
knowledge-graph package's local segfault was NOT environmental, and this document and a memory
note said it was. Cause: `LadybugStore.close()` skips the native close because lbug's Database
destructor segfaults Bun (SIO-954), then nulled `db` and `conn`. That made the native objects
collectable, so the garbage collector ran the same destructor MID-RUN and the next store the
process opened crashed at `0x8`. The app never saw it (one store, never closed);
`ladybug.integration.test.ts` opens ten, and CI skips that file (SIO-1100), which is the whole
reason CI was green. `close()` now parks the handles on `globalThis` for the life of the process.

The deciding measurement, on raw lbug with four databases in one process: references KEPT, never
a crash in any init-stage combination; references DROPPED plus enough work to trigger a
collection, a crash on the next open every time. Worth knowing for next time:

- "Zero tests executed" was false. `bun test` buffers its `(pass)` lines when piped and a crash
  loses them.
- Every test passed ALONE with exit 0. "Crashes only with several stores in one process" means a
  collected handle, not a handle cap.
- My first GC test refuted the true hypothesis: it retained the `LadybugStore` objects, which
  does not retain the native handles once `close()` has nulled them.
- The integration file's old rule, "hold the file's total at three stores", was a workaround for
  this without knowing the cause. That comment is corrected.

`cd packages/knowledge-graph && bun run test` now gives 195 pass, sandboxed, on merged `main`. A
segfault there is from now on a real regression.

State at close: `origin/main` at the commit that adds this section, on top of `796193bd`. No
branch is open and no process of this session is running. Open work: SIO-1804 (In Review, the
bundle is deployed, waiting for a real "not valid JSON" sample or a quiet period) and SIO-1799
(Backlog until 2026-11-16).

## Close-out, 2026-09-18 10:55 UTC: every ticket of this document is Done or Cancelled

The owner chose to close the last two rather than wait, in these words: "let be definitive and
close thse out, eiitherr done or cancelled".

- **[SIO-1804](https://linear.app/siobytes/issue/SIO-1804): Done.** Fix merged (PR #836) and
  deployed (bundle `97b9d8ad`, ninth update). Still unproven, and said so on the ticket: that the
  raw control character was THE cause of the original failure; no sample of it ever existed.
  Closing is safe because the question no longer needs a ticket to stay answerable: any future
  "response not valid JSON" carries its own length, stop reason, head and tail. If one appears,
  open a NEW ticket with that text and link SIO-1804.
- **[SIO-1799](https://linear.app/siobytes/issue/SIO-1799): Cancelled.** The last 100 CI runs,
  all since 2026-09-17, hold one failure, and it was a genuine lint error on a PR branch, not the
  `ajv` flake. Seen once, never reproduced. If it recurs, open a new ticket with the run id.

Nothing in this document is open. The sections below are history.

## What is still open

### 1. SIO-1786: the user-side verification (no code) [DONE, see the update above]

Linear moved SIO-1786 to Done automatically when PR #819 merged. One item from its handover
(`experiments/HANDOFF-2026-09-17-SIO-1786.md`, last paragraph of Verification) was never done,
because it needs the user's own process:

1. Restart the web app on 5173 so it runs the day's agent changes. It is the user's process: ask,
   never kill it.
2. One full incident replay, watching: `tool_result_truncated` lines with `indexedRows` above zero,
   no `evidence_index.unavailable`, `cacheReadTokens` growing turn over turn, `pi verification cards
   proposed` (count 1 when the model completes the ECS enumeration; SIO-1784 explains why it can be
   2), and Approve opening a `verify` entry in the fleet pane.

Two things from the earlier 2026-09-17 session are still unconfirmed live and have no ticket:
`subagent.final_turn_forced` (SIO-1779) never fired in a replay, and the key-decision memory write
after a pi verdict was never checked because the replay ran with memory off. Note them if the replay
shows either; do not chase them.

### 2. Twenty-four local-only failures in `packages/agent` [EXPLAINED: bare `bun test` without `--isolate`, see the update above]

In this session's worktree, `cd packages/agent && bun test` gives `4616 pass, 24 fail`, identically
sandboxed and unsandboxed, on a branch that differed from main by one markdown file. CI on the same
commits runs 4689 tests with 0 failures, so the worktree runs about 50 FEWER tests and fails 24 of
the rest. Every failing suite is in the memory and knowledge-graph recall area:

```
recallPriorRenovateTriggers (SIO-1472)   memoryEnrichIac        runMemorySearch
reviewPlan recall status (SIO-1083)      recordIacOutcome       recordIacEntities
recallPriorFleetUpgrades (SIO-971)       graphEnrichIac
```

First failure text: `expect(received).toBeDefined()`. No `AGENT_MEMORY*`, `LIVE_MEMORY*` or
`KNOWLEDGE_GRAPH*` variable was set in the shell. NOT investigated further. Start by running the same
command in the MAIN checkout: if it passes there, the gap is this worktree's environment (a missing
workspace symlink or native library is the known class, see memory
`reference_pi_coms_workspace_symlink_missing` and `hub_knowledge_graph`), not the code. Do not
"fix" a test on this evidence.

### 3. One CI flake, seen once

On the first CI run of PR #819 the `Test` job failed with `4689 pass, 0 fail, 1 error`: an unhandled
`error: ajv implementation error` thrown from `ajv@8.18.0 dist/compile/errors.js:45` while
`packages/agent/src/correlation/extractors/atlassian.test.ts` was loading. Main passed at the same
base commit, it was the only failed CI run in the last 40, three local runs did not reproduce it,
and the re-run passed with no change. Treated as a flake and NOT ticketed. If it recurs, that is the
signal to look at how that test file builds its ajv validators.

### 4. `just fleet status` hung, cause NOT established [SIO-1792 DONE via PR #828, see the third update]

During SIO-1787, `just fleet status --operator simon` did not return within 5 minutes and left one
orphaned dev tunnel on 8787 (proven mine by parent chain, killed by PID). At the time the prd hub's
local port 8788 was held by the operator's own `just hub-tunnel`. The session first blamed that. The
code does not support it as stated: `withHubTunnel` would see `/health` succeed THROUGH the existing
tunnel and carry on.

`packages/pi-coms/scripts/fleet.ts:239-254`:

```ts
	try {
		const baseUrl = `http://127.0.0.1:${localPort}`;
		for (let i = 0; i < 30; i++) {
			try {
				const r = await fetch(`${baseUrl}/health`);
				if (r.ok) break;
			} catch {
				// tunnel not up yet
			}
			await Bun.sleep(1000);
		}
		return await fn(baseUrl);
	} finally {
		tunnel.kill();
		await tunnel.exited;
	}
```

Two things that ARE visible in that code and worth a ticket if anyone picks this up: the health loop
falls through after 30 tries without throwing, so `fn` runs against a tunnel that never came up; and
`tunnel.kill()` signals the `aws` CLI but not its `session-manager-plugin` child, which is the orphan
memory `reference_fleet_cli_orphans_ssm_tunnels` describes. The output was also piped through `tail`,
which buffers until exit, so the run may simply have been slow rather than hung. Reproduce before
concluding anything. No ticket exists.

### 5. SIO-1788: two acceptance items met by a different route than the ticket named [offline half: SIO-1793 DONE via PR #827; the live hub message stays user-driven]

- The ticket said "a hub message". The probes actually ran as a separate Pi print-mode process on
  each host (deployed `mcp.json`, real adapter, the host's own model, persona loaded). That proves
  the deployed configuration; it is not the live hub-driven session. The live sessions are covered
  by process checks only (new pid, ctx server as its child, the same `mcp.json`). A real hub message
  to one spoke per environment would close the gap, and needs an operator token and a tunnel.
- `CTX_MODE_ENABLED=false` removing `mcp.json` was not exercised live. That branch of the launcher
  is untouched by the diff (`packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh`, the `else` of the
  block that writes `mcp.json`).

Also noted, no action needed: the fleet pins `pi-mcp-adapter@2.33.0` and npm latest is 2.34.0. The
pin already supports everything in use. Bump only through the canary procedure (memory
`reference_pi_version_upgrade_procedure`).

SIO-1787 is Done (closed by the user on 2026-09-17; it was In Review with nothing left to do when
this was written).

## Where things stand, precisely

**AgentCore AWS runtime.** Runtime id and the ECR repository are in the runbook's quick reference.
Live digest `sha256:390b78bce8bd5493c2e2d2dc86eaf16eeb31832124661f20bbc4515ddaf0bd6c`, rollback
`sha256:3e2693033fda93c2d9f5dd6a3ca4c47ddf26f586783a7bf76237eda68aeb0fd0`. Rollback is editing
`containerUri` back and re-running step 5 of the runbook. Kafka was not redeployed.

**Fleet.** Both hub buckets `fleet/version` = `61b43f87`; the previous value, and the rollback
target, is `12a7be86`. Rollback is republishing that SHA and running `pi-coms-update` per host.

**The SIO-1788 change itself**, `packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh`, the launcher
block that writes `mcp.json`:

```bash
  printf '%s\n' "{\"mcpServers\":{\"ctx\":{\"command\":\"$HOME/.bun/bin/bun\",\"args\":[\"$CTX_SERVER\"],\"lifecycle\":\"keep-alive\",\"directTools\":true,\"toolPrefix\":\"none\",\"excludeTools\":[\"ctx_upgrade\",\"ctx_purge\",\"ctx_doctor\",\"ctx_insight\"]}}}" \
    > "$HOME/.pi/agent/mcp.json"
```

That line is a hand-escaped JSON string. `packages/pi-coms/tests/agent-bootstrap-project-scope.test.ts`
(the `agent-bootstrap.sh mcp.json entry` block) runs it through bash and parses the result, because a
quoting slip there leaves a spoke with no ctx tools at all, silently.

## Verification (state checks, all read-only)

```bash
bun run typecheck && bun run lint && bun run test     # only if any code changes; `bun test` at the repo root can crash the runner, run per package

# Fleet: every spoke on the bundle, excludeTools live, ctx server attached (per host, base64 the script)
cat /home/piagent/pi-coms/.bundle-version                                  # 61b43f87
grep -o '"excludeTools":\[[^]]*\]' /home/piagent/.pi/agent/mcp.json         # the four names
P=$(pgrep -u piagent -f pi-coding-agent/dist/cli.js | head -1); pgrep -P "$P" -f context-mode/server.bundle.mjs

# Spoke tool list without the hub (as piagent, cd ~/pi-coms, source ~/.coms-env first): expect 7 names
bun <pi cli.js> --model <the live Pi's --model> --provider amazon-bedrock --no-session \
  -p 'List every tool available to you whose name starts with ctx_. Names only, one per line.'

# AgentCore: endpoint live version and behaviour
aws bedrock-agentcore-control get-agent-runtime-endpoint --agent-runtime-id <id> --endpoint-name DEFAULT \
  --profile eu-shared-services-prd --region eu-central-1 --query '{live:liveVersion,status:status}'   # live 16
```

Expected for `aws_cloudwatch_describe_alarms` through the proxy: about 36 KB for the ALARM-state
alarms of the prd estate used in the probe, no `AlarmArn` / `AlarmActions` / `StateReasonData`. If it
shows the old 78 KB, reset the proxy session first (runbook step 6) before suspecting the deploy.

## Workflow for whoever picks one of these up

1. Each open item is independent. None has a ticket except SIO-1786's replay, which belongs on that
   ticket as a comment. Create a Linear issue in the DevOps Incident Analyzer project before any code
   change, claim it (assign, In Progress), never set Done.
2. Branch off `main`, `SIO-XXXX: message` commits with a HEREDOC, PR ready for review (never draft),
   Greptile gate: `status == COMPLETED` AND `conclusion == SUCCESS`, footer SHA equal to the PR head,
   zero unresolved threads. Verify every finding before applying it.
3. Note that a merged PR linked to a ticket makes Linear move it to Done on its own.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| The 24 local failures get "fixed" in code | Low now | Explained: bare `bun test` leaks `mock.module` across files. Use the package script (`bun test --isolate`) |
| A future AgentCore deploy is judged failed, or good, off the pinned proxy session | Medium | Runbook step 6: wait for the endpoint's `liveVersion`, check the proxy is idle, `DELETE /mcp`, then verify by behaviour |
| `DELETE /mcp` aborts someone's in-flight analysis | Low | `activeSseConnections: 0` on `/health` is necessary, not sufficient; stop your own probes and confirm nobody else uses the proxy |
| A spoke model wants `ctx_purge` or `ctx_upgrade` and cannot find it | Low | Intended. Operators run those by hand on the host |
| An unbounded wait loop on an SSM command id that was never issued | Seen once this session | Bound every loop and check the command id is 36 characters before polling |
| Sandboxed and unsandboxed `TMPDIR` differ, so a script written in one is empty in the other | Seen once this session | Write helper scripts to a fixed path |

## Out of scope

- SIO-1784 (deterministic ECS enumeration completion): code change with its own handover.
- Redeploying the Kafka AgentCore runtime. It shares `packages/shared`, so its next deploy will carry
  the day's shared changes; that is a separate decision.
- Adding the repo's other MCP servers to the spokes. A spoke is deliberately the AWS CLI plus the
  instance role.
- Upgrading `context-mode`: the pin already equals npm latest (1.0.169).

## Related code references

- `packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh`: the context-mode and adapter installs (the
  `CTX_MODE_ENABLED` block near the top), the launcher's `mcp.json` block, and the `pi-coms-update`
  heredoc near the end (version compare, reload sentinel, user-data re-run).
- `packages/pi-coms/docs/deployment/deployment.md`: boot sequence step 5, the launcher paragraph with
  the `excludeTools` and "not a security boundary" notes, and the per-host probe.
- `packages/pi-coms/docs/deployment/deploying-from-a-worktree.md`: read before any fleet command
  from a worktree. `publish-fleet.sh` takes the bucket and profile as arguments and needs no manifest.
- `agents/pi-fleet/agents/aws-spoke/SOUL.md`, `RULES.md` (section "Sandboxed execution and search"),
  `agent.yaml` (0.5.1).
- `packages/shared/src/agentcore-proxy.ts`: the process-wide `mcpSessionId`, the session signal
  attached to the upstream `fetch` and to `sleepWithAbort`, and the `DELETE` route that resets both.
- `packages/mcp-server-aws/src/tools/cloudwatch/describe-alarms.ts`: `omitAlarmNoise`,
  `includeNotificationConfig`.
- `docs/runbooks/mcp-agentcore-image-deployment.md`: the whole procedure plus this session's lessons.

## Memory references

`reference_agentcore_proxy_sticky_session_tests_old_image`,
`reference_fleet_rollout_host_by_host_over_ssm`, `reference_fleet_cli_orphans_ssm_tunnels`,
`reference_pi_version_upgrade_procedure`, `hub_pi_coms_ops`, `hub_pi_fleet`, `hub_agentcore_and_aws`,
`hub_testing_and_bun`, `hub_knowledge_graph`, `reference_pi_coms_workspace_symlink_missing`,
`reference_worktree_gitignored_deploy_config`, `feedback_validate_before_acting_on_infra`,
`feedback_roll_back_before_diagnosing_a_deploy_break`,
`feedback_never_blame_working_code_for_probe_failures`, `feedback_new_features_default_on`,
`feedback_never_attach_ui_to_prod_spoke_panes`, `reference_linear_pr_link_auto_transitions_to_done`,
`reference_greptile_active_again_2026_09_14`, `feedback_repo_is_public_sanitize_before_commit`,
`feedback_never_use_em_dashes`, `feedback_handoff_docs_main_branch`.
